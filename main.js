import { FaceLandmarker, FilesetResolver, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
import {
  DEFAULT_PERSONALIZED_RATE,
  CADENCE_UNDER_FACTOR, CADENCE_OVER_FACTOR,
  RATE_SLIDER_MIN, RATE_SLIDER_MAX, SAMPLE_SENTENCE,
  estimateWordDuration, estimateFallbackDelayMs, interpolateCadence,
  getPersonalizedCadence, setPersonalizedCadence, resetPersonalizedCadence,
} from "./js/cadence.js";
import {
  LEGACY_TEXT_STORAGE_KEY, idbSetText, idbGetText,
  extractPdfText, MAX_UPLOAD_FILE_SIZE_BYTES,
} from "./js/storage.js";
import { wireCalibrateIntro } from "./js/tour.js";
import { initFeedbackWidget } from "./js/feedback.js";
import {
  getMouthState, setMouthState,
  getIsFaceVisible, setIsFaceVisible,
  getNoFaceSince, setNoFaceSince,
  getReadingActive, setReadingActive,
  getIsSpeakingChunk, setIsSpeakingChunk,
  getCalibrationActive, setCalibrationActive,
  getLastWordBoundaryTime, setLastWordBoundaryTime,
  getCurrentSpokenWordExpectedMs, setCurrentSpokenWordExpectedMs,
  getManualSpeechEnabled, setManualSpeechEnabledFlag,
  getManualCancel, setManualCancel,
  getCancelRequestedTime, setCancelRequestedTime,
} from "./js/readingState.js";
import {
  LIGHT_SAMPLE_INTERVAL_MS,
  setLowLightBaseline, getLowLightThresholds,
  getCurrentBrightness, getIsLowLight, sampleBrightness,
  ABSOLUTE_DARK_EXIT_THRESHOLD,
} from "./js/lighting.js";
import { updateTroubleShading, resetTroubleShading, maybeFireTroublePulse } from "./js/warningBox.js";
import { resolveSelectedVoice } from "./js/voice.js";
import { findSentenceEnd, getToneForSentence } from "./js/tone.js";
import "./js/panels.js";

const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const videoContainer = document.getElementById('container');

// --- Entry 53: camera/privacy trust messaging + camera gating ---
// getUserMedia() no longer fires automatically from setup() — it only ever
// fires from requestCameraAccess(), triggered by an explicit click on
// cameraGateBtn. cameraGranted/mediaPipeReady gate calibrateBtn/startBtn
// (see updateStartButtonState) so neither can be clicked before tracking can
// actually work. See index.html's #cameraTrustBlock comment for the full
// reasoning.
const cameraGateCard = document.getElementById('cameraGateCard');
const cameraGateBtn = document.getElementById('cameraGateBtn');
const cameraGateStatus = document.getElementById('cameraGateStatus');
const privacyNote = document.getElementById('privacyNote');
const cameraPreviewNote = document.getElementById('cameraPreviewNote');
let cameraGranted = false;
let mediaPipeReady = false;

// --- Phase 10c: webcam/mesh visibility ---
// Decided in scoping (Entry 27): the live camera feed + mesh overlay is
// only useful to look at while the calibration wizard needs the student to
// position themselves; during an actual reading session (the app's real
// use case — reading in bed/dark, low-focus readers, ALS/paralysis users)
// there's no reason to show it. Tracking itself is untouched — MediaPipe
// keeps reading frames off the <video> element regardless of whether it's
// visible, so this is a CSS-only visibility toggle, not a functional
// change. Hidden by default via the .video-hidden class already present in
// index.html; only the calibration entry/exit points below turn it on/off,
// matching the resolved "assumption confirmed" open question from Entry 27
// (visually hidden, not removed from the DOM, since tracking must keep
// running underneath regardless of visibility).
function setCalibrationVideoVisible(visible) {
  videoContainer.classList.toggle('video-hidden', !visible);
}

// Phase 10c (folded-in former Phase 10b): the calibration view is the only
// place the video is actually shown now, so it's the only place the old
// hardcoded-640x480-stretches-a-portrait-stream bug still matters. Rather
// than a mobile-only special case, this sizes the box to the *real*
// stream's aspect ratio (whatever it is) and caps it to fit the viewport,
// so it's correct on any device/orientation instead of assuming 4:3.
function updateVideoBoxSize() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return; // metadata not loaded yet

  const maxWidth = Math.min(640, window.innerWidth - 48);
  const width = Math.max(160, maxWidth); // sane floor for very narrow screens
  const height = Math.round(width * (vh / vw));

  videoContainer.style.width = width + 'px';
  videoContainer.style.height = height + 'px';
  video.style.width = width + 'px';
  video.style.height = height + 'px';
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
}
video.addEventListener('loadedmetadata', updateVideoBoxSize);
window.addEventListener('resize', updateVideoBoxSize);
window.addEventListener('orientationchange', updateVideoBoxSize);

// --- Phase 12c: manual-scroll detection ---
// Deliberately listens for the *gestures* that only ever originate from a
// real user action (wheel, touch drag, keyboard paging) rather than the
// 'scroll' event itself — 'scroll' also fires for our own programmatic
// scrollIntoView() calls below, and there's no reliable way to tell those
// apart after the fact without extra bookkeeping. Listening one level up,
// at the gesture, sidesteps that ambiguity entirely.
const SCROLL_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '
]);
// Revised per live feedback: an indefinite session-long pause felt like
// auto-scroll had "completely switched off" rather than yielded — a reader
// glancing back at an earlier word expects to be picked back up once they
// stop interacting, not to have to click a word or restart the session.
// AUTO_SCROLL_RESUME_IDLE_MS is a starting guess (project convention — see
// MS_PER_SYLLABLE etc. — ship simple, tune from real use); the debounce
// (clearTimeout+reschedule on every gesture, not just the first) means the
// clock only starts once the reader actually stops touching the page, so a
// long deliberate scroll-and-read doesn't get yanked mid-interaction.
const AUTO_SCROLL_RESUME_IDLE_MS = 4000;
let resumeAutoScrollTimer = null;
function onManualScrollGesture() {
  autoScrollEnabled = false;
  if (resumeAutoScrollTimer !== null) clearTimeout(resumeAutoScrollTimer);
  resumeAutoScrollTimer = setTimeout(() => {
    resumeAutoScrollTimer = null;
    autoScrollEnabled = true;
    scrollToActiveWord(); // catch up immediately rather than waiting for the next word boundary
  }, AUTO_SCROLL_RESUME_IDLE_MS);
}
window.addEventListener('wheel', onManualScrollGesture, { passive: true });
window.addEventListener('touchmove', onManualScrollGesture, { passive: true });
window.addEventListener('keydown', (e) => {
  if (SCROLL_KEYS.has(e.key)) onManualScrollGesture();
});

// --- Manual ON/OFF speech switch (Entry 45+) ---
// Spacebar toggles the switch, EXCEPT while focus is inside the text input —
// otherwise a reader typing/pasting their reading text couldn't type a
// space. Also gated on readingActive: outside an active session the switch
// does nothing, so space is left to do its normal browser thing (page
// scroll) rather than silently eating the keypress for no effect.
function isTypingContext() {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable;
}
window.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || isTypingContext() || !getReadingActive()) return;
  e.preventDefault(); // don't also scroll the page
  toggleManualSpeechSwitch();
});

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
// MS_PER_SYLLABLE, BASE_WORD_MS, PERSONALIZED_RATE, CADENCE_UNDER/OVER_FACTOR,
// and the estimateSyllables/estimateWordDuration/estimateFallbackDelayMs/
// interpolateCadence functions now live in js/cadence.js (Entry 55
// modularization) — imported at the top of this file. Personalized cadence
// is read/written via getPersonalizedCadence()/setPersonalizedCadence()/
// resetPersonalizedCadence() rather than raw globals.

// Phase 12d fix: mouthOpenStartTime/currentWordExpectedMs (a clock that
// only reset on closed->open transitions) used to live here and drove the
// stop-detection threshold below. Removed — see the fix note in
// updateMouthState. One clock now, not two.
// Mobile testing session (diagnostic): precise, non-eyeballed measurement of
// the gap between "MAR first dropped below CLOSE_THRESHOLD" and "isMouthStopped
// actually went true". Resets whenever MAR pops back above CLOSE_THRESHOLD, so
// it always measures the most recent continuous below-threshold stretch, not
// a stale earlier dip. This isolates exactly how long the movementRange
// buffer (WINDOW_MS) takes to flush stale open-mouth samples, without any
// human reaction-time noise in the number.
let firstBelowCloseThresholdTime = null;

const cadenceValueEl = document.getElementById('cadenceValue');

// Phase 12d fix: getWordForCadence() (used only to prime the now-removed
// mouthOpenStartTime/currentWordExpectedMs clock on a closed->open
// transition) has been removed — the per-word clock below is always kept
// current by highlightWordAt/speakFrom regardless of mouth state, so there's
// nothing left to prime here.

// --- Phase 8: emotional tone toggle ---
// Off by default. When on, each resume looks ahead to the sentence its start
// point falls inside and sets that utterance's pitch/rate once, from that
// sentence's ending punctuation — see speakFrom below. (An earlier version
// chunked per-sentence and chained speak() calls sentence-to-sentence; that
// wedged Chrome's speech engine into a bad state, so it was reverted —
// see Entry 16.) Purely a punctuation heuristic, not real emotion/sentiment
// detection — consistent with the project's usual "simplest version first"
// approach (same spirit as estimateSyllables' vowel-cluster counting).
let toneEnabled = false;
const toneToggleEl = document.getElementById('toneToggle');
const toneValueEl = document.getElementById('toneValue');

toneToggleEl.addEventListener('change', () => {
  toneEnabled = toneToggleEl.checked;
  toneValueEl.textContent = toneEnabled ? 'on, neutral' : 'off';
});

// Local-voice selection (dropdown, persistence, resolveSelectedVoice) now
// lives in js/voice.js (Entry 55 modularization), imported at the top of
// this file. findSentenceEnd/getToneForSentence now live in js/tone.js,
// same import.

// --- Phase 10a: text input (paste/type + .txt upload) ---
// Replaces the old hardcoded READING_TEXT const from Phase 3. currentText is
// now mutable and starts as null (no default reading content) — Start
// Reading stays disabled (see updateStartButtonState) until real text is
// loaded, either by the student typing/pasting + clicking "Load Text", a
// .txt upload, or a restored previous session from localStorage.
//
// Kept only as a convenience prefill for the textarea at startup (NOT as
// currentText) so the old '?'/'!' test sentence — added in Phase 8 purely to
// give the tone toggle punctuation to react to — is still one click away
// for quick testing, without being baked into the app's actual logic.
const SAMPLE_TEXT_FOR_TESTING = "This is a longer piece of test text for phase three. Instead of a single " +
  "short sentence, we now advance word by word while you read, using the same mouth movement " +
  "signal from phase two. As each word is spoken it should highlight on screen, and if you turn " +
  "your head away from the camera the reading should pause automatically, even if your mouth is " +
  "still moving. Wait, did you hear that? That was surprising! This next part should sound " +
  "different, exciting even!";

// IndexedDB text-persistence primitives (openTextDB/idbSetText/idbGetText/
// idbDeleteText) now live in js/storage.js (Entry 55 modularization),
// imported at the top of this file. TEXT_STORAGE_KEY below is the legacy
// localStorage key name, imported as LEGACY_TEXT_STORAGE_KEY from storage.js
// so this migration logic and that module agree on the exact string.
const TEXT_STORAGE_KEY = LEGACY_TEXT_STORAGE_KEY;

let currentText = null;           // the active reading text; null until loaded
let lastLoadedFileName = null;    // set on .txt upload, cleared on manual textarea edits —
                                   // lets the status line say "notes.txt" vs "pasted/typed text"

const textInputAreaEl = document.getElementById('textInputArea');
const txtFileInputEl = document.getElementById('txtFileInput');
const loadTextBtnEl = document.getElementById('loadTextBtn');
const textLoadStatusEl = document.getElementById('textLoadStatus');

// Entry 52: auto-grow the textarea to fit its actual content, rather than
// relying on a fixed rows="N". A fixed row count looked reasonably full at
// the old ~640px panel width, but the same text wraps into fewer lines at
// the wider column introduced by the layout restructure, leaving a large
// empty gap below it (student screenshot) — sizing to content avoids
// depending on any particular column width at all. Called after every
// place the textarea's value is set programmatically, plus on manual input.
function resizeTextareaToFit(el) {
  el.style.height = 'auto';
  const minHeight = 90; // ~4 lines at this font-size — floor for empty/short text
  // Bug fix (session after E56): uncapped growth pushed the Load Text button
  // (and anything else below the textarea) past .panel-body's fixed
  // max-height/overflow:hidden clip boundary on a long paste — button
  // silently disappeared, not scrolled, just cut off. Cap growth and let the
  // textarea scroll internally past that point instead (overflow-y toggled
  // to 'auto' only once capped, so short text still shows no scrollbar).
  const maxHeight = 260; // leaves room under it for the button/hint row within panel-body's 480px
  const targetHeight = Math.max(el.scrollHeight, minHeight);
  if (targetHeight > maxHeight) {
    el.style.height = `${maxHeight}px`;
    el.style.overflowY = 'auto';
  } else {
    el.style.height = `${targetHeight}px`;
    el.style.overflowY = 'hidden';
  }
}

// manualCancel/cancelRequestedTime now live in js/readingState.js (Entry 55
// modularization) — imported at the top of this file.
let currentUtterance = null;
// Fix 1 (isolated testing via tts-stop-reliability-test.html, 6 configs / 120
// cycles, confirmed 100% no-fire rate): `onend` never fires on this browser
// after a manual cancel(), with or without simulated CPU load, chunking, or
// iframe recycling. `speaking` was confirmed to flip false quickly (~15ms avg)
// and reliably in the same tests, so it — not `onend` — is now the source of
// truth for "has this utterance actually stopped." `onend` is kept wired as a
// fallback (harmless if it never fires; picks up the same handler if some
// future browser/version does fire it) rather than removed outright.
let speakGeneration = 0;        // bumped on every speakFrom() call
let speakingPollIntervalId = null; // defensive: cleared at the top of each new speakFrom()
// --- Phase 9 (diagnostic, temporary): mobile TTS restart bug investigation ---
// Working theory (PROGRESS.md Section 3c): on the affected mobile browser/TTS
// voice, `onboundary` events don't fire reliably, so `lastBoundaryOffset` goes
// stale and reopening the mouth resumes from an old position instead of where
// reading actually stopped. This counter/timestamp pair is NOT a fix — it's
// instrumentation to confirm that theory on the real device before writing
// any fix. Reset per-utterance in speakFrom(); bumped in onboundary. Displayed
// live so you can watch, on the phone itself, whether the count keeps
// climbing normally and then goes stale right before/at the restart moment.
let boundaryEventCount = 0;
let lastBoundaryEventTime = 0; // performance.now() of the most recent onboundary
const boundaryCountValueEl = document.getElementById('boundaryCountValue');
const detectionGapValueEl = document.getElementById('detectionGapValue');
const cancelStopGapValueEl = document.getElementById('cancelStopGapValue');
const lastBoundaryAgoValueEl = document.getElementById('lastBoundaryAgoValue');

// --- Phase 12d (diagnostic, temporary): sticky-word bug investigation ---
// Not yet root-caused (PROGRESS.md 12d): some words occasionally stall,
// needing a repeat/next-word mouth action to release. Two live hypotheses
// this instruments, rather than guesses at blind:
//   (a) TTS-side: the browser's onboundary events for a specific word are
//       delayed, duplicated (fired more than once for the same word span,
//       which highlightWordAt currently silently no-ops on), or otherwise
//       irregular — same event-reliability family as the mobile 9a root
//       cause, but happening here on a single-utterance-per-resume desktop
//       session where call-frequency isn't the trigger.
//   (b) Mouth-detection-side: a false-early mouth-close on a word whose
//       phonetic content (e.g. bilabial/nasal-heavy words like "movement")
//       has naturally low MAR movement range mid-word, tripping
//       isMouthStopped before the word is actually done.
// Not a fix — just visibility, same convention as the Entry 22-23 mobile
// diagnostics. Remove once 12d is closed.
let duplicateBoundaryCount = 0;
let earlyCloseCount = 0;
const lastWordTextValueEl = document.getElementById('lastWordTextValue');
const lastWordGapValueEl = document.getElementById('lastWordGapValue');
const lastWordExpectedValueEl = document.getElementById('lastWordExpectedValue');
const duplicateBoundaryValueEl = document.getElementById('duplicateBoundaryValue');
const earlyCloseValueEl = document.getElementById('earlyCloseValue');
const lastCloseInRiskyWindowValueEl = document.getElementById('lastCloseInRiskyWindowValue');
const lastCloseRiskyDeltaValueEl = document.getElementById('lastCloseRiskyDeltaValue');

// Session-wide (NOT reset per-utterance, unlike boundaryEventCount) count of
// every speechSynthesis.speak() call since this page was loaded. Testing a
// specific hypothesis: student reported stalls starting rare/random-word
// and getting MORE frequent and MORE random (old words re-sticking) across
// repeated test runs in one session — that pattern doesn't fit a per-word
// cadence bug (which would hit the same word content the same way each
// time). It fits Entry 24's already-confirmed root cause instead: repeated
// speak() calls in general (not just chained ones) wedge Chromium's speech
// engine over a session. This counter makes that directly checkable against
// stall frequency, rather than guessing.
let sessionSpeakCallCount = 0;
const sessionSpeakCountValueEl = document.getElementById('sessionSpeakCountValue');

// --- Phase 9a "iframe recycle" experiment (live test, Entry 39) -----------
// Candidate fix for the Entry 24/Entry 33 speak()-count freeze. Idea: spawn
// a hidden same-origin iframe and speak through ITS speechSynthesis
// instance instead of the main window's, destroying/recreating it every N
// calls (well ahead of the observed #10-22 freeze range) — if the leak
// lives in per-frame JS-bound engine state, recycling the frame should
// reset it before it ever wedges.
//
// Isolated synthetic testing (standalone harness, no MediaPipe) could NOT
// reproduce the original freeze at all across several attempts (clean
// calls, interrupted calls, randomized timing, even real MediaPipe +
// synthetic CPU load) — only an unrelated, milder bug showed up under
// artificial call-overlap. So this is being tested live, in the real app,
// against a real reading session where the freeze has actually happened
// before, rather than guessed at synthetically. See PROGRESS.md Entry 39.
//
// FLAG: set to false to fully revert to the pre-existing behavior (main
// window's speechSynthesis, no recycling, byte-for-byte the old code path)
// with zero other changes needed.
const IFRAME_TTS_RECYCLE_ENABLED = true;

// Fix 3b's flat MIN_TIGHT_GATING_MS window was superseded by Fix 3c
// (syllable/consonant-risk-aware gating — see currentWordRiskyTimings /
// RISKY_CONSONANTS / RISK_WINDOW_HALF_MS below) before it was ever tested
// live, per the student's own prior experience that the sticky-word bug on
// several words was already well-established and unlikely to be fixed by a
// flat window. Left this note instead of the dead constant so the "why did
// v2 skip straight to v3" jump is traceable later.
const IFRAME_RECYCLE_EVERY_N_CALLS = 6; // safely below the lowest ever-observed real freeze (#10)

let ttsIframe = null;
let ttsRecycleCount = 0;
const ttsRecycleCountValueEl = document.getElementById('ttsRecycleCountValue');

// ttsEngine.synth / ttsEngine.UtteranceCtor are what every TTS call site
// below actually uses — swapping these two references is the entire
// mechanism, nothing else about speakFrom()'s logic changes.
const ttsEngine = {
  synth: window.speechSynthesis,
  UtteranceCtor: window.SpeechSynthesisUtterance,
};

// Bug fix (found via student report + isolated diagnostic, see PROGRESS.md):
// every cancel() call site OUTSIDE speakFrom() (onMouthClosed, the
// looking-away/no-face gate trip, word-click resync, calibration start,
// startBtn reset) used to call `ttsEngine.synth.cancel()` directly. That's
// wrong the moment a recycle has happened between "this utterance started
// speaking" and "we need to cancel it now" — cancel() would fire on the
// NEW (empty) iframe's synth while the utterance actually playing is
// orphaned on the OLD iframe's synth, completely unstoppable through the
// normal path. Invisible with the default voice (both "orphaned" and
// "new" utterances sound identical); became audible as two overlapping
// voices once a distinct custom voice was in play. Fix: track exactly
// which synth is currently speaking, and have every cancel() site use
// THIS, not whatever ttsEngine.synth happens to be right now.
let activeSpeechSynth = window.speechSynthesis;

function cancelActiveSpeech() {
  activeSpeechSynth.cancel();
}

function spawnFreshTtsIframe() {
  if (ttsIframe) {
    ttsIframe.remove();
  }
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(iframe);
  // A bare same-origin iframe's contentWindow (and its speechSynthesis /
  // SpeechSynthesisUtterance) is available synchronously right after
  // append — no need to wait for a 'load' event before using it.
  ttsIframe = iframe;
  ttsEngine.synth = iframe.contentWindow.speechSynthesis;
  ttsEngine.UtteranceCtor = iframe.contentWindow.SpeechSynthesisUtterance;
  ttsRecycleCount += 1;
  if (ttsRecycleCountValueEl) ttsRecycleCountValueEl.textContent = String(ttsRecycleCount);
  console.log(`[Phase 9a-iframe] fresh TTS iframe spawned (recycle #${ttsRecycleCount})`);
}

// Called right before each speak() — recycles BEFORE the call that would
// land on a recycle boundary, same convention as the benchmark harness
// (Entry 38): with IFRAME_RECYCLE_EVERY_N_CALLS=6, calls 1-6 use frame A,
// call 7 gets a fresh frame B, etc. sessionSpeakCallCount is incremented
// right after this runs (see speakFrom), so "the call about to happen" is
// sessionSpeakCallCount + 1.
function maybeRecycleTtsEngine() {
  if (!IFRAME_TTS_RECYCLE_ENABLED) return;
  // Entry 58 self-test fix: this function reassigns ttsEngine.synth/
  // UtteranceCtor directly (spawnFreshTtsIframe below), same two fields the
  // self-test swaps out for its scripted fake driver. Recycling fires on
  // the very first speak() of a session unconditionally (nextCallNumber
  // === 1) — which is exactly what a self-test run is — so without this
  // guard it silently overwrote the fake with a REAL iframe's speechSynthesis
  // right before speakFrom() constructs currentUtterance, causing actual
  // TTS audio and real onboundary events to fire for every word instead of
  // the scripted subset. Caught by reading the self-test's own console
  // output, not guessed.
  if (CLOCK_SELFTEST_ACTIVE) return;
  const nextCallNumber = sessionSpeakCallCount + 1;
  if (nextCallNumber === 1 || (nextCallNumber - 1) % IFRAME_RECYCLE_EVERY_N_CALLS === 0) {
    spawnFreshTtsIframe();
  }
}

if (IFRAME_TTS_RECYCLE_ENABLED) {
  spawnFreshTtsIframe(); // set up the first frame before any speak() call happens
}

let baseOffset = 0;             // char offset into currentText where currentUtterance's text starts
let lastBoundaryOffset = 0;     // charIndex within currentUtterance of the most recent word boundary
let wordSpans = [];             // { span, start, end } built from currentText
let activeWordIndex = -1;
// lastWordBoundaryTime/currentSpokenWordExpectedMs now live in
// js/readingState.js (Entry 55 modularization) — imported at the top of
// this file, since trouble-shading/the warning box read them too.
// Fix 3c: estimated ms-from-word-start offsets where a lip-closing
// consonant is expected in the CURRENT word, recomputed alongside
// currentSpokenWordExpectedMs at every point that resets it (highlightWordAt,
// speakFrom). Empty array = no risky sound detected, use fast/loose gating
// for the whole word.
let currentWordRiskyTimings = [];

// --- Mobile highlighter-freeze fix (see PROGRESS.md) -----------------------
// Isolated diagnostic (harness test, real mobile device): speechSynthesis's
// `onboundary` event fired 0/14 times for a plain local-voice utterance in
// the main window, with NO iframe involved — so this is not the Phase 9a
// iframe-recycling mechanism, it's the platform's onboundary support itself.
// Since highlightWordAt()/lastBoundaryOffset (both the visible highlight AND
// the mouth-close resume point) were previously updated ONLY inside
// onboundary, a browser that never fires it left the highlight frozen and
// resumed reading from a stale word every time — exactly the reported bug.
//
// Fix: a per-word fallback timer, seeded from the same estimateWordDuration()
// used for mouth-close cadence gating (Fix 3c/3c-2), advances the highlight/
// resume point on a timer if a real onboundary event doesn't arrive for the
// current word in time. A real onboundary, if one does land, always wins —
// it clears and reschedules the fallback from the TRUE position (see its
// handler in speakFrom) — so on a browser where onboundary already fires
// reliably (Entry 44 confirmed this for local voices on desktop), this timer
// is continuously preempted before it ever fires and has no effect at all.
// No platform/browser detection needed; it's self-correcting either way.
let fallbackAdvanceTimerId = null;
let fallbackAdvanceCount = 0; // diagnostic: how many words this utterance advanced via the timer, not a real event
const fallbackAdvanceCountValueEl = document.getElementById('fallbackAdvanceCountValue');
// Desktop test toggle (debug panel): forces onboundary events to be ignored,
// so the fallback-only path can be exercised and watched end-to-end on a
// normal desktop session — confirms the mechanism itself before relying on
// a slow mobile deploy-and-retest cycle. Real onboundary events are still
// received (nothing about actual speech changes), just not acted on.
let DEBUG_SIMULATE_NO_ONBOUNDARY = false;
const debugSimulateNoBoundaryEl = document.getElementById('debugSimulateNoBoundary');
if (debugSimulateNoBoundaryEl) {
  debugSimulateNoBoundaryEl.addEventListener('change', () => {
    DEBUG_SIMULATE_NO_ONBOUNDARY = debugSimulateNoBoundaryEl.checked;
  });
}

// Entry 58 clock-decouple self-test: off unless runClockDecoupleSelfTest()
// (exposed on window, see bottom of file) is actively running. When true,
// highlightWordAt()/scheduleFallbackAdvance's fallback branch push tagged
// entries to window.__clockWriteLog instead of doing nothing extra — cheap,
// and inert in normal use since this stays false.
let CLOCK_SELFTEST_ACTIVE = false;

// --- Self-calibrating fallback rate factor ----------------------------------
// Answers the "stop guessing constants" ask directly: rather than a fixed
// multiplier, this is MEASURED from real data every time an utterance
// completes naturally (reaches the actual end of currentText without being
// cancelled by a mouth close) — the one moment a real elapsed-time ground
// truth exists even on a browser with zero onboundary events. We already
// know, for that utterance: exactly how long it really took (performance.now()
// deltas) and exactly what estimateWordDuration() predicted it would take
// (the same tuned Entry-47 formula, summed over its words) — the ratio of
// the two is a genuine measurement of how wrong the baseline estimate is on
// THIS device/voice/rate, not a hand-picked value. Smoothed with an EMA so
// one unusual utterance can't swing it wildly, and persisted to localStorage
// so it keeps improving across sessions instead of resetting every reload.
const FALLBACK_RATE_STORAGE_KEY = 'readingAppFallbackRateFactor';
const FALLBACK_RATE_EMA_ALPHA = 0.3;
let fallbackRateFactor = 1.0;
try {
  const savedFactor = parseFloat(localStorage.getItem(FALLBACK_RATE_STORAGE_KEY));
  // Sanity clamp: guard against a corrupted value or a wildly unrepresentative
  // early sample (e.g. a one-word utterance) ever making the factor unusable.
  if (!isNaN(savedFactor) && savedFactor >= 0.3 && savedFactor <= 3) {
    fallbackRateFactor = savedFactor;
  }
} catch (err) { /* localStorage unavailable — keep the 1.0 default */ }
const fallbackRateFactorValueEl = document.getElementById('fallbackRateFactorValue');
if (fallbackRateFactorValueEl) fallbackRateFactorValueEl.textContent = fallbackRateFactor.toFixed(3);

// Called from handleStop only on a NATURAL completion (see speakFrom) —
// updates fallbackRateFactor from this utterance's real-vs-predicted ratio.
function recordFallbackCalibrationSample(realElapsedMs, wordStartIdx) {
  // Self-test guard (added after the fix was caught contaminating real
  // calibration data): the self-test's fake driver still ends via the REAL
  // handleStop() path (its onend call, and independently the speaking-poll
  // once `speaking` flips false) — both treat a scripted test run as a
  // genuine natural completion and would otherwise EMA a synthetic
  // test-sentence timing ratio into the real, persisted fallbackRateFactor.
  // Confirmed via a live run: this is what pushed a real browser's stored
  // factor to 1.901. No calibration writes may happen while a self-test is
  // active, full stop — this has to be checked here, not just in the
  // self-test's own driver, since the poll path never goes through the
  // self-test's code at all.
  if (CLOCK_SELFTEST_ACTIVE) {
    console.log('[clock-decouple self-test] blocked a calibration write that would have used synthetic test timing — real fallbackRateFactor left untouched.');
    return;
  }
  if (wordStartIdx === -1 || wordStartIdx >= wordSpans.length) return;
  let predictedMs = 0;
  for (let i = wordStartIdx; i < wordSpans.length; i++) {
    predictedMs += estimateWordDuration(wordSpans[i].span.textContent);
  }
  if (predictedMs <= 0 || realElapsedMs <= 0) return;
  const observedRatio = realElapsedMs / predictedMs;
  if (observedRatio < 0.3 || observedRatio > 3) {
    console.log(`[fallback-calibration] discarded outlier sample: ratio ${observedRatio.toFixed(2)} (${Math.round(realElapsedMs)}ms real vs ${Math.round(predictedMs)}ms predicted)`);
    return;
  }
  fallbackRateFactor = fallbackRateFactor * (1 - FALLBACK_RATE_EMA_ALPHA) + observedRatio * FALLBACK_RATE_EMA_ALPHA;
  if (fallbackRateFactorValueEl) fallbackRateFactorValueEl.textContent = fallbackRateFactor.toFixed(3);
  try { localStorage.setItem(FALLBACK_RATE_STORAGE_KEY, String(fallbackRateFactor)); } catch (err) { /* ignore */ }
  console.log(`[fallback-calibration] natural completion: ${Math.round(realElapsedMs)}ms real vs ${Math.round(predictedMs)}ms predicted (ratio ${observedRatio.toFixed(2)}) — fallbackRateFactor now ${fallbackRateFactor.toFixed(3)}`);
}

// --- Entry 60: silent calibration-phase probe for fallbackRateFactor -------
// Confirmed necessary by runResumeOffsetDiagnostic(): with an uncorrected
// factor, resume-after-mouth-close lag grows unbounded (2/4/6 words behind
// across trials). With factor and true rate matched, the SAME diagnostic
// showed a flat, non-growing ~1-word residual — an inherent tick-granularity
// ceiling, not a bug. So getting fallbackRateFactor close to real is a real,
// sufficient fix for both the highlighter-lag complaint and the resume-
// position complaint, since they share this one root cause.
//
// Problem this probe solves: recordFallbackCalibrationSample() (above) only
// fires on a NATURAL completion, and Entry 58 found those are rare in real
// use — speakFrom() queues the entire rest of the document as one utterance,
// so "completes naturally" needs uninterrupted mouth movement all the way to
// the literal end of the text. Most sessions may never produce a sample,
// leaving fallbackRateFactor stuck at 1.0 (or a prior session's stale value)
// regardless of how wrong that is for this device/voice/rate. This probe
// gets one real, grounded sample immediately, during calibration, instead
// of waiting on a rare event.
//
// Deliberately mirrors testRateVoice()'s pattern (raw window.speechSynthesis
// calls, not the app's speakFrom/iframe-recycle machinery) rather than
// reusing speakFrom() — has to be fully isolated from wordSpans/
// activeWordIndex/speakGeneration so it can never touch real reading state,
// same isolation reason CLOCK_SELFTEST_ACTIVE exists for the clock
// self-test. Muted (volume 0) so nothing audible happens without the user
// asking for it — matches the project's no-forced-action rule, since this
// runs automatically, not from a click.
let fallbackProbeInProgress = false;

// rate: the just-confirmed personalizedRate (see finishCalibration) — used
// for utterance.rate so what's measured matches what will actually play
// during real reading. predictedMs is computed from estimateWordDuration,
// which by this point already reflects the same rate (setPersonalizedCadence
// runs before this is called) — so both sides of the ratio are apples-to-
// apples with the rate the user just chose.
function runSilentFallbackProbe(rate) {
  if (fallbackProbeInProgress || CLOCK_SELFTEST_ACTIVE) return;
  if (!('speechSynthesis' in window)) return;

  const words = SAMPLE_SENTENCE.match(/\S+/g) || [];
  if (words.length === 0) return;
  const predictedMs = words.reduce((sum, w) => sum + estimateWordDuration(w), 0);
  if (predictedMs <= 0) return;

  fallbackProbeInProgress = true;
  let settled = false;
  let startTime = null;
  let timeoutId = null;

  const finish = (elapsedMs) => {
    if (settled) return;
    settled = true;
    if (timeoutId !== null) clearTimeout(timeoutId);
    fallbackProbeInProgress = false;
    if (elapsedMs === null) {
      console.log('[fallback-probe] no result (timed out or failed) — fallbackRateFactor left untouched.');
      return;
    }
    const observedRatio = elapsedMs / predictedMs;
    if (observedRatio < 0.3 || observedRatio > 3) {
      console.log(`[fallback-probe] discarded outlier: ratio ${observedRatio.toFixed(2)} (${Math.round(elapsedMs)}ms real vs ${Math.round(predictedMs)}ms predicted) — fallbackRateFactor left untouched.`);
      return;
    }
    // Direct assignment, NOT an EMA blend like recordFallbackCalibrationSample
    // uses for later natural completions. Deliberate: the EMA exists to
    // protect an already-reasonable value from one unusual utterance; here
    // the existing value is either the untested 1.0 default or a prior
    // session's number, and this probe is a cleaner, more controlled
    // measurement (fixed sentence, isolated from mouth-tracking/reading
    // state) than what it's replacing — blending it partway toward the old
    // value would just slow-walk toward the better number instead of using
    // it immediately.
    const previous = fallbackRateFactor;
    fallbackRateFactor = observedRatio;
    if (fallbackRateFactorValueEl) fallbackRateFactorValueEl.textContent = fallbackRateFactor.toFixed(3);
    try { localStorage.setItem(FALLBACK_RATE_STORAGE_KEY, String(fallbackRateFactor)); } catch (err) { /* ignore */ }
    console.log(`[fallback-probe] ${Math.round(elapsedMs)}ms real vs ${Math.round(predictedMs)}ms predicted (ratio ${observedRatio.toFixed(2)}) — fallbackRateFactor ${previous.toFixed(3)} -> ${fallbackRateFactor.toFixed(3)}`);
  };

  try {
    const utterance = new SpeechSynthesisUtterance(SAMPLE_SENTENCE);
    utterance.rate = rate;
    utterance.volume = 0; // muted — this must never be audible, it wasn't asked for
    const voice = resolveSelectedVoice(window.speechSynthesis);
    if (voice) utterance.voice = voice;

    utterance.onstart = () => { startTime = performance.now(); };
    utterance.onend = () => {
      finish(startTime === null ? null : performance.now() - startTime);
    };
    utterance.onerror = () => { finish(null); };

    // Timeout floor generous enough for a slow device/voice to actually
    // finish (3x predicted, same shape as the calibration wizard's own
    // detection timeouts), capped so a stuck/never-firing engine can't hang
    // this indefinitely.
    const timeoutMs = Math.min(12000, Math.max(4000, predictedMs * 3));
    timeoutId = setTimeout(() => finish(null), timeoutMs);

    window.speechSynthesis.cancel(); // clear anything pending first, same as testRateVoice()
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    console.error('[fallback-probe] failed to start:', err);
    finish(null);
  }
}

// Clears any pending fallback-advance timer. Called whenever something else
// is about to take over the highlight/resume position: a real onboundary
// event, a manual cancel (mouth close / word click / hard reset), or the
// utterance finishing.
function clearFallbackAdvance() {
  if (fallbackAdvanceTimerId !== null) {
    clearTimeout(fallbackAdvanceTimerId);
    fallbackAdvanceTimerId = null;
  }
}

// Schedules a timer to advance the highlight/resume point to the word AFTER
// `forWordIndex`, using estimateFallbackDelayMs() for that word, in case no
// real onboundary event arrives for it in time. Guarded on the same
// `generation` pattern speakFrom's handleStop already uses (myGeneration vs
// speakGeneration), plus isSpeakingChunk and an activeWordIndex check, so a
// stale timer from a cancelled/superseded utterance can never fire late and
// silently move the highlight/resume point out from under a click or a
// mouth-close that happened in between.
function scheduleFallbackAdvance(forWordIndex, generation) {
  clearFallbackAdvance();
  if (forWordIndex === -1 || forWordIndex + 1 >= wordSpans.length) return; // no next word to fall forward to
  const wordText = wordSpans[forWordIndex].span.textContent;
  let delayMs = estimateFallbackDelayMs(wordText, fallbackRateFactor);
  // Confidence guard: if real onboundary events HAVE landed already this
  // utterance, trust that this browser fires them and give the fallback a
  // generous safety margin so it only steps in when a real event is
  // genuinely overdue — not just running a little behind our estimate
  // (e.g. a punctuation pause). If we've seen ZERO real events so far this
  // utterance, treat that as evidence this browser may not fire them at all
  // (confirmed on mobile — harness test: 0/14) and stay close to the raw
  // estimate instead, so the highlighter doesn't lag noticeably behind.
  if (boundaryEventCount > 0) delayMs *= 2.2;
  delayMs = Math.max(60, delayMs); // small floor so a near-zero estimate can't fire instantly
  if (CLOCK_SELFTEST_ACTIVE) {
    console.log(`[fallback-schedule] set for word after "${wordText}" (idx ${forWordIndex}->${forWordIndex + 1}), delay=${Math.round(delayMs)}ms, boundaryEventCount=${boundaryEventCount}, fallbackRateFactor=${fallbackRateFactor.toFixed(3)}`);
  }
  fallbackAdvanceTimerId = setTimeout(() => {
    fallbackAdvanceTimerId = null;
    if (CLOCK_SELFTEST_ACTIVE) {
      console.log(`[fallback-fire-attempt] idx ${forWordIndex}->${forWordIndex + 1}: generation ${generation === speakGeneration ? 'OK' : 'STALE'}, isSpeakingChunk=${getIsSpeakingChunk()}, activeWordIndex=${activeWordIndex} (expected ${forWordIndex})`);
    }
    if (generation !== speakGeneration) return; // this utterance was superseded/cancelled — stale timer
    if (!getIsSpeakingChunk()) return; // speech already stopped — don't advance past where it actually stopped
    if (activeWordIndex !== forWordIndex) return; // a real boundary (or another fallback tick) already moved us on
    const nextIdx = forWordIndex + 1;
    fallbackAdvanceCount += 1;
    if (fallbackAdvanceCountValueEl) fallbackAdvanceCountValueEl.textContent = String(fallbackAdvanceCount);
    console.log(`[fallback-highlight] no onboundary for "${wordSpans[forWordIndex].span.textContent}" within ${Math.round(delayMs)}ms — advancing on estimate instead`);
    lastBoundaryOffset = wordSpans[nextIdx].start - baseOffset;
    // Entry 58 fix: moveHighlightTo(), NOT highlightWordAt(). This is an
    // ungrounded guess (no real event confirmed this word), so it must move
    // the visible highlight WITHOUT resetting lastWordBoundaryTime/
    // currentSpokenWordExpectedMs — those belong exclusively to grounded
    // sources now (real onboundary, or a genuine user action like word-click
    // resync). See the comment block above moveHighlightTo()'s definition.
    moveHighlightTo(baseOffset + lastBoundaryOffset);
    if (CLOCK_SELFTEST_ACTIVE) {
      window.__clockWriteLog.push({ source: 'fallback', word: wordSpans[nextIdx].span.textContent, idx: nextIdx, t: performance.now() });
    }
    scheduleFallbackAdvance(nextIdx, generation); // keep the chain going for the word after this one
  }, delayMs);
}

// Fix 3c: syllable/consonant-risk-aware gating (replaces Fix 3b's flat
// grace-window test, skipped before live testing — see the note near
// IFRAME_RECYCLE_EVERY_N_CALLS above). Detects likely lip-closing
// consonants (bilabial: b, m, p) inside a word and estimates roughly when,
// in ms from the word's start, that sound would land — using the
// consonant's character position scaled against the word's total expected
// duration as a rough proxy for a uniform speaking rate across it. We don't
// have real phoneme-level timing, so this is a proportional estimate, not
// exact.
// Fix 3c-2 (correction): v1 skipped a risky consonant at position 0,
// reasoning "the natural mouth-open transition into the word already covers
// it." Live testing on "moved"/"performance"/"paused" (all word-initial m/p,
// no interior b/m/p) showed the opposite — producing a b/m/p sound at all
// requires closing the lips FIRST, so a word-initial one is a real closure
// moment right when elapsed time is lowest, which v1 left fully
// unprotected. Now included: timing≈0ms for a position-0 match, same
// risk-window treatment as any mid-word one.
const RISKY_CONSONANTS = /[bmp]/gi;
function estimateRiskyConsonantTimings(word, expectedDurationMs) {
  const timings = [];
  if (!word || word.length < 2 || expectedDurationMs <= 0) return timings;
  RISKY_CONSONANTS.lastIndex = 0;
  let match;
  while ((match = RISKY_CONSONANTS.exec(word)) !== null) {
    const proportion = match.index / word.length;
    timings.push(Math.round(proportion * expectedDurationMs));
  }
  return timings;
}

// Unvalidated starting guess — how wide (ms, each side of an estimated
// risky-consonant moment) the cautious/tight window is. Needs real-world
// tuning once this is live: too narrow and it won't catch the dip in time
// (sticky-word bug returns); too wide and it starts re-creating the
// original flat-window overshoot around every risky word.
const RISK_WINDOW_HALF_MS = 120;
function isWithinRiskyWindow(elapsedMs, riskyTimings) {
  for (let i = 0; i < riskyTimings.length; i++) {
    if (Math.abs(elapsedMs - riskyTimings[i]) <= RISK_WINDOW_HALF_MS) return true;
  }
  return false;
}

// --- Phase 12c: auto-scroll to active word ---
// Follows .word.active as reading progresses (via highlightWordAt, the single
// place the active word ever changes — both mouth-driven progression and
// manual word-click resync flow through it). Must yield to a reader who
// scrolls back up on their own rather than yanking them back down every
// tick, so a genuine user scroll gesture (wheel/touch drag/keyboard paging)
// latches autoScrollEnabled off. It re-latches on a fresh session start
// (Start Reading / word-click resync — both are "jump to a spot" actions
// already) OR after AUTO_SCROLL_RESUME_IDLE_MS of no further manual
// scrolling, whichever comes first (see the idle-resume timer above) — so a
// reader who glances back up gets picked back up automatically instead of
// auto-scroll staying off for the rest of the session.
let autoScrollEnabled = true;
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

// Phase 12c: shared by highlightWordAt (every natural word-boundary update)
// and the idle-resume timer above (catches back up after a manual-scroll
// pause expires, rather than waiting for the next word to trigger it).
// No-ops safely if called before any word is active yet.
function scrollToActiveWord() {
  if (activeWordIndex === -1) return;
  wordSpans[activeWordIndex].span.scrollIntoView({
    behavior: reducedMotionQuery.matches ? 'auto' : 'smooth',
    block: 'nearest'
  });
}

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
// Phase 9b: covers MediaPipe returning zero landmarks at all (camera pointed
// away entirely, obstructed, etc). Confirmed by code inspection (Entry 23):
// that case previously just skipped the frame silently, so isFaceVisible/
// mouthState froze at whatever they last were and TTS kept speaking
// indefinitely with nobody in frame. Not mobile-exclusive — same gap exists
// on laptop, just less likely to be triggered there. A short timeout rather
// than an immediate trip, so one dropped frame (camera hiccup, brief motion
// blur) doesn't falsely gate.
const NO_FACE_TIMEOUT_MS = 500;

// Head-pose gating (Phase 3) removed (Entry 45 — decided Entry 43, scoped
// Entry 44): the biological ceiling here (ALS-associated head-drop; lying
// down as a primary, not edge, use case — Section 1) meant "facing the
// screen" was an unreliable proxy for engagement for exactly the audience
// this app most needs to serve, and mouth movement already is the honest
// signal. isFaceVisible now means only "MediaPipe currently sees a face at
// all" (Phase 9b's job) — no yaw/pitch involved.

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

// Minimum required MAR gap between the neutral and mouthing-speech steps.
// Exists to reject a bad calibration run (e.g. user didn't actually mouth
// words) rather than silently saving broken thresholds. Set well below the
// real neutral-vs-mutter gap this project has actually measured (~0.023,
// see Phase 6a calibration notes) so a genuine attempt always clears it.
// (A matching MIN_POSE_THRESHOLD existed here for head-pose calibration —
// removed Entry 45 along with the rest of pose gating.)
const MIN_MAR_GAP = 0.015;

// Entry 46: Speed step rebuilt from the ground up — the Phase 11 regression
// above (multi-pass mutter sampling, peak-trough word-boundary detection,
// outlier rejection, OLS fit) is REMOVED. Reasoning (PROGRESS.md Section 3):
// it was inferring a number from noisy live mouth-timing data, which a
// live-picked value has none of. Replaced with a manual slider
// (0.5x-1.75x) + audible test-voice preview, tuned continuously (not
// discrete steps) via three hand-tuned anchor points and linear
// interpolation between them for whatever rate the user actually lands on.
// The slider value IS PERSONALIZED_RATE directly — no separate fit needed
// for that half. Only msPerSyllable/baseWordMs (used for cadence-gating
// tightness, not TTS playback) need interpolating.
//
// RATE_SLIDER_MIN/MAX, the rate anchors (with their Entry-47 data-tuning
// history), and interpolateCadence() now live in js/cadence.js (Entry 55
// modularization) — imported at the top of this file.

// Ambient trouble-shading + the plain-English warning box (formerly here
// and further below — they were never adjacent even in the original file)
// now live together in js/warningBox.js (Entry 55 modularization),
// imported at the top of this file.

// Phase 7b's 'facing'/'away' pose-calibration steps removed Entry 45
// alongside the rest of head-pose gating — wizard is 3 steps now, not 5.
// UI cleanup pass, round 3 (on-camera calibration): step 1's stillness gate
// and step 2's mouth-open gate both need a "confident enough" detection
// window AND a hard timeout fallback, so nobody — including someone with
// limited motor control — can get stuck on a step that never fires. The
// numbers below are reasoned starting guesses, not yet tuned against real
// logged data — same "unvalidated until tested live" status RISK_WINDOW_HALF_MS
// above carried before its own real-world tuning pass.
const STILLNESS_WINDOW_MS = 500;        // rolling window used to judge "not moving"
const STILLNESS_MAR_RANGE_MAX = 0.03;   // max MAR range within the window to count as "still"
const STILLNESS_MIN_HOLD_MS = 400;      // window must stay under the range max this long before unlocking
const STILLNESS_TIMEOUT_MS = 7000;      // auto-unlock the button anyway if stillness is never confidently detected

const MOUTH_OPEN_RELATIVE_DELTA = 0.05; // how far above the step-1 neutral baseline counts as "opened"
const MOUTH_OPEN_ABSOLUTE_FLOOR = 0.12; // backstop in case the neutral baseline itself came out noisy/near-zero
const MOUTH_OPEN_TIMEOUT_MS = 8000;     // auto-start sampling anyway if mouth-open is never confidently detected

const CALIBRATION_STEPS = [
  {
    id: 'neutral',
    label: 'Step 1 of 3 — Stay still',
    instruction: "Relax your mouth. We'll count down once you're steady.",
    sampleMs: 3000,
    metric: 'mar'
  },
  {
    id: 'mutter',
    label: 'Step 2 of 3 — Silent mouthing',
    instruction: 'Tap below, then silently mouth the sentence shown.',
    // Entry 53's UI cleanup, round 3: replaces "The quick brown fox jumps
    // over the lazy dog" — that sentence has zero b/m/p sounds, meaning
    // calibration never actually sampled a full lip closure, the one
    // movement RISKY_CONSONANTS/RISK_WINDOW_HALF_MS above specifically
    // exists to detect. This sentence hits b/m/p at both word-initial and
    // mid-word positions (Mumblew, helps, people, mouth, movements),
    // matching the Fix 3c-2 finding that word position matters.
    sentence: 'Mumblew helps people read by watching quiet mouth movements.',
    sampleMs: 4000,
    metric: 'mar'
  },
  {
    id: 'rate',
    // Entry 46: rebuilt from a timed mouthing sample into a manual slider —
    // see PROGRESS.md Section 3 for the full reasoning. No sampleMs; this
    // step doesn't run through the per-frame sampling pipeline at all
    // (updateCalibration() returns immediately for metric === 'rate').
    // Advancing happens via the "Set speed" button (finishRateStep below),
    // not a countdown.
    label: 'Step 3 of 3 — Your pace',
    instruction: 'Drag to a comfortable speed, then confirm.',
    metric: 'rate'
  }
];

// `active` is no longer a field on this object — it's tracked externally
// via getCalibrationActive()/setCalibrationActive() (js/readingState.js),
// since it's the one calibration field read outside calibration itself
// (mouth-tracking's gating, the warning box, button-disabled states). See
// PROGRESS.md Section 2 and readingState.js's header comment.
let calibration = {
  stepIndex: -1,
  // UI cleanup pass, round 3: 'awaiting-stillness' (step 1, gated by
  // detection) -> 'sampling' (unchanged pipeline). 'awaiting-ready' (step 2,
  // gated by the user's own click) -> 'awaiting-mouth-open' (gated by
  // detection) -> 'sampling' (unchanged pipeline). Rate step doesn't use
  // phase at all. Replaces the old fixed-timer 'prep' phase entirely.
  phase: null,
  phaseStartTime: 0,
  currentSamples: [],   // samples for the step currently being collected (mar/pose steps)
  results: {},           // stepId -> array of samples, filled in as steps complete
  // Rolling buffer for step 1's stillness check — {t, mar} pairs within the
  // last STILLNESS_WINDOW_MS, trimmed each frame in updateCalibration().
  stillnessBuffer: [],
  stillnessConfirmed: false,
  stillnessConfirmedAt: 0,
  neutralBaselineMar: null, // computed once, when step 2's mouth-open watch begins
  // Entry 46: replaces the old rateTracker — just the slider's current
  // value, live-updated on 'input' while the rate step is showing, read
  // once when the user confirms via finishRateStep().
  selectedRate: DEFAULT_PERSONALIZED_RATE,
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
const speedCalibrationValueEl = document.getElementById('speedCalibrationValue');
// UI cleanup pass, round 3: the on-camera action button shared by steps 1
// and 2 (step 1: "Press when ready", unlocked by stillness detection;
// step 2: "Ready to mumble?", always enabled immediately) and the sentence
// display for step 2, revealed only once that button is pressed.
const calActionBtnEl = document.getElementById('calActionBtn');
const calSentenceEl = document.getElementById('calSentence');
const calSentenceTimerEl = document.getElementById('calSentenceTimer');
const calErrorCardEl = document.getElementById('calErrorCard');

function average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function startCalibration() {
  // Stop any active reading first — calibration and reading shouldn't run
  // at the same time, and this reuses the same safe-reset pattern as the
  // Start Reading button (cancel() is safe even if nothing is speaking).
  setManualCancel(true);
  cancelActiveSpeech();
  setIsSpeakingChunk(false);
  setReadingActive(false);
  speechStateEl.textContent = 'idle (calibrating)';

  calibration = {
    stepIndex: 0,
    phase: 'awaiting-stillness',
    phaseStartTime: performance.now(),
    currentSamples: [],
    results: {},
    stillnessBuffer: [],
    stillnessConfirmed: false,
    stillnessConfirmedAt: 0,
    neutralBaselineMar: null,
    selectedRate: DEFAULT_PERSONALIZED_RATE
  };
  setCalibrationActive(true);

  startBtn.disabled = true;
  calibrateBtn.disabled = true;
  speechSwitchBtn.classList.add('is-inactive'); // predictLoop skips the per-frame sync during calibration, so set explicitly here
  calibrationRetryBtn.style.display = 'none';
  calibrationMessageEl.textContent = '';
  calErrorCardEl.style.display = 'none';
  calibrationPanel.style.display = 'block';
  setCalibrationVideoVisible(true); // student needs to see themselves to position for calibration
  renderCalibrationStep();
  updateProgressUI();
}

function cancelCalibration() {
  setCalibrationActive(false);
  calibrationPanel.style.display = 'none';
  setCalibrationVideoVisible(false);
  updateStartButtonState();
  updateCalibrateButtonState();
  updateProgressUI();
}

function renderCalibrationStep() {
  const step = CALIBRATION_STEPS[calibration.stepIndex];
  calibrationStepEl.textContent = step.label;
  calibrationInstructionEl.textContent = step.instruction;
  calSentenceEl.style.display = 'none';
  calSentenceEl.textContent = '';
  calSentenceTimerEl.style.display = 'none';

  const isRateStep = step.metric === 'rate';
  rateStepPanelEl.style.display = isRateStep ? 'block' : 'none';
  calibrationCountdownEl.style.display = 'none';
  calActionBtnEl.style.display = 'none';

  if (isRateStep) {
    calibration.selectedRate = DEFAULT_PERSONALIZED_RATE;
    rateSliderEl.value = String(DEFAULT_PERSONALIZED_RATE);
    updateRateSliderReadout();
  } else if (calibration.stepIndex === 0) {
    // Step 1: button starts disabled — updateCalibration()'s stillness
    // check (or its timeout fallback) is what enables it.
    calActionBtnEl.style.display = 'inline-block';
    calActionBtnEl.disabled = true;
    calActionBtnEl.textContent = 'Press when ready';
  } else {
    // Step 2: this button is always enabled immediately — unlike step 1,
    // nothing needs to be detected before the person can say "I'm ready to
    // start," since they haven't done anything yet for us to detect.
    calActionBtnEl.style.display = 'inline-block';
    calActionBtnEl.disabled = false;
    calActionBtnEl.textContent = 'Ready to mumble?';
  }
}

// Entry 46: slider UI for the manual Speed step. Live-updates the readout
// and calibration.selectedRate on every drag/arrow-key tick; nothing is
// applied to the live app until finishRateStep() commits it, same
// "preview vs commit" separation the old step had (sampling vs finish).
// UI cleanup pass, round 3: the one on-camera action button, shared by
// steps 1 and 2 since only one of them is ever visible at a time (see
// renderCalibrationStep). Each branch is a manual, user-paced transition —
// detection only ever unlocks or auto-times-out a button; it never fires a
// transition by itself without the person's own click, so a stray moment
// of stillness or an accidental mouth twitch can't start a countdown
// nobody asked for yet.
function onCalActionBtnClick() {
  const now = performance.now();

  if (calibration.stepIndex === 0 && calibration.phase === 'awaiting-stillness') {
    calibration.phase = 'sampling';
    calibration.phaseStartTime = now;
    calibration.currentSamples = [];
    calActionBtnEl.style.display = 'none';
    calibrationCountdownEl.style.display = 'block';
    calibrationInstructionEl.textContent = '';
  } else if (calibration.stepIndex === 1 && calibration.phase === 'awaiting-ready') {
    calibration.neutralBaselineMar = average(calibration.results.neutral.map((s) => s.mar));
    calibration.phase = 'awaiting-mouth-open';
    calibration.phaseStartTime = now;
    calActionBtnEl.style.display = 'none';
    calSentenceEl.textContent = `"${CALIBRATION_STEPS[1].sentence}"`;
    calSentenceEl.style.display = 'block';
    calibrationInstructionEl.textContent = 'Go ahead whenever you like.';
  }
}
calActionBtnEl.addEventListener('click', onCalActionBtnClick);

function updateRateSliderReadout() {
  const rate = parseFloat(rateSliderEl.value);
  calibration.selectedRate = rate;
  rateValueEl.textContent = `${rate.toFixed(2)}x`;
}

function testRateVoice() {
  try {
    const utterance = new SpeechSynthesisUtterance(SAMPLE_SENTENCE);
    utterance.rate = calibration.selectedRate;
    const voice = resolveSelectedVoice(window.speechSynthesis);
    if (voice) utterance.voice = voice;
    window.speechSynthesis.cancel(); // stop any previous preview before starting a new one
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    console.error('Test voice preview failed:', err);
  }
}

// Confirms the slider's current value and advances past the rate step —
// the manual-step equivalent of completeCalibrationStep() finishing a
// timed mar/pose sample. Stores { rate } as this step's result; finishCalibration
// reads it back via calibration.results.rate.rate.
function finishRateStep() {
  window.speechSynthesis.cancel(); // stop any in-progress test-voice preview
  completeCalibrationStep(performance.now(), { rate: calibration.selectedRate });
}

// Called once per frame from predictLoop while calibration is active. Handles
// both the prep countdown (gives the user a moment to get into position
// before we start trusting samples) and the actual sampling window.
// Shared by both the mar/pose timeout path and the rate step's early-completion
// path: records this step's result, then either moves to the next step's prep
// phase or, if this was the last step, runs finishCalibration().
function completeCalibrationStep(now, resultForStep) {
  const step = CALIBRATION_STEPS[calibration.stepIndex];
  calibration.results[step.id] = resultForStep;
  calibration.stepIndex += 1;

  if (calibration.stepIndex >= CALIBRATION_STEPS.length) {
    finishCalibration();
  } else {
    // UI cleanup pass, round 3: step 2 starts in 'awaiting-ready' — nothing
    // to detect yet, just waiting on the person's own "Ready to mumble?"
    // click (see onCalActionBtnClick). The rate step doesn't use phase at
    // all (updateCalibration() returns immediately for metric === 'rate'),
    // so phase is left null there rather than implying a state that's
    // never actually checked.
    calibration.phase = calibration.stepIndex === 1 ? 'awaiting-ready' : null;
    calibration.phaseStartTime = now;
    calibration.currentSamples = [];
    calibration.stillnessBuffer = [];
    calibration.stillnessConfirmed = false;
    calibration.stillnessConfirmedAt = 0;
    renderCalibrationStep();
  }
}

// Handles all four calibration phases. Called once per frame from
// predictLoop while calibration is active (rate step excepted — it's a
// manual slider, never routed through here). 'awaiting-ready' does nothing
// per-frame (purely waiting on the person's own click); 'awaiting-stillness'
// and 'awaiting-mouth-open' both run a live detection check with a timeout
// fallback; 'sampling' is the original fixed-duration collection window,
// unchanged from before this pass — only how each step *arrives* at
// sampling changed, not sampling itself.
function updateCalibration(mar) {
  const step = CALIBRATION_STEPS[calibration.stepIndex];
  if (step.metric === 'rate') return; // handled entirely by the slider UI, not per-frame

  const now = performance.now();
  const elapsed = now - calibration.phaseStartTime;

  if (calibration.phase === 'awaiting-ready') {
    return; // nothing to detect yet — waiting on the person's own click
  }

  if (calibration.phase === 'awaiting-stillness') {
    calibration.stillnessBuffer.push({ t: now, mar });
    calibration.stillnessBuffer = calibration.stillnessBuffer.filter(
      (s) => now - s.t <= STILLNESS_WINDOW_MS
    );

    const marsInWindow = calibration.stillnessBuffer.map((s) => s.mar);
    // Fewer than 2 samples isn't enough to judge variance yet — treat as
    // "not still" rather than a false positive on the very first frame.
    const range = marsInWindow.length > 1
      ? Math.max(...marsInWindow) - Math.min(...marsInWindow)
      : Infinity;
    const isCurrentlyStill = range <= STILLNESS_MAR_RANGE_MAX;

    if (isCurrentlyStill) {
      if (!calibration.stillnessConfirmed) {
        const oldest = calibration.stillnessBuffer[0];
        if (oldest && now - oldest.t >= STILLNESS_MIN_HOLD_MS) {
          calibration.stillnessConfirmed = true;
          calibration.stillnessConfirmedAt = now;
        }
      }
    } else {
      // A real movement resets confirmation, but NOT the overall elapsed
      // timer below — a fidgety person still reaches the fallback instead
      // of waiting forever for a stillness read that may never come.
      calibration.stillnessConfirmed = false;
    }

    if (calibration.stillnessConfirmed && calActionBtnEl.disabled) {
      calActionBtnEl.disabled = false;
      calibrationInstructionEl.textContent = "Ready — press below to start.";
    } else if (!calibration.stillnessConfirmed && elapsed >= STILLNESS_TIMEOUT_MS && calActionBtnEl.disabled) {
      // Fallback: never got a confident still-enough read. Unlock anyway
      // rather than leaving someone stuck on a step that may never
      // register for them — see this pass's constants comment above
      // CALIBRATION_STEPS for the reasoning.
      calActionBtnEl.disabled = false;
      calibrationInstructionEl.textContent = "Whenever you're ready, press below.";
    }
    return;
  }

  if (calibration.phase === 'awaiting-mouth-open') {
    // Bootstrapped from step 1's own just-measured neutral baseline, not a
    // hardcoded constant — the personalized open/close thresholds this
    // whole calibration run produces don't exist yet, so this can only ever
    // be a relative comparison against this person's own resting MAR,
    // backed by an absolute floor in case that baseline itself came out
    // noisy. Same relative-baseline + absolute-floor pattern as the Entry
    // 50 low-light fix, reused rather than reinvented.
    const baseline = calibration.neutralBaselineMar ?? 0;
    const openedEnough = mar >= baseline + MOUTH_OPEN_RELATIVE_DELTA || mar >= MOUTH_OPEN_ABSOLUTE_FLOOR;

    if (openedEnough || elapsed >= MOUTH_OPEN_TIMEOUT_MS) {
      calibration.phase = 'sampling';
      calibration.phaseStartTime = now;
      calibration.currentSamples = [];
      // The sentence stays visible — the person is actively reading it
      // right now, mid-mumble. Only the button-slot changes, from nothing
      // (already hidden since the "Ready to mumble?" click) to a small
      // recording indicator. The giant center countdown stays off for this
      // step — see the sampling branch below for why.
      calSentenceTimerEl.style.display = 'block';
      calibrationInstructionEl.textContent = '';
    }
    return;
  }

  // phase === 'sampling' — unchanged pipeline from before this pass.
  // Entry 50: also record the live brightness reading alongside each MAR
  // sample. Costs nothing extra — sampleBrightness() already runs on its
  // own interval and currentBrightness is just read here, not recomputed.
  // Only the 'neutral' step's samples actually get used (see
  // finishCalibration()) — this step is the natural "what does normal
  // reading light look like for this person" moment, since it already asks
  // them to sit still in their real reading position/lighting.
  calibration.currentSamples.push({ mar, brightness: getCurrentBrightness() });
  const remaining = Math.max(0, step.sampleMs - elapsed);
  const remainingSeconds = Math.ceil(remaining / 1000);

  if (calibration.stepIndex === 0) {
    // Step 1: nothing else on screen, so the giant center digit is the
    // whole point — no need to spell out "Hold it..." to be understood.
    calibrationCountdownEl.textContent = `${remainingSeconds}`;
  } else {
    // Step 2: the sentence is the thing that needs attention here, not the
    // countdown — a small "Recording… Ns" next to it instead of a giant
    // digit taking over the screen and competing with what they're reading.
    calSentenceTimerEl.textContent = `Recording… ${remainingSeconds}`;
  }

  if (elapsed >= step.sampleMs) {
    completeCalibrationStep(now, calibration.currentSamples);
  }
}

// REMOVED Entry 46: recordRateWordBoundary, updateRateCalibration, median,
// filterRateOutliers, fitDurationRegression — the entire peak-trough
// tracker + OLS regression + outlier-rejection stack. Replaced by the
// manual slider + interpolateCadence() above. See PROGRESS.md Section 3
// for the full reasoning.

function finishCalibration() {
  const neutralMar = average(calibration.results.neutral.map(s => s.mar));
  const mutterMar = average(calibration.results.mutter.map(s => s.mar));

  // Entry 50: light baseline for the self-calibrating low-light warning —
  // "what does normal brightness look like for this reader, on this
  // camera" — from the same neutral-step samples already being collected
  // above, no separate step needed. Guarded with `|| null` rather than
  // assuming it's always populated: brightness sampling depends on
  // sampleBrightness() having run at least once (LIGHT_SAMPLE_INTERVAL_MS
  // after startup), which the neutral step's 1s prep + 3s sample window
  // comfortably covers in practice, but a defensive fallback costs nothing.
  const neutralBrightnessSamples = calibration.results.neutral
    .map(s => s.brightness)
    .filter(b => typeof b === 'number');
  const lightBaseline = neutralBrightnessSamples.length > 0
    ? average(neutralBrightnessSamples)
    : null;

  // Reject a run that couldn't have produced meaningful thresholds, rather
  // than silently saving broken values: mouth didn't move enough between
  // neutral/mutter. (A second failure mode — head didn't turn enough
  // between facing/away — existed here until Entry 45's head-pose removal.)
  const marGap = mutterMar - neutralMar;

  if (marGap < MIN_MAR_GAP) {
    // UI cleanup pass, round 3 (student nudge): short, plain-English, no
    // app-internal vocabulary ("neutral"/"mutter"/"gap") — same fact as
    // before, said the way a non-technical person would actually say it.
    showCalibrationFailure("Couldn't tell you were mumbling. Move your mouth a bit more.");
    return;
  }

  // Same margin logic used by hand for the original OPEN/CLOSE thresholds:
  // sit closeThreshold and openThreshold inside the neutral-to-mutter gap,
  // in that order, so the existing hysteresis check (open above, close
  // below) keeps working unchanged.
  const closeThreshold = neutralMar + marGap * 0.33;
  const openThreshold = neutralMar + marGap * 0.67;

  // Entry 46: rate/cadence numbers now come from the manual slider, not a
  // regression — no fit to reject/clamp, the user's chosen value IS the
  // rate, and interpolateCadence() derives the matching cadence-gating
  // pair from it. See RATE_ANCHORS' comment for how those anchor points
  // were chosen.
  const personalizedRate = calibration.results.rate.rate;
  const cadence = interpolateCadence(personalizedRate);
  const msPerSyllablePersonal = cadence.msPerSyllable;
  const baseWordMsPersonal = cadence.baseWordMs;

  const rateFitDebugValueEl = document.getElementById('rateFitDebugValue');
  rateFitDebugValueEl.textContent =
    `manual rate=${personalizedRate.toFixed(2)}x, interpolated msPerSyll=${msPerSyllablePersonal.toFixed(1)}, ` +
    `baseWordMs=${baseWordMsPersonal.toFixed(1)}`;

  const data = {
    openThreshold,
    closeThreshold,
    msPerSyllablePersonal,
    baseWordMsPersonal,
    personalizedRate,
    lightBaseline,
    calibratedAt: new Date().toISOString()
  };

  try {
    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(data));
  } catch (err) {
    console.error('Could not save calibration:', err);
  }

  applyCalibration(data);

  // Entry 60: fire-and-forget, muted, runs in the background. Deliberately
  // AFTER applyCalibration() so estimateWordDuration() inside the probe
  // already reflects the rate/cadence just picked — see the probe's own
  // comment block for why. Doesn't block or delay the "Saved" UI below.
  // Held back until runResumeOffsetDiagnostic() confirmed a corrected
  // factor is a sufficient fix (matched-shape test showed a flat, non-
  // growing ~1-word residual instead of the unbounded growth an
  // uncorrected factor produces) — now safe to wire in.
  runSilentFallbackProbe(personalizedRate);

  calibrationStepEl.textContent = 'All done ✓';
  calActionBtnEl.style.display = 'none';
  calSentenceEl.style.display = 'none';
  // Entry 50 follow-up: doesn't block calibration (the neutral/mutter MAR
  // gap check above already covers whether mouth-tracking itself worked) —
  // just an honest heads-up, matching the project's usual "tell them, don't
  // fail silently" approach. Reuses lighting.js's ABSOLUTE_DARK_EXIT_THRESHOLD
  // as the reference point rather than inventing a third light constant.
  // UI cleanup pass, round 3 (student nudge): shortened to match the same
  // plain-English, no-jargon bar as the error message above.
  const isDimCalibration = typeof lightBaseline === 'number' && lightBaseline < ABSOLUTE_DARK_EXIT_THRESHOLD;
  if (isDimCalibration) {
    calibrationInstructionEl.textContent =
      "Saved. It's a bit dim right now — for best results, redo this somewhere brighter later.";
  } else {
    calibrationInstructionEl.textContent = 'Saved for this device.';
  }
  calibrationCountdownEl.style.display = 'none';
  calibrationCountdownEl.textContent = '';
  setCalibrationActive(false);
  updateStartButtonState();
  updateCalibrateButtonState();
  setTimeout(() => {
    calibrationPanel.style.display = 'none';
    setCalibrationVideoVisible(false);
  }, isDimCalibration ? 6000 : 2000); // longer hold so the advisory is actually readable
}

function showCalibrationFailure(message) {
  setCalibrationActive(false);
  calibrationMessageEl.textContent = message;
  calibrationRetryBtn.style.display = 'inline-block';
  calErrorCardEl.style.display = 'flex';
  // Clear the rest of the overlay so the error card is the only thing
  // showing — otherwise a stale countdown/sentence/button could linger
  // underneath it.
  calActionBtnEl.style.display = 'none';
  calSentenceEl.style.display = 'none';
  calSentenceTimerEl.style.display = 'none';
  calibrationCountdownEl.style.display = 'none';
  updateStartButtonState();
  updateCalibrateButtonState();
  updateProgressUI();
}

// Applies a calibration result (either freshly computed or loaded from
// localStorage) to the live thresholds used everywhere else in the file.
function applyCalibration(data) {
  OPEN_THRESHOLD = data.openThreshold;
  CLOSE_THRESHOLD = data.closeThreshold;

  const when = new Date(data.calibratedAt).toLocaleString();
  calibrationStatusValueEl.textContent = `custom (calibrated ${when})`;

  // Phase 11: fields introduced after this file's first calibration format
  // shipped (Phase 7b). A calibration saved before today's change won't have
  // these — fall back to the untouched defaults rather than reading
  // `undefined` into MS_PER_SYLLABLE/PERSONALIZED_RATE, so an existing
  // user's saved MAR/pose calibration keeps working exactly as before until
  // they run the wizard again and pick up a Speed measurement too.
  // Note (mobile testing session, post-Entry-22): MS_PER_SYLLABLE can now
  // legitimately land very low (see MIN_MS_PER_SYLLABLE's comment above) —
  // for a user whose real fit looks like that, expected duration during
  // live reading will barely grow with word length, since it's applied
  // uniformly to real reading text (not just the fixed sample sentence).
  // That's the correct reflection of a real regression, not a bug to guess
  // around pre-emptively — but if an unusually long real word starts
  // getting cut off too early during actual reading (cadence threshold
  // tightening before the word is realistically done), that's the concrete
  // symptom to watch for and revisit against, not something to fix blind.
  if (typeof data.msPerSyllablePersonal === 'number') {
    setPersonalizedCadence({
      msPerSyllable: data.msPerSyllablePersonal,
      baseWordMs: data.baseWordMsPersonal,
      personalizedRate: data.personalizedRate,
    });
    const cadence = getPersonalizedCadence();
    speedCalibrationValueEl.textContent =
      `custom (${cadence.personalizedRate.toFixed(2)}x rate, ${Math.round(cadence.msPerSyllable)}ms/syllable)`;
  } else {
    resetPersonalizedCadence();
    speedCalibrationValueEl.textContent = 'using default pacing (calibrate to personalize)';
  }

  // Entry 50: low-light thresholds, relative to this device's own
  // calibrated baseline rather than a fixed number — see js/lighting.js for
  // the full reasoning. Same fallback pattern as the speed block above: no
  // baseline yet (calibration predates this feature, or the neutral step's
  // brightness samples somehow came back empty) means keep using the fixed
  // DEFAULT_* values, not `undefined` — handled inside setLowLightBaseline().
  const lightBaselineValueEl = document.getElementById('lightBaselineValue');
  if (typeof data.lightBaseline === 'number' && data.lightBaseline > 0) {
    setLowLightBaseline(data.lightBaseline);
    if (lightBaselineValueEl) {
      lightBaselineValueEl.textContent =
        `custom (baseline ${data.lightBaseline.toFixed(1)}, warns below ${getLowLightThresholds().enter.toFixed(1)})`;
    }
  } else {
    setLowLightBaseline(null);
    if (lightBaselineValueEl) {
      lightBaselineValueEl.textContent = 'using default fallback (calibrate to personalize)';
    }
  }

  // UI cleanup pass: this is the one function that runs whether calibration
  // just finished live or was restored from localStorage at startup, so
  // it's the right single place to flip this — see hasCustomCalibration's
  // declaration for the reasoning.
  hasCustomCalibration = true;
  updateProgressUI();
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

// Entry 46: manual Speed step controls.
const rateStepPanelEl = document.getElementById('rateStepPanel');
const rateSliderEl = document.getElementById('rateSlider');
const rateValueEl = document.getElementById('rateValue');
const rateTestVoiceBtn = document.getElementById('rateTestVoiceBtn');
const rateFinishBtn = document.getElementById('rateFinishBtn');

rateSliderEl.min = String(RATE_SLIDER_MIN);
rateSliderEl.max = String(RATE_SLIDER_MAX);
rateSliderEl.step = '0.01';
rateSliderEl.addEventListener('input', updateRateSliderReadout);
rateTestVoiceBtn.addEventListener('click', testRateVoice);
rateFinishBtn.addEventListener('click', finishRateStep);

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

// --- Phase 10a: text loading, persistence, and session reset ---

function hasLoadedText() {
  return typeof currentText === 'string' && currentText.trim().length > 0;
}

// Start Reading must reflect real text availability at all times, including
// through the calibration flow (which unconditionally re-enables startBtn on
// cancel/complete/failure) — centralizing this here means every one of those
// call sites can just call this instead of guessing startBtn.disabled = false
// is always correct.
function updateStartButtonState() {
  // Entry 53: cameraGranted added — startBtn used to only check text/
  // calibration state, silently assuming the webcam was already running
  // (true before Entry 53, since setup() auto-started it). Now that camera
  // access is gated behind an explicit click, Start Reading has to wait on
  // it too, or predictLoop would never be running when it's clicked.
  startBtn.disabled = !hasLoadedText() || !cameraGranted || getCalibrationActive();
}

// Entry 53: same "single source of truth" pattern as updateStartButtonState
// above. calibrateBtn used to just get hardcoded to `.disabled = false` at
// every "re-enable" call site (cancel/finish/fail), which was safe before
// Entry 53 because the webcam was always already running by the time any of
// those could fire. Now that camera access is gated behind an explicit
// click, every one of those call sites needs to check cameraGranted instead
// of assuming it — centralizing here means they can't drift out of sync.
function updateCalibrateButtonState() {
  calibrateBtn.disabled = !cameraGranted || getCalibrationActive();
}

function wordCount(text) {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

// --- UI cleanup pass: progressive disclosure (Section 3d #5) ------------
// Restructures the setup flow (text -> calibrate -> read) into a 3-dot
// progress strip + accordion, so the next step is visually obvious without
// reading anything. Deliberately reuses state that already exists
// (hasLoadedText(), cameraGranted, hasCustomCalibration below) rather than
// tracking anything new, so this can't drift out of sync with what
// updateStartButtonState()/updateCalibrateButtonState() already decide.
// hasCustomCalibration mirrors those two functions' "single source of
// truth" pattern: set once, in applyCalibration() (the one function that
// runs whether calibration just finished or was loaded from localStorage),
// rather than re-derived ad hoc at each call site.
let hasCustomCalibration = false;

const pStepTextEl = document.getElementById('pStepText');
const pStepCalEl = document.getElementById('pStepCal');
const pStepReadEl = document.getElementById('pStepRead');
const pLine1El = document.getElementById('pLine1');
const pLine2El = document.getElementById('pLine2');
const textInputPanelEl = document.getElementById('textInputPanel');
const textPanelHeaderEl = document.getElementById('textPanelHeader');
const textPanelSummaryEl = document.getElementById('textPanelSummary');
const calibrationEntryEl = document.getElementById('calibrationEntry');
const calPanelSummaryEl = document.getElementById('calPanelSummary');
const readStepEl = document.getElementById('readStep');
const readHintEl = document.getElementById('readHint');

// Moves the .step-glow cue (same gradient-border shimmer as the camera
// frame, see index.html's CSS comment) onto exactly one element at a time —
// whichever step the person hasn't finished yet.
function setStepGlow(activeEl) {
  [textInputPanelEl, calibrationEntryEl, readStepEl].forEach(node => {
    if (node) node.classList.remove('step-glow');
  });
  if (activeEl) activeEl.classList.add('step-glow');
}

// Single reconciliation point, called after every state change that could
// affect "what's the next step" — text loaded/cleared, calibration
// started/finished/cancelled/failed, camera granted. Only touches summaries,
// dots, and the glow cue; panel expand/collapse for the text accordion is
// driven explicitly at the actual load-text transition (see setCurrentText
// below), so this function can be called defensively elsewhere without
// fighting a manual expand/collapse the person just did.
function updateProgressUI() {
  const textDone = hasLoadedText();
  const calDone = hasCustomCalibration;

  if (textDone) {
    const n = wordCount(currentText);
    textPanelSummaryEl.textContent = `${n} word${n === 1 ? '' : 's'} loaded ✓`;
    textPanelSummaryEl.classList.add('ok');
  } else {
    textPanelSummaryEl.textContent = '';
    textPanelSummaryEl.classList.remove('ok');
  }

  if (!textDone) {
    calPanelSummaryEl.textContent = 'Add your text first';
    calPanelSummaryEl.classList.remove('ok');
  } else if (calDone) {
    calPanelSummaryEl.textContent = `Calibrated ✓ · ${getPersonalizedCadence().personalizedRate.toFixed(2)}x`;
    calPanelSummaryEl.classList.add('ok');
  } else if (getCalibrationActive()) {
    calPanelSummaryEl.textContent = 'Calibrating…';
    calPanelSummaryEl.classList.remove('ok');
  } else {
    calPanelSummaryEl.textContent = 'Not calibrated yet';
    calPanelSummaryEl.classList.remove('ok');
  }

  if (textDone && calDone) {
    readHintEl.textContent = 'Ready when you are';
  } else if (!textDone) {
    readHintEl.textContent = 'Add text and calibrate to unlock this';
  } else {
    readHintEl.textContent = 'Calibrate to unlock this';
  }

  [pStepTextEl, pStepCalEl, pStepReadEl].forEach(el => el.classList.remove('active', 'done'));
  pLine1El.classList.remove('done');
  pLine2El.classList.remove('done');

  if (!textDone) {
    pStepTextEl.classList.add('active');
    setStepGlow(textInputPanelEl);
  } else if (!calDone) {
    pStepTextEl.classList.add('done');
    pStepCalEl.classList.add('active');
    pLine1El.classList.add('done');
    setStepGlow(calibrationEntryEl);
  } else {
    pStepTextEl.classList.add('done');
    pStepCalEl.classList.add('done');
    pStepReadEl.classList.add('active');
    pLine1El.classList.add('done');
    pLine2El.classList.add('done');
    setStepGlow(readStepEl);
  }
}

// Manual expand/collapse for the text accordion — always available
// regardless of state, same "collapsible, never locked" pattern as the
// Entry 45 warning box, so a completed step can still be reopened to edit.
if (textPanelHeaderEl) {
  textPanelHeaderEl.addEventListener('click', () => {
    textInputPanelEl.classList.toggle('expanded');
  });
}

// UI cleanup pass, round 2: settings + debug as fixed corner widgets,
// reusing the exact toggle/[hidden]-panel/aria-expanded pattern the Entry 51
// feedback widget already established (see openFeedbackPanel/
// closeFeedbackPanel further down) rather than inventing a second
// mechanism — same reasoning as reusing .step-glow instead of a new cue.
// Settings and debug corner-widget panels now live in js/panels.js (Entry
// 55 modularization) — imported at the top of this file for its side
// effects (wires its own buttons on load, no exports needed).

// Single entry point for adopting new reading text, whether from the Load
// Text button, a restored localStorage session, or (future) 10d's PDF
// extraction. Hard-stops any in-progress reading session first — loading new
// text mid-read would otherwise leave baseOffset/wordSpans pointing at text
// that no longer matches what's on screen. cancel() is safe to call even
// when nothing is speaking (same reasoning as startBtn's click handler).
function setCurrentText(text, sourceLabel, opts = {}) {
  const persist = opts.persist !== false;

  setManualCancel(true);
  cancelActiveSpeech();
  setIsSpeakingChunk(false);
  setReadingActive(false);

  currentText = text;
  wordSpans = buildWordSpans(currentText);
  activeWordIndex = -1;
  baseOffset = 0;
  lastBoundaryOffset = 0;
  resetTroubleShading();
  speechStateEl.textContent = 'idle (new text loaded)';

  const n = wordCount(currentText);
  textLoadStatusEl.style.color = '#555';
  textLoadStatusEl.textContent = `Loaded: ${sourceLabel} (${n} word${n === 1 ? '' : 's'}).`;

  updateStartButtonState();

  // UI cleanup pass: text is the "done" step now — collapse its panel to a
  // summary line and hand the .step-glow cue to whichever step is next.
  // Applies uniformly whether this came from a real load-text click, a
  // restored session, or PDF extraction, since they all funnel through here.
  textInputPanelEl.classList.remove('expanded');
  updateProgressUI();

  if (persist) {
    idbSetText({
      text: currentText,
      sourceLabel,
      savedAt: new Date().toISOString()
    }).catch((err) => {
      console.error('Could not save reading text:', err);
    });
  }
}

function showTextLoadError(message) {
  textLoadStatusEl.style.color = '#b00020';
  textLoadStatusEl.textContent = message;
}

// Runs once at startup, alongside loadSavedCalibration(). If a previous
// session's text is found, restore it into both currentText and the
// textarea (so it's visible/editable) and enable Start immediately, same as
// if it had just been loaded this session.
//
// One-time migration: anyone who used the app before this change has their
// saved text sitting in the old localStorage key, not IndexedDB. Check
// IndexedDB first (the normal path going forward); only if it's empty, fall
// back to localStorage, restore from there, write it into IndexedDB, and
// remove the old key — so migration happens transparently on next load and
// never runs twice.
async function loadSavedText() {
  let data = null;

  try {
    data = await idbGetText();
  } catch (err) {
    console.error('Could not read saved reading text from IndexedDB:', err);
  }

  if (!data) {
    try {
      const raw = localStorage.getItem(TEXT_STORAGE_KEY);
      if (raw) {
        const legacy = JSON.parse(raw);
        if (typeof legacy.text === 'string' && legacy.text.trim().length > 0) {
          data = legacy;
          idbSetText(legacy)
            .then(() => localStorage.removeItem(TEXT_STORAGE_KEY))
            .catch((err) => console.error('Could not migrate saved text to IndexedDB:', err));
        }
      }
    } catch (err) {
      console.error('Saved reading text (legacy localStorage) was corrupted, ignoring:', err);
    }
  }

  if (!data || typeof data.text !== 'string' || data.text.trim().length === 0) return;

  textInputAreaEl.value = data.text;
  resizeTextareaToFit(textInputAreaEl);
  const when = new Date(data.savedAt).toLocaleString();
  setCurrentText(data.text, `restored from last session, ${when}`, { persist: false });
}

loadTextBtnEl.addEventListener('click', () => {
  const text = textInputAreaEl.value;
  if (text.trim().length === 0) {
    showTextLoadError('The text box is empty — type/paste some text or upload a .txt file first.');
    return;
  }
  const sourceLabel = lastLoadedFileName ? lastLoadedFileName : 'pasted/typed text';
  setCurrentText(text, sourceLabel);
});

// Editing the box by hand after a file was loaded into it means the content
// no longer strictly matches that file — drop the filename hint so the next
// Load Text click is correctly labeled "pasted/typed text" instead of lying
// about the source.
textInputAreaEl.addEventListener('input', () => {
  lastLoadedFileName = null;
  resizeTextareaToFit(textInputAreaEl);
});

// pdf.js loading + text extraction (extractPdfText) now live in
// js/storage.js (Entry 55 modularization), imported at the top of this
// file. MAX_UPLOAD_FILE_SIZE_BYTES below is also imported from there.

async function handlePdfFile(file) {
  textLoadStatusEl.style.color = '#555';
  textLoadStatusEl.textContent = `Reading "${file.name}"…`;

  let text;
  try {
    text = await extractPdfText(file);
  } catch (err) {
    console.error('PDF extraction failed:', err);
    showTextLoadError(`Could not read "${file.name}" — it may be password-protected or corrupted.`);
    return;
  }

  if (text.trim().length === 0) {
    showTextLoadError(`"${file.name}" has no extractable text — it may be a scanned/image-only PDF.`);
    return;
  }

  textInputAreaEl.value = text;
  resizeTextareaToFit(textInputAreaEl);
  lastLoadedFileName = file.name;
  textLoadStatusEl.style.color = '#555';
  textLoadStatusEl.textContent = `"${file.name}" loaded into the box below — click Load Text to use it.`;
}

// MAX_UPLOAD_FILE_SIZE_BYTES (20MB ceiling — see storage.js for the full
// rationale) is imported from js/storage.js.

txtFileInputEl.addEventListener('change', () => {
  const file = txtFileInputEl.files[0];
  if (!file) return;

  const lowerName = file.name.toLowerCase();
  const isTxt = lowerName.endsWith('.txt');
  const isPdf = lowerName.endsWith('.pdf');

  if (!isTxt && !isPdf) {
    showTextLoadError('Please choose a .txt or .pdf file.');
    txtFileInputEl.value = '';
    return;
  }

  if (file.size > MAX_UPLOAD_FILE_SIZE_BYTES) {
    showTextLoadError(`"${file.name}" is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB, limit 20MB).`);
    txtFileInputEl.value = '';
    return;
  }

  if (isPdf) {
    handlePdfFile(file);
    txtFileInputEl.value = ''; // allow re-selecting the same file later
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result);
    if (text.trim().length === 0) {
      showTextLoadError(`"${file.name}" appears to be empty.`);
      return;
    }
    textInputAreaEl.value = text;
    resizeTextareaToFit(textInputAreaEl);
    lastLoadedFileName = file.name;
    textLoadStatusEl.style.color = '#555';
    textLoadStatusEl.textContent = `"${file.name}" loaded into the box below — click Load Text to use it.`;
  };
  reader.onerror = () => {
    showTextLoadError(`Could not read "${file.name}": ${reader.error}`);
  };
  reader.readAsText(file);
  txtFileInputEl.value = ''; // allow re-selecting the same file later if edited/reloaded
});

// Convenience prefill only — does not touch currentText, so Start stays
// disabled until the student actually clicks Load Text (or a saved session
// is restored, which runs after this and will overwrite it).
textInputAreaEl.value = SAMPLE_TEXT_FOR_TESTING;
resizeTextareaToFit(textInputAreaEl);

// --- Phase 4: click-to-word manual resync (State 3) ---
// Lets the reader jump the reading position directly to any word by clicking it,
// independent of the mouth-driven pacing signal. Reuses the exact same cancel()
// path as onMouthClosed (never pause()/resume() — see Phase 3 decision) and the
// same baseOffset/lastBoundaryOffset bookkeeping onMouthOpen already relies on,
// so a click is really just "manually set the resume point, then behave as if
// mouth-open logic ran."
function onWordClick(wordIndex) {
  if (wordSpans.length === 0) return; // clicked before any reading session started
  // Bug fix (session after E56): during calibration, predictLoop() routes mouth
  // data to updateCalibration() instead of updateMouthState(), so onMouthOpen/
  // onMouthClosed never fire from the frame loop while calibrating. Without this
  // guard, a click here could read a stale getMouthState()==='open' left over from
  // before calibration started and call speakFrom() directly — then nothing during
  // calibration ever calls onMouthClosed() to stop it, so speech runs on ungated,
  // same failure shape as the old no-face bug. Word-click resync is a reading-only
  // action; ignore it entirely while calibration owns the mouth signal.
  if (getCalibrationActive()) return;
  const word = wordSpans[wordIndex];

  if (getIsSpeakingChunk()) {
    setManualCancel(true);
    cancelActiveSpeech();
    clearFallbackAdvance();
    setIsSpeakingChunk(false);
  }

  baseOffset = word.start;
  lastBoundaryOffset = 0;
  setReadingActive(true); // allow resync to also restart a finished reading
  autoScrollEnabled = true; // Phase 12c: a click is itself an intentional jump, resume following
  if (resumeAutoScrollTimer !== null) { clearTimeout(resumeAutoScrollTimer); resumeAutoScrollTimer = null; }
  highlightWordAt(baseOffset);
  speechStateEl.textContent = 'waiting for mouth to open';

  // If the mouth is already open and a face is visible at click time, don't
  // make the reader close-then-reopen their mouth just to kick things off.
  if (getMouthState() === 'open' && getIsFaceVisible() && getManualSpeechEnabled()) {
    speakFrom(baseOffset);
  }
}

// Entry 58 architecture fix: highlightWordAt() used to do two unrelated
// jobs at once — (1) move the visible highlight/resume point, and (2) reset
// the per-word clock (lastWordBoundaryTime/currentSpokenWordExpectedMs)
// that updateMouthState() reads to judge whether a still mouth means "word
// genuinely finished" or "mid-word, don't cut off." Both the REAL onboundary
// handler and the FALLBACK timer (scheduleFallbackAdvance, an ungrounded
// guess) called this same function, so a fallback tick was silently
// resetting a clock that's supposed to mean "a real event just confirmed
// this." That's what caused the Entry 58 live regression when the fallback
// was sped up: the clock started resetting for words that weren't actually
// the one being spoken, corrupting mouth-close detection.
//
// Fix: split into two layers.
//   moveHighlightTo()  — display only (active class, scroll, diagnostic
//                         log). Safe to call from ANY source, grounded or
//                         not — this is what scheduleFallbackAdvance calls
//                         now, instead of highlightWordAt.
//   highlightWordAt()  — moveHighlightTo() + the clock reset. Only called
//                         from genuinely grounded sources: the real
//                         onboundary handler in speakFrom, and speakFrom's
//                         own resume-priming (which sets the clock inline,
//                         not through this function, since a resume isn't
//                         a "word changed" event).
// No other call sites needed to change — real onboundary already called
// highlightWordAt() and should keep doing exactly that.
function moveHighlightTo(charIndex) {
  const idx = wordSpans.findIndex(w => charIndex >= w.start && charIndex < w.end);
  if (idx === -1) return -1;

  // Phase 12d diagnostic: a boundary/advance landed but mapped into the
  // SAME word that's already active — either a genuinely duplicate event
  // for one word, or evidence the browser's charIndex for this word drifted
  // backward/stayed put instead of advancing.
  if (idx === activeWordIndex) {
    duplicateBoundaryCount += 1;
    duplicateBoundaryValueEl.textContent = String(duplicateBoundaryCount);
    console.log(`[Phase 12d diag] duplicate/non-advancing boundary for already-active word "${wordSpans[idx].span.textContent}" (charIndex=${charIndex})`);
    return -1;
  }

  if (activeWordIndex !== -1) {
    wordSpans[activeWordIndex].span.classList.remove('active');
  }
  wordSpans[idx].span.classList.add('active');
  activeWordIndex = idx;

  // Phase 12c: keep the active word in view as reading progresses. 'nearest'
  // means a word that's already visible doesn't cause any scroll jitter —
  // only a word that's actually scrolled out of view (top or bottom) pulls
  // the page. Respects prefers-reduced-motion the same way the CSS
  // animations already do (Phase 10c) rather than forcing a smooth scroll
  // on someone who's asked the OS/browser to minimize motion.
  if (autoScrollEnabled) {
    scrollToActiveWord();
  }

  return idx;
}

function highlightWordAt(charIndex) {
  // Phase 12d diagnostic: how long did THIS word's boundary event actually
  // take to arrive, vs. how long the PREVIOUS word was expected to take?
  // A stall shows up here as gapMs far exceeding prevExpectedMs, tagged
  // with exactly which word it landed on. Computed BEFORE moveHighlightTo()
  // so it still reflects the previous word's numbers, same as before the split.
  const nowForDiag = performance.now();
  const prevExpectedMs = getCurrentSpokenWordExpectedMs();
  const prevBoundaryTime = getLastWordBoundaryTime();

  const idx = moveHighlightTo(charIndex);
  if (idx === -1) return; // no match, or duplicate/non-advancing — moveHighlightTo already logged it

  const gapMs = Math.round(nowForDiag - prevBoundaryTime);
  const newWordText = wordSpans[idx].span.textContent;
  console.log(`[Phase 12d diag] boundary -> "${newWordText}" | gap since prev boundary: ${gapMs}ms (prev word expected ~${Math.round(prevExpectedMs)}ms)`);
  lastWordTextValueEl.textContent = newWordText;
  lastWordGapValueEl.textContent = `${gapMs}ms`;
  lastWordExpectedValueEl.textContent = `${Math.round(prevExpectedMs)}ms`;

  // Phase 11b bugfix: per-word cadence clock, independent of mouthOpenStartTime.
  // mouthOpenStartTime only resets on a closed->open transition, which during
  // smooth continuous reading can span many words (Phase 6a smoothing keeps
  // real mouth-closes intentionally rare) — using it for trouble scoring
  // falsely accumulated elapsed time across the WHOLE open stretch instead of
  // the current word, pegging the border red during normal smooth reading.
  // onboundary fires per word regardless of mouth smoothing, so it's the
  // right clock here — and as a side benefit, this now doubles as a live
  // detector for a frozen/stalled TTS engine (the documented Chromium
  // freeze bug, Section 3) rather than reader-mouth behavior.
  //
  // Entry 58: this is now ONLY reached from grounded call sites (see the
  // comment above moveHighlightTo). A fallback-advance tick moves the
  // highlight via moveHighlightTo() directly and never reaches here, so it
  // can no longer reset this clock.
  setLastWordBoundaryTime(performance.now());
  setCurrentSpokenWordExpectedMs(estimateWordDuration(wordSpans[idx].span.textContent));
  currentWordRiskyTimings = estimateRiskyConsonantTimings(wordSpans[idx].span.textContent, getCurrentSpokenWordExpectedMs());

  if (CLOCK_SELFTEST_ACTIVE) {
    window.__clockWriteLog.push({ source: 'grounded', word: newWordText, idx, t: performance.now() });
  }
}

// Extract yaw/pitch (in degrees) from MediaPipe's facialTransformationMatrix.
// The matrix is a flat 16-value column-major 4x4 transform. Column index 2
// (data[8], data[9], data[10]) is the face's local Z axis expressed in camera
// space — i.e. the direction the face is pointing. We turn that forward vector
// into two simple angles rather than doing a full Euler decomposition, since we
// only care about "how far off is the face from pointing at the camera."
// getYawPitch()/updateHeadPose() removed Entry 45 — head-pose gating is
// gone (Section 1's ALS-head-drop/lying-down reasoning; see the note above
// isFaceVisible). facialTransformationMatrixes is no longer read anywhere
// in this file.

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

  if (getMouthState() === 'closed' && mar > OPEN_THRESHOLD) {
    setMouthState('open');
    onMouthOpen();
  } else if (getMouthState() === 'open') {
    // Phase 12d fix (root cause confirmed via live log: elapsed=20303ms
    // against expected=800ms on "approach", 40+ words into one open
    // stretch). This used to measure elapsed time since the mouth last
    // transitioned closed->open — fine for a single word, but Phase 6a's
    // whole point is keeping the mouth open across many words during
    // smooth reading, so that clock went stale within a few words and then
    // sat there for the rest of the stretch. Once "elapsed" is that far
    // past any word's expected duration, dynamicRangeThreshold is
    // permanently pinned to the loose CADENCE_OVER_FACTOR value — so an
    // ordinary mid-word dip (a lip-closure syllable in "approach",
    // "movement", "information") reads as a real stop.
    // Fix: reuse the per-word clock (lastWordBoundaryTime/
    // currentSpokenWordExpectedMs) Phase 11b already introduced for
    // trouble-shading, which is refreshed on every real onboundary
    // (highlightWordAt) and primed on every resume (speakFrom) — always
    // current regardless of mouth state. One clock instead of two.
    const elapsedMs = now - getLastWordBoundaryTime();
    cadenceValueEl.textContent = `${Math.round(elapsedMs)} / ${Math.round(getCurrentSpokenWordExpectedMs())}ms`;

    // Dynamic range threshold, built on top of Option A's fixed one: tighten
    // it while we're still under the word's expected duration (an early
    // close-looking dip is more likely mid-word noise than a real stop), and
    // relax it once we're past expected duration (the word's had its time;
    // don't make the reader hold their mouth extra to prove it's really over).
    // Fix 3c (replaces Fix 3b's flat MIN_TIGHT_GATING_MS window): v1
    // (elapsed < full average word duration) fixed the overshoot but
    // reopened the mid-word dip false-stop this tightening was originally
    // built for (e.g. "movement", "approach" — see the comment above). v2
    // (a flat 150ms window on every word) was untested when the student's
    // own prior experience already showed the sticky-word bug on several
    // words to be persistent, so we skipped straight to this targeted
    // version: tighten ONLY in a short window around an estimated
    // lip-closing-consonant moment (currentWordRiskyTimings, computed per
    // word in highlightWordAt()/speakFrom() — see its definition), loose
    // everywhere else in the word, including its entire duration if it has
    // no risky sound at all.
    const inRiskyWindowNow = isWithinRiskyWindow(elapsedMs, currentWordRiskyTimings);
    const dynamicRangeThreshold = inRiskyWindowNow
      ? STOPPED_RANGE_THRESHOLD * CADENCE_UNDER_FACTOR
      : STOPPED_RANGE_THRESHOLD * CADENCE_OVER_FACTOR;

    // Diagnostic (mobile testing session): show the threshold actually being
    // compared against, and which phase we're in, right next to the raw
    // movement-range number. If mobile's MAR noise floor sits between the
    // "under" (tight) and "over" (loose) thresholds, this will show
    // movementRange hovering just above the tight number for the whole
    // "under" phase, then clearing once "over" kicks in — the live,
    // on-screen version of the theory rather than something to take on faith.
    movementRangeValueEl.textContent =
      `${movementRange.toFixed(4)} (need < ${dynamicRangeThreshold.toFixed(4)}, ` +
      `${elapsedMs < getCurrentSpokenWordExpectedMs() ? 'under' : 'over'} phase)`;

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

    // Diagnostic: precise (non-eyeballed) gap measurement — see the variable's
    // comment above.
    if (mar < CLOSE_THRESHOLD) {
      if (firstBelowCloseThresholdTime === null) firstBelowCloseThresholdTime = now;
    } else {
      firstBelowCloseThresholdTime = null;
    }

    if (isMouthStopped) {
      const gapMs = firstBelowCloseThresholdTime !== null
        ? Math.round(now - firstBelowCloseThresholdTime)
        : 0;
      console.log(`[Phase 9 diag] MAR-below-threshold to detected-stop gap: ${gapMs}ms`);
      // Sticky: its own element, only touched here (on an actual detected
      // close), not overwritten by the per-frame movementRangeValueEl update
      // above. Stays on screen exactly as-is until the next close.
      detectionGapValueEl.textContent = `${gapMs}ms`;

      // Fix 3c/3c-2 tuning diagnostic: was this detected stop inside the
      // tight risky-consonant window, or out in the loose zone? And how far
      // (ms) from the nearest estimated risky-consonant moment? This is the
      // one piece of data missing to tune RISK_WINDOW_HALF_MS precisely
      // instead of guessing at a new width — same real-data approach as the
      // Entry 23 clamp-bounds fix.
      const nearestRiskyDelta = currentWordRiskyTimings.length > 0
        ? Math.min(...currentWordRiskyTimings.map((rt) => Math.abs(elapsedMs - rt)))
        : null;
      const wasInRiskyWindow = isWithinRiskyWindow(elapsedMs, currentWordRiskyTimings);
      const underExpected = elapsedMs < getCurrentSpokenWordExpectedMs();
      const activeWordText = activeWordIndex !== -1 ? wordSpans[activeWordIndex].span.textContent : '';
      if (underExpected) {
        earlyCloseCount += 1;
        earlyCloseValueEl.textContent = String(earlyCloseCount);
      }
      console.log(
        `[Fix 3c/3c-2 diag] mouth-close on "${activeWordText}" | elapsed=${Math.round(elapsedMs)}ms expected=${Math.round(getCurrentSpokenWordExpectedMs())}ms | ` +
        `${underExpected ? 'EARLY (under expected)' : 'over expected'} | riskyTimings=[${currentWordRiskyTimings.join(',')}] | ` +
        `inRiskyWindow=${wasInRiskyWindow} | nearestRiskyDelta=${nearestRiskyDelta === null ? 'n/a (no risky sound)' : Math.round(nearestRiskyDelta) + 'ms'}`
      );
      lastCloseInRiskyWindowValueEl.textContent = `${wasInRiskyWindow} (word: "${activeWordText}")`;
      lastCloseRiskyDeltaValueEl.textContent = nearestRiskyDelta === null ? 'n/a' : `${Math.round(nearestRiskyDelta)}ms`;

      setMouthState('closed');
      onMouthClosed();
    }
  }
  mouthStateEl.textContent = getMouthState();
}

// --- Manual ON/OFF speech switch (Entry 45+) ---
// A user-controlled pause layered ALONGSIDE mouth-tracking, not replacing
// it — added after head-pose removal to give the reader an explicit,
// deliberate way to pause (interruption, dry mouth throwing off MAR, wants
// to think) without relying on the app to infer disengagement. Hard-stop on
// OFF per explicit decision: cancels immediately, no partial-word grace.
// Deliberately does NOT touch mouthState — the mouth may still be
// physically open; this is independent of the mouth-open/closed signal.
// manualSpeechEnabled itself now lives in js/readingState.js (Entry 55
// modularization) as getManualSpeechEnabled()/setManualSpeechEnabledFlag()
// — this function stays here since it has real side effects (UI update,
// cancelling active speech) beyond the raw flag.
const speechSwitchBtn = document.getElementById('speechSwitchBtn');
const switchDebugValueEl = document.getElementById('switchDebugValue');

function updateSpeechSwitchUI() {
  const enabled = getManualSpeechEnabled();
  speechSwitchBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  speechSwitchBtn.querySelector('.switch-state').textContent = enabled ? 'ON' : 'OFF';
  speechSwitchBtn.title = enabled ? 'Pause reading (Space)' : 'Resume reading (Space)';
  if (switchDebugValueEl) switchDebugValueEl.textContent = enabled ? 'on' : 'off';
}

function setManualSpeechEnabled(enabled) {
  if (enabled === getManualSpeechEnabled()) return;
  setManualSpeechEnabledFlag(enabled);
  updateSpeechSwitchUI();
  if (!enabled) {
    if (getIsSpeakingChunk()) {
      setManualCancel(true);
      setCancelRequestedTime(performance.now());
      cancelActiveSpeech();
      setIsSpeakingChunk(false);
    }
    speechStateEl.textContent = 'paused (switch off)';
  } else if (getMouthState() === 'open') {
    // Recovery pattern matching isFaceVisible/tab-visibility: resume
    // immediately if the mouth is already open when flipped back on.
    onMouthOpen();
  } else {
    speechStateEl.textContent = 'waiting for mouth to open';
  }
}

function toggleManualSpeechSwitch() {
  if (!getReadingActive()) return; // no-op outside an active session
  setManualSpeechEnabled(!getManualSpeechEnabled());
}

// Resets to enabled+ON at the start of every fresh session (startBtn click)
// so a previous session's OFF state can't silently carry into a new one.
function resetSpeechSwitch() {
  setManualSpeechEnabledFlag(true);
  updateSpeechSwitchUI();
}

speechSwitchBtn.addEventListener('click', () => toggleManualSpeechSwitch());

// Ambient brightness sampling + low-light detection (sampleBrightness,
// setLowLightBaseline, getIsLowLight/getCurrentBrightness) now live in
// js/lighting.js (Entry 55 modularization), imported at the top of this
// file. lastLightSampleTime/LIGHT_SAMPLE_INTERVAL_MS-based throttling of
// WHEN to call it stays here — that's predictLoop's scheduling concern,
// not lighting's.
let lastLightSampleTime = 0;

function onMouthOpen() {
  // Phase 12d diagnostic: if a "repeat/next-word mouth action" is what
  // releases a stall, THIS call is that action landing — log which guard
  // (if any) makes it a no-op, so a stall can be traced to "the resume
  // never actually fired" vs. "it fired but resumed from the wrong place."
  console.log(`[Phase 12d diag] onMouthOpen() | isFaceVisible=${getIsFaceVisible()} manualSpeechEnabled=${getManualSpeechEnabled()} readingActive=${getReadingActive()} isSpeakingChunk=${getIsSpeakingChunk()} resumeOffset=${baseOffset + lastBoundaryOffset}`);
  if (!getIsFaceVisible()) return; // gated: don't resume while no face is detected (Phase 9b; head-pose gate removed Entry 45)
  if (!getManualSpeechEnabled()) return; // gated: user has manually paused via the switch
  if (!getReadingActive()) return; // no active reading session
  if (getIsSpeakingChunk()) return; // already flowing, nothing to do

  const resumeOffset = baseOffset + lastBoundaryOffset;
  speakFrom(resumeOffset);
}

function onMouthClosed() {
  console.log(`[Phase 12d diag] onMouthClosed() | isSpeakingChunk=${getIsSpeakingChunk()}`);
  if (!getIsSpeakingChunk()) return;

  // Stop the current utterance with cancel() rather than pause() — cancel()
  // fully resets speechSynthesis's internal state instead of parking it in a
  // paused limbo, which is the specific state that was wedging Edge's speech
  // engine after repeated use. We remember exactly where we got to (the last
  // completed word boundary) so the next mouth-open can pick up from there.
  setManualCancel(true);
  setCancelRequestedTime(performance.now());
  cancelActiveSpeech();
  clearFallbackAdvance();
  setIsSpeakingChunk(false);
  speechStateEl.textContent = 'waiting for mouth to open';
}

function speakFrom(offset) {
  if (offset >= currentText.length) {
    finishReading();
    return;
  }

  baseOffset = offset;
  lastBoundaryOffset = 0;

  // Phase 9 (diagnostic): fresh utterance, fresh count. A stall theory is
  // only meaningful measured within one utterance's boundary stream.
  boundaryEventCount = 0;
  boundaryCountValueEl.textContent = '0';
  duplicateBoundaryCount = 0;
  duplicateBoundaryValueEl.textContent = '0';
  earlyCloseCount = 0;
  earlyCloseValueEl.textContent = '0';
  fallbackAdvanceCount = 0;
  if (fallbackAdvanceCountValueEl) fallbackAdvanceCountValueEl.textContent = '0';

  // Phase 11b bugfix: prime the per-word cadence clock for the word at the
  // resume point right away, rather than only waiting for onboundary/
  // highlightWordAt to set it — there's a real gap between speak() being
  // called and the browser's first word-boundary callback landing, and
  // highlightWordAt also no-ops if this word is already the active one
  // (e.g. resuming the same word after a brief mouth close), which would
  // otherwise leave a stale clock in place right when a fresh one matters most.
  const resumeWordIdx = wordSpans.findIndex(w => offset >= w.start && offset < w.end);
  setLastWordBoundaryTime(performance.now());
  setCurrentSpokenWordExpectedMs(resumeWordIdx !== -1
    ? estimateWordDuration(wordSpans[resumeWordIdx].span.textContent)
    : 0);
  currentWordRiskyTimings = resumeWordIdx !== -1
    ? estimateRiskyConsonantTimings(wordSpans[resumeWordIdx].span.textContent, getCurrentSpokenWordExpectedMs())
    : [];

  // Phase 8, final (Entry 16): one utterance per resume, no chaining. Two
  // chaining attempts within this same session both failed with
  // different symptoms — state desync, then a silent freeze where speak()
  // is called but no events ever return. This matches Chromium's documented
  // unreliability with repeated speak() calls in one session: it can stop
  // firing events with no error to catch or recover from. Explicitly
  // rejected, same category as ROI cropping / the mic safeguard — not
  // fixable within a $0/no-alternate-TTS-API budget. Tone is decided once
  // per resume (mouth-open or click), from whichever sentence the resume
  // point falls inside, and holds for the rest of that utterance. Known,
  // accepted limitation: during smooth continuous reading (few real mouth
  // closes, by design — see Phase 6a), tone may rarely change.
  maybeRecycleTtsEngine(); // Phase 9a-iframe experiment — no-op if the flag above is off

  // Defensive: if a previous utterance's poll is somehow still running when a
  // fresh speakFrom() fires, stop it explicitly rather than relying only on
  // the generation check inside its own callback.
  if (speakingPollIntervalId !== null) {
    clearInterval(speakingPollIntervalId);
    speakingPollIntervalId = null;
  }
  const myGeneration = ++speakGeneration;
  const utteranceCallTime = performance.now(); // fallback anchor if onstart never fires on this browser
  let utteranceRealStartTime = null;           // set from onstart when available — the real ground-truth anchor
  const synthRef = ttsEngine.synth; // captured now in case a later recycle swaps ttsEngine.synth mid-flight
  // Bug fix: this is also the ONE place activeSpeechSynth gets updated —
  // every external cancel() call site (onMouthClosed, gate trips, word-click,
  // calibration start, startBtn) now cancels via activeSpeechSynth instead of
  // the live (possibly-since-recycled) ttsEngine.synth. See the comment above
  // its declaration for the full "orphaned utterance" bug this fixes.
  activeSpeechSynth = synthRef;
  let stopHandled = false; // local to this call — whichever of onend/poll fires first wins, the other is a no-op

  // Mobile highlighter-freeze fix: don't wait for a first onboundary event
  // to even show WHERE we're resuming from — confirmed missing ENTIRELY on
  // some mobile browsers (harness test: 0/14 events, no iframe involved).
  // If the resume word is already the active one (e.g. a brief mouth close
  // and reopen mid-word), leave the highlight alone — highlightWordAt's own
  // duplicate-word guard would no-op this anyway, and the clock was already
  // re-primed above. Otherwise mark it directly; a real onboundary landing
  // on this same word afterward is a harmless no-op via that same guard.
  if (resumeWordIdx !== -1 && resumeWordIdx !== activeWordIndex) {
    if (activeWordIndex !== -1) {
      wordSpans[activeWordIndex].span.classList.remove('active');
    }
    wordSpans[resumeWordIdx].span.classList.add('active');
    activeWordIndex = resumeWordIdx;
    if (autoScrollEnabled) scrollToActiveWord();
  }
  scheduleFallbackAdvance(resumeWordIdx, myGeneration);

  currentUtterance = new ttsEngine.UtteranceCtor(currentText.slice(offset));

  // Phase 12b Stage A: resolved from the MAIN WINDOW's voice list, not the
  // (possibly brand-new, still-async-loading) recycled iframe's own list.
  // Each fresh iframe needs its own 'voiceschanged' round-trip before
  // getVoices() returns anything — right after a recycle that list can
  // still be empty, which was silently degrading a chosen voice back to
  // default exactly when a recycle landed. The main window's list is
  // loaded once at startup and never goes stale, and Chromium resolves a
  // voice by its voiceURI at synthesis time regardless of which frame's
  // SpeechSynthesis object the voice object came from, so this is safe to
  // use even though `synthRef` (the frame that will actually speak) may be
  // a recycled iframe.
  const resolvedVoice = resolveSelectedVoice(window.speechSynthesis);
  if (resolvedVoice) {
    currentUtterance.voice = resolvedVoice;
  }

  // Phase 11: PERSONALIZED_RATE is applied unconditionally now (it defaults
  // to 1.0 — the untouched Web Speech default — until the user calibrates,
  // so an uncalibrated session sounds exactly as it did before this phase).
  // When tone (Phase 8a) is also on, the two multiply rather than one
  // overriding the other: tone's rate is a per-sentence *expressive* nudge
  // (excited/curious), personalized rate is the user's *baseline* mumbling
  // speed — both should apply at once rather than tone silently discarding
  // the personalization, or personalization ignoring tone's intent.
  const { personalizedRate } = getPersonalizedCadence();
  if (toneEnabled) {
    const sentenceEnd = findSentenceEnd(currentText, offset);
    const sentenceText = currentText.slice(offset, sentenceEnd);
    const tone = getToneForSentence(sentenceText);
    currentUtterance.pitch = tone.pitch;
    currentUtterance.rate = tone.rate * personalizedRate;
    toneValueEl.textContent = tone.label;
  } else {
    currentUtterance.rate = personalizedRate;
    toneValueEl.textContent = 'off';
  }

  currentUtterance.onboundary = (event) => {
    if (event.name !== 'word') return;
    if (DEBUG_SIMULATE_NO_ONBOUNDARY) return; // debug toggle: pretend this event never arrived
    lastBoundaryOffset = event.charIndex;
    // Phase 9 (diagnostic): record that a real boundary event landed.
    boundaryEventCount += 1;
    lastBoundaryEventTime = performance.now();
    boundaryCountValueEl.textContent = String(boundaryEventCount);
    highlightWordAt(baseOffset + event.charIndex);
    // Mobile highlighter-freeze fix: a real event always wins — reschedule
    // the fallback chain from the TRUE position it just gave us, so drift
    // never compounds past a single word on a browser where onboundary
    // fires at all (even partially/unreliably, not just the fully-broken case).
    scheduleFallbackAdvance(activeWordIndex, myGeneration);
  };

  // Ground-truth anchor for the fallback timer, not a guess: onstart fires
  // when audio actually begins, which is measurably later than the speak()
  // call on some devices (voice loading, engine startup). The very first
  // fallback schedule above was anchored to speak()-call time because
  // nothing else was available yet at that point — silently eating into
  // word 1's own budget by however long that startup gap turned out to be
  // on a given device, which is what caused the first-word-only jitter seen
  // in live testing (every later word is anchored correctly, by either a
  // real onboundary or a fallback tick that both fire during actual
  // playback). Re-anchoring here closes that gap with a real measurement
  // instead of a bigger guessed buffer. If onstart never fires on some
  // browser, the original speak()-time-anchored schedule above simply
  // stands uncorrected — no regression, just no improvement.
  currentUtterance.onstart = () => {
    utteranceRealStartTime = performance.now();
    if (myGeneration === speakGeneration) {
      scheduleFallbackAdvance(activeWordIndex, myGeneration);
    }
  };

  // Shared by both onend (fallback, effectively never fires — see the
  // comment on speakGeneration above) and the speaking-property poll below
  // (primary, confirmed reliable). Whichever fires first handles the stop;
  // the other becomes a no-op via stopHandled/generation checks.
  function handleStop() {
    if (stopHandled) return;
    if (myGeneration !== speakGeneration) return; // superseded by a newer speakFrom()
    stopHandled = true;
    if (speakingPollIntervalId !== null) {
      clearInterval(speakingPollIntervalId);
      speakingPollIntervalId = null;
    }

    setIsSpeakingChunk(false);
    if (getManualCancel()) {
      // This utterance stopped because WE called cancel() (closing the mouth
      // or looking away), not because the text actually finished.
      //
      // Diagnostic: how long between us requesting cancel() and `speaking`
      // actually confirming it stopped? Isolated testing (see the comment on
      // speakGeneration) showed this is consistently small (~15ms avg) even
      // under simulated CPU load — evidence cancel() itself is not the slow
      // part; the up-to-~300-400ms detection window is the far bigger factor
      // in any perceived overshoot.
      if (getCancelRequestedTime() !== null) {
        const stopGapMs = Math.round(performance.now() - getCancelRequestedTime());
        console.log(`[Phase 9 diag] cancel() to stop-confirmed gap: ${stopGapMs}ms`);
        cancelStopGapValueEl.textContent = `${stopGapMs}ms`;
        setCancelRequestedTime(null);
      }
      setManualCancel(false);
      return;
    }
    // Natural completion — the one moment we get real ground truth even on
    // a browser with zero onboundary events. See recordFallbackCalibrationSample.
    const realStartTime = utteranceRealStartTime !== null ? utteranceRealStartTime : utteranceCallTime;
    recordFallbackCalibrationSample(performance.now() - realStartTime, resumeWordIdx);
    finishReading();
  }

  currentUtterance.onend = handleStop;

  setIsSpeakingChunk(true);
  sessionSpeakCallCount += 1;
  sessionSpeakCountValueEl.textContent = String(sessionSpeakCallCount);
  console.log(`[Phase 12d diag] speak() call #${sessionSpeakCallCount} this session (${IFRAME_TTS_RECYCLE_ENABLED ? 'iframe recycle #' + ttsRecycleCount : 'main window, no recycling'})`);
  ttsEngine.synth.speak(currentUtterance);
  speechStateEl.textContent = 'speaking';

  // Fix 1: poll `speaking` instead of trusting `onend`. 20ms tick — cheap
  // (single boolean read) and well under the ~15ms gaps seen in testing, so
  // it won't itself be the bottleneck in the numbers it reports.
  speakingPollIntervalId = setInterval(() => {
    if (myGeneration !== speakGeneration) {
      // A newer speakFrom() has already started; this poll is stale.
      clearInterval(speakingPollIntervalId);
      speakingPollIntervalId = null;
      return;
    }
    if (synthRef.speaking) return; // still genuinely speaking, keep polling
    clearInterval(speakingPollIntervalId);
    speakingPollIntervalId = null;
    handleStop();
  }, 20);
}

function finishReading() {
  setReadingActive(false);
  setIsSpeakingChunk(false);
  clearFallbackAdvance();
  speechStateEl.textContent = 'finished';
  if (activeWordIndex !== -1) {
    wordSpans[activeWordIndex].span.classList.remove('active');
  }
  activeWordIndex = -1;
  resetTroubleShading(); // Phase 11b: no active session left to reflect, so settle the border calm
  resetSpeechSwitch();
}

startBtn.addEventListener('click', () => {
  // Phase 10a: startBtn is disabled whenever hasLoadedText() is false, but
  // guard here too rather than trust the DOM disabled state alone.
  if (!hasLoadedText()) return;

  // Hard reset on every click, rather than trusting readingActive/isSpeakingChunk
  // to be accurate. speechSynthesis state has proven flaky enough this session
  // that relying on our own flags alone was leaving the button stuck unusable
  // after a full read-through. cancel() is safe to call even if nothing is
  // currently speaking. Belt-and-suspenders here specifically (cancel both
  // the tracked active synth AND whatever's live right now) since this is
  // the explicit hard-reset path — cheap insurance against any lingering
  // orphaned utterance on an old recycled iframe.
  setManualCancel(true);
  cancelActiveSpeech();
  ttsEngine.synth.cancel();
  clearFallbackAdvance();
  setIsSpeakingChunk(false);
  setReadingActive(false);

  wordSpans = buildWordSpans(currentText);
  activeWordIndex = -1;
  baseOffset = 0;
  lastBoundaryOffset = 0;
  setReadingActive(true);
  autoScrollEnabled = true; // Phase 12c: fresh session, resume following the active word
  if (resumeAutoScrollTimer !== null) { clearTimeout(resumeAutoScrollTimer); resumeAutoScrollTimer = null; }
  marBuffer = []; // fresh window so a stale pre-click buffer can't cause a false stop
  resetTroubleShading(); // Phase 11b: fresh session shouldn't inherit a lingering score/pulse cooldown
  resetSpeechSwitch(); // fresh session shouldn't inherit a previous session's OFF state
  speechStateEl.textContent = 'waiting for mouth to open';

  // If the mouth is already open right when the button is clicked, start
  // speaking immediately from the beginning. Otherwise wait for mouth-open.
  if (getMouthState() === 'open' && getIsFaceVisible()) {
    speakFrom(0);
  }
});

// --- Tab/window visibility safety gate ---------------------------------
// predictLoop() is scheduled via requestAnimationFrame (scheduleNextFrame),
// which browsers throttle heavily or suspend entirely once the tab/window
// is backgrounded — switching to a completely different application (e.g.
// Edge) backgrounds Chrome much harder than switching between Chrome tabs.
// speechSynthesis has no such throttling and keeps talking regardless.
// That means every mouth/face safety check in this file — head-pose gating,
// the Phase 9b no-face timeout, even ordinary mouth-close detection — stops
// running the moment the tab is hidden, because predictLoop itself is what
// stops running. This is a distinct, more fundamental gap than Phase 9b:
// that fix only covers "camera sees no face while the tab is still visible
// and predictLoop is still running normally."
// Fix: react directly to the Page Visibility API instead of depending on
// predictLoop to notice anything. On hidden, stop speech immediately and
// force mouthState closed so a stale "still open" reading from before
// backgrounding can't cause a blind resume the instant the tab returns.
// On visible again, deliberately do NOT auto-resume — the next real
// predictLoop frame re-establishes the actual current mouth/face state
// from scratch, same "recovery is free" pattern already used for
// no-face/looking-away recovery elsewhere in this file. noFaceSince is
// cleared too, so background time isn't counted against the reader once
// frames resume.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    console.log(`[visibility] tab hidden | readingActive=${getReadingActive()} mouthState=${getMouthState()}`);
    if (getReadingActive()) {
      onMouthClosed();
      setMouthState('closed');
      mouthStateEl.textContent = getMouthState();
      facingStateEl.textContent = 'tab hidden — reading paused';
      // Entry 45 fix: force a fresh face-visible confirmation once the tab
      // returns, so this label doesn't linger forever. Before head-pose
      // removal, updateHeadPose() ran every frame and overwrote this label
      // as a side effect of its own pose check; that side effect is gone
      // now, so predictLoop's face-reappear branch needs an actual
      // false->true transition to fire and update the text. Same "recovery
      // is free" pattern as the no-face timeout.
      setIsFaceVisible(false);
    }
    setNoFaceSince(null);
  } else {
    console.log('[visibility] tab visible again — waiting for a fresh mouth/face read before resuming');
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
    numFaces: 1
    // outputFacialTransformationMatrixes removed Entry 45 — only consumer
    // was head-pose gating, which no longer exists. Skipping this output
    // is a small free perf win per frame.
  });

  loadSavedCalibration();
  await loadSavedText();

  // UI cleanup pass: covers the case neither loadSavedCalibration() nor
  // loadSavedText() had anything to restore (a genuine first-time visitor)
  // — those two already call updateProgressUI() themselves via
  // applyCalibration()/setCurrentText() when they DO find something, so
  // this is only a no-op double-call in the returning-visitor case, not
  // duplicated state.
  updateProgressUI();

  // Entry 53: startWebcam() used to be called right here, unconditionally,
  // the moment MediaPipe finished loading — meaning the native camera
  // permission prompt could interrupt a visitor before they'd read a single
  // word of the page. It now only ever fires from requestCameraAccess(),
  // triggered by an explicit click on cameraGateBtn (see #cameraTrustBlock
  // in index.html). All this does is mark MediaPipe as ready and unlock that
  // button if the person already clicked it while MediaPipe was still
  // loading (see requestCameraAccess's own "not ready yet" branch below).
  mediaPipeReady = true;
  cameraGateBtn.disabled = false;
  cameraGateStatus.textContent = '';
  cameraGateStatus.classList.remove('status-error');
}

// Entry 53: this is now the ONLY call site for getUserMedia() in the app —
// only ever runs from a real click on cameraGateBtn (see listener below),
// never automatically. Keeps the exact same stream-setup logic the old
// auto-fired startWebcam() had; what changed is *when* it can run and how
// it reports success/failure (inline status text instead of a native
// alert(), which didn't match the rest of the app's plain-English-message
// pattern used everywhere else, e.g. the Entry 45 warning box).
async function requestCameraAccess() {
  // Guards the edge case where someone clicks before setup() finishes
  // loading MediaPipe (slow connection) — the button should be disabled
  // during that window (see index.html), so this is defensive, not the
  // primary gate. setup() clears the "getting ready" status once ready.
  if (!mediaPipeReady) return;

  cameraGateBtn.disabled = true;
  cameraGateStatus.textContent = 'Requesting camera access…';
  cameraGateStatus.classList.remove('status-error');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });
    video.srcObject = stream;
    video.addEventListener('loadeddata', predictLoop);
    setCameraGateResolved();
  } catch (err) {
    console.error('Webcam error:', err);
    cameraGateBtn.disabled = false;
    cameraGateStatus.classList.add('status-error');
    // Deliberately plain-English, no error.message/err.name shown — those
    // are technical (e.g. "NotAllowedError") and not meaningful to this
    // app's non-technical/mobile audience, matching the reasoning that
    // drove the rest of this trust-messaging pass.
    cameraGateStatus.textContent =
      "Camera access was blocked or dismissed. Mumblew needs it to track your mouth movement — click the button above to try again.";
  }
}

// Entry 53: single place that flips the page over from "gate" to "granted"
// state — hides the gate card, reveals the short persistent reminder +
// calibration-preview note, and unlocks Calibrate/Start Reading (via their
// respective updateXButtonState() functions, so this doesn't have to
// duplicate their logic).
function setCameraGateResolved() {
  cameraGranted = true;
  cameraGateCard.classList.add('gate-resolved');
  privacyNote.style.display = '';
  cameraPreviewNote.style.display = '';
  updateCalibrateButtonState();
  updateStartButtonState();
  updateProgressUI();
}

cameraGateBtn.addEventListener('click', requestCameraAccess);

// --- Phase 7c: dynamic frame rate ---
// Full-rate tracking is only actually needed while something time-sensitive
// is happening: an active reading session (mouth/pose gating needs every
// frame to feel responsive) or an in-progress calibration step (same
// reason — it's sampling live numbers). Otherwise — webcam on but Start
// Reading not yet clicked, or after a reading has finished — we throttle
// down substantially, since nothing is consuming the extra frames anyway.
// This doesn't change accuracy or responsiveness of the core reading
// experience at all; it only changes how often we poll while genuinely
// idle. No new libraries/network calls, so privacy and $0-cost goals are
// unaffected.
const IDLE_FRAME_INTERVAL_MS = 100; // ~10fps while idle, vs ~60fps (rAF) while active

function isIdle() {
  return !getReadingActive() && !getCalibrationActive();
}

function scheduleNextFrame() {
  if (isIdle()) {
    setTimeout(() => requestAnimationFrame(predictLoop), IDLE_FRAME_INTERVAL_MS);
  } else {
    requestAnimationFrame(predictLoop);
  }
}

function predictLoop() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  // Entry 50: independent of face detection below — brightness only needs
  // a video frame, not a detected face, so a dark room with no face found
  // still gets sampled (arguably the exact case where the reading is most
  // relevant). Interval-gated, not every frame — see comment at
  // sampleBrightness().
  const nowForLightSample = performance.now();
  if (nowForLightSample - lastLightSampleTime >= LIGHT_SAMPLE_INTERVAL_MS) {
    lastLightSampleTime = nowForLightSample;
    sampleBrightness(video);
  }

  const results = faceLandmarker.detectForVideo(video, performance.now());

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (results.faceLandmarks && results.faceLandmarks.length > 0) {
    setNoFaceSince(null); // Phase 9b: a face is visible again, clear the gap timer

    // Phase 9b recovery, folded in here Entry 45: this used to happen inside
    // updateHeadPose() (which ran regardless of facing state, so it always
    // noticed a fresh face). With head-pose gating gone, this branch is now
    // the only place a "face reappeared" transition is observed, so the
    // recovery has to live here instead. Mirrors the old behavior: resume
    // immediately if the mouth is already open, rather than waiting for a
    // fresh open edge that may never come.
    if (!getIsFaceVisible()) {
      setIsFaceVisible(true);
      facingStateEl.textContent = 'face detected';
      if (getMouthState() === 'open') {
        onMouthOpen();
      }
    }

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

    if (getCalibrationActive()) {
      updateCalibration(mar);
    } else {
      updateMouthState(mar);
    }
  } else {
    // Phase 9b: zero landmarks this frame — start (or continue) the gap
    // timer. Once it's been missing long enough, stop speech and flip the
    // face-detection indicator, so a reader who's walked away or turned the
    // camera off doesn't get talked at indefinitely. Guarded on
    // isFaceVisible so this only fires once per gap, not every frame after
    // the timeout.
    if (getNoFaceSince() === null) {
      setNoFaceSince(performance.now());
    } else if (getReadingActive() && getIsFaceVisible() && (performance.now() - getNoFaceSince()) >= NO_FACE_TIMEOUT_MS) {
      setIsFaceVisible(false);
      facingStateEl.textContent = 'no face detected';
      maybeFireTroublePulse();
      onMouthClosed();
    }
  }

  // Phase 3's head-pose gating block (independent yaw/pitch check on every
  // frame) removed Entry 45 — see the note above isFaceVisible.

  // Phase 9 (diagnostic): live "ago" readout, independent of onboundary itself
  // firing — this is the whole point, since a stalled boundary stream is
  // exactly the case where nothing else would update this number for you.
  if (getReadingActive() && getIsSpeakingChunk() && lastBoundaryEventTime > 0) {
    lastBoundaryAgoValueEl.textContent = Math.round(performance.now() - lastBoundaryEventTime).toString();
  }

  // Phase 11b: reads mouthState/cadence/pose state that's all fresh as of
  // this same frame's updates above. Skipped during calibration for the same
  // reason head-pose gating is skipped — no active reading session for it to
  // reflect, and calibration.active already makes computeRawTroubleScore()
  // return 0 via the readingActive check, so this is mostly a perf/clarity
  // skip rather than a correctness-critical one.
  if (!getCalibrationActive()) {
    updateTroubleShading();
    // Entry 45+ fix: sync every frame off readingActive directly, rather
    // than each call site (startBtn, onWordClick, finishReading...)
    // remembering to update it — onWordClick can also start a session
    // independent of startBtn, and was the one path this got missed on.
    speechSwitchBtn.classList.toggle('is-inactive', !getReadingActive());
  }

  scheduleNextFrame();
}

// Coach-mark tour engine, main-app tour + calibration-intro content, the
// 8-panel intro sequence, and the first-visit welcome gate now live in
// js/tour.js (Entry 55 modularization) — imported at the top of this file.
// The one coupling point (showing the calibration-intro tour before
// calibration itself starts) is wired here rather than inside tour.js, so
// that module doesn't need to import main.js's startCalibration directly.
wireCalibrateIntro(calibrateBtn, startCalibration);

// --- Mobile-viewport notice (Entry 51) ---------------------------------
// Deliberately separate from the tour system above: this needs to be seen
// immediately by anyone on a phone, before they invest time in a
// coach-mark walkthrough built around desktop-sized elements. Same
// breakpoint the app's own CSS already treats as "narrow/mobile"
// (see the existing @media (max-width: 480px) rules).
const mobileNoticeBannerEl = document.getElementById('mobileNoticeBanner');
const mobileNoticeDismissBtn = document.getElementById('mobileNoticeDismissBtn');
// Bug fix (student-reported): the original version only ran the check ONCE
// at page load, so live window resizing (a desktop user shrinking their
// browser tab, as opposed to a genuine phone visit) never re-triggered it.
// Real mobile visits still would have worked (viewport is narrow from the
// very first paint), but manual/testing resizes wouldn't have — exactly
// the gap the student caught. Fixed with a resize listener below.
let mobileNoticeDismissedThisLoad = false;
function checkMobileNotice() {
  if (!mobileNoticeBannerEl || mobileNoticeDismissedThisLoad) return;
  const isNarrowViewport = window.matchMedia('(max-width: 480px)').matches;
  mobileNoticeBannerEl.classList.toggle('mobile-notice-visible', isNarrowViewport);
}
if (mobileNoticeDismissBtn) {
  mobileNoticeDismissBtn.addEventListener('click', () => {
    mobileNoticeDismissedThisLoad = true; // don't let the next resize tick immediately re-show it
    mobileNoticeBannerEl.classList.remove('mobile-notice-visible');
  });
}
checkMobileNotice();
window.addEventListener('resize', checkMobileNotice);


// --- Feedback widget (Entry 51) ----------------------------------------
// Widget UI/submission logic now lives in js/feedback.js (Entry 55
// modularization), imported at the top of this file. It needs two pieces
// of context it has no business owning directly (calibration storage key,
// the rate slider) — supplied here via a callback rather than importing
// this file's internals into that module.
initFeedbackWidget(() => {
  let hasCalibration = false;
  try {
    hasCalibration = !!localStorage.getItem(CALIBRATION_STORAGE_KEY);
  } catch (e) { /* localStorage unavailable — leave false, not worth failing the submit over */ }
  return { hasCalibration, speedSetting: rateSliderEl.value };
});

// Note: the welcome gate itself (above) runs synchronously as this script
// executes, immediately toggling body.app-gated before first paint settles
// — no deferred call needed here, unlike the old invite-card version.

setup();

// --- Entry 58 clock-decouple self-test -------------------------------------
// Verifies the highlightWordAt()/moveHighlightTo() split (see the big
// comment block above moveHighlightTo()'s definition) WITHOUT depending on
// a human's ear or reaction time at all. The drift diagnostic (Entry 58,
// fallback-drift-diagnostic.js) needed a human tap because it measured
// PERCEIVED timing — how far the highlighter lagged what a person actually
// heard. This test measures something different and fully mechanical:
// "does the mouth-close clock get written on a fallback-only tick?" — a
// yes/no the code itself can answer, if the TTS timing is scripted instead
// of real audio.
//
// How: swap ttsEngine.synth/UtteranceCtor for a fake driver that fires
// onstart/onboundary/onend at EXACT, hand-picked millisecond offsets — some
// words get a scripted onboundary (a "real" event), others are deliberately
// skipped so the app's own real scheduleFallbackAdvance() timer, running
// unmodified, has to step in. This calls the REAL production functions
// (speakFrom, highlightWordAt, moveHighlightTo, scheduleFallbackAdvance) —
// nothing here is a reimplementation, avoiding the "harness has its own
// bugs" trap (E41) and the "diagnostic reimplements instead of importing
// real logic" gap the drift diagnostic was built to avoid.
//
// Usage: open the app, open the browser console, run
//   runClockDecoupleSelfTest()
// Results print on-screen (a floating box, plain English) AND to console.
// Safe to run repeatedly; fully restores ttsEngine and text state after.
function runClockDecoupleSelfTest() {
  const TEST_WORDS = ['Alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  const testText = TEST_WORDS.join(' ');
  // Index 0 is primed directly by speakFrom()'s resume logic (not through
  // highlightWordAt), by design — excluded from both phases' assertions,
  // since that priming path isn't what this fix touches.

  // Redesigned after a live run exposed a real flaw in the first version:
  // before ANY real onboundary has landed, boundaryEventCount is still 0,
  // so scheduleFallbackAdvance's 2.2x confidence-guard multiplier is
  // INACTIVE — fallback chains through several words at raw speed
  // (~340-560ms each) and can race straight past a sparsely-scheduled
  // "real" event before it ever arrives. Rather than hand-tuning timing to
  // dodge that race, this now runs two phases that structurally cannot
  // race each other at all — same idea as the drift diagnostic's own
  // "ignore real boundary" toggle, just split into two separate passes:
  //   Phase A (fallback-only): never send a single scripted onboundary.
  //     The ENTIRE utterance must advance via fallback alone. Assert: not
  //     one word gets a grounded clock-write.
  //   Phase B (real-only): send a scripted onboundary for EVERY word,
  //     spaced well under fallback's fastest possible delay, so a real
  //     event always cancels the pending fallback timer before it can
  //     fire. Assert: every word gets a grounded write and zero fallback
  //     writes.
  // Each phase in isolation is unambiguous — no timing arithmetic to get
  // right, no confidence-guard interaction to model.

  let resultsBox = document.getElementById('clockSelfTestResults');
  if (!resultsBox) {
    resultsBox = document.createElement('div');
    resultsBox.id = 'clockSelfTestResults';
    resultsBox.style.cssText = 'position:fixed;bottom:12px;right:12px;max-width:420px;background:#111;color:#eee;font:13px/1.4 monospace;padding:14px;border-radius:8px;z-index:99999;box-shadow:0 4px 18px rgba(0,0,0,0.4);white-space:pre-wrap;';
    document.body.appendChild(resultsBox);
  }
  resultsBox.textContent = 'Running clock-decouple self-test (phase A: fallback-only)...';

  const savedSynth = ttsEngine.synth;
  const savedCtor = ttsEngine.UtteranceCtor;
  const savedText = currentText;
  const savedFallbackRateFactor = fallbackRateFactor;

  // Pin fallbackRateFactor — a real, persisted, per-browser value — so the
  // test's pass/fail depends only on the decoupling mechanism, not on
  // whatever this happens to currently be (a prior run found an un-pinned
  // 1.901 producing a false timing-based failure unrelated to the fix).
  fallbackRateFactor = 1.0;

  function FakeUtterance(text) {
    this.text = text;
    this.onboundary = null;
    this.onstart = null;
    this.onend = null;
    this.voice = null;
    this.pitch = 1;
    this.rate = 1;
  }

  // scriptFn(utterance, starts) => nothing; schedules whatever onboundary/
  // onend calls this phase needs via setTimeout, using `speaking` to no-op
  // after cancel().
  function makeFakeSynth(scriptFn) {
    let speaking = false;
    let timers = [];
    const synth = {
      get speaking() { return speaking; },
      speak(utterance) {
        speaking = true;
        timers.push(setTimeout(() => { if (speaking && utterance.onstart) utterance.onstart(); }, 0));
        scriptFn(utterance, () => speaking, (fn, atMs) => timers.push(setTimeout(fn, atMs)));
      },
      cancel() {
        speaking = false;
        timers.forEach(id => clearTimeout(id));
        timers = [];
      },
    };
    return synth;
  }

  function runPhase(label, scriptFn, onDone) {
    window.__clockWriteLog = [];
    CLOCK_SELFTEST_ACTIVE = true;
    setCurrentText(testText, 'self-test', { persist: false });
    const starts = wordSpans.map(w => w.start);
    ttsEngine.synth = makeFakeSynth((utterance, isSpeaking, schedule) => scriptFn(utterance, starts, isSpeaking, schedule, onDone));
    ttsEngine.UtteranceCtor = FakeUtterance;
    setReadingActive(true);
    speakFrom(0);
  }

  // Phase A: fallback-only. No onboundary calls at all — just end the
  // utterance generously after the fallback chain has had time to run the
  // whole text (raw/unguarded speed, ~340-560ms/word here, well under 6s
  // for 9 words).
  function phaseAScript(utterance, starts, isSpeaking, schedule, onDone) {
    schedule(() => {
      if (!isSpeaking()) return;
      if (utterance.onend) utterance.onend();
      onDone();
    }, 6000);
  }

  // Phase B: real-only. A scripted onboundary for every word, 120ms apart
  // — comfortably under the shortest observed base delay (~340ms), so the
  // fallback timer scheduled after each real event never survives long
  // enough to fire before the next real event cancels it via
  // scheduleFallbackAdvance's own clearFallbackAdvance() call.
  function phaseBScript(utterance, starts, isSpeaking, schedule, onDone) {
    for (let i = 1; i < TEST_WORDS.length; i++) {
      schedule(() => {
        if (isSpeaking() && utterance.onboundary) {
          utterance.onboundary({ name: 'word', charIndex: starts[i] });
        }
      }, i * 120);
    }
    schedule(() => {
      if (!isSpeaking()) return;
      if (utterance.onend) utterance.onend();
      onDone();
    }, TEST_WORDS.length * 120 + 300);
  }

  const phaseAFailures = [];
  const phaseBFailures = [];

  runPhase('A', phaseAScript, () => {
    const log = window.__clockWriteLog.slice();
    for (let i = 1; i < TEST_WORDS.length; i++) {
      const grounded = log.find(e => e.source === 'grounded' && e.idx === i);
      const fallback = log.find(e => e.source === 'fallback' && e.idx === i);
      if (grounded) phaseAFailures.push(`FAIL (the actual bug this test exists to catch): Word #${i + 1} "${TEST_WORDS[i]}" moved via fallback only, but the clock got GROUNDED-written anyway.`);
      if (!fallback) phaseAFailures.push(`Word #${i + 1} "${TEST_WORDS[i]}" never advanced via fallback within the 6s window — check timing, not decoupling.`);
    }

    resultsBox.textContent = 'Running clock-decouple self-test (phase B: real-events-only)...';
    runPhase('B', phaseBScript, () => {
      const log2 = window.__clockWriteLog.slice();
      for (let i = 1; i < TEST_WORDS.length; i++) {
        const grounded = log2.find(e => e.source === 'grounded' && e.idx === i);
        const fallback = log2.find(e => e.source === 'fallback' && e.idx === i);
        if (!grounded) phaseBFailures.push(`Word #${i + 1} "${TEST_WORDS[i]}" got a scripted real event but was never grounded-written.`);
        if (fallback) phaseBFailures.push(`Word #${i + 1} "${TEST_WORDS[i]}" unexpectedly ALSO got a fallback clock-write despite a real event arriving first.`);
      }
      finishSelfTest();
    });
  });

  function finishSelfTest() {
    CLOCK_SELFTEST_ACTIVE = false;
    const allFailures = [...phaseAFailures, ...phaseBFailures];
    const pass = allFailures.length === 0;
    const summary = pass
      ? `PASS — Phase A: all ${TEST_WORDS.length - 1} words advanced via fallback alone and NONE wrote the grounded clock. Phase B: all ${TEST_WORDS.length - 1} words arrived via a real event and every one wrote the grounded clock, with zero fallback writes. The decoupling fix is working as intended.`
      : `FAIL — ${allFailures.length} problem(s) found:\n` + allFailures.map(f => '  • ' + f).join('\n');

    console.log('[clock-decouple self-test] ' + summary);
    resultsBox.textContent = 'Entry 58 clock-decouple self-test\n\n' + summary + '\n\n(Full log in console. This box is safe to dismiss — reload clears it.)';

    // Restore real state. Must go back through setCurrentText (not a raw
    // variable reassignment) — buildWordSpans() replaces readingTextEl's
    // DOM contents, so a stale wordSpans reference would leave the pane
    // visibly showing the test sentence while pointing at detached spans.
    ttsEngine.synth = savedSynth;
    ttsEngine.UtteranceCtor = savedCtor;
    fallbackRateFactor = savedFallbackRateFactor;
    if (fallbackRateFactorValueEl) fallbackRateFactorValueEl.textContent = fallbackRateFactor.toFixed(3);
    setIsSpeakingChunk(false);
    setReadingActive(false);
    clearFallbackAdvance();
    if (typeof savedText === 'string' && savedText.length > 0) {
      setCurrentText(savedText, 'restored (self-test cleanup)', { persist: false });
    } else {
      currentText = null;
      wordSpans = [];
      readingTextEl.innerHTML = '';
      activeWordIndex = -1;
      updateStartButtonState();
    }
  }
}
window.runClockDecoupleSelfTest = runClockDecoupleSelfTest;

// --- Entry 60: resume-offset diagnostic -------------------------------------
// Built to confirm/rule out a mechanism a student report surfaced after
// Entry 59 deployed: on mouth-close then reopen, speech sometimes resumes
// from BEHIND where it actually stopped ("reads from back").
//
// Hypothesis, from reading the code (not guessed): Entry 59 split
// highlightWordAt() so lastWordBoundaryTime/currentSpokenWordExpectedMs (the
// mouth-close CADENCE clock) can only be grounded-written. It did NOT touch
// lastBoundaryOffset — a separate variable, still written by BOTH the real
// onboundary handler AND scheduleFallbackAdvance's ungrounded fallback tick
// (see the grep: line ~674 fallback, line ~2356 real). onMouthOpen()'s
// resume position is computed directly from it:
//   const resumeOffset = baseOffset + lastBoundaryOffset;
// On a browser with unreliable/absent onboundary (mobile — confirmed 0/14
// in earlier testing), lastBoundaryOffset is fallback-only for the whole
// utterance. If the fallback's timing estimate lags behind where real
// speech actually is (uncorrected fallbackRateFactor, see Entry 58's
// measured ~0.6 ratio), lastBoundaryOffset lags too — so resume reads a
// stale, earlier position. Same class of bug Entry 59 fixed, different
// variable, never addressed.
//
// This doesn't need live mouth-tracking to test — onMouthClosed()/
// onMouthOpen() are called directly, same seam runClockDecoupleSelfTest
// uses for speakFrom(). Ground truth is defined by the test script itself
// (a fixed simulated words-per-second the fallback never sees an onboundary
// for), not measured from anything the app produces — so "true position at
// close" is known by construction, not inferred.
function runResumeOffsetDiagnostic(pinnedFactor, trueScale) {
  const factorToUse = typeof pinnedFactor === 'number' && pinnedFactor > 0 ? pinnedFactor : 1.0;
  // trueScale: how the SIMULATED real speech relates to estimateWordDuration's
  // own syllable-weighted base — same shape, different constant, rather than
  // the first version's flat per-word ms (which the "seven" vs "one"/"two"
  // delay difference in the 0.44 run exposed as an unfair ground truth: real
  // speech naturally varies with word length, so comparing it against a flat
  // model manufactured a residual that wasn't really about drift). Defaults
  // to matching factorToUse, i.e. "what if the factor were exactly right."
  const scaleToUse = typeof trueScale === 'number' && trueScale > 0 ? trueScale : factorToUse;
  const TEST_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const testText = TEST_WORDS.join(' ');

  // Deliberately faster than the fallback's own raw per-word estimate
  // (~340-560ms/word per Entry 59's self-test comments) — simulates the
  // "real speech is faster than predicted" scenario Entry 58 measured
  // directly (real ratio ~0.6), without claiming this exact number IS that
  // ratio. The point is only that real < predicted, which is what makes
  // lastBoundaryOffset lag in the first place.
  //
  // Same shape as the app's own estimate, scaled by scaleToUse — NOT a flat
  // per-word constant (see the function-level comment on trueScale for why
  // that mattered).
  function trueWordDurationMs(word) {
    return estimateWordDuration(word) * scaleToUse;
  }

  // Word indices to simulate a mouth-close at — early/mid/late, to also
  // show whether the resume error grows the longer speech has been running
  // (matching what was actually reported: "grows steadily worse").
  const CLOSE_AT_WORD_INDICES = [3, 6, 9];

  let resultsBox = document.getElementById('resumeOffsetDiagnosticResults');
  if (!resultsBox) {
    resultsBox = document.createElement('div');
    resultsBox.id = 'resumeOffsetDiagnosticResults';
    resultsBox.style.cssText = 'position:fixed;bottom:12px;left:12px;max-width:440px;background:#111;color:#eee;font:13px/1.4 monospace;padding:14px;border-radius:8px;z-index:99999;box-shadow:0 4px 18px rgba(0,0,0,0.4);white-space:pre-wrap;';
    document.body.appendChild(resultsBox);
  }
  resultsBox.textContent = 'Running resume-offset diagnostic...';

  const savedSynth = ttsEngine.synth;
  const savedCtor = ttsEngine.UtteranceCtor;
  const savedText = currentText;
  const savedFallbackRateFactor = fallbackRateFactor;
  fallbackRateFactor = factorToUse; // parameterized — see runResumeOffsetDiagnostic(pinnedFactor)

  function FakeUtterance(text) {
    this.text = text;
    this.onboundary = null;
    this.onstart = null;
    this.onend = null;
    this.voice = null;
    this.pitch = 1;
    this.rate = 1;
  }

  // Fallback-only synth: no scripted onboundary, ever. Mirrors mobile's
  // confirmed 0/14 onboundary behavior — the exact condition under which
  // lastBoundaryOffset becomes fallback-only for an entire utterance.
  function makeFakeSynth() {
    let speaking = false;
    let timers = [];
    return {
      get speaking() { return speaking; },
      speak(utterance) {
        speaking = true;
        timers.push(setTimeout(() => { if (speaking && utterance.onstart) utterance.onstart(); }, 0));
      },
      cancel() {
        speaking = false;
        timers.forEach(id => clearTimeout(id));
        timers = [];
      },
    };
  }

  const results = [];

  function runTrial(closeAtWordIdx, onDone) {
    window.__clockWriteLog = [];
    CLOCK_SELFTEST_ACTIVE = true;
    setCurrentText(testText, 'self-test', { persist: false });
    ttsEngine.synth = makeFakeSynth();
    ttsEngine.UtteranceCtor = FakeUtterance;
    setReadingActive(true);
    speakFrom(0);

    setTimeout(() => {
      // Ground truth, by construction — not read from the app.
      const trueWordIdx = closeAtWordIdx;

      // What the app itself believes right now, purely from the (fallback-
      // only, for this trial) lastBoundaryOffset — read directly since this
      // diagnostic lives in the same module scope as speakFrom.
      const believedOffset = baseOffset + lastBoundaryOffset;
      const believedWordIdx = wordSpans.findIndex(w => believedOffset >= w.start && believedOffset < w.end);

      onMouthClosed();
      onMouthOpen(); // resumes synchronously via speakFrom(); activeWordIndex is set before this call returns

      const resumedWordIdx = activeWordIndex;

      results.push({
        trueWordIdx,
        believedWordIdx,
        resumedWordIdx,
        wordsBehind: trueWordIdx - resumedWordIdx,
      });

      // Hard-stop before the next trial — don't rely on onMouthClosed alone,
      // this trial's fake synth may have a pending onstart timer from the
      // resume's own speakFrom() call.
      cancelActiveSpeech();
      clearFallbackAdvance();
      setIsSpeakingChunk(false);
      setReadingActive(false);

      setTimeout(onDone, 20);
    }, TEST_WORDS.slice(0, closeAtWordIdx).reduce((sum, w) => sum + trueWordDurationMs(w), 0));
  }

  function runNext(i) {
    if (i >= CLOSE_AT_WORD_INDICES.length) {
      finishDiagnostic();
      return;
    }
    runTrial(CLOSE_AT_WORD_INDICES[i], () => runNext(i + 1));
  }

  function finishDiagnostic() {
    CLOCK_SELFTEST_ACTIVE = false;

    const lines = results.map(r =>
      `  • Closed at word #${r.trueWordIdx + 1} ("${TEST_WORDS[r.trueWordIdx]}") — fallback believed word #${r.believedWordIdx + 1}, resumed at word #${r.resumedWordIdx + 1} (${r.wordsBehind} word(s) behind true position)`
    );
    const anyBehind = results.some(r => r.wordsBehind > 0);
    const summary = anyBehind
      ? `Resume landed behind true position (fallbackRateFactor=${factorToUse}, trueScale=${scaleToUse}):\n${lines.join('\n')}\n\nNOTE: fallbackRateFactor and trueScale are now the SAME shape (both scale estimateWordDuration), so if this run used matching values and still shows divergence, that's real residual, not a flat-vs-weighted artifact — worth investigating further. Try runResumeOffsetDiagnostic(0.44, 0.44) for a fully matched baseline.`
      : `No divergence this run (fallbackRateFactor=${factorToUse}, trueScale=${scaleToUse}) — resume matched true position in all ${results.length} trials:\n${lines.join('\n')}`;

    console.log('[resume-offset diagnostic] ' + summary);
    resultsBox.textContent = 'Entry 60 resume-offset diagnostic\n\n' + summary + '\n\n(Full log in console. Safe to dismiss — reload clears it.)';

    ttsEngine.synth = savedSynth;
    ttsEngine.UtteranceCtor = savedCtor;
    fallbackRateFactor = savedFallbackRateFactor;
    if (fallbackRateFactorValueEl) fallbackRateFactorValueEl.textContent = fallbackRateFactor.toFixed(3);
    setIsSpeakingChunk(false);
    setReadingActive(false);
    clearFallbackAdvance();
    if (typeof savedText === 'string' && savedText.length > 0) {
      setCurrentText(savedText, 'restored (self-test cleanup)', { persist: false });
    } else {
      currentText = null;
      wordSpans = [];
      readingTextEl.innerHTML = '';
      activeWordIndex = -1;
      updateStartButtonState();
    }
  }

  runNext(0);
}
window.runResumeOffsetDiagnostic = runResumeOffsetDiagnostic;