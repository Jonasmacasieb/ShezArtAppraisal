// ============================================
// OBJECT SCOUTER — FULL APPLICATION SCRIPT
// ============================================

// --- GLOBAL VARIABLES & STATE ---
let audioCtx = null;
let isAudioMuted = false;

const DB_NAME = 'ScouterObjectDB';
const DB_VERSION = 1;
const STORE_NAME = 'scans';
let db = null;
let cachedScansList = [];

let canvas, ctx, video;
let cameraStream = null;
let isVideoReady = false;
let isScanning = false;
let currentFacingMode = 'environment';

let lastFrameTime = 0;
const targetFPS = 30;
const frameInterval = 1000 / targetFPS;

const SCOUTER_CONFIG = {
    imageMaxWidth: 768,
    imageQuality: 0.75
};


// --- AUDIO SYNTHESIZER ---
function initAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

function playSynthSound(freq, type, duration, vol = 0.1) {
    if (isAudioMuted || !audioCtx) return;
    try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(vol, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
    } catch (e) { }
}

function playScanCompleteSound() {
    if (isAudioMuted || !audioCtx) return;
    playSynthSound(587.33, 'triangle', 0.15, 0.2);
    setTimeout(() => playSynthSound(880, 'triangle', 0.25, 0.25), 100);
}

function toggleAudioMute() {
    isAudioMuted = !isAudioMuted;
    const icon = document.getElementById('audioBtnIcon');
    if (isAudioMuted) {
        icon.className = 'fa-solid fa-volume-xmark text-red-400';
    } else {
        icon.className = 'fa-solid fa-volume-high text-cyan-300';
        initAudioContext();
        playSynthSound(800, 'sine', 0.1);
    }
}


// --- INDEXEDDB LOCAL STORAGE ---
function initDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const dbInstance = e.target.result;
            if (!dbInstance.objectStoreNames.contains(STORE_NAME)) {
                dbInstance.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = (e) => {
            db = e.target.result;
            loadSavedScansFromDB();
            resolve(db);
        };
        request.onerror = (e) => {
            console.error("IndexedDB error:", e);
            reject(e);
        };
    });
}

function saveScanToDB(record) {
    return new Promise((resolve, reject) => {
        if (!db) return resolve();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(record);
        tx.oncomplete = () => {
            loadSavedScansFromDB();
            resolve();
        };
        tx.onerror = (e) => reject(e);
    });
}

function getAllScansFromDB() {
    return new Promise((resolve, reject) => {
        if (!db) return resolve([]);
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = (e) => reject(e);
    });
}

function deleteScanFromDB(id) {
    return new Promise((resolve, reject) => {
        if (!db) return resolve();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(id);
        tx.oncomplete = () => {
            loadSavedScansFromDB();
            resolve();
        };
        tx.onerror = (e) => reject(e);
    });
}

function clearAllScans() {
    if (!confirm('Delete all saved scans from local database?')) return;
    if (!db) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => loadSavedScansFromDB();
}

async function loadSavedScansFromDB() {
    try {
        cachedScansList = await getAllScansFromDB();
        document.getElementById('inventoryBadgeCount').textContent = cachedScansList.length;
        renderInventoryList(cachedScansList);
    } catch (e) {
        console.error("Failed to load inventory:", e);
    }
}

function renderInventoryList(list) {
    const container = document.getElementById('inventoryList');
    container.innerHTML = '';

    if (list.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8 text-slate-500 font-mono-tech text-xs">
                NO SAVED SCANS FOUND IN INDEXEDDB.
            </div>`;
        return;
    }

    list.sort((a, b) => b.timestamp - a.timestamp).forEach(item => {
        const card = document.createElement('div');
        card.className = 'bg-slate-900/90 border border-slate-700/60 p-2.5 rounded-xl flex gap-3 items-center hover:border-amber-400/60 transition-all cursor-pointer';
        card.onclick = () => {
            displayAppraisalResult(item);
            toggleInventoryDrawer();
        };

        const dateStr = new Date(item.timestamp).toLocaleDateString();

        card.innerHTML = `
            <img src="${item.thumbnail || 'https://placehold.co/100x100/0f172a/06b6d4?text=SCAN'}" 
                 class="w-14 h-14 object-cover rounded-lg border border-cyan-500/30 flex-shrink-0"
                 alt="Scan thumbnail">
            <div class="flex-1 overflow-hidden">
                <div class="flex justify-between items-start">
                    <h4 class="font-orbitron font-bold text-xs text-white truncate">${item.objectName}</h4>
                    <span class="text-[9px] font-mono-tech text-amber-400 font-bold">${item.rarity}</span>
                </div>
                <p class="text-[10px] text-slate-400 truncate font-mono-tech">${item.category}</p>
                <span class="text-[9px] text-slate-500 font-mono-tech">${dateStr}</span>
            </div>
            <button onclick="event.stopPropagation(); deleteScanItem('${item.id}')" 
                    class="text-slate-500 hover:text-red-400 p-1.5 text-xs">
                <i class="fa-solid fa-trash"></i>
            </button>
        `;
        container.appendChild(card);
    });
}

function filterInventory() {
    const query = document.getElementById("inventorySearch").value.toLowerCase();
    const filtered = cachedScansList.filter(item => {
        const searchableText = [
            item.objectName,
            item.category,
            item.rarity,
            item.scanSummary,
            ...(Array.isArray(item.objects)
                ? item.objects.map(object =>
                    [object.objectName, object.brand, object.model, object.category].join(" ")
                )
                : [])
        ].join(" ").toLowerCase();
        return searchableText.includes(query);
    });
    renderInventoryList(filtered);
}

async function deleteScanItem(id) {
    await deleteScanFromDB(id);
}

function toggleInventoryDrawer() {
    const drawer = document.getElementById('inventoryDrawer');
    drawer.classList.toggle('translate-x-full');
}


// --- CAMERA & CANVAS RENDERING ---
function initCameraElements() {
    canvas = document.getElementById('appCanvas');
    ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    video = document.getElementById('webcam');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
    if (canvas) {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
}

async function startCamera() {
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
    }

    try {
        const constraints = {
            video: {
                facingMode: currentFacingMode,
                width: { ideal: 854, max: 1280 },
                height: { ideal: 480, max: 720 },
                frameRate: { ideal: 30 }
            },
            audio: false
        };
        cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = cameraStream;
        await video.play();
        isVideoReady = true;
        document.getElementById('camSourceBadge').textContent =
            currentFacingMode === 'user' ? 'FRONT CAM' : 'REAR CAM';
    } catch (err) {
        isVideoReady = false;
        document.getElementById('camSourceBadge').textContent = 'SIMULATION';
    }
}

function toggleCameraFacing() {
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    startCamera();
}

function renderLoop(timestamp) {
    requestAnimationFrame(renderLoop);

    const elapsed = timestamp - lastFrameTime;
    if (elapsed < frameInterval) return;
    lastFrameTime = timestamp - (elapsed % frameInterval);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (isVideoReady && video.readyState >= 2) {
        ctx.save();
        if (currentFacingMode === 'user') {
            ctx.translate(canvas.width, 0);
            ctx.scale(-1, 1);
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx.restore();
    } else {
        ctx.fillStyle = '#030712';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.15)';
        for (let x = 0; x < canvas.width; x += 60) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
        }
        for (let y = 0; y < canvas.height; y += 60) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
        }
    }

    drawFullscreenGridLines();
}

function drawFullscreenGridLines() {
    ctx.save();
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    ctx.strokeStyle = isScanning ? 'rgba(236, 72, 153, 0.6)' : 'rgba(6, 182, 212, 0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);

    ctx.beginPath();
    ctx.moveTo(cx - 40, cy); ctx.lineTo(cx + 40, cy);
    ctx.moveTo(cx, cy - 40); ctx.lineTo(cx, cy + 40);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.strokeStyle = isScanning ? '#ec4899' : '#06b6d4';
    ctx.beginPath();
    ctx.arc(cx, cy, 12, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
}


// --- GEMINI VISION AI APPRAISAL — HELPERS ---
function createReportField(label, value) {
    const wrapper = document.createElement("div");
    wrapper.className = "bg-slate-950/80 p-2 rounded border border-slate-700/70";

    const heading = document.createElement("span");
    heading.className = "text-cyan-400 text-[8px] font-bold uppercase block mb-1";
    heading.textContent = label;

    const content = document.createElement("p");
    content.className = "text-slate-200 text-[10px] leading-relaxed whitespace-pre-wrap";
    content.textContent = value || "Information unavailable.";

    wrapper.appendChild(heading);
    wrapper.appendChild(content);
    return wrapper;
}

function createObjectReportCard(item, index, thumbnail) {
    const card = document.createElement("div");
    card.className = "bofuri-card p-3 rounded-xl flex flex-col gap-2";

    const header = document.createElement("div");
    header.className = "flex items-center gap-3 border-b border-cyan-500/30 pb-2";

    const image = document.createElement("img");
    image.src = thumbnail || "https://placehold.co/100x100/0f172a/06b6d4?text=OBJECT";
    image.className = "w-14 h-14 rounded-lg object-cover border border-amber-400";
    image.alt = "Object preview";

    const titleArea = document.createElement("div");
    titleArea.className = "flex-1 min-w-0";

    const number = document.createElement("span");
    number.className = "text-[8px] text-cyan-400 font-mono-tech block";
    number.textContent = `DETECTED OBJECT #${index + 1}`;

    const name = document.createElement("h3");
    name.className = "text-amber-300 font-orbitron font-bold text-xs break-words";
    name.textContent = item.objectName || "Unknown Object";

    const category = document.createElement("p");
    category.className = "text-slate-400 text-[9px] font-mono-tech";
    category.textContent = item.category || "Unclassified";

    titleArea.append(number, name, category);
    header.append(image, titleArea);
    card.appendChild(header);

    const confidence = document.createElement("div");
    confidence.className = "text-[9px] text-emerald-400 font-mono-tech";
    confidence.textContent = "IDENTIFICATION CONFIDENCE: " +
        (item.identificationConfidence || "Unknown");
    card.appendChild(confidence);

    const fields = [
        ["BRAND", item.brand],
        ["MODEL", item.model],
        ["IDENTIFICATION NOTES", item.identificationNotes],
        ["DESCRIPTION", item.description],
        ["MATERIALS", item.materials],
        ["PURPOSE AND USES", item.purposeAndUses],
        ["KEY FEATURES", item.keyFeatures],
        ["SPECIFICATIONS", item.specifications],
        ["VISIBLE CONDITION", item.visibleCondition],
        ["AUTHENTICITY ASSESSMENT", item.authenticity],
        ["ESTIMATED MARKET VALUE", item.marketValue],
        ["ISSUES DETECTED", item.issuesDetected],
        ["RECOMMENDED SOLUTIONS", item.solutions]
    ];

    fields.forEach(([label, value]) => {
        card.appendChild(createReportField(label, value));
    });

    return card;
}

// --- GEMINI API APPRAISAL CORE ---
async function appraiseObjectWithGemini() {
    if (isScanning) return;

    if (!window.supabaseClient) {
        alert("Supabase is not configured. Check the Supabase client scripts and project settings.");
        return;
    }

    isScanning = true;
    const scanBtnText = document.getElementById("scanBtnText");
    const scanningLaser = document.getElementById("scanningLaser");
    scanningLaser.classList.remove("hidden");

    try {
        const hasCameraFrame = isVideoReady && video && video.readyState >= 2 && video.videoWidth > 0;
        const frameSource = hasCameraFrame ? video : canvas;
        const frameWidth = hasCameraFrame ? video.videoWidth : canvas?.width;
        const frameHeight = hasCameraFrame ? video.videoHeight : canvas?.height;
        if (!frameSource || !frameWidth || !frameHeight) {
            throw new Error("The camera preview is not ready yet.");
        }

        initAudioContext();
        scanBtnText.textContent = "ANALYZING...";
        document.getElementById("scouterStatusTextTop").textContent = "ANALYZING IMAGE...";

        // Use the live camera when available, otherwise scan the simulation canvas.
        const apiCanvas = document.createElement("canvas");
        const scale = Math.min(1, SCOUTER_CONFIG.imageMaxWidth / frameWidth);
        apiCanvas.width = Math.round(frameWidth * scale);
        apiCanvas.height = Math.round(frameHeight * scale);

        const apiCtx = apiCanvas.getContext('2d', { alpha: false });
        apiCtx.drawImage(frameSource, 0, 0, apiCanvas.width, apiCanvas.height);

        // Convert frame to base64 JPEG
        const base64Image = apiCanvas.toDataURL('image/jpeg', SCOUTER_CONFIG.imageQuality);
        const imageBase64 = base64Image.split(',')[1];

        const { data, error } = await window.supabaseClient.functions.invoke('appraisal-scan', {
            body: { imageBase64 }
        });
        if (error) {
            let message = error.message;
            if (error.context instanceof Response) {
                try {
                    const details = await error.context.clone().json();
                    if (typeof details.error === 'string') message = details.error;
                } catch (parseError) {
                    console.warn("Could not read appraisal service error details:", parseError);
                }
            }
            throw new Error(`Appraisal service failed: ${message}`);
        }
        if (!data?.scanRecord) {
            throw new Error("The appraisal service returned an invalid response.");
        }

        const scanRecord = {
            ...data.scanRecord,
            timestamp: data.scanRecord.timestamp || Date.now()
        };
        await saveScanToDB(scanRecord);

        playScanCompleteSound();
        displayAppraisalResult(scanRecord);

        document.getElementById("scouterStatusTextTop").textContent =
            data.matched ? "MATCH FOUND IN SHARED ARCHIVE" : "SCAN COMPLETE — SAVED TO SHARED ARCHIVE";

    } catch (error) {
        console.error("Appraisal failed:", error);
        document.getElementById("scouterStatusTextTop").textContent = "SCAN FAILED";
        alert(`Analysis failed: ${error.message}`);
    } finally {
        isScanning = false;
        scanningLaser.classList.add("hidden");
        document.getElementById("scanBtnText").textContent = "START SCAN";
    }
}


// --- DISPLAY RESULTS ---
function displayAppraisalResult(scanRecord) {
    const objects = Array.isArray(scanRecord.objects) ? scanRecord.objects : [];
    const panel = document.getElementById('appraisalCard');
    const container = document.getElementById('appraisalObjectsList');

    document.getElementById('scanSummary').textContent =
        scanRecord.scanSummary || 'No summary available.';
    document.getElementById('detectedObjectCount').textContent =
        `${objects.length} OBJECT${objects.length === 1 ? '' : 'S'}`;
    document.getElementById('itemRarity').textContent =
        scanRecord.rarity || 'UNRATED';
    container.replaceChildren();

    if (objects.length === 0) {
        const message = document.createElement('p');
        message.className = 'text-slate-400 text-xs italic';
        message.textContent = 'No objects were identified in this scan.';
        container.appendChild(message);
    } else {
        objects.forEach((item, idx) => {
            container.appendChild(createObjectReportCard(item, idx, scanRecord.thumbnail));
        });
    }

    panel.classList.remove('hidden');
}

function closeAppraisalCard() {
    document.getElementById('appraisalCard').classList.add('hidden');
}


// --- API KEY MANAGEMENT ---
function toggleSettingsMenu() {
    document.getElementById('settingsDrawer').classList.toggle('hidden');
}

// --- INITIALIZATION & EVENT BINDING ---
document.addEventListener('DOMContentLoaded', async () => {
    initCameraElements();
    requestAnimationFrame(renderLoop);

    try {
        await initDatabase();
    } catch (e) {
        console.warn("IndexedDB unavailable — scans won't persist:", e);
    }

    sessionStorage.removeItem('GEMINI_CUSTOM_API_KEY');

    // Try starting camera
    await startCamera();

    // Initialize audio on first interaction
    document.body.addEventListener('click', () => {
        if (!audioCtx) initAudioContext();
    }, { once: true });
});
