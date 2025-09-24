# selfie segmentation demo

browser demo that cuts a person out from the background using mediapipe’s selfie segmentation. first step toward my personal project **holocall** — holographic presence during video calls.

---

## why this matters

face tracking gets attention, but segmentation is what makes true presence possible.  
with a clean mask, you can drop the subject into any background:  
- conferencing overlays  
- ar filters  
- creative or branded settings
- real backgrounds

this repo shows how little code it takes to get there.

---

## quick start

```bash
git clone https://github.com/emmanuel-paulmaah/selfie-segmentation-demo.git
cd selfie-segmentation-demo
python -m http.server 5173
# open http://localhost:5173 in your browser
````

or skip straight to the [live demo](https://emmanuel-paulmaah.github.io/selfie-segmentation-demo/).

---

## how it works

1. capture webcam with `getUserMedia`
2. feed frames into mediapipe’s selfie segmentation
3. get a segmentation mask back
4. composite mask + original video in a canvas
5. render in real time

---

## repo structure

```
selfie-segmentation-demo/
├── index.html
├── script.js
├── styles.css
└── readme.md
```

---

## core snippet

```js
const mask = result.segmentationMask
ctx.drawImage(mask, 0, 0)
ctx.globalCompositeOperation = 'source-in'
ctx.drawImage(video, 0, 0)
ctx.globalCompositeOperation = 'source-over'
```

---

## next steps

* integrate this into holocall so the subject can be placed in any environment in real time
* use ai to make cut-out cleaner
* re-render 2d video cut-out
