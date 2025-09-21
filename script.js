/**
 * Best-effort, realistic body cut-out (MediaPipe Selfie Segmentation)
 * Drop this in as script.js alongside the HTML that loads:
 *  - https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js
 *  - https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js
 *
 * Goals:
 *  - Clean silhouette with minimal “edge shimmer”
 *  - Looks natural: soft feather, tiny dilation, temporal smoothing
 *  - Fast: zero per-pixel JS loops; all canvas ops stay on GPU fast path
 *
 * UI hooks expected in your HTML:
 *  - <video id="inputVideo" playsinline muted></video>
 *  - <canvas id="outputCanvas"></canvas>
 *  - <button id="startBtn">start</button>   (optional but recommended)
 *  - (optional) <select id="quality">qvga|vga|hd</select>
 *  - (optional) <select id="modelSel">0|1</select>   // 0=fast, 1=accurate
 */

/////////////////////// DOM ///////////////////////
const videoEl   = document.getElementById('inputVideo');
const canvasOut = document.getElementById('outputCanvas');
const startBtn  = document.getElementById('startBtn') || { addEventListener: () => {} };
const qualityEl = document.getElementById('quality');
const modelEl   = document.getElementById('modelSel');

/////////////////////// Tunables (safe, realistic defaults) ///////////////////////
const TUNING = {
  // Mask edge quality
  featherPx: 1.0,          // softens the cut edge; 0.6–1.5px is a sweet spot
  dilatePx: 0.6,           // expands mask outward ~1px total after blur (prevents background slivers)
  // Temporal smoothing (reduces “edge shimmer” without obvious lag)
  emaAlpha: 0.35,          // 0..1; weight of NEW mask per frame (0.25–0.45 good)
  // “Safety margin”: draw RGB a hair smaller so the mask overhang hides jitters
  rgbScale: 0.992,         // 0.985–0.996; higher = less shrink
  // Resolution & performance
  depthFpsDivider: 1,      // run model every frame (set 2 or 3 to skip frames if you need perf)
  // Camera selection
  facingMode: 'user'       // 'user' (front) or 'environment' (rear)
};

/////////////////////// State & Canvases ///////////////////////
let selfieSeg, camera;
let frameCount = 0;

// Offscreen (or fallback) canvases for mask processing
const W = () => canvasOut.width;
const H = () => canvasOut.height;

const makeCanvas = (w=1, h=1) => {
  const c = ('OffscreenCanvas' in window) ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  c.width = w; c.height = h; return c;
};

// Raw mask from MediaPipe (alpha = person)
let maskRaw = makeCanvas(2, 2);
// Smoothed + feathered + dilated mask we’ll actually use
let maskNice = makeCanvas(2, 2);
// Scratch during processing
let maskScratch = makeCanvas(2, 2);

/** Resize all offscreens to match output */
function resizeBuffers(w, h) {
  [maskRaw, maskNice, maskScratch].forEach(c => { c.width = w; c.height = h; });
}

/////////////////////// Helpers ///////////////////////
function getQualityConstraints() {
  const choice = qualityEl?.value || 'vga';
  if (choice === 'qvga') return { width: { ideal: 320 },  height: { ideal: 240 }  };
  if (choice === 'hd')   return { width: { ideal: 1280 }, height: { ideal: 720 }  };
  return { width: { ideal: 640 }, height: { ideal: 480 } }; // vga
}

/** EMA blend current mask into maskNice (approximate linear blend using canvas) */
function temporalSmoothMask() {
  const w = W(), h = H();
  const ctxNice = maskNice.getContext('2d');
  const ctxRaw  = maskRaw.getContext('2d');

  // Draw previous nice mask into scratch (to preserve original while blending)
  const ctxScratch = maskScratch.getContext('2d');
  ctxScratch.globalCompositeOperation = 'copy';
  ctxScratch.drawImage(maskNice, 0, 0, w, h);

  // Start new nice mask as blank
  ctxNice.clearRect(0, 0, w, h);

  // Blend prev (1 - emaAlpha)
  ctxNice.globalAlpha = (1.0 - TUNING.emaAlpha);
  ctxNice.globalCompositeOperation = 'source-over';
  ctxNice.drawImage(maskScratch, 0, 0, w, h);

  // Blend new raw (emaAlpha)
  ctxNice.globalAlpha = TUNING.emaAlpha;
  ctxNice.drawImage(maskRaw, 0, 0, w, h);

  // Reset state
  ctxNice.globalAlpha = 1.0;
}

/** Feather & slight dilate mask edges to hide pixel crawl without “sticker” look */
function featherAndDilateMask() {
  const w = W(), h = H();
  const ctxNice = maskNice.getContext('2d');

  // Slight dilation via blur on alpha
  if (TUNING.dilatePx > 0 || TUNING.featherPx > 0) {
    const totalBlur = Math.max(0, TUNING.dilatePx + TUNING.featherPx);
    ctxNice.filter = `blur(${totalBlur}px)`;
    // Draw onto itself to blur alpha (works in OffscreenCanvas and 2D canvas)
    ctxNice.globalCompositeOperation = 'source-over';
    ctxNice.drawImage(maskNice, 0, 0, w, h);
    ctxNice.filter = 'none';
  }
}

/** Composite: use maskNice as alpha matte, draw RGB slightly scaled under it */
function compositePersonOnly(results) {
  const w = W(), h = H();
  const ctxOut = canvasOut.getContext('2d', { willReadFrequently: false });
  const img = results.image;

  ctxOut.save();
  ctxOut.clearRect(0, 0, w, h);

  // 1) Draw mask (alpha)
  ctxOut.globalCompositeOperation = 'source-over';
  ctxOut.drawImage(maskNice, 0, 0, w, h);

  // Optional: tiny extra feather on the final matte to avoid harsh edges
  if (TUNING.featherPx > 0.2) {
    ctxOut.filter = `blur(${Math.max(0, TUNING.featherPx * 0.6)}px)`;
    ctxOut.drawImage(canvasOut, 0, 0); // blur what we just drew (the mask)
    ctxOut.filter = 'none';
  }

  // 2) Keep only masked pixels going forward
  ctxOut.globalCompositeOperation = 'source-in';

  // 3) Draw RGB slightly smaller so mask overhang hides any 1–2px jitter
  const s = Math.min(1, Math.max(0.975, TUNING.rgbScale));
  const w2 = w * s, h2 = h * s;
  const x  = (w - w2) / 2;
  const y  = (h - h2) / 2;

  ctxOut.drawImage(img, x, y, w2, h2);

  ctxOut.restore();
}

/////////////////////// MediaPipe setup ///////////////////////
async function initSegmentation() {
  selfieSeg = new SelfieSegmentation({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
  });

  const modelSelection = parseInt(modelEl?.value || '1', 10); // default to accurate
  selfieSeg.setOptions({
    modelSelection,
    selfieMode: (TUNING.facingMode === 'user'),
    // effect: 'mask' // not needed; we do our own compositing
  });

  selfieSeg.onResults(onResults);
}

/////////////////////// Camera & Main ///////////////////////
async function start() {
  startBtn.disabled = true;

  await initSegmentation();

  // Get camera
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: TUNING.facingMode,
      ...getQualityConstraints()
    }
  });

  videoEl.srcObject = stream;
  await videoEl.play();

  // Sync canvas sizes
  canvasOut.width  = videoEl.videoWidth;
  canvasOut.height = videoEl.videoHeight;
  resizeBuffers(canvasOut.width, canvasOut.height);

  // Kick off MediaPipe processing using its camera helper
  camera = new Camera(videoEl, {
    onFrame: async () => {
      frameCount++;
      // Optional frame skipping for perf
      if (TUNING.depthFpsDivider > 1 && (frameCount % TUNING.depthFpsDivider !== 0)) {
        // Reuse previous mask for temporal stability
        compositePersonOnly({ image: videoEl });
        return;
      }
      await selfieSeg.send({ image: videoEl });
    }
  });

  camera.start();
}

/////////////////////// Results handler ///////////////////////
function onResults(results) {
  const w = canvasOut.width, h = canvasOut.height;

  // 1) Copy raw segmentation mask to maskRaw (full size)
  const ctxRaw = maskRaw.getContext('2d');
  ctxRaw.globalCompositeOperation = 'copy';
  ctxRaw.drawImage(results.segmentationMask, 0, 0, w, h);

  // 2) Temporal smoothing: raw → nice (EMA)
  temporalSmoothMask();

  // 3) Edge polish: feather + slight dilation on nice mask
  featherAndDilateMask();

  // 4) Final composite into output canvas
  compositePersonOnly(results);
}

/////////////////////// Wire up ///////////////////////
startBtn.addEventListener('click', start);

// Live updates if user flips model selection (no restart needed)
modelEl?.addEventListener('change', () => {
  const modelSelection = parseInt(modelEl.value || '1', 10);
  if (selfieSeg) selfieSeg.setOptions({ modelSelection });
});

// If you want auto-start without a button, uncomment the next line:
// start().catch(console.error);

/**
 * Notes:
 * - This keeps everything on the GPU path (drawImage + canvas filters).
 * - No getImageData() loops = far better FPS on mobile.
 * - If you need even steadier edges, increase dilatePx to ~1.2 and set rgbScale to 0.99.
 * - If perf dips, set depthFpsDivider = 2 (run model every other frame).
 * - To place this in AR later, use this output canvas as a texture on a quad/mesh.
 */
