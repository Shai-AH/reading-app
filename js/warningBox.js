// warningBox.js — ambient trouble-shading (the red border) + the
// plain-English warning box, extracted together since they're one
// cohesive feature: trouble-shading feeds the warning box directly
// (updateTroubleShading calls updateWarningBox at the end), and
// resetTroubleShading resets both sets of state as one unit.
// Extracted from main.js (Entry 55 modularization, Section 3d #1).
// These two pieces are NOT adjacent in the original main.js — this
// module reassembles them from two separate locations that used to
// sit on either side of the calibration/mouth-tracking/speech code.
//
// This module owns no cross-domain state itself, only reads it:
// readingActive/mouthState/isFaceVisible/manualSpeechEnabled/
// lastWordBoundaryTime/currentSpokenWordExpectedMs all come from
// js/readingState.js, isLowLight from js/lighting.js.

import {
  getReadingActive, getMouthState, getIsFaceVisible,
  getManualSpeechEnabled, getLastWordBoundaryTime, setLastWordBoundaryTime,
  getCurrentSpokenWordExpectedMs, setCurrentSpokenWordExpectedMs,
} from './readingState.js';
import { getIsLowLight } from './lighting.js';

// --- Phase 11b: ambient trouble-shading ---
// Addresses the detection-legibility paradox (Entry 17): the reader can't
// feel their own MAR value, so a silent miss (movement that doesn't quite
// cross a threshold) feels arbitrary rather than explainable. Rather than a
// popup/toast (which would interrupt reading — the opposite of the app's
// whole premise), a persistent ambient border around the reading pane drifts
// through red shades as a combined "trouble score" rises.
//
// Design decisions locked in this session (answers to Entry 17's four open
// questions):
//   1. ONE blended score, not a per-subsystem breakdown. An ambient signal
//      is meant to be felt peripherally; three simultaneous hues would force
//      conscious interpretation, defeating the point. combine via max(), not
//      average — one badly-off subsystem should read as trouble even if the
//      others are fine, not get diluted.
//   2. A second, separate SHARP cue (a quick pulse, not a hue) layered on
//      top for hard failures (a stuck word, a real head-pose gate trip) —
//      slow drift is the wrong shape for a discrete event.
//   3. Reads off this user's CALIBRATED thresholds (currentSpokenWordExpectedMs
//      from Phase 11's personalized cadence), not raw values — so a twitchy
//      mumbler and a slow one both see "trouble" mean the same thing: how
//      close they are to THEIR OWN threshold, not an absolute scale.
//      (Originally also read pose thresholds — removed Entry 45, see the
//      head-pose-removal note above computeRawTroubleScore.)
//   4. Hue is paired with opacity+saturation, not used alone, for red/green
//      colorblind accessibility.
//
// Audience note: this app's core/secondary audiences (dark-reading,
// neurodivergent/low-focus readers, and especially early-stage bulbar
// ALS/vocal-cord-paralysis users with reduced or effortful motor control —
// Section 1) make "minimum tolerable error, not zero error" the right target
// here specifically, not just a general philosophy. A jumpy, quick-to-redden
// border would read as the app scolding a user for exactly the kind of
// movement variability its target audience is expected to have. Slow
// accumulation + fast recovery (below) and a pulse cooldown are both in
// service of that: the shading should trail sustained trouble, not flicker
// at every borderline frame.
const TROUBLE_ACCUMULATE_RATE = 0.04; // fraction of the gap closed per frame while rising (slow)
const TROUBLE_RECOVER_RATE = 0.12;    // fraction of the gap closed per frame while falling (~3x faster)
const TROUBLE_CADENCE_OVERRUN_CAP = 2.5; // elapsed/expected ratio at which cadence trouble maxes out
const TROUBLE_MAX_OPACITY = 0.85;
const TROUBLE_MIN_SATURATION = 30; // %, floor so even faint trouble is a visible (not just alpha) shift
const TROUBLE_MAX_SATURATION = 90; // %

// Sharp-pulse trigger for a stuck word during LIVE reading. This is
// a non-blocking heads-up nudge, not a hard failure that aborts anything, so
// it's fine (and more useful) for it to fire earlier. Real reading also has
// genuine long pauses (re-reading, thinking) that aren't errors, which is
// exactly the "room for error" the pulse cooldown below protects against.
const READING_STALL_FACTOR = 3;
const READING_STALL_MIN_MS = 2000;
const TROUBLE_PULSE_COOLDOWN_MS = 1500; // debounce so one ongoing problem doesn't spam pulses

let displayedTroubleScore = 0;
let lastPulseTime = 0;

const readingPaneEl = document.getElementById('readingPane');
const troubleValueEl = document.getElementById('troubleValue');

// Cadence trouble: only meaningful while a word is actively open past its
// (personalized, Phase 11) expected duration — 0 while still within the
// expected window, ramping up to 1 at TROUBLE_CADENCE_OVERRUN_CAP times over.
// Bugfix: uses lastWordBoundaryTime/currentSpokenWordExpectedMs (reset every
// word via onboundary/highlightWordAt), NOT mouthOpenStartTime/
// currentWordExpectedMs — those only reset on a closed->open transition,
// which during smooth continuous reading (Phase 6a) can span many words, so
// "elapsed" kept growing across the whole open stretch instead of the
// current word, pegging the border red during completely normal reading.
function computeCadenceTrouble() {
  if (!getReadingActive() || getMouthState() !== 'open' || getCurrentSpokenWordExpectedMs() <= 0) return 0;
  const elapsedMs = performance.now() - getLastWordBoundaryTime();
  const ratio = elapsedMs / getCurrentSpokenWordExpectedMs();
  if (ratio <= 1) return 0;
  return Math.min(1, (ratio - 1) / (TROUBLE_CADENCE_OVERRUN_CAP - 1));
}

function computeRawTroubleScore() {
  if (!getReadingActive()) return 0; // calm border whenever there's no active session to have trouble in
  // Head-pose removed (Entry 45) — cadence overrun is the only remaining
  // continuous trouble source. max() kept as the combining shape in case a
  // future signal joins it, even though there's only one input today.
  return Math.max(computeCadenceTrouble());
}

// Called once per frame from predictLoop (skipped during calibration, same
// as the mouth/pose updates it depends on). Smooths the raw score with
// asymmetric rates (slow up, fast down — see design note above) and paints
// the ambient border from it.
export function updateTroubleShading() {
  const raw = computeRawTroubleScore();
  const rate = raw > displayedTroubleScore ? TROUBLE_ACCUMULATE_RATE : TROUBLE_RECOVER_RATE;
  displayedTroubleScore += (raw - displayedTroubleScore) * rate;
  if (displayedTroubleScore < 0.01) displayedTroubleScore = 0; // settle fully instead of trailing asymptotically forever

  const opacity = displayedTroubleScore * TROUBLE_MAX_OPACITY;
  const saturation = TROUBLE_MIN_SATURATION + displayedTroubleScore * (TROUBLE_MAX_SATURATION - TROUBLE_MIN_SATURATION);
  readingPaneEl.style.borderColor = `hsla(0, ${saturation}%, 45%, ${opacity})`;
  troubleValueEl.textContent = displayedTroubleScore.toFixed(2);

  checkReadingStallPulse();
  updateWarningBox();
}

// Live-reading analog of calibration's stall detection (Phase 11), but
// non-blocking: it just fires the sharp cue, nothing is aborted or retried.
// Same bugfix as computeCadenceTrouble above — per-word clock, not mouth-open clock.
function checkReadingStallPulse() {
  if (!getReadingActive() || getMouthState() !== 'open' || getCurrentSpokenWordExpectedMs() <= 0) return;
  const elapsedMs = performance.now() - getLastWordBoundaryTime();
  const stallThreshold = Math.max(READING_STALL_MIN_MS, getCurrentSpokenWordExpectedMs() * READING_STALL_FACTOR);
  if (elapsedMs > stallThreshold) {
    maybeFireTroublePulse();
  }
}

export function maybeFireTroublePulse() {
  const now = performance.now();
  if (now - lastPulseTime < TROUBLE_PULSE_COOLDOWN_MS) return;
  lastPulseTime = now;
  readingPaneEl.classList.remove('trouble-pulse');
  void readingPaneEl.offsetWidth; // force reflow so re-adding the class restarts the animation
  readingPaneEl.classList.add('trouble-pulse');
}

// Resets shading state to calm on every fresh Start Reading click, so a new
// session doesn't inherit a lingering score/pulse-cooldown from a previous
// one that ended mid-trouble.
export function resetTroubleShading() {
  displayedTroubleScore = 0;
  lastPulseTime = 0;
  setLastWordBoundaryTime(performance.now());
  setCurrentSpokenWordExpectedMs(0);
  readingPaneEl.classList.remove('trouble-pulse');
  readingPaneEl.style.borderColor = 'transparent';
  troubleValueEl.textContent = '0.00';
  currentWarningReason = null;
  warningBoxMinimized = false;
  cadenceWarningActiveUntil = 0;
  warningBoxEl.classList.add('warning-hidden');
  updateWarningBoxMinimizedUI();
  warningDebugValueEl.textContent = 'none';
}

// --- Plain-English trouble explainer (Entry 45+) ---
// The ambient red border (Phase 11b) signals THAT something's off but not
// WHAT — this fills that gap without a popup/toast (which would interrupt
// reading, the exact thing Phase 11b's design note argues against). Single
// message at a time by priority, not a stack: a deliberate user pause is
// always the most relevant thing to tell them, even if e.g. a cadence
// stall is also technically true underneath it.
const WARNING_MESSAGES = {
  'switch-off': 'Reading is paused — flip the switch (or press Space) to resume.',
  'no-face': "Can't see your face — check your camera or lighting.",
  'low-light': 'Lighting looks low — more light will help tracking keep up with your mouth.',
  'cadence': 'Taking a while on this word — no rush, just checking in.'
};
// Threshold on the ALREADY-smoothed trouble score (slow-accumulate/
// fast-recover, same as the ambient border) rather than a new debounce —
// this is what gives "don't show every borderline frame" for free. Starting
// guess, same tier as every other unvalidated constant in this project —
// tune from real use if it feels early/late.
const WARNING_BOX_TROUBLE_THRESHOLD = 0.35;
// Fast-recover means the raw score itself can drop back under threshold
// within a frame or two of a stall resolving — gating display purely on the
// instantaneous score made the cadence message flash for well under a
// second, unreadable. Once triggered, hold it visible for a real minimum
// window instead of re-checking the raw score every frame.
const WARNING_BOX_MIN_DISPLAY_MS = 3000;
let cadenceWarningActiveUntil = 0;

let currentWarningReason = null;
let warningBoxMinimized = false;
const warningBoxEl = document.getElementById('warningBox');
const warningTextEl = document.getElementById('warningText');
const warningMinimizeBtnEl = document.getElementById('warningMinimizeBtn');
const warningDebugValueEl = document.getElementById('warningDebugValue');

function computeWarningReason() {
  if (!getReadingActive()) return null;
  if (!getManualSpeechEnabled()) return 'switch-off'; // highest priority — always wins
  if (!getIsFaceVisible()) return 'no-face';
  // Entry 50: ranked ahead of 'cadence' deliberately — Entry 49 found dim
  // light is often the actual root cause behind a cadence stall (landmark
  // precision degrading, not the reader genuinely pausing), so naming the
  // real cause first is more useful than reporting the downstream symptom.
  if (getIsLowLight()) return 'low-light';
  const now = performance.now();
  if (displayedTroubleScore >= WARNING_BOX_TROUBLE_THRESHOLD) {
    cadenceWarningActiveUntil = now + WARNING_BOX_MIN_DISPLAY_MS;
  }
  if (now < cadenceWarningActiveUntil) return 'cadence';
  return null;
}

function updateWarningBoxMinimizedUI() {
  warningBoxEl.classList.toggle('warning-minimized', warningBoxMinimized);
  warningMinimizeBtnEl.setAttribute('aria-label', warningBoxMinimized ? 'Expand warning' : 'Minimize warning');
  warningMinimizeBtnEl.title = warningBoxMinimized ? 'Expand' : 'Minimize';
}

// Called once per frame from updateTroubleShading (same cadence as the
// ambient border, skipped during calibration for the same reason).
function updateWarningBox() {
  const reason = computeWarningReason();
  if (reason !== currentWarningReason) {
    currentWarningReason = reason;
    warningDebugValueEl.textContent = reason || 'none';
    if (reason === null) {
      warningBoxEl.classList.add('warning-hidden');
    } else {
      warningTextEl.textContent = WARNING_MESSAGES[reason];
      warningBoxEl.classList.remove('warning-hidden');
      // A NEW condition always re-expands, even if the reader minimized a
      // previous one — minimizing means "not this one right now", not
      // "never tell me anything again".
      warningBoxMinimized = false;
      updateWarningBoxMinimizedUI();
    }
  }
}

warningMinimizeBtnEl.addEventListener('click', () => {
  warningBoxMinimized = !warningBoxMinimized;
  updateWarningBoxMinimizedUI();
});
