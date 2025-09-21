const videoEl = document.getElementById('inputVideo');
const canvasEl = document.getElementById('outputCanvas');
const ctx = canvasEl.getContext('2d', { willReadFrequently: false });
const startBtn = document.getElementById('startBtn');
const qualitySel = document.getElementById('quality');
const modelSel = document.getElementById('modelSel');

let camera, selfieSeg;

function getConstraints() {
  const q = qualitySel.value;
  if (q === 'qvga') return { width: { ideal: 320 }, height: { ideal: 240 } };
  if (q === 'hd')   return { width: { ideal: 1280 }, height: { ideal: 720 } };
  return { width: { ideal: 640 }, height: { ideal: 480 } }; // vga
}

async function start() {
  startBtn.disabled = true;

  // set up MediaPipe SelfieSegmentation
  selfieSeg = new SelfieSegmentation({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
  });
  selfieSeg.setOptions({
    modelSelection: parseInt(modelSel.value, 10), // 0=fast, 1=accurate
    selfieMode: true,
    effect: 'mask' // not required, we manually composite anyway
  });

  selfieSeg.onResults(onResults);

  // set up camera feed
  const constraints = {
    audio: false,
    video: {
      facingMode: 'user', // front camera
      ...getConstraints()
    }
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEl.srcObject = stream;

  await videoEl.play();

  // sync canvas size to video
  canvasEl.width = videoEl.videoWidth;
  canvasEl.height = videoEl.videoHeight;

  // optional: use MediaPipe's camera helper for a clean render loop
  camera = new Camera(videoEl, {
    onFrame: async () => {
      await selfieSeg.send({ image: videoEl });
    }
  });
  camera.start();
}

function onResults(results) {
  // results.image = original frame
  // results.segmentationMask = an HTMLCanvasElement with alpha=person
  const { image, segmentationMask } = results;

  // draw the segmentation mask onto output; keep only the person
  ctx.save();
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  // 1) draw the mask
  ctx.drawImage(segmentationMask, 0, 0, canvasEl.width, canvasEl.height);

  // 2) keep only pixels where mask is present
  ctx.globalCompositeOperation = 'source-in';

  // 3) draw the original image through the mask → person only
  ctx.drawImage(image, 0, 0, canvasEl.width, canvasEl.height);

  // (optional) if you want to put a background, uncomment:
  // ctx.globalCompositeOperation = 'destination-over';
  // ctx.fillStyle = '#20232a'; // or draw another image here
  // ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

  ctx.restore();
}

startBtn.addEventListener('click', start);
modelSel.addEventListener('change', () => {
  if (selfieSeg) selfieSeg.setOptions({ modelSelection: parseInt(modelSel.value, 10) });
});
