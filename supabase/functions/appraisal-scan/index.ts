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
const EMBEDDING_MODEL = "gemini-embedding-2";
const EMBEDDING_DIMENSIONS = 1408;
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function createImageEmbedding(apiKey: string, imageBase64: string): Promise<number[]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: {
          parts: [{ inline_data: { mime_type: "image/jpeg", data: imageBase64 } }],
        },
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    },
  );
  if (!response.ok) {
    let message: string | null = null;
    try {
      const errorBody = await response.json();
      if (typeof errorBody?.error?.message === "string") {
        message = errorBody.error.message
          .replaceAll(apiKey, "[redacted]")
          .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
          .slice(0, 250);
      }
    } catch {
      // Keep the response generic if Google returned a non-JSON error body.
    }
    console.error("Gemini image embedding failed:", {
      httpStatus: response.status,
      message,
    });
    throw new RequestError(
      message
        ? `Visual recognition failed (HTTP ${response.status}): ${message}`
        : `Visual recognition failed (HTTP ${response.status}).`,
      response.status === 429 ? 429 : 502,
    );
  }

  const data = await response.json();
  const values = data.embedding?.values;
  if (
    !Array.isArray(values) ||
    values.length !== EMBEDDING_DIMENSIONS ||
    !values.every((value: unknown) => typeof value === "number" && Number.isFinite(value))
  ) {
    console.error("Gemini returned an invalid image embedding.");
    throw new RequestError("Visual recognition returned an invalid image embedding.", 502);
  }
  return values;
}

function parseModelResponse(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new RequestError("The AI returned an unreadable response.", 502);
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      throw new RequestError("The AI returned an unreadable response.", 502);
    }
  }
}

async function verifySamePhysicalItem(
  apiKey: string,
  scannedImage: string,
  savedImage: string,
): Promise<boolean> {
  const result = await requestGemini(
    apiKey,
    [scannedImage, savedImage],
    `Compare Image 1 and Image 2. Decide whether they show the exact same physical item, not merely the same product model or type. Compare distinctive marks, wear, shape details, labels, and other visible identifiers. Be conservative: if uncertain, return samePhysicalItem false. Return JSON only: {"samePhysicalItem":true,"confidence":0}. Confidence is an integer from 0 to 100.`,
    256,
  );
  return result.samePhysicalItem === true &&
    typeof result.confidence === "number" &&
    Number.isFinite(result.confidence) &&
    result.confidence >= 90;
}

async function requestGemini(
  apiKey: string,
  imageBase64: string | string[],
  prompt: string,
  maxOutputTokens: number,
): Promise<Record<string, unknown>> {
  const images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            ...images.map((image) => ({
              inline_data: { mime_type: "image/jpeg", data: image },
            })),
          ],
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens },
      }),
    },
  );
  if (!response.ok) {
    let providerStatus: string | null = null;
    let providerMessage: string | null = null;
    try {
      const providerError = await response.json();
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
        .replaceAll(apiKey, "[redacted]")
        .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
        .replace(/key=[^&\s"'`]+/gi, "key=[redacted]")
        .slice(0, 300);
    }
    console.error("Gemini request failed:", {
      httpStatus: response.status,
      providerStatus,
      providerMessage,
    });

    let message = providerMessage
      ? `Gemini returned HTTP ${response.status}: ${providerMessage}`
      : `Gemini returned HTTP ${response.status}. Check the function logs for the error category.`;
    if (response.status === 400 || response.status === 401) {
      message = providerMessage
        ? `Gemini rejected the request (HTTP ${response.status}): ${providerMessage}`
        : "Gemini rejected the request. Check the API key and request details.";
    } else if (response.status === 403) {
      message = providerMessage
        ? `Gemini denied access (HTTP 403): ${providerMessage}`
        : "Gemini denied access. Check API key restrictions, Google AI API access, and billing or project eligibility.";
    } else if (response.status === 404) {
      message = providerMessage
        ? `Gemini model unavailable (HTTP 404): ${providerMessage}`
        : "The configured Gemini model is unavailable for this API project.";
    } else if (response.status === 429) {
      message = providerMessage
        ? `Gemini usage limit reached (HTTP 429): ${providerMessage}`
        : "Gemini usage limit or quota reached. Check the Google AI Studio project quota and try again later.";
    } else if (response.status >= 500) {
      message = "Gemini is temporarily unavailable. Please try again later.";
    }

    throw new RequestError(message, response.status === 429 ? 429 : 502);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new RequestError("The AI did not return a response.", 502);
  }
  return parseModelResponse(rawText);
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

    let body: { imageBase64?: unknown; imageHash?: unknown };
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
    if (
      body.imageHash !== undefined &&
      (typeof body.imageHash !== "string" || !/^[0-9a-f]{16}$/i.test(body.imageHash))
    ) {
      throw new RequestError("A valid image fingerprint is required.", 400);
    }
    const imageHash = typeof body.imageHash === "string" ? body.imageHash.toLowerCase() : null;

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

    const findCatalogMatch = async (brand: string | null, model: string | null) => {
      if (!brand || !model) return null;
      const { data: matches, error: matchError } = await supabase.rpc(
        "find_appraisal_match",
        { p_brand: brand, p_model: model },
      );
      if (matchError) {
        console.error("Appraisal match lookup failed:", matchError.message);
        throw new RequestError("Could not check the shared appraisal catalog.", 503);
      }
      return Array.isArray(matches) ? matches[0] ?? null : null;
    };

    const returnMatchedAppraisal = async (
      match: Record<string, unknown> & {
        id: string;
        image_hash?: string | null;
        image_path?: string | null;
      },
      matchedBy: "visualEmbedding" | "identification",
    ) => {
      if (imageHash && !match.image_hash) {
        const { error: backfillError } = await supabase
          .from("appraisals")
          .update({ image_hash: imageHash })
          .eq("id", match.id);
        if (backfillError) {
          console.error("Appraisal image fingerprint backfill failed:", backfillError.message);
        }
      }
      const { data: publicUrl } = match.image_path
        ? supabase.storage.from(BUCKET).getPublicUrl(match.image_path)
        : { data: { publicUrl: null } };
      return respond({
        matched: true,
        matchedByVisualEmbedding: matchedBy === "visualEmbedding",
        matchedByIdentification: matchedBy === "identification",
        scanRecord: toScanRecord(match, publicUrl.publicUrl),
      });
    };

    if (imageHash) {
      const { data: imageMatches, error: imageMatchError } = await supabase.rpc(
        "find_appraisal_by_image_hash",
        { p_image_hash: imageHash, p_max_distance: 1 },
      );
      if (imageMatchError) {
        console.error("Appraisal image lookup failed:", imageMatchError.message);
        throw new RequestError("Could not check the shared appraisal catalog.", 503);
      }
      const imageMatch = Array.isArray(imageMatches) ? imageMatches[0] : null;
      if (imageMatch) {
        const { data: publicUrl } = imageMatch.image_path
          ? supabase.storage.from(BUCKET).getPublicUrl(imageMatch.image_path)
          : { data: { publicUrl: null } };
        return respond({
          matched: true,
          matchedByImage: true,
          scanRecord: toScanRecord(imageMatch, publicUrl.publicUrl),
        });
      }
    }

    const imageEmbedding = await createImageEmbedding(geminiApiKey, body.imageBase64);
    const { data: legacyImages, error: legacyImagesError } = await supabase
      .from("appraisals")
      .select("id, image_path")
      .is("image_embedding", null)
      .not("image_path", "is", null)
      .order("created_at", { ascending: true })
      .limit(5);
    if (legacyImagesError) {
      console.error("Unindexed appraisal lookup failed:", legacyImagesError.message);
      throw new RequestError("Could not prepare the saved image catalog for visual search.", 503);
    }

    for (const legacyImage of legacyImages ?? []) {
      const { data: imageBlob, error: downloadError } = await supabase.storage
        .from(BUCKET)
        .download(legacyImage.image_path);
      if (downloadError || !imageBlob) {
        console.error("Saved appraisal image download failed:", downloadError?.message);
        throw new RequestError("Could not prepare a saved image for visual search.", 503);
      }
      if (imageBlob.size > 6 * 1024 * 1024) {
        throw new RequestError("A saved image is too large to prepare for visual search.", 413);
      }
      const legacyEmbedding = await createImageEmbedding(
        geminiApiKey,
        bytesToBase64(new Uint8Array(await imageBlob.arrayBuffer())),
      );
      const { error: updateEmbeddingError } = await supabase
        .from("appraisals")
        .update({ image_embedding: legacyEmbedding })
        .eq("id", legacyImage.id);
      if (updateEmbeddingError) {
        console.error("Saved appraisal image indexing failed:", updateEmbeddingError.message);
        throw new RequestError("Could not save an image index for visual search.", 503);
      }
    }

    const { data: visualCandidates, error: visualSearchError } = await supabase.rpc(
      "find_appraisal_by_image_embedding",
      {
        p_image_embedding: imageEmbedding,
        p_match_threshold: 0.72,
        p_match_count: 3,
      },
    );
    if (visualSearchError) {
      console.error("Appraisal visual search failed:", visualSearchError.message);
      throw new RequestError("Could not search the appraisal images.", 503);
    }
    for (const candidate of visualCandidates ?? []) {
      const { data: match, error: matchError } = await supabase
        .from("appraisals")
        .select("id, created_at, object_name, category, rarity, scan_summary, objects, image_hash, image_path, brand, model")
        .eq("id", candidate.appraisal_id)
        .maybeSingle();
      if (matchError) {
        console.error("Visual search candidate lookup failed:", matchError.message);
        throw new RequestError("Could not load a visual search result.", 503);
      }
      if (!match?.image_path) continue;

      const { data: savedImage, error: savedImageError } = await supabase.storage
        .from(BUCKET)
        .download(match.image_path);
      if (savedImageError || !savedImage) {
        console.error("Visual search candidate image download failed:", savedImageError?.message);
        throw new RequestError("Could not verify a visual search result.", 503);
      }
      if (savedImage.size > 6 * 1024 * 1024) {
        throw new RequestError("A saved image is too large to verify visually.", 413);
      }
      const savedImageBase64 = bytesToBase64(
        new Uint8Array(await savedImage.arrayBuffer()),
      );
      if (await verifySamePhysicalItem(geminiApiKey, body.imageBase64, savedImageBase64)) {
        return await returnMatchedAppraisal(match, "visualEmbedding");
      }
    }

    const identificationPrompt = `Identify the main visible object. Return JSON only with this shape:
{"objects":[{"objectName":"specific visible item","category":"subcategory","brand":"brand or Not visible","model":"model or Not visible","identificationConfidence":"High / Medium / Low"}]}
Use only evidence visible in the image. Never guess a brand or model; use "Not visible" if uncertain. Return an empty objects array if no object can be identified.`;
    const identification = await requestGemini(
      geminiApiKey,
      body.imageBase64,
      identificationPrompt,
      1024,
    );
    const identifiedObjects = Array.isArray(identification.objects)
      ? identification.objects.filter(
        (item: unknown): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      ).slice(0, 3)
      : [];
    if (identifiedObjects.length === 0) {
      throw new RequestError("No objects were identified. Try a clearer image.", 422);
    }

    const identifiedPrimaryObject = identifiedObjects[0];
    const identifiedBrand = cleanText(identifiedPrimaryObject.brand);
    const identifiedModel = cleanText(identifiedPrimaryObject.model);
    const identifiedObjectName = cleanText(identifiedPrimaryObject.objectName);
    const identifiedMatch = await findCatalogMatch(identifiedBrand, identifiedModel);
    if (identifiedMatch) return await returnMatchedAppraisal(identifiedMatch, "identification");

    const appraisalPrompt = `You are an object appraisal assistant. Analyze the image and return JSON only with this shape:
{"scanSummary":"one concise sentence","primaryCategory":"category","rarity":"Common / Uncommon / Rare / Very Rare / Legendary","objects":[{"objectName":"specific visible item","category":"subcategory","brand":"brand or Not visible","model":"model or Not visible","identificationConfidence":"High / Medium / Low","description":"concise physical description","materials":"visible materials","purposeAndUses":"likely use","keyFeatures":"distinctive visible features","specifications":"visible specifications or Not visible","visibleCondition":"visible condition","authenticity":"cautious assessment based only on image","marketValue":"estimated Philippines market range in PHP; state uncertainty","issuesDetected":"visible issues or None visible","solutions":"reasonable care or repair advice"}]}
Identify at most 3 objects. Only use evidence visible in the image. Never guess a brand or model; use "Not visible" if uncertain. Keep each field concise.`;
    const appraisal = await requestGemini(
      geminiApiKey,
      body.imageBase64,
      appraisalPrompt,
      3072,
    );
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
    const brand = cleanText(primaryObject.brand) || identifiedBrand;
    const model = cleanText(primaryObject.model) || identifiedModel;
    const objectName = cleanText(primaryObject.objectName) || identifiedObjectName;
    const appraisalMatch = brand === identifiedBrand &&
        model === identifiedModel &&
        objectName === identifiedObjectName
      ? null
      : await findCatalogMatch(brand, model);
    if (appraisalMatch) return await returnMatchedAppraisal(appraisalMatch, "identification");

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
      ...(imageHash ? { image_hash: imageHash } : {}),
      image_embedding: imageEmbedding,
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
