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
// Phase 7b: these were consts until now. Calibration mode can override them
// per-device via applyCalibration(); DEFAULT_* below are the fallback values
// (student's original hand-tuned numbers) used whenever no saved calibration
// exists yet, so an uncalibrated first run behaves exactly as before.
const DEFAULT_OPEN_THRESHOLD = 0.05;
const DEFAULT_CLOSE_THRESHOLD = 0.04;
let OPEN_THRESHOLD = DEFAULT_OPEN_THRESHOLD;   // MAR must rise above this to count as "open"
let CLOSE_THRESHOLD = DEFAULT_CLOSE_THRESHOLD; // MAR must fall below this to count as "closed"

let mouthState = 'closed'; // 'open' | 'closed'

// --- Phase 6 (Option A): windowed movement-range smoothing ---
// Instead of treating a single MAR dip below CLOSE_THRESHOLD as a hard stop,
// we keep a rolling buffer of recent MAR samples and only fire cancel() when
// there's been no meaningful oscillation across the whole window. This lets a
// natural punctuation micro-slowdown (mouth still moving, just less) pass
// through without triggering a stop, while a genuine mouth-close (flat MAR)
// still stops promptly. This buffer is also the foundation Option B's
// predictive cadence-matching will build on later.
const WINDOW_MS = 300; // was 600 — halved to reduce how long stale open-mouth
// samples from the last spoken word linger in the trailing window after an
// actual mouth-close (this lag, not the threshold, was the cause of speech
// continuing several words past a real close).
const STOPPED_RANGE_THRESHOLD = 0.03; // was 0.074 — true steady-state closed
// noise floor measured at only ~0.006 (raw MAR 0.014-0.020 at rest), far
// below the punctuation-dip floor (~0.08), so we have room to sit low and
// still avoid false stops on punctuation.

let marBuffer = []; // { timestamp, mar }

// --- Phase 6 (Option B): cadence-based pacing ---
// Estimates how long (ms) the CURRENT word should take to mouth, based on a
// syllable-count estimate. Used to adjust how eagerly a mouth-close is
// accepted as "done with this word" vs. "probably still mid-word": short
// (few-syllable) words like "a" or "is" finish fast and shouldn't need the
// full Option A smoothing window to confirm a stop; multi-syllable words
// naturally take more open-mouth time, so an early-looking close is more
// likely just a mid-word dip and should be held to a stricter (flatter)
// movement-range bar before we believe it.
//
// Syllable-count based (not character-count) — chosen because it tracks
// natural speech rhythm much better (e.g. "through" is 7 characters but 1
// syllable; "kiwi" is 4 characters but 2 syllables). Estimated via simple
// vowel-cluster counting rather than a real phonetic dictionary/library,
// consistent with the project's $0/no-dependencies constraint. Starting
// simple (raw vowel-cluster count, no silent-e or y-adjacency refinements)
// per the project's usual pattern: ship the simplest version, then refine
// based on live-tuning mismatches rather than guessing corrections upfront.
// MS_PER_SYLLABLE and BASE_WORD_MS are unvalidated starting guesses and
// WILL need live tuning, same as every other threshold in this project.
const MS_PER_SYLLABLE = 220;
const BASE_WORD_MS = 120; // floor so even a 1-syllable word gets a sane estimate

// How much the Option A range threshold gets tightened/relaxed based on
// whether we're under or over the current word's expected duration.
// Under expected duration → likely mid-word → demand a flatter (stricter)
// window before accepting a close. Over expected duration → the word has
// had its expected time already → relax the bar so we don't lag on words
// that are naturally quick to close after.
const CADENCE_UNDER_FACTOR = 0.6; // stricter: threshold * 0.6
const CADENCE_OVER_FACTOR = 1.5;  // looser: threshold * 1.5

let mouthOpenStartTime = 0;    // performance.now() when the current open phase began
let currentWordExpectedMs = 0; // estimated duration for the word active when mouth opened

const cadenceValueEl = document.getElementById('cadenceValue');

// Rough syllable estimate via vowel-cluster counting: each run of consecutive
// vowel characters (a, e, i, o, u, y) counts as one syllable candidate, with
// two refinements found via testing against the real READING_TEXT (not just
// isolated words):
//   1. Punctuation stripping — word spans include attached punctuation
//      (buildWordSpans uses \S+), so "sentence," was failing the trailing-'e'
//      check below simply because it ends in ',' not 'e'. Strip anything
//      that isn't a-z before doing any of this.
//   2. Consonant+'le' exception — a trailing silent-e gets subtracted (see
//      below), but words ending in "consonant + le" (table, little, single)
//      are a different pattern: that 'e' is NOT silent, it's part of a real
//      spoken syllable. Detected via a simple suffix check; skip the
//      subtraction when it matches.
// Known remaining gap, deliberately not handled: mid-word silent-e patterns
// (e.g. "movement" overcounts as 3 instead of 2, since the silent e in
// "move" isn't at the end of the whole word) — a fundamentally different,
// harder problem than end-of-word silent-e, and not worth chasing with this
// heuristic. Revisit only if it turns out to matter in practice.
// Floor of 1 so every real word gets at least one syllable's worth of
// expected duration, even after the silent-e subtraction.
function estimateSyllables(word) {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, '');
  const matches = cleaned.match(/[aeiouy]+/g);
  let syllables = matches ? matches.length : 0;
  const endsInConsonantLe = /[^aeiouy]le$/.test(cleaned);
  if (cleaned.endsWith('e') && !endsInConsonantLe && syllables > 1) {
    syllables -= 1;
  }
  return Math.max(1, syllables);
}

function estimateWordDuration(word) {
  return BASE_WORD_MS + estimateSyllables(word) * MS_PER_SYLLABLE;
}

// Picks the word this cadence estimate should be based on: the currently
// highlighted word if one is active, otherwise the word at the pending
// resume offset (covers the moment right after Start Reading / a click,
// before the first onboundary event has landed).
function getWordForCadence() {
  if (activeWordIndex !== -1) return wordSpans[activeWordIndex].span.textContent;
  const idx = wordSpans.findIndex(w => (baseOffset + lastBoundaryOffset) >= w.start && (baseOffset + lastBoundaryOffset) < w.end);
  return idx !== -1 ? wordSpans[idx].span.textContent : '';
}

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
const movementRangeValueEl = document.getElementById('movementRangeValue');
const mouthStateEl = document.getElementById('mouthState');
const speechStateEl = document.getElementById('speechState');
const startBtn = document.getElementById('startBtn');
const readingTextEl = document.getElementById('readingText');

// --- Phase 3/7: head-pose (yaw/pitch) gating ---
// Live-calibrated (Phase 7, Entry 11) against student's real face/camera, same
// process as the MAR thresholds: watched the live debug readout while
// deliberately turning/tilting the head to find the "facing" -> "looking away"
// boundary, rather than guessing.
//   Normal reading wobble: yaw -1.1 to -0.8, pitch +3.8 to +5.5 (pitch isn't
//     centered on 0 — natural head angle while reading looks slightly down).
//   Measured yaw boundary: 25.8-26.4, symmetric left/right.
//   Measured pitch boundary: -20.8 to -21.7, symmetric up/down.
// Thresholds set just above each measured boundary, same margin approach used
// for STOPPED_RANGE_THRESHOLD.
const DEFAULT_YAW_THRESHOLD = 26;
const DEFAULT_PITCH_THRESHOLD = 21;
let YAW_THRESHOLD = DEFAULT_YAW_THRESHOLD;
let PITCH_THRESHOLD = DEFAULT_PITCH_THRESHOLD;

let isFacingScreen = true;

const yawValueEl = document.getElementById('yawValue');
const pitchValueEl = document.getElementById('pitchValue');
const facingStateEl = document.getElementById('facingState');

// --- Phase 7b: guided in-app calibration mode ---
// Reproduces, without Claude/chat in the loop, the same process used by hand
// for every threshold in this file so far: watch a live number while doing a
// specific action, then derive a threshold from it. Scoped to MAR (open/
// close) and head-pose (yaw/pitch) only — STOPPED_RANGE_THRESHOLD and the
// cadence constants were tuned from live *reading* behavior over several
// sessions (Entries 9-10), not a single static pose, so they're out of scope
// here and stay as fixed constants for now.
const CALIBRATION_STORAGE_KEY = 'readingAppCalibration';

// Minimum required MAR gap between the neutral and mouthing-speech steps,
// and a minimum degrees-turned floor for head-pose thresholds. Both exist to
// reject a bad calibration run (e.g. user didn't actually mouth words, or
// didn't turn their head) rather than silently saving broken thresholds.
// MIN_MAR_GAP set well below the real neutral-vs-mutter gap this project has
// actually measured (~0.023, see Phase 6a calibration notes) so a genuine
// attempt always clears it. MIN_POSE_THRESHOLD set well above the normal
// reading wobble measured in Phase 7a (yaw ~1°, pitch ~4-5°).
const MIN_MAR_GAP = 0.015;
const MIN_POSE_THRESHOLD = 8; // degrees; also acts as a floor on the derived threshold

const CALIBRATION_STEPS = [
  {
    id: 'neutral',
    label: 'Step 1 of 4 — Neutral face',
    instruction: 'Relax your mouth naturally, like you\'re not reading. Hold still.',
    prepMs: 1000,
    sampleMs: 3000,
    metric: 'mar'
  },
  {
    id: 'mutter',
    label: 'Step 2 of 4 — Silent mouthing',
    instruction: 'Silently mouth this sentence as if reading aloud, no need to make sound: ' +
      '"The quick brown fox jumps over the lazy dog."',
    prepMs: 1000,
    sampleMs: 4000,
    metric: 'mar'
  },
  {
    id: 'facing',
    label: 'Step 3 of 4 — Facing screen',
    instruction: 'Look directly at the camera, like you\'re reading normally. Hold still.',
    prepMs: 1000,
    sampleMs: 3000,
    metric: 'pose'
  },
  {
    id: 'away',
    label: 'Step 4 of 4 — Turned away',
    instruction: 'Turn your head to where you\'d expect reading to pause, and hold it there.',
    prepMs: 1000,
    sampleMs: 3000,
    metric: 'pose'
  }
];

let calibration = {
  active: false,
  stepIndex: -1,
  phase: null,          // 'prep' | 'sampling'
  phaseStartTime: 0,
  currentSamples: [],   // samples for the step currently being collected
  results: {}           // stepId -> array of samples, filled in as steps complete
};

const calibrateBtn = document.getElementById('calibrateBtn');
const calibrationPanel = document.getElementById('calibrationPanel');
const calibrationStepEl = document.getElementById('calibrationStep');
const calibrationInstructionEl = document.getElementById('calibrationInstruction');
const calibrationCountdownEl = document.getElementById('calibrationCountdown');
const calibrationMessageEl = document.getElementById('calibrationMessage');
const calibrationCancelBtn = document.getElementById('calibrationCancelBtn');
const calibrationRetryBtn = document.getElementById('calibrationRetryBtn');
const calibrationStatusValueEl = document.getElementById('calibrationStatusValue');

function average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function startCalibration() {
  // Stop any active reading first — calibration and reading shouldn't run
  // at the same time, and this reuses the same safe-reset pattern as the
  // Start Reading button (cancel() is safe even if nothing is speaking).
  manualCancel = true;
  speechSynthesis.cancel();
  isSpeakingChunk = false;
  readingActive = false;
  speechStateEl.textContent = 'idle (calibrating)';

  calibration = {
    active: true,
    stepIndex: 0,
    phase: 'prep',
    phaseStartTime: performance.now(),
    currentSamples: [],
    results: {}
  };

  startBtn.disabled = true;
  calibrateBtn.disabled = true;
  calibrationRetryBtn.style.display = 'none';
  calibrationMessageEl.textContent = '';
  calibrationPanel.style.display = 'block';
  renderCalibrationStep();
}

function cancelCalibration() {
  calibration.active = false;
  calibrationPanel.style.display = 'none';
  startBtn.disabled = false;
  calibrateBtn.disabled = false;
}

function renderCalibrationStep() {
  const step = CALIBRATION_STEPS[calibration.stepIndex];
  calibrationStepEl.textContent = step.label;
  calibrationInstructionEl.textContent = step.instruction;
}

// Called once per frame from predictLoop while calibration is active. Handles
// both the prep countdown (gives the user a moment to get into position
// before we start trusting samples) and the actual sampling window.
function updateCalibration(mar, yaw, pitch) {
  const step = CALIBRATION_STEPS[calibration.stepIndex];
  const now = performance.now();
  const elapsed = now - calibration.phaseStartTime;

  if (calibration.phase === 'prep') {
    const remaining = Math.max(0, step.prepMs - elapsed);
    calibrationCountdownEl.textContent = `Get ready... ${Math.ceil(remaining / 1000)}`;
    if (elapsed >= step.prepMs) {
      calibration.phase = 'sampling';
      calibration.phaseStartTime = now;
      calibration.currentSamples = [];
    }
    return;
  }

  // phase === 'sampling'
  calibration.currentSamples.push({ mar, yaw, pitch });
  const remaining = Math.max(0, step.sampleMs - elapsed);
  calibrationCountdownEl.textContent = `Hold it... ${Math.ceil(remaining / 1000)}`;

  if (elapsed >= step.sampleMs) {
    calibration.results[step.id] = calibration.currentSamples;
    calibration.stepIndex += 1;

    if (calibration.stepIndex >= CALIBRATION_STEPS.length) {
      finishCalibration();
    } else {
      calibration.phase = 'prep';
      calibration.phaseStartTime = now;
      calibration.currentSamples = [];
      renderCalibrationStep();
    }
  }
}

function finishCalibration() {
  const neutralMar = average(calibration.results.neutral.map(s => s.mar));
  const mutterMar = average(calibration.results.mutter.map(s => s.mar));
  const awayYaw = average(calibration.results.away.map(s => Math.abs(s.yaw)));
  const awayPitch = average(calibration.results.away.map(s => Math.abs(s.pitch)));
  const facingYaw = average(calibration.results.facing.map(s => Math.abs(s.yaw)));
  const facingPitch = average(calibration.results.facing.map(s => Math.abs(s.pitch)));

  // Reject a run that couldn't have produced meaningful thresholds, rather
  // than silently saving broken values. Two failure modes: mouth didn't
  // move enough between neutral/mutter, or head didn't turn enough between
  // facing/away.
  const marGap = mutterMar - neutralMar;
  const poseTurn = Math.max(awayYaw - facingYaw, awayPitch - facingPitch);

  if (marGap < MIN_MAR_GAP) {
    showCalibrationFailure(
      'Not enough difference between the neutral and mouthing steps. ' +
      'Try exaggerating the silent mouthing a bit more, then retry.'
    );
    return;
  }
  if (poseTurn < MIN_POSE_THRESHOLD / 2) {
    showCalibrationFailure(
      'Not enough head movement between the facing and turned-away steps. ' +
      'Try turning further away, then retry.'
    );
    return;
  }

  // Same margin logic used by hand for the original OPEN/CLOSE thresholds:
  // sit closeThreshold and openThreshold inside the neutral-to-mutter gap,
  // in that order, so the existing hysteresis check (open above, close
  // below) keeps working unchanged.
  const closeThreshold = neutralMar + marGap * 0.33;
  const openThreshold = neutralMar + marGap * 0.67;

  // Derived directly from the measured turn-away boundary, floored so a
  // shallow turn (e.g. user only turned yaw, not pitch) can't produce an
  // oversensitive threshold that trips on normal reading wobble.
  const yawThreshold = Math.max(MIN_POSE_THRESHOLD, awayYaw);
  const pitchThreshold = Math.max(MIN_POSE_THRESHOLD, awayPitch);

  const data = {
    openThreshold,
    closeThreshold,
    yawThreshold,
    pitchThreshold,
    calibratedAt: new Date().toISOString()
  };

  try {
    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(data));
  } catch (err) {
    console.error('Could not save calibration:', err);
  }

  applyCalibration(data);

  calibrationStepEl.textContent = 'Calibration complete';
  calibrationInstructionEl.textContent = 'Your thresholds have been saved for this device.';
  calibrationCountdownEl.textContent = '';
  calibration.active = false;
  startBtn.disabled = false;
  calibrateBtn.disabled = false;
  setTimeout(() => { calibrationPanel.style.display = 'none'; }, 2000);
}

function showCalibrationFailure(message) {
  calibration.active = false;
  calibrationMessageEl.textContent = message;
  calibrationRetryBtn.style.display = 'inline-block';
  startBtn.disabled = false;
  calibrateBtn.disabled = false;
}

// Applies a calibration result (either freshly computed or loaded from
// localStorage) to the live thresholds used everywhere else in the file.
function applyCalibration(data) {
  OPEN_THRESHOLD = data.openThreshold;
  CLOSE_THRESHOLD = data.closeThreshold;
  YAW_THRESHOLD = data.yawThreshold;
  PITCH_THRESHOLD = data.pitchThreshold;

  const when = new Date(data.calibratedAt).toLocaleString();
  calibrationStatusValueEl.textContent = `custom (calibrated ${when})`;
}

// Runs once at startup, before the webcam loop begins producing frames.
function loadSavedCalibration() {
  let raw;
  try {
    raw = localStorage.getItem(CALIBRATION_STORAGE_KEY);
  } catch (err) {
    console.error('Could not read saved calibration:', err);
    return;
  }
  if (!raw) return;

  try {
    const data = JSON.parse(raw);
    applyCalibration(data);
  } catch (err) {
    console.error('Saved calibration was corrupted, ignoring:', err);
  }
}

calibrateBtn.addEventListener('click', startCalibration);
calibrationCancelBtn.addEventListener('click', cancelCalibration);
calibrationRetryBtn.addEventListener('click', startCalibration);

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
  // Bug fix (Phase 7, Entry 11): speech is one continuous utterance (Phase 3),
  // not per-word — it never "finishes naturally" at a word boundary. Looking
  // away mid-utterance must actively stop it via the same cancel() path as a
  // mouth-close, or it just keeps talking regardless of head pose. mouthState
  // itself is left untouched here since the mouth may still be physically open.
  if (!isFacingScreen) {
    onMouthClosed();
  } else if (mouthState === 'open') {
    // Mirrors Phase 4's click-to-word pattern: if the mouth is already open
    // when we come back to facing the screen, resume immediately rather than
    // waiting for a fresh mouth-open edge that may never come.
    onMouthOpen();
  }
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
  // Maintain the rolling buffer every frame, regardless of current mouthState,
  // so it's always warm by the time we need it.
  const now = performance.now();
  marBuffer.push({ timestamp: now, mar });
  marBuffer = marBuffer.filter(sample => now - sample.timestamp <= WINDOW_MS);

  const marValues = marBuffer.map(s => s.mar);
  const movementRange = marValues.length > 0
    ? Math.max(...marValues) - Math.min(...marValues)
    : 0;
  movementRangeValueEl.textContent = movementRange.toFixed(4);

  if (mouthState === 'closed' && mar > OPEN_THRESHOLD) {
    mouthState = 'open';
    mouthOpenStartTime = now;
    currentWordExpectedMs = estimateWordDuration(getWordForCadence());
    cadenceValueEl.textContent = `0 / ${currentWordExpectedMs}ms`;
    onMouthOpen();
  } else if (mouthState === 'open') {
    // Phase 6b: how far into this word's expected mouthing time are we?
    const elapsedMs = now - mouthOpenStartTime;
    cadenceValueEl.textContent = `${Math.round(elapsedMs)} / ${currentWordExpectedMs}ms`;

    // Dynamic range threshold, built on top of Option A's fixed one: tighten
    // it while we're still under the word's expected duration (an early
    // close-looking dip is more likely mid-word noise than a real stop), and
    // relax it once we're past expected duration (the word's had its time;
    // don't make the reader hold their mouth extra to prove it's really over).
    const dynamicRangeThreshold = elapsedMs < currentWordExpectedMs
      ? STOPPED_RANGE_THRESHOLD * CADENCE_UNDER_FACTOR
      : STOPPED_RANGE_THRESHOLD * CADENCE_OVER_FACTOR;

    // Two conditions, both required (Option A base case):
    //  1. Current MAR is actually down in the closed region (not just "not
    //     moving" — a mouth held open steadily would also show a flat range,
    //     so range alone can't distinguish "closed" from "open and still").
    //  2. The recent window shows no meaningful oscillation against the
    //     cadence-adjusted threshold above, so a brief dip below
    //     CLOSE_THRESHOLD near punctuation (with real speech motion
    //     surrounding it in the window) doesn't get treated as a full stop.
    // (Bug fix, Entry 9: previously also gated on a "hasFullWindow" check
    // computed from the buffer's own oldest-sample age, which the pruning
    // filter guarantees is always < WINDOW_MS — so that gate was never true
    // and this whole branch was effectively dead code. Removed.)
    const isMouthStopped = mar < CLOSE_THRESHOLD && movementRange < dynamicRangeThreshold;
    if (isMouthStopped) {
      mouthState = 'closed';
      onMouthClosed();
    }
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
  marBuffer = []; // fresh window so a stale pre-click buffer can't cause a false stop
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

  loadSavedCalibration();
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

    if (calibration.active) {
      // During calibration we still want live yaw/pitch for this same frame,
      // so pull it here rather than waiting for the block below (which is
      // skipped once calibration owns the frame).
      let yaw = 0, pitch = 0;
      if (results.facialTransformationMatrixes && results.facialTransformationMatrixes.length > 0) {
        const pose = getYawPitch(results.facialTransformationMatrixes[0].data);
        yaw = pose.yaw;
        pitch = pose.pitch;
        yawValueEl.textContent = yaw.toFixed(1);
        pitchValueEl.textContent = pitch.toFixed(1);
      }
      updateCalibration(mar, yaw, pitch);
    } else {
      updateMouthState(mar);
    }
  }

  // Phase 3: head-pose gating, independent of whether lip landmarks were found
  // above (facialTransformationMatrixes comes from the same detection pass).
  // Skipped during calibration — updateCalibration() above already consumed
  // this frame's pose data, and we don't want head-pose gating firing
  // onMouthClosed()/onMouthOpen() mid-calibration since there's no active
  // reading session for it to act on.
  if (!calibration.active && results.facialTransformationMatrixes && results.facialTransformationMatrixes.length > 0) {
    updateHeadPose(results.facialTransformationMatrixes[0].data);
  }

  requestAnimationFrame(predictLoop);
}

setup();