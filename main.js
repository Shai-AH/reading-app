import { FaceLandmarker, FilesetResolver, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

let faceLandmarker;

// --- Phase 2: mouth-open/closed detection + speech wiring ---

// Landmark indices from MediaPipe's face mesh topology (468/478-point model):
// 13 = upper inner lip center, 14 = lower inner lip center,
// 61 = left mouth corner, 291 = right mouth corner.
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const LEFT_CORNER = 61;
const RIGHT_CORNER = 291;

// Hysteresis thresholds — tuned from real calibration data (July 6, 2026, round 2):
//   closed range          ≈ 0.022 - 0.037
//   mutter range (target) ≈ 0.060 - 0.200
//   wide open / yawn      ≈ 0.800 - 1.180
const OPEN_THRESHOLD = 0.05;   // MAR must rise above this to count as "open"
const CLOSE_THRESHOLD = 0.04;  // MAR must fall below this to count as "closed"

let mouthState = 'closed'; // 'open' | 'closed'

// --- Phase 3: longer pre-loaded text, word-by-word highlighting ---
const READING_TEXT = "This is a longer piece of test text for phase three. Instead of a single " +
  "short sentence, we now advance word by word while you read, using the same mouth movement " +
  "signal from phase two. As each word is spoken it should highlight on screen, and if you turn " +
  "your head away from the camera the reading should pause automatically, even if your mouth is " +
  "still moving.";

let readingActive = false;      // true from Start Reading click until the whole text finishes
let isSpeakingChunk = false;    // true while a (possibly multi-word) utterance is actively speaking
let manualCancel = false;       // true right before we intentionally cancel() due to mouth closing
let currentUtterance = null;
let baseOffset = 0;             // char offset into READING_TEXT where currentUtterance's text starts
let lastBoundaryOffset = 0;     // charIndex within currentUtterance of the most recent word boundary
let wordSpans = [];             // { span, start, end } built from READING_TEXT
let activeWordIndex = -1;

const marValueEl = document.getElementById('marValue');
const mouthStateEl = document.getElementById('mouthState');
const speechStateEl = document.getElementById('speechState');
const startBtn = document.getElementById('startBtn');
const readingTextEl = document.getElementById('readingText');

// --- Phase 3: head-pose (yaw/pitch) gating ---
// PLACEHOLDER thresholds (degrees) — not yet calibrated against a real face/camera,
// unlike the MAR thresholds. Watch the debug readout while deliberately turning your
// head and adjust these two numbers the same way OPEN/CLOSE_THRESHOLD were tuned.
const YAW_THRESHOLD = 25;
const PITCH_THRESHOLD = 20;

let isFacingScreen = true;

const yawValueEl = document.getElementById('yawValue');
const pitchValueEl = document.getElementById('pitchValue');
const facingStateEl = document.getElementById('facingState');

function buildWordSpans(text) {
  readingTextEl.innerHTML = '';
  const spans = [];
  const regex = /\S+/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const span = document.createElement('span');
    span.textContent = match[0];
    span.className = 'word';
    readingTextEl.appendChild(span);
    readingTextEl.appendChild(document.createTextNode(' '));
    const wordIndex = spans.length;
    span.addEventListener('click', () => onWordClick(wordIndex));
    spans.push({ span, start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

// --- Phase 4: click-to-word manual resync (State 3) ---
// Lets the reader jump the reading position directly to any word by clicking it,
// independent of the mouth-driven pacing signal. Reuses the exact same cancel()
// path as onMouthClosed (never pause()/resume() — see Phase 3 decision) and the
// same baseOffset/lastBoundaryOffset bookkeeping onMouthOpen already relies on,
// so a click is really just "manually set the resume point, then behave as if
// mouth-open logic ran."
function onWordClick(wordIndex) {
  console.log('[TIMING] word clicked at', performance.now().toFixed(0)); // TEMP DIAGNOSTIC
  if (wordSpans.length === 0) return; // clicked before any reading session started
  const word = wordSpans[wordIndex];

  if (isSpeakingChunk) {
    manualCancel = true;
    speechSynthesis.cancel();
    isSpeakingChunk = false;
  }

  baseOffset = word.start;
  lastBoundaryOffset = 0;
  readingActive = true; // allow resync to also restart a finished reading
  highlightWordAt(baseOffset);
  speechStateEl.textContent = 'waiting for mouth to open';

  // If the mouth is already open and facing the screen at click time, don't
  // make the reader close-then-reopen their mouth just to kick things off.
  if (mouthState === 'open' && isFacingScreen) {
    speakFrom(baseOffset);
  }
}

function highlightWordAt(charIndex) {
  const idx = wordSpans.findIndex(w => charIndex >= w.start && charIndex < w.end);
  if (idx === -1 || idx === activeWordIndex) return;

  if (activeWordIndex !== -1) {
    wordSpans[activeWordIndex].span.classList.remove('active');
  }
  wordSpans[idx].span.classList.add('active');
  activeWordIndex = idx;
}

// Extract yaw/pitch (in degrees) from MediaPipe's facialTransformationMatrix.
// The matrix is a flat 16-value column-major 4x4 transform. Column index 2
// (data[8], data[9], data[10]) is the face's local Z axis expressed in camera
// space — i.e. the direction the face is pointing. We turn that forward vector
// into two simple angles rather than doing a full Euler decomposition, since we
// only care about "how far off is the face from pointing at the camera."
function getYawPitch(matrixData) {
  const fx = matrixData[8];
  const fy = matrixData[9];
  const fz = matrixData[10];

  const yawRad = Math.atan2(fx, fz);
  const pitchRad = Math.atan2(-fy, Math.sqrt(fx * fx + fz * fz));

  return {
    yaw: yawRad * (180 / Math.PI),
    pitch: pitchRad * (180 / Math.PI)
  };
}

function updateHeadPose(matrixData) {
  const { yaw, pitch } = getYawPitch(matrixData);
  yawValueEl.textContent = yaw.toFixed(1);
  pitchValueEl.textContent = pitch.toFixed(1);

  const facing = Math.abs(yaw) < YAW_THRESHOLD && Math.abs(pitch) < PITCH_THRESHOLD;
  if (facing === isFacingScreen) return; // no state change, nothing else to do

  isFacingScreen = facing;
  facingStateEl.textContent = isFacingScreen ? 'facing screen' : 'looking away';
  // No pause()/resume() here anymore — gating is enforced entirely in onMouthOpen
  // by simply refusing to start the next word while facing away. Whatever word
  // is already mid-utterance just finishes naturally.
}

function getMAR(landmarks) {
  const upper = landmarks[UPPER_LIP];
  const lower = landmarks[LOWER_LIP];
  const left = landmarks[LEFT_CORNER];
  const right = landmarks[RIGHT_CORNER];

  const verticalGap = Math.hypot(upper.x - lower.x, upper.y - lower.y);
  const mouthWidth = Math.hypot(left.x - right.x, left.y - right.y);

  if (mouthWidth === 0) return 0; // avoid divide-by-zero on a bad frame
  return verticalGap / mouthWidth;
}

function updateMouthState(mar) {
  if (mouthState === 'closed' && mar > OPEN_THRESHOLD) {
    mouthState = 'open';
    onMouthOpen();
  } else if (mouthState === 'open' && mar < CLOSE_THRESHOLD) {
    mouthState = 'closed';
    onMouthClosed();
  }
  mouthStateEl.textContent = mouthState;
}

function onMouthOpen() {
  if (!isFacingScreen) return; // gated: don't resume while looking away
  if (!readingActive) return; // no active reading session
  if (isSpeakingChunk) return; // already flowing, nothing to do

  const resumeOffset = baseOffset + lastBoundaryOffset;
  speakFrom(resumeOffset);
}

function onMouthClosed() {
  if (!isSpeakingChunk) return;

  // Stop the current utterance with cancel() rather than pause() — cancel()
  // fully resets speechSynthesis's internal state instead of parking it in a
  // paused limbo, which is the specific state that was wedging Edge's speech
  // engine after repeated use. We remember exactly where we got to (the last
  // completed word boundary) so the next mouth-open can pick up from there.
  manualCancel = true;
  speechSynthesis.cancel();
  isSpeakingChunk = false;
  speechStateEl.textContent = 'waiting for mouth to open';
}

function speakFrom(offset) {
  if (offset >= READING_TEXT.length) {
    finishReading();
    return;
  }

  baseOffset = offset;
  lastBoundaryOffset = 0;

  currentUtterance = new SpeechSynthesisUtterance(READING_TEXT.slice(offset));

  // --- TEMP DIAGNOSTIC (Phase 5 lag investigation, remove once resolved) ---
  const speakCallTime = performance.now();
  currentUtterance.onstart = () => {
    console.log('[TIMING] speak() -> onstart gap:', (performance.now() - speakCallTime).toFixed(0), 'ms');
  };
  console.log('[TIMING] speak() called, speechSynthesis.speaking =', speechSynthesis.speaking, 'pending =', speechSynthesis.pending);
  // TEMP DIAGNOSTIC: check if default voice is local (instant) or network-dependent (adds latency)
  const voices = speechSynthesis.getVoices();
  console.log('[TIMING] voices:', voices.map(v => `${v.name} | localService=${v.localService} | default=${v.default}`));
  // --- END TEMP DIAGNOSTIC ---

  currentUtterance.onboundary = (event) => {
    if (event.name !== 'word') return;
    lastBoundaryOffset = event.charIndex;
    highlightWordAt(baseOffset + event.charIndex);
  };

  currentUtterance.onend = () => {
    isSpeakingChunk = false;
    if (manualCancel) {
      // This 'end' event fired because WE called cancel() (closing the mouth),
      // not because the text actually finished. Chromium fires 'end' either way.
      manualCancel = false;
      return;
    }
    finishReading();
  };

  isSpeakingChunk = true;
  speechSynthesis.speak(currentUtterance);
  speechStateEl.textContent = 'speaking';
}

function finishReading() {
  readingActive = false;
  isSpeakingChunk = false;
  speechStateEl.textContent = 'finished';
  if (activeWordIndex !== -1) {
    wordSpans[activeWordIndex].span.classList.remove('active');
  }
  activeWordIndex = -1;
}

startBtn.addEventListener('click', () => {
  // Hard reset on every click, rather than trusting readingActive/isSpeakingChunk
  // to be accurate. speechSynthesis state has proven flaky enough this session
  // that relying on our own flags alone was leaving the button stuck unusable
  // after a full read-through. cancel() is safe to call even if nothing is
  // currently speaking.
  manualCancel = true;
  speechSynthesis.cancel();
  isSpeakingChunk = false;
  readingActive = false;

  wordSpans = buildWordSpans(READING_TEXT);
  activeWordIndex = -1;
  baseOffset = 0;
  lastBoundaryOffset = 0;
  readingActive = true;
  speechStateEl.textContent = 'waiting for mouth to open';

  // If the mouth is already open right when the button is clicked, start
  // speaking immediately from the beginning. Otherwise wait for mouth-open.
  if (mouthState === 'open' && isFacingScreen) {
    speakFrom(0);
  }
});

async function setup() {
  // Load the MediaPipe model files (runs locally after this download)
  const filesetResolver = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFacialTransformationMatrixes: true
  });

  startWebcam();
}

async function startWebcam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });
    video.srcObject = stream;
    video.addEventListener('loadeddata', predictLoop);
  } catch (err) {
    console.error('Webcam error:', err);
    alert('Could not access webcam: ' + err.message);
  }
}

function predictLoop() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const results = faceLandmarker.detectForVideo(video, performance.now());

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (results.faceLandmarks && results.faceLandmarks.length > 0) {
    const drawingUtils = new DrawingUtils(ctx);
    for (const landmarks of results.faceLandmarks) {
      drawingUtils.drawConnectors(
        landmarks,
        FaceLandmarker.FACE_LANDMARKS_TESSELATION,
        { color: "#00FF0033", lineWidth: 1 }
      );
      drawingUtils.drawConnectors(
        landmarks,
        FaceLandmarker.FACE_LANDMARKS_LIPS,
        { color: "#FF0000", lineWidth: 2 }
      );
    }

    // Use the first (only) detected face for mouth-state tracking
    const mar = getMAR(results.faceLandmarks[0]);
    marValueEl.textContent = mar.toFixed(3);
    updateMouthState(mar);
  }

  // Phase 3: head-pose gating, independent of whether lip landmarks were found
  // above (facialTransformationMatrixes comes from the same detection pass).
  if (results.facialTransformationMatrixes && results.facialTransformationMatrixes.length > 0) {
    updateHeadPose(results.facialTransformationMatrixes[0].data);
  }

  requestAnimationFrame(predictLoop);
}

setup();