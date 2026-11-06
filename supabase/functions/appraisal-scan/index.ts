import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024;
const MAX_SCANS_PER_HOUR = 20;
const RATE_WINDOW_SECONDS = 60 * 60;
const MODEL = "gemini-3.8-flash";
const BUCKET = "appraisal-images";

class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || /^(unknown|not visible|uncertain|n\/a|none)$/i.test(text)) return null;
  return text.slice(0, 1000);
}

function toScanRecord(row: Record<string, unknown>, imageUrl: string | null) {
  const createdAt = typeof row.created_at === "string" ? Date.parse(row.created_at) : Date.now();
  return {
    id: row.id,
    timestamp: Number.isFinite(createdAt) ? createdAt : Date.now(),
    objectName: row.object_name || "Scanned Object",
    category: row.category || "General",
    rarity: row.rarity || "Unspecified",
    scanSummary: row.scan_summary || "",
    thumbnail: imageUrl,
    objects: Array.isArray(row.objects) ? row.objects : [],
  };
}

async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseModelResponse(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new RequestError("The AI returned an unreadable appraisal.", 502);
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      throw new RequestError("The AI returned an unreadable appraisal.", 502);
    }
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return respond({ error: "Method not allowed." }, 405);
  }

  try {
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || secretKeys.default;
    if (!geminiApiKey || !supabaseUrl || !serviceRoleKey) {
      throw new RequestError("The appraisal service is not configured.", 503);
    }

    let body: { imageBase64?: unknown };
    try {
      body = await request.json();
    } catch {
      throw new RequestError("Request body must be valid JSON.", 400);
    }

    if (
      typeof body.imageBase64 !== "string" ||
      body.imageBase64.length === 0 ||
      body.imageBase64.length > MAX_IMAGE_BASE64_LENGTH ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(body.imageBase64)
    ) {
      throw new RequestError("A valid image under 6 MB is required.", 400);
    }

    const forwardedIps = request.headers.get("x-forwarded-for")?.split(",");
    const ip = request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-real-ip") ||
      forwardedIps?.at(-1)?.trim() ||
      "unknown";
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: allowed, error: rateError } = await supabase.rpc(
      "consume_scan_rate_limit",
      {
        p_ip_hash: await hashIp(ip),
        p_window_seconds: RATE_WINDOW_SECONDS,
        p_max_requests: MAX_SCANS_PER_HOUR,
      },
    );
    if (rateError) {
      console.error("Scan rate-limit check failed:", rateError.message);
      throw new RequestError("Could not verify scan limits. Please try again later.", 503);
    }
    if (allowed !== true) {
      throw new RequestError("Scan limit reached. Please try again in an hour.", 429);
    }

    const prompt = `You are an object identification and appraisal assistant. Analyze the image and return JSON only with this shape:
{"scanSummary":"one concise sentence","primaryCategory":"category","rarity":"Common / Uncommon / Rare / Very Rare / Legendary","objects":[{"objectName":"specific visible item","category":"subcategory","brand":"brand or Not visible","model":"model or Not visible","identificationConfidence":"High / Medium / Low","description":"concise physical description","materials":"visible materials","purposeAndUses":"likely use","keyFeatures":"distinctive visible features","specifications":"visible specifications or Not visible","visibleCondition":"visible condition","authenticity":"cautious assessment based only on image","marketValue":"estimated Philippines market range in PHP; state uncertainty","issuesDetected":"visible issues or None visible","solutions":"reasonable care or repair advice"}]}
Identify at most 3 objects. Only use evidence visible in the image. Never guess a brand or model; use "Not visible" if uncertain. Keep each field concise.`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: "image/jpeg", data: body.imageBase64 } },
            ],
          }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 3072 },
        }),
      },
    );
    if (!geminiResponse.ok) {
      let providerStatus: string | null = null;
      let providerMessage: string | null = null;
      try {
        const providerError = await geminiResponse.json();
        providerStatus = typeof providerError?.error?.status === "string"
          ? providerError.error.status
          : null;
        providerMessage = typeof providerError?.error?.message === "string"
          ? providerError.error.message
          : null;
      } catch {
        // Keep the response generic if Google returned a non-JSON error body.
      }
      if (providerMessage) {
        providerMessage = providerMessage
          .replaceAll(geminiApiKey, "[redacted]")
          .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
          .replace(/key=[^&\s"'`]+/gi, "key=[redacted]")
          .slice(0, 300);
      }
      console.error("Gemini request failed:", {
        httpStatus: geminiResponse.status,
        providerStatus,
        providerMessage,
      });

      let message = providerMessage
        ? `Gemini returned HTTP ${geminiResponse.status}: ${providerMessage}`
        : `Gemini returned HTTP ${geminiResponse.status}. Check the function logs for the error category.`;
      if (geminiResponse.status === 400 || geminiResponse.status === 401) {
        message = providerMessage
          ? `Gemini rejected the request (HTTP ${geminiResponse.status}): ${providerMessage}`
          : "Gemini rejected the request. Check the API key and request details.";
      } else if (geminiResponse.status === 403) {
        message = providerMessage
          ? `Gemini denied access (HTTP 403): ${providerMessage}`
          : "Gemini denied access. Check API key restrictions, Google AI API access, and billing or project eligibility.";
      } else if (geminiResponse.status === 404) {
        message = providerMessage
          ? `Gemini model unavailable (HTTP 404): ${providerMessage}`
          : "The configured Gemini model is unavailable for this API project.";
      } else if (geminiResponse.status === 429) {
        message = providerMessage
          ? `Gemini usage limit reached (HTTP 429): ${providerMessage}`
          : "Gemini usage limit or quota reached. Check the Google AI Studio project quota and try again later.";
      } else if (geminiResponse.status >= 500) {
        message = "Gemini is temporarily unavailable. Please try again later.";
      }

      throw new RequestError(
        message,
        geminiResponse.status === 429 ? 429 : 502,
      );
    }

    const geminiData = await geminiResponse.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof rawText !== "string" || !rawText.trim()) {
      throw new RequestError("The AI did not return an appraisal.", 502);
    }
    const appraisal = parseModelResponse(rawText);
    const objects = Array.isArray(appraisal.objects)
      ? appraisal.objects.filter(
        (item: unknown): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      ).slice(0, 3)
      : [];
    if (objects.length === 0) {
      throw new RequestError("No objects were identified. Try a clearer image.", 422);
    }

    const primaryObject = objects[0];
    const brand = cleanText(primaryObject.brand);
    const model = cleanText(primaryObject.model);

    if (brand && model) {
      const { data: matches, error: matchError } = await supabase.rpc(
        "find_appraisal_match",
        { p_brand: brand, p_model: model },
      );
      if (matchError) {
        console.error("Appraisal match lookup failed:", matchError.message);
        throw new RequestError("Could not check the shared appraisal catalog.", 503);
      }
      const match = Array.isArray(matches) ? matches[0] : null;
      if (match) {
        const { data: publicUrl } = match.image_path
          ? supabase.storage.from(BUCKET).getPublicUrl(match.image_path)
          : { data: { publicUrl: null } };
        return respond({ matched: true, scanRecord: toScanRecord(match, publicUrl.publicUrl) });
      }
    }

    const id = crypto.randomUUID();
    const imagePath = `${id}.jpg`;
    const binary = Uint8Array.from(atob(body.imageBase64), (character) => character.charCodeAt(0));
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(imagePath, binary, {
      contentType: "image/jpeg",
      upsert: false,
    });
    if (uploadError) {
      console.error("Appraisal image upload failed:", uploadError.message);
      throw new RequestError("Could not save the appraisal image.", 503);
    }

    const row = {
      id,
      object_name: cleanText(primaryObject.objectName) || "Scanned Object",
      brand,
      model,
      category: cleanText(appraisal.primaryCategory) || "General",
      rarity: cleanText(appraisal.rarity) || "Unspecified",
      scan_summary: cleanText(appraisal.scanSummary) || "",
      objects,
      image_path: imagePath,
    };
    const { data: savedRow, error: insertError } = await supabase
      .from("appraisals")
      .insert(row)
      .select()
      .single();
    if (insertError) {
      console.error("Appraisal insert failed:", insertError.message);
      const { error: cleanupError } = await supabase.storage.from(BUCKET).remove([imagePath]);
      if (cleanupError) console.error("Uploaded image cleanup failed:", cleanupError.message);
      throw new RequestError("Could not save the appraisal to the shared catalog.", 503);
    }

    const { data: imageUrl } = supabase.storage.from(BUCKET).getPublicUrl(imagePath);
    return respond({ matched: false, scanRecord: toScanRecord(savedRow, imageUrl.publicUrl) });
  } catch (error) {
    if (error instanceof RequestError) {
      return respond({ error: error.message }, error.status);
    }
    console.error("Appraisal function failed:", error);
    return respond({ error: "Unexpected appraisal service error. Please try again." }, 500);
  }
});
