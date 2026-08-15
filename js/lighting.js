// lighting.js — ambient brightness sampling + low-light detection.
// Extracted from main.js (Entry 55 modularization, Section 3d #1).

// --- Low-light detection (Entry 49/50) ----------------------------------
// Root cause of the original "sticky word" bug (see PROGRESS.md Section 3):
// ambient light degrades MediaPipe's landmark precision broadly, not any
// single threshold/anchor/fallback value — so the fix samples brightness
// directly from the video frame, independent of MediaPipe/MAR entirely.
// That independence is deliberate — it measures the actual thing we mean
// ("is there enough light") rather than inferring it secondhand from a
// tracking symptom, so it stays honest even if the tracking-precision
// relationship ever changes.
//
// Drawn onto a small offscreen canvas (downsampled to LIGHT_SAMPLE_SIZE x
// LIGHT_SAMPLE_SIZE) rather than reading the full webcam frame — this makes
// getImageData cheap regardless of the source camera's real resolution, and
// keeps this safe to run on mobile too (no per-platform special-casing
// needed, per the project's cross-device discipline). Sampled on an
// interval, not every frame — ambient light doesn't change frame-to-frame,
// so there's no reason to pay the pixel-read cost 60x/sec. (The interval
// throttle itself lives in main.js's predictLoop, which decides WHEN to
// call sampleBrightness() each frame; LIGHT_SAMPLE_INTERVAL_MS below is
// exported so that decision uses the same constant this comment is about.)
export const LIGHT_SAMPLE_SIZE = 16; // px — small enough getImageData is effectively instant
export const LIGHT_SAMPLE_INTERVAL_MS = 500;

// Threshold approach — Entry 50 follow-up, per PROGRESS.md discussion: a
// single hardcoded brightness cutoff would NOT be portable across devices.
// What we sample here isn't raw physical light (lux) — it's pixel
// brightness AFTER the camera's own auto-exposure/auto-gain has already
// processed it, and that processing varies a lot by camera/OS/browser. A
// number tuned against one webcam would be wrong for the next reader's.
// Instead: capture a per-device BASELINE brightness once, during the
// existing 'neutral' calibration step (camera already on, user already
// asked to sit in their normal reading position — zero extra cost), then
// flag low light as a RELATIVE drop from that baseline rather than an
// absolute cutoff. Self-calibrating, same category as OPEN_THRESHOLD/
// CLOSE_THRESHOLD (mouth-tracking module) and the speed anchors (cadence
// module) — see setLowLightBaseline() below for where a calibrated
// baseline gets applied, called from main.js's applyCalibration().
// DEFAULT_*_THRESHOLD below are only a fallback for a reader who hasn't
// calibrated yet (mirrors how OPEN_THRESHOLD/CLOSE_THRESHOLD themselves
// have hardcoded defaults until a real calibration overrides them).
//
// Hysteresis (enter/exit gap), not a single threshold either way — same
// pattern as OPEN_THRESHOLD/CLOSE_THRESHOLD for mouth state. A single
// cutoff would flicker the warning on/off if brightness hovers right at
// the edge (a lamp flicker, someone shifting in their chair); requiring a
// real climb back up before clearing avoids that without needing an
// arbitrary min-display timer like the cadence warning uses.
const DEFAULT_LOW_LIGHT_ENTER_THRESHOLD = 55; // fallback absolute value, pre-calibration only
const DEFAULT_LOW_LIGHT_EXIT_THRESHOLD = 70;  // fallback absolute value, pre-calibration only
// Ratios applied to a calibrated baseline once one exists (see
// setLowLightBaseline()). Also unvalidated guesses — "dim enough to
// matter" as a fraction of a personal baseline is still a judgment call,
// just a more portable one than a raw pixel number. Revisit if real
// feedback says the warning fires too eagerly or not eagerly enough.
const LOW_LIGHT_ENTER_RATIO = 0.6; // warn once brightness drops below 60% of baseline
const LOW_LIGHT_EXIT_RATIO = 0.75; // must climb back above 75% of baseline to clear
let lowLightEnterThreshold = DEFAULT_LOW_LIGHT_ENTER_THRESHOLD;
let lowLightExitThreshold = DEFAULT_LOW_LIGHT_EXIT_THRESHOLD;

// Called from main.js's applyCalibration() with the brightness baseline
// captured during the 'neutral' calibration step, or with null to reset to
// the pre-calibration defaults (mirrors loadSavedCalibration()'s handling
// of OPEN_THRESHOLD/CLOSE_THRESHOLD/personalized cadence in their own
// modules).
export function setLowLightBaseline(baseline) {
  if (typeof baseline === 'number') {
    lowLightEnterThreshold = baseline * LOW_LIGHT_ENTER_RATIO;
    lowLightExitThreshold = baseline * LOW_LIGHT_EXIT_RATIO;
  } else {
    lowLightEnterThreshold = DEFAULT_LOW_LIGHT_ENTER_THRESHOLD;
    lowLightExitThreshold = DEFAULT_LOW_LIGHT_EXIT_THRESHOLD;
  }
}

// Absolute floor — a real gap the relative-baseline approach has on its
// own, flagged by the student: if someone calibrates IN a dim room, their
// baseline is already dim, so a further 40% drop from an already-low
// number rarely happens even when the room is genuinely too dark to read
// by. This floor fires independent of any baseline at all, as a backstop.
// It's deliberately set low on the 0-255 scale specifically because that's
// the one part of the brightness scale where camera auto-exposure/auto-gain
// differences across devices matter least — every camera's compensation
// eventually hits its own noise floor, so a genuinely dim room reads low
// pretty much everywhere. This does NOT replace the calibrated relative
// check above; the two run together (see sampleBrightness()) — relative
// catches "dimmer than what's normal for you," absolute catches "dim
// enough that no one's baseline should matter."
//
// Values below are DATA-TUNED (student's own real test, not the original
// guess): normal room ~118-120, a "borderline dim, between normal and
// dark" room measured ~40 and was correctly felt to be too dim but the
// original 25/35 pair missed it entirely, a darker room measured ~27-30,
// full darkness ~20. Raised from the original 25/35 guess to 40/52 so the
// borderline-dim case is actually caught.
export const ABSOLUTE_DARK_ENTER_THRESHOLD = 40;
export const ABSOLUTE_DARK_EXIT_THRESHOLD = 52;

const lightSampleCanvas = document.createElement('canvas');
lightSampleCanvas.width = LIGHT_SAMPLE_SIZE;
lightSampleCanvas.height = LIGHT_SAMPLE_SIZE;
const lightSampleCtx = lightSampleCanvas.getContext('2d', { willReadFrequently: true });

// Optimistic default (bright) until the first real sample comes in, so a
// webcam that hasn't produced a frame yet can't flag a false low-light
// warning before startup.
let currentBrightness = 255;
let isLowLight = false;
const brightnessValueEl = document.getElementById('brightnessValue');
const lowLightDebugValueEl = document.getElementById('lowLightDebugValue');

export function getCurrentBrightness() { return currentBrightness; }
export function getIsLowLight() { return isLowLight; }
export function getLowLightThresholds() { return { enter: lowLightEnterThreshold, exit: lowLightExitThreshold }; }

// video: the <video> element showing the live camera feed — owned by
// main.js's camera/mouth-tracking setup, passed in rather than imported so
// this module doesn't need a DOM reference beyond its own offscreen canvas.
export function sampleBrightness(video) {
  if (!video.videoWidth || !video.videoHeight) return; // no frame yet
  lightSampleCtx.drawImage(video, 0, 0, LIGHT_SAMPLE_SIZE, LIGHT_SAMPLE_SIZE);
  const { data } = lightSampleCtx.getImageData(0, 0, LIGHT_SAMPLE_SIZE, LIGHT_SAMPLE_SIZE);
  let sum = 0;
  const pixelCount = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    // Standard perceptual luminance weighting (Rec. 601) rather than a flat
    // RGB average — green contributes far more to perceived brightness than
    // blue, and a flat average under/over-weights depending on the room's
    // color temperature.
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  currentBrightness = sum / pixelCount;

  // Hybrid check: warn if EITHER the relative-to-baseline signal or the
  // absolute-darkness floor says it's too dark; only clear once BOTH have
  // resolved. This is what actually fixes the "calibrated in a dim room"
  // gap — the relative check alone could stay permanently insensitive if
  // the baseline itself was dim, but the absolute floor doesn't care what
  // the baseline was.
  if (isLowLight) {
    const relativeCleared = currentBrightness >= lowLightExitThreshold;
    const absoluteCleared = currentBrightness >= ABSOLUTE_DARK_EXIT_THRESHOLD;
    if (relativeCleared && absoluteCleared) isLowLight = false;
  } else {
    const relativeTripped = currentBrightness < lowLightEnterThreshold;
    const absoluteTripped = currentBrightness < ABSOLUTE_DARK_ENTER_THRESHOLD;
    if (relativeTripped || absoluteTripped) isLowLight = true;
  }

  if (brightnessValueEl) brightnessValueEl.textContent = currentBrightness.toFixed(1);
  if (lowLightDebugValueEl) lowLightDebugValueEl.textContent = isLowLight ? 'low light' : 'ok';
}
