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
// Phase 11: these were consts until now. Calibration's new 5th step ("Speed")
// can override both per-device, same pattern as OPEN_THRESHOLD/CLOSE_THRESHOLD
// in Phase 7b. DEFAULT_* are the fallback used whenever no saved speed
// calibration exists yet (either a brand-new install, or a pre-Phase-11
// saved calibration that only has MAR/pose fields) — an uncalibrated speed
// setting behaves exactly as before.
const DEFAULT_MS_PER_SYLLABLE = 220;
const DEFAULT_BASE_WORD_MS = 120; // floor so even a 1-syllable word gets a sane estimate
let MS_PER_SYLLABLE = DEFAULT_MS_PER_SYLLABLE;
let BASE_WORD_MS = DEFAULT_BASE_WORD_MS;

// Phase 11: utterance.rate was confirmed unused/fixed at the Web Speech
// default (1.0) through Phase 8 (see Section 3 of PROGRESS.md) — this is the
// lever that finally uses it. Derived from the same Speed calibration step
// as MS_PER_SYLLABLE/BASE_WORD_MS above (never tuned independently — see
// speakFrom), so TTS pacing and mouth-close cadence detection move together
// instead of racing ahead of/lagging behind a user's real mumbling speed.
const DEFAULT_PERSONALIZED_RATE = 1.0;
let PERSONALIZED_RATE = DEFAULT_PERSONALIZED_RATE;

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
// three refinements found via testing against the real READING_TEXT (not
// just isolated words):
//   1. Punctuation stripping — word spans include attached punctuation
//      (buildWordSpans uses \S+), so "sentence," was failing the trailing-'e'
//      check below simply because it ends in ',' not 'e'. Strip anything
//      that isn't a-z before doing any of this.
//   2. Consonant+'le' exception — a trailing silent-e gets subtracted (see
//      below), but words ending in "consonant + le" (table, little, single)
//      are a different pattern: that 'e' is NOT silent, it's part of a real
//      spoken syllable. Detected via a simple suffix check; skip the
//      subtraction when it matches.
//   3. Mid-word silent-e (Phase 7c, was a deferred known gap from Entry 10 —
//      "movement" overcounted as 3 instead of 2, since the silent 'e' in
//      "move" isn't at the very end of the whole word so refinement #2's
//      end-of-word check missed it). Fixed generally rather than as a one-off:
//      a base "magic e" word (vowel+consonant+e — move, care, hope, late)
//      keeps its silent 'e' in spelling when a common consonant-initial
//      suffix is attached (movement, careless, hopeful, lately), even though
//      it's still silent. Detected via a small suffix list + checking the
//      stem (word minus suffix) for the same vowel-consonant-e pattern used
//      above. Verified via direct testing against READING_TEXT plus a set of
//      common real-word cases (careless, management, wireless, etc.) to
//      check it generalizes without misfiring on unrelated words (e.g.
//      "elephant", "quickly", "endless" correctly stay unaffected).
// Floor of 1 so every real word gets at least one syllable's worth of
// expected duration, even after any silent-e subtraction.
const SILENT_E_SUFFIXES = ['ment', 'ness', 'less', 'ful', 'ly', 'ship', 'ward', 'some'];

function estimateSyllables(word) {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, '');
  const matches = cleaned.match(/[aeiouy]+/g);
  let syllables = matches ? matches.length : 0;

  const endsInConsonantLe = /[^aeiouy]le$/.test(cleaned);
  if (cleaned.endsWith('e') && !endsInConsonantLe && syllables > 1) {
    syllables -= 1;
  }

  for (const suffix of SILENT_E_SUFFIXES) {
    if (cleaned.endsWith(suffix) && cleaned.length > suffix.length) {
      const stem = cleaned.slice(0, -suffix.length);
      if (/[aeiouy][^aeiouy]e$/.test(stem) && syllables > 1) {
        syllables -= 1;
      }
      break; // only one suffix can match the end of a word
    }
  }

  return Math.max(1, syllables);
}

function estimateWordDuration(word) {
  return BASE_WORD_MS + estimateSyllables(word) * MS_PER_SYLLABLE;
}

// --- Phase 11: sample sentence for the Speed calibration step ---
// Deliberately spans a range of syllable counts (per this file's own
// estimateSyllables — internal consistency matters more than strict
// linguistic accuracy, since the regression below only needs to relate
// THIS app's syllable estimate to THIS user's mouthing duration) so the
// regression in finishCalibration has enough spread to separate a personal
// "per-syllable" rate from a personal "fixed per-word overhead," rather
// than collapsing to one blended average like a single-number timing would.
const SAMPLE_SENTENCE = "The cat slowly wandered through an unexpectedly enormous garden " +
  "while butterflies fluttered quietly overhead.";
const SAMPLE_WORDS = SAMPLE_SENTENCE.match(/\S+/g).map(text => ({
  text,
  syllables: estimateSyllables(text)
}));
// Phase 11 (revised): the Speed step now asks for SAMPLE_WORDS TWICE through
// — see the CALIBRATION_STEPS 'rate' entry for the full reasoning. Word
// index in the tracker wraps via `% SAMPLE_WORDS.length` against this.
const RATE_PASSES = 2;

// Picks the word this cadence estimate should be based on: the currently
// highlighted word if one is active, otherwise the word at the pending
// resume offset (covers the moment right after Start Reading / a click,
// before the first onboundary event has landed).
function getWordForCadence() {
  if (activeWordIndex !== -1) return wordSpans[activeWordIndex].span.textContent;
  const idx = wordSpans.findIndex(w => (baseOffset + lastBoundaryOffset) >= w.start && (baseOffset + lastBoundaryOffset) < w.end);
  return idx !== -1 ? wordSpans[idx].span.textContent : '';
}

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

// Finds the end (exclusive-of-nothing, i.e. index right after the punctuation
// mark) of the sentence starting at fromOffset. Falls back to the end of the
// text if no sentence-ending punctuation is found (last sentence, or text
// doesn't end with one) — this matches the pre-Phase-8 default of speaking
// everything remaining in one chunk. Known limitation, not handled: doesn't
// distinguish abbreviations like "Mr." from real sentence ends — acceptable
// for the current heuristic-first scope.
function findSentenceEnd(text, fromOffset) {
  const rest = text.slice(fromOffset);
  const match = rest.match(/[.!?]/);
  if (!match) return text.length;
  return fromOffset + match.index + 1;
}

// Punctuation -> {pitch, rate, label}. Neutral matches the untouched Web
// Speech defaults (pitch 1.0, rate 1.0) so a plain '.' sentence sounds
// identical to how every sentence sounded before this phase.
function getToneForSentence(sentenceText) {
  const trimmed = sentenceText.trim();
  const lastChar = trimmed[trimmed.length - 1];
  if (lastChar === '!') return { pitch: 1.3, rate: 1.1, label: 'on, excited (!)' };
  if (lastChar === '?') return { pitch: 1.15, rate: 1.0, label: 'on, curious (?)' };
  return { pitch: 1.0, rate: 1.0, label: 'on, neutral' };
}

// --- Phase 3: longer pre-loaded text, word-by-word highlighting ---
// TEMPORARY (Phase 8): the trailing sentence below was added purely so the
// emotional-tone toggle has a '?' and a '!' to react to during testing — the
// original text only had periods/commas. Remove/replace once Phase 10 (real
// text input) ships; not a permanent part of the reading content.
const READING_TEXT = "This is a longer piece of test text for phase three. Instead of a single " +
  "short sentence, we now advance word by word while you read, using the same mouth movement " +
  "signal from phase two. As each word is spoken it should highlight on screen, and if you turn " +
  "your head away from the camera the reading should pause automatically, even if your mouth is " +
  "still moving. Wait, did you hear that? That was surprising! This next part should sound " +
  "different, exciting even!";

let readingActive = false;      // true from Start Reading click until the whole text finishes
let isSpeakingChunk = false;    // true while a (possibly multi-word) utterance is actively speaking
let manualCancel = false;       // true right before we intentionally cancel() due to mouth closing
let currentUtterance = null;
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
const lastBoundaryAgoValueEl = document.getElementById('lastBoundaryAgoValue');

let baseOffset = 0;             // char offset into READING_TEXT where currentUtterance's text starts
let lastBoundaryOffset = 0;     // charIndex within currentUtterance of the most recent word boundary
let wordSpans = [];             // { span, start, end } built from READING_TEXT
let activeWordIndex = -1;
let lastWordBoundaryTime = 0;        // Phase 11b (fixed): performance.now() at the most recent onboundary
let currentSpokenWordExpectedMs = 0; // expected duration for the word currently being spoken

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
let lastYaw = 0;   // Phase 11b: most recent yaw/pitch, kept outside updateHeadPose's
let lastPitch = 0; // own scope so the trouble-shading score (computed once per frame
                    // in predictLoop) can read it without recomputing.

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

// Phase 11: validation for the Speed step's regression. A duration-per-word
// regression needs both (a) enough data points and (b) enough syllable-count
// *variety* among them — e.g. 6 captured words that are all 1-syllable can't
// separate BASE_WORD_MS from MS_PER_SYLLABLE (infinite equally-good fits),
// same failure shape as trying to fit a line through points with no spread
// on the x-axis. Both are checked in finishCalibration before trusting the
// fit, same "reject rather than silently save broken values" pattern as
// MIN_MAR_GAP/MIN_POSE_THRESHOLD above.
const MIN_RATE_WORDS_CAPTURED = 6;
const MIN_RATE_SYLLABLE_SPREAD = 2; // max syllables captured - min syllables captured, must exceed this

// Phase 11 rebuild: the original Speed-step tracker required MAR to cross a
// full CLOSE_THRESHOLD between every word, same as the main reading loop's
// mouth-close detection. Live testing showed this breaks down badly during
// natural continuous mouthing — connected speech often doesn't dip all the
// way to "closed" between words, and the effect got *worse* the faster the
// user mouthed (confirmed live: a fast run produced a NEGATIVE
// msPerSyllable slope, i.e. multiple real words silently merging into one
// tracked interval). Replaced with peak-trough envelope detection: track
// whether the (lightly smoothed) MAR signal is rising or falling, and
// confirm a word boundary at each local minimum that dips by at least
// RATE_PROMINENCE_FRACTION of the user's own neutral-to-mutter range below
// the preceding peak — no absolute "closed" crossing required. This is the
// same idea speech-processing envelope segmentation uses for syllable/word
// boundaries in continuous speech.
const RATE_SMOOTHING_ALPHA = 0.35; // EMA factor on raw MAR before peak-trough detection, filters landmark jitter without much lag (words run several hundred ms+)
// Lowered from 0.25 (Phase 11 testing, this session): live diagnostic
// logging showed "enormous" clearing the old threshold (0.0327) by only 3%
// margin (0.0338), while words repeatedly needing manual repeats across
// multiple test runs ("fluttered", "quietly", "butterflies") share a
// pattern — they're articulated more with lips/tongue than jaw drop, so
// even a clear, natural attempt produces a smaller true MAR swing than an
// open-vowel word like "cat" or "an". A single fixed threshold can't serve
// both equally; 0.15 was chosen to sit comfortably below the smallest
// genuine swings observed (~0.033-0.09) while staying well above the
// sensor noise floor (RATE_MIN_PROMINENCE).
const RATE_PROMINENCE_FRACTION = 0.15;
const RATE_MIN_PROMINENCE = 0.01; // floor, in case a user's own neutral-mutter gap is unusually small

// Live testing (two full rounds) showed even a clean per-word tracker isn't
// enough on its own: a single natural read-through of the sample sentence
// reliably contains at least one hesitation/thinking-pause on some word,
// and ordinary least-squares has no defense against that with only ~14
// points — one outlier can flip the fitted slope negative. Rejected before
// fitting using a standard modified z-score on PACE (duration/syllables,
// not raw duration — a legitimately slow 5-syllable word shouldn't look
// like an outlier next to a fast 1-syllable one). 3.0 is the conventional
// default for this method (Iglewicz & Hoaglin).
const RATE_OUTLIER_Z_THRESHOLD = 3.0;

// Real problem found via testing (not a threshold issue): when a word's dip
// doesn't register, the tracker just keeps waiting — it has no idea the
// user noticed and repeated the word 2-3 times to force a detection. That
// repeated time silently gets folded into ONE captured duration, and worse,
// if a whole trough gets missed entirely, every capture after that point is
// paired with the wrong word/syllable-count for the rest of the run —
// corruption the outlier filter can't reliably catch, since a misaligned
// entry can still look individually "normal." Rather than let a run finish
// looking complete while secretly corrupted, a stall now fails the step
// immediately (same "reject, don't silently save" pattern as every other
// validation in this file) so the user retries cleanly instead of powering
// through with repeats.
const RATE_STALL_FACTOR = 5; // how many multiples of a word's generic estimated duration counts as "stuck"
const RATE_STALL_MIN_MS = 2500; // floor, so a short 1-syllable word's tiny generic estimate can't make the stall trigger unreasonably fast

// Found via testing (opposite problem from the stall above): loose, fast
// mumbling can produce enough small rise/fall wobble WITHIN a single word
// that each wobble individually clears prominenceThreshold — the tracker
// raced ahead of real speech, consuming all 14 word slots on internal
// jaw-bounce noise rather than genuine word-to-word gaps. Standard fix for
// this class of problem in any peak-detection system: a refractory period
// after each confirmed trough during which another can't be confirmed, so
// the detector can't fire faster than physically plausible for distinct
// spoken words. 200ms is an unvalidated starting guess (based on the
// fastest genuine word duration seen in testing, ~250ms, minus margin) —
// same "starting guess, live-tune from real data" tier as every other
// threshold in this file.
const MIN_INTER_TROUGH_MS = 200;

// Tried and reverted (Phase 11): an adaptive version of prominenceThreshold
// that re-derived itself from the rolling average of recently CONFIRMED
// word swings, meant to track declining amplitude over a longer utterance.
// Live testing showed a repeat needed on one word inflates that word's
// recorded swing (it's the merged motion of multiple attempts), which then
// raised the threshold for the NEXT word too — a feedback loop that made
// failures compound instead of self-correcting. Reverted to the fixed
// version below. See PROGRESS.md Section 3 for the fuller reasoning.
// Sane bounds for the regression output — guards against a noisy fit (e.g.
// from a distracted run) producing an unusable/unintelligible personalized
// rate or pacing. Centered around the DEFAULT_* constants above.
//
// MIN_MS_PER_SYLLABLE/MAX_BASE_WORD_MS updated (mobile testing session,
// post-Entry-22): the original bounds (80 / 300) were guessed against the
// assumption that per-syllable cost dominates a word's duration. A real
// calibration run (console log, 28/28 words captured, clean two-pass fit)
// showed the opposite shape for this user: raw fit msPerSyllable=3.4,
// baseWordMs=642.7 — a large fixed per-word cost (mouth open/close
// overhead) with almost no additional cost per syllable. The old bounds
// didn't just trim that fit, they inverted it: msPerSyllable got floored
// UP from 3.4 to 80 (24x), baseWordMs got capped DOWN from 642.7 to 300
// (more than half), and the resulting personalizedRate came out as 1.272
// (audibly fast) where the unclamped raw fit gives ~0.93 (slightly slow —
// the sane answer for someone with heavy per-word overhead). Widened so a
// real fit like this one passes through un-mangled. MIN_MS_PER_SYLLABLE
// floors at 0 rather than removing the floor entirely — a NEGATIVE slope
// (longer words taking less time) is still implausible and worth guarding
// against; near-zero is not. MAX_BASE_WORD_MS raised to 800, giving
// headroom above the one real data point seen so far while still guarding
// against a genuinely runaway noisy fit. Revisit if real fits start
// clustering near these new bounds the same way they did at the old ones —
// same "the bound is wrong, not the fit" signal as before.
const MIN_PERSONALIZED_RATE = 0.5;
const MAX_PERSONALIZED_RATE = 2.0;
const MIN_MS_PER_SYLLABLE = 0;
const MAX_MS_PER_SYLLABLE = 500;
const MIN_BASE_WORD_MS = 0;
const MAX_BASE_WORD_MS = 800;

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
//   3. Reads off this user's CALIBRATED thresholds (YAW_THRESHOLD,
//      PITCH_THRESHOLD, currentWordExpectedMs from Phase 11's personalized
//      cadence), not raw values — so a twitchy mumbler and a slow one both
//      see "trouble" mean the same thing: how close they are to THEIR OWN
//      threshold, not an absolute scale.
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

// Sharp-pulse trigger for a stuck word during LIVE reading. Deliberately
// looser (fires sooner) than calibration's RATE_STALL_FACTOR (5x) — this is
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

// Pose trouble: continuous distance toward THIS user's calibrated gating
// boundary, normalized 0-1. Naturally ~0 during normal reading wobble and
// rises smoothly as the user approaches (not just crosses) the threshold —
// gives earlier, gentler warning than waiting for an actual gate trip.
function computePoseTrouble() {
  if (YAW_THRESHOLD <= 0 || PITCH_THRESHOLD <= 0) return 0;
  const yawFrac = Math.abs(lastYaw) / YAW_THRESHOLD;
  const pitchFrac = Math.abs(lastPitch) / PITCH_THRESHOLD;
  return Math.min(1, Math.max(yawFrac, pitchFrac));
}

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
  if (!readingActive || mouthState !== 'open' || currentSpokenWordExpectedMs <= 0) return 0;
  const elapsedMs = performance.now() - lastWordBoundaryTime;
  const ratio = elapsedMs / currentSpokenWordExpectedMs;
  if (ratio <= 1) return 0;
  return Math.min(1, (ratio - 1) / (TROUBLE_CADENCE_OVERRUN_CAP - 1));
}

function computeRawTroubleScore() {
  if (!readingActive) return 0; // calm border whenever there's no active session to have trouble in
  return Math.max(computePoseTrouble(), computeCadenceTrouble());
}

// Called once per frame from predictLoop (skipped during calibration, same
// as the mouth/pose updates it depends on). Smooths the raw score with
// asymmetric rates (slow up, fast down — see design note above) and paints
// the ambient border from it.
function updateTroubleShading() {
  const raw = computeRawTroubleScore();
  const rate = raw > displayedTroubleScore ? TROUBLE_ACCUMULATE_RATE : TROUBLE_RECOVER_RATE;
  displayedTroubleScore += (raw - displayedTroubleScore) * rate;
  if (displayedTroubleScore < 0.01) displayedTroubleScore = 0; // settle fully instead of trailing asymptotically forever

  const opacity = displayedTroubleScore * TROUBLE_MAX_OPACITY;
  const saturation = TROUBLE_MIN_SATURATION + displayedTroubleScore * (TROUBLE_MAX_SATURATION - TROUBLE_MIN_SATURATION);
  readingPaneEl.style.borderColor = `hsla(0, ${saturation}%, 45%, ${opacity})`;
  troubleValueEl.textContent = displayedTroubleScore.toFixed(2);

  checkReadingStallPulse();
}

// Live-reading analog of calibration's stall detection (Phase 11), but
// non-blocking: it just fires the sharp cue, nothing is aborted or retried.
// Same bugfix as computeCadenceTrouble above — per-word clock, not mouth-open clock.
function checkReadingStallPulse() {
  if (!readingActive || mouthState !== 'open' || currentSpokenWordExpectedMs <= 0) return;
  const elapsedMs = performance.now() - lastWordBoundaryTime;
  const stallThreshold = Math.max(READING_STALL_MIN_MS, currentSpokenWordExpectedMs * READING_STALL_FACTOR);
  if (elapsedMs > stallThreshold) {
    maybeFireTroublePulse();
  }
}

function maybeFireTroublePulse() {
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
function resetTroubleShading() {
  displayedTroubleScore = 0;
  lastPulseTime = 0;
  lastWordBoundaryTime = performance.now();
  currentSpokenWordExpectedMs = 0;
  readingPaneEl.classList.remove('trouble-pulse');
  readingPaneEl.style.borderColor = 'transparent';
  troubleValueEl.textContent = '0.00';
}

const CALIBRATION_STEPS = [
  {
    id: 'neutral',
    label: 'Step 1 of 5 — Neutral face',
    instruction: 'Relax your mouth naturally, like you\'re not reading. Hold still.',
    prepMs: 1000,
    sampleMs: 3000,
    metric: 'mar'
  },
  {
    id: 'mutter',
    label: 'Step 2 of 5 — Silent mouthing',
    instruction: 'Silently mouth this sentence as if reading aloud, no need to make sound: ' +
      '"The quick brown fox jumps over the lazy dog."',
    prepMs: 1000,
    sampleMs: 4000,
    metric: 'mar'
  },
  {
    id: 'facing',
    label: 'Step 3 of 5 — Facing screen',
    instruction: 'Look directly at the camera, like you\'re reading normally. Hold still.',
    prepMs: 1000,
    sampleMs: 3000,
    metric: 'pose'
  },
  {
    id: 'away',
    label: 'Step 4 of 5 — Turned away',
    instruction: 'Turn your head to where you\'d expect reading to pause, and hold it there.',
    prepMs: 1000,
    sampleMs: 3000,
    metric: 'pose'
  },
  {
    id: 'rate',
    // Phase 11 (revised): asks for the sentence TWICE now — a single 14-word
    // pass produced a noisy regression even on fully clean captures (no
    // detection failures, no outliers), because syllable count alone is a
    // crude proxy for real timing (word familiarity, stress, coarticulation
    // all matter too) — one pass just isn't enough data to fit two free
    // parameters reliably. A second pass through the SAME sentence lets each
    // word's noise average against an independent second measurement of
    // that exact word, which is the right remedy for word-specific
    // noise — a different sentence would add variety but not that.
    // Instruction says "twice" up front in the static text rather than via
    // a live prompt mid-run — deliberate, given prior testing showed live
    // reactive feedback here changes how naturally people mouth the words.
    label: 'Step 5 of 5 — Your pace',
    instruction: 'At your own natural pace, silently mouth this sentence TWICE through, word by word, ' +
      'pausing briefly between words like normal reading: "' + SAMPLE_SENTENCE + '"',
    prepMs: 1500,
    // Doubled from the single-pass ceiling — generous, not a target, same
    // reasoning as before.
    sampleMs: 38000,
    metric: 'rate'
  }
];

let calibration = {
  active: false,
  stepIndex: -1,
  phase: null,          // 'prep' | 'sampling'
  phaseStartTime: 0,
  currentSamples: [],   // samples for the step currently being collected (mar/pose steps)
  results: {},           // stepId -> array of samples, filled in as steps complete
  // Phase 11: live open/closed word-boundary tracker used only during the
  // 'rate' step's sampling phase. Separate from the main reading session's
  // mouthState/marBuffer (Section 3) since calibration isn't a reading
  // session and shouldn't touch that state.
  rateTracker: null,    // { smoothedMar, baselineValue, baselineTime, direction, extremeValue, extremeTime, previousTroughTime, wordIndex, durations, prominenceThreshold }
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
    calibration.phase = 'prep';
    calibration.phaseStartTime = now;
    calibration.currentSamples = [];
    calibration.rateTracker = null;
    renderCalibrationStep();
  }
}

// Phase 11 (rebuilt): scale for the Speed step's peak-trough word-boundary
// detection, derived from the neutral/mutter steps already collected
// (steps 1-2) — same source data the old absolute-threshold version used,
// just used differently now (see RATE_PROMINENCE_FRACTION's comment above).
function computeRateProminenceThreshold() {
  const neutralMar = average(calibration.results.neutral.map(s => s.mar));
  const mutterMar = average(calibration.results.mutter.map(s => s.mar));
  const gap = Math.abs(mutterMar - neutralMar);
  const threshold = Math.max(RATE_MIN_PROMINENCE, gap * RATE_PROMINENCE_FRACTION);
  // TEMPORARY (Phase 11 threshold validation): every previous round tuned
  // RATE_PROMINENCE_FRACTION without ever seeing the actual MAR-unit number
  // it produces, or how it compares to real achieved swings (added below).
  // This is that missing visibility.
  console.log(`[Phase 11 rate] fixed threshold=${threshold.toFixed(4)} ` +
    `(neutral=${neutralMar.toFixed(4)}, mutter=${mutterMar.toFixed(4)}, gap=${gap.toFixed(4)})`);
  return threshold;
}

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
      if (step.metric === 'rate') {
        calibration.rateTracker = {
          smoothedMar: null,     // EMA state, seeded from the first sampling-phase frame
          baselineValue: null,   // "at rest" MAR right after the countdown ends, before real movement is detected
          baselineTime: 0,
          direction: null,       // null -> 'unknown' (waiting for real movement) -> 'up' | 'down'
          extremeValue: null,    // running peak (direction 'up') or trough (direction 'down') candidate
          extremeTime: 0,
          previousTroughTime: now, // fallback only — overwritten once real movement is first detected
          wordIndex: 0,
          durations: [],          // { word, syllables, durationMs }
          prominenceThreshold: computeRateProminenceThreshold(),
          lastPeakValue: null      // diagnostic only — see comment at the peak-confirm branch
        };
      }
    }
    return;
  }

  // phase === 'sampling'
  if (step.metric === 'rate') {
    updateRateCalibration(mar, now, step);
    return;
  }

  calibration.currentSamples.push({ mar, yaw, pitch });
  const remaining = Math.max(0, step.sampleMs - elapsed);
  calibrationCountdownEl.textContent = `Hold it... ${Math.ceil(remaining / 1000)}`;

  if (elapsed >= step.sampleMs) {
    completeCalibrationStep(now, calibration.currentSamples);
  }
}

// Phase 11 (rebuilt): live per-word timing for the Speed step, via
// peak-trough envelope detection rather than absolute threshold crossing —
// see the RATE_SMOOTHING_ALPHA/RATE_PROMINENCE_FRACTION comment above for
// why the original simpler version (mirroring updateMouthState's
// open/closed hysteresis) didn't hold up under real testing.
// Records a confirmed word boundary (a trough) and advances to the next
// expected word. Shared by the live zigzag confirmation below and the
// timeout finalization at the end of this function.
function recordRateWordBoundary(tracker, troughTime) {
  const totalExpected = SAMPLE_WORDS.length * RATE_PASSES;
  const word = SAMPLE_WORDS[tracker.wordIndex % SAMPLE_WORDS.length];
  const passNumber = Math.floor(tracker.wordIndex / SAMPLE_WORDS.length) + 1;
  if (word && tracker.wordIndex < totalExpected) {
    const durationMs = troughTime - tracker.previousTroughTime;
    tracker.durations.push({ word: word.text, syllables: word.syllables, durationMs });
    // TEMPORARY (Phase 11 threshold validation, remove once
    // MIN_RATE_WORDS_CAPTURED/MIN_RATE_SYLLABLE_SPREAD/clamp bounds are set
    // from real data instead of starting guesses): live visibility into
    // each word capture as it happens.
    console.log(`[Phase 11 rate] word ${tracker.wordIndex + 1}/${totalExpected} (pass ${passNumber}) ` +
      `"${word.text}" (${word.syllables} syll): ${Math.round(durationMs)}ms`);
  }
  tracker.wordIndex += 1;
  tracker.previousTroughTime = troughTime;
}

function updateRateCalibration(mar, now, step) {
  const tracker = calibration.rateTracker;
  const elapsed = now - calibration.phaseStartTime;

  // EMA smoothing — see RATE_SMOOTHING_ALPHA's comment above.
  tracker.smoothedMar = tracker.smoothedMar === null
    ? mar
    : tracker.smoothedMar + RATE_SMOOTHING_ALPHA * (mar - tracker.smoothedMar);
  const smoothed = tracker.smoothedMar;

  // Zigzag extrema confirmation: only flip direction, and only confirm an
  // extreme, once the signal has moved at least prominenceThreshold away
  // from the running candidate — this is what rejects landmark jitter
  // without needing an absolute "closed" crossing.
  if (tracker.direction === null) {
    // First frame of sampling: this is the "at rest" baseline, NOT the
    // start of word 1. Bug found via live testing: word 1's duration was
    // coming out wildly inconsistent (3s / 1.9s / 0.25s across three runs,
    // uncorrelated with actual speed) because previousTroughTime was being
    // seeded here, at the countdown's end — silently folding in whatever
    // reaction-time gap the user took before actually starting to mouth
    // the sentence. baselineValue/baselineTime below exist specifically so
    // that gap can be excluded once we know when real movement began.
    tracker.baselineValue = smoothed;
    tracker.baselineTime = now;
    tracker.direction = 'unknown';
  } else if (tracker.direction === 'unknown') {
    // Same prominence gate as the 'up'/'down' branches below — a plain
    // frame-to-frame comparison here (the original version of this branch)
    // committed to a direction on the very first frame of noise, which is
    // exactly what let the reaction-time gap leak into word 1's duration
    // in the first place.
    if (smoothed - tracker.baselineValue >= tracker.prominenceThreshold) {
      tracker.direction = 'up';
      tracker.previousTroughTime = tracker.baselineTime; // real movement starts here, not at countdown-end
      tracker.extremeValue = smoothed;
      tracker.extremeTime = now;
    } else if (tracker.baselineValue - smoothed >= tracker.prominenceThreshold) {
      tracker.direction = 'down';
      tracker.previousTroughTime = tracker.baselineTime;
      tracker.extremeValue = smoothed;
      tracker.extremeTime = now;
    }
    // else: still at rest, waiting for real movement — don't advance anything.
  } else if (tracker.direction === 'up') {
    if (smoothed > tracker.extremeValue) {
      tracker.extremeValue = smoothed;
      tracker.extremeTime = now;
    } else if (tracker.extremeValue - smoothed >= tracker.prominenceThreshold) {
      // Confirmed peak (mid-word) — start tracking the trough candidate
      // that follows it. The peak itself isn't recorded as a word-boundary
      // event; only troughs mark those. lastPeakValue is kept for
      // diagnostic swing logging only (see the trough branch below) — it
      // deliberately does NOT feed back into prominenceThreshold this time,
      // unlike the reverted adaptive attempt.
      tracker.lastPeakValue = tracker.extremeValue;
      tracker.direction = 'down';
      tracker.extremeValue = smoothed;
      tracker.extremeTime = now;
    }
  } else if (tracker.direction === 'down') {
    if (smoothed < tracker.extremeValue) {
      tracker.extremeValue = smoothed;
      tracker.extremeTime = now;
    } else if (smoothed - tracker.extremeValue >= tracker.prominenceThreshold) {
      // Swing is big enough to be a real trough — but only confirm it if
      // enough real time has passed since the last one (refractory period,
      // see MIN_INTER_TROUGH_MS). If not, DON'T flip direction or reset the
      // candidate: keep tracking the current running minimum as-is (a
      // still-lower dip in the meantime correctly replaces it via the
      // branch above), so once the refractory window opens we confirm
      // using the true deepest point reached, not just "wherever we
      // happened to be when the timer allowed it."
      if (now - tracker.previousTroughTime >= MIN_INTER_TROUGH_MS) {
        // TEMPORARY (Phase 11 threshold validation): the actual achieved
        // swing size for this word, in the same MAR units as
        // prominenceThreshold — so we can finally see how close real
        // successful swings run to the threshold, instead of only seeing
        // pass/fail outcomes.
        if (tracker.lastPeakValue !== null) {
          const swing = tracker.lastPeakValue - tracker.extremeValue;
          console.log(`[Phase 11 rate] swing=${swing.toFixed(4)} vs threshold=${tracker.prominenceThreshold.toFixed(4)}`);
        }
        recordRateWordBoundary(tracker, tracker.extremeTime);
        tracker.direction = 'up';
        tracker.extremeValue = smoothed;
        tracker.extremeTime = now;
      }
    }
  }

  const remaining = Math.max(0, step.sampleMs - elapsed);
  const totalExpected = SAMPLE_WORDS.length * RATE_PASSES;
  const finishedAllWords = tracker.wordIndex >= totalExpected;

  if (!finishedAllWords) {
    const targetWord = SAMPLE_WORDS[tracker.wordIndex % SAMPLE_WORDS.length];
    // Deliberately generic — no word name shown here. Live testing showed
    // naming the target word turned "mouth at your natural pace" into
    // "watch the screen and react to it": users started consciously pacing
    // against the display (rushing words they knew would register easily,
    // lingering on ones they weren't sure about), which is exactly the
    // opposite of what this step is trying to measure. Stall detection
    // below still runs exactly the same — it just doesn't need to be
    // visible to work, only to fail visibly when it actually catches
    // something.
    calibrationCountdownEl.textContent =
      `Captured ${tracker.durations.length} of ${totalExpected} words... ${Math.ceil(remaining / 1000)}`;

    // Stall detection: how long have we been waiting for THIS word's
    // trough, versus a generous multiple of its generic estimated
    // duration? Deliberately generous (5x, floored at 2.5s) — this isn't
    // trying to catch a slightly-slow word, only a genuinely stuck
    // detection where the user has likely already started repeating.
    const stallDeadline = Math.max(
      RATE_STALL_MIN_MS,
      estimateWordDuration(targetWord.text) * RATE_STALL_FACTOR
    );
    if (now - tracker.previousTroughTime > stallDeadline) {
      showCalibrationFailure(
        `Got stuck detecting "${targetWord.text}" (word ${tracker.wordIndex + 1} of ${totalExpected}). ` +
        'Rather than continue with a misaligned run, this attempt is being discarded — retry and try ' +
        'mouthing each word a little more distinctly, with a brief pause between words.'
      );
      return;
    }
  }

  // Early completion: don't make a mumbler who finished the sentence sit
  // through a 20s timeout just because that's the ceiling we set for
  // stragglers.
  if (finishedAllWords) {
    completeCalibrationStep(now, tracker.durations);
    return;
  }
  if (elapsed >= step.sampleMs) {
    // Timeout mid-word: if the signal was still descending toward a trough
    // when time ran out (the common shape for "stopped right after the
    // last word, never swung back up"), credit the current best trough
    // candidate rather than silently dropping the last captured word.
    if (tracker.direction === 'down') {
      recordRateWordBoundary(tracker, tracker.extremeTime);
    }
    completeCalibrationStep(now, tracker.durations);
  }
}

// Ordinary least-squares fit of durationMs ≈ baseWordMs + msPerSyllable * syllables,
// over the captured { syllables, durationMs } pairs from the Speed step.
// Returns null if the fit is degenerate (near-zero denominator — happens
// when captured words don't have enough syllable-count spread, e.g. all
// 1-syllable), so the caller can reject rather than trust a wild/undefined
// slope. Standard closed-form two-parameter OLS, chosen over averaging a
// single word-rate ratio because it's the simplest method that can actually
// separate a fixed per-word overhead from a per-syllable rate — see
// MIN_RATE_SYLLABLE_SPREAD's comment for why that separation needs variety
// in the x values (syllable counts), not just more data points.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Rejects hesitation/thinking-pause outliers from the Speed step's captures
// before they reach the regression — see RATE_OUTLIER_Z_THRESHOLD's comment
// for why this is necessary even after the reaction-time fix above. Uses
// PACE (durationMs / syllables) rather than raw duration so a genuinely
// slow long word isn't penalized just for being long.
function filterRateOutliers(captures) {
  const paces = captures.map(c => c.durationMs / c.syllables);
  const med = median(paces);
  const mad = median(paces.map(p => Math.abs(p - med)));
  if (mad < 1e-6) return captures; // no spread to judge outliers against — keep everything

  const kept = [];
  const rejected = [];
  captures.forEach((c, i) => {
    const modifiedZ = 0.6745 * (paces[i] - med) / mad;
    (Math.abs(modifiedZ) <= RATE_OUTLIER_Z_THRESHOLD ? kept : rejected).push(c);
  });
  if (rejected.length > 0) {
    // TEMPORARY (Phase 11 threshold validation): visibility into what got
    // rejected and why, so RATE_OUTLIER_Z_THRESHOLD can be tuned from real
    // runs instead of guessed.
    console.log(`[Phase 11 rate] outliers rejected: ${rejected.map(c => c.word).join(', ')}`);
  }
  return kept;
}

function fitDurationRegression(points) {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.syllables, 0);
  const sumY = points.reduce((s, p) => s + p.durationMs, 0);
  const sumXY = points.reduce((s, p) => s + p.syllables * p.durationMs, 0);
  const sumXX = points.reduce((s, p) => s + p.syllables * p.syllables, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (Math.abs(denominator) < 1e-6) return null;

  const msPerSyllable = (n * sumXY - sumX * sumY) / denominator;
  const baseWordMs = (sumY - msPerSyllable * sumX) / n;
  return { msPerSyllable, baseWordMs };
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

  // Phase 11: third failure mode — the Speed step's captured word timings
  // weren't usable for a regression. Two distinct causes get one combined
  // check each, same "reject don't silently save" pattern as the two checks
  // above.
  const rateCaptures = calibration.results.rate || [];
  // TEMPORARY (Phase 11 threshold validation, remove alongside the log in
  // updateRateCalibration once thresholds are set from real data): one-line
  // summary per run, before any pass/fail branching below, so a failed run
  // is just as inspectable as a successful one.
  console.log(`[Phase 11 rate] run summary: ${rateCaptures.length}/${SAMPLE_WORDS.length * RATE_PASSES} words captured, ` +
    `syllables ${rateCaptures.map(c => c.syllables).join(',')}`);
  if (rateCaptures.length < MIN_RATE_WORDS_CAPTURED) {
    showCalibrationFailure(
      `Only captured ${rateCaptures.length} of ${SAMPLE_WORDS.length * RATE_PASSES} words in the pace step. ` +
      'Try mouthing the whole sentence more clearly, pausing briefly between words, then retry.'
    );
    return;
  }

  // Reject hesitation/thinking-pause outliers before trusting anything else
  // about this run — see RATE_OUTLIER_Z_THRESHOLD's comment. Checked again
  // for count after filtering: a run with borderline capture count that
  // then loses several words to outlier rejection isn't reliable either.
  const inlierCaptures = filterRateOutliers(rateCaptures);
  if (inlierCaptures.length < MIN_RATE_WORDS_CAPTURED) {
    showCalibrationFailure(
      `Captured ${rateCaptures.length} words, but too many looked like pauses/hesitations rather ` +
      'than steady reading pace to trust. Try mouthing the sentence at a more even rhythm, then retry.'
    );
    return;
  }
  const capturedSyllables = inlierCaptures.map(c => c.syllables);
  const syllableSpread = Math.max(...capturedSyllables) - Math.min(...capturedSyllables);
  if (syllableSpread < MIN_RATE_SYLLABLE_SPREAD) {
    showCalibrationFailure(
      'The pace step didn\'t capture enough variety between short and long words to measure ' +
      'your speed accurately. Try mouthing the full sentence, including the longer words, then retry.'
    );
    return;
  }
  const fit = fitDurationRegression(inlierCaptures.map(c => ({ syllables: c.syllables, durationMs: c.durationMs })));
  if (!fit) {
    showCalibrationFailure(
      'Couldn\'t reliably measure your pace from that run. Try mouthing the sentence at a steady, ' +
      'natural rhythm, then retry.'
    );
    return;
  }
  // TEMPORARY (Phase 11 threshold validation): raw fit before clamping, so
  // MIN/MAX_MS_PER_SYLLABLE and MIN/MAX_BASE_WORD_MS can be set from what a
  // real fit actually produces rather than a starting guess. If this number
  // is regularly landing near/outside the clamp bounds below, that's the
  // signal the bounds are wrong, not the fit.
  console.log(`[Phase 11 rate] raw fit: msPerSyllable=${fit.msPerSyllable.toFixed(1)}, ` +
    `baseWordMs=${fit.baseWordMs.toFixed(1)}`);
  // Same numbers, on-screen — console.log requires a tethered debugging
  // session on mobile, this doesn't. Filled in fully once personalizedRate
  // is computed below.
  const rateFitDebugValueEl = document.getElementById('rateFitDebugValue');
  rateFitDebugValueEl.textContent =
    `raw msPerSyll=${fit.msPerSyllable.toFixed(1)}, raw baseWordMs=${fit.baseWordMs.toFixed(1)}`;

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

  // Phase 11: clamp the regression to a sane range before trusting it — a
  // technically-valid fit (passed the spread/count checks above) can still
  // land somewhere unreasonable from noise in a short run. Same spirit as
  // flooring yawThreshold/pitchThreshold above, just with a ceiling too
  // since both directions (too twitchy / too sluggish a pace) are plausible
  // failure shapes here, unlike the pose thresholds.
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const msPerSyllablePersonal = clamp(fit.msPerSyllable, MIN_MS_PER_SYLLABLE, MAX_MS_PER_SYLLABLE);
  const baseWordMsPersonal = clamp(fit.baseWordMs, MIN_BASE_WORD_MS, MAX_BASE_WORD_MS);

  // Personalized TTS rate: ratio of the GENERIC expected duration to THIS
  // user's personalized expected duration, evaluated at the sample
  // sentence's average syllable count. A fast mumbler (shorter personal
  // durations) gets ratio > 1 → faster TTS to match; a slow mumbler gets
  // ratio < 1 → slower TTS. Deliberately derived from the same fit as
  // MS_PER_SYLLABLE/BASE_WORD_MS above, not measured independently — see
  // Section 3/Entry 15: speeding up TTS without also adjusting mouth-close
  // cadence (or vice versa) would make the app race ahead of, or lag
  // behind, the very pace it just measured.
  // Evaluated at the SAMPLE_WORDS average (fixed), not the surviving inlier
  // subset's average — keeps the evaluation point stable across runs
  // regardless of which specific words got filtered as outliers.
  const avgSyllables = SAMPLE_WORDS.reduce((s, w) => s + w.syllables, 0) / SAMPLE_WORDS.length;
  const genericExpected = DEFAULT_BASE_WORD_MS + DEFAULT_MS_PER_SYLLABLE * avgSyllables;
  const personalExpected = baseWordMsPersonal + msPerSyllablePersonal * avgSyllables;
  const personalizedRate = clamp(
    genericExpected / personalExpected,
    MIN_PERSONALIZED_RATE,
    MAX_PERSONALIZED_RATE
  );
  // TEMPORARY (Phase 11 threshold validation): pre-clamp rate ratio, same
  // reasoning as the raw-fit log above — validates MIN/MAX_PERSONALIZED_RATE.
  console.log(`[Phase 11 rate] pre-clamp personalizedRate=${(genericExpected / personalExpected).toFixed(3)}, ` +
    `clamped=${personalizedRate.toFixed(3)}`);
  rateFitDebugValueEl.textContent =
    `raw msPerSyll=${fit.msPerSyllable.toFixed(1)}, raw baseWordMs=${fit.baseWordMs.toFixed(1)}, ` +
    `clamped msPerSyll=${msPerSyllablePersonal.toFixed(1)}, clamped baseWordMs=${baseWordMsPersonal.toFixed(1)}, ` +
    `pre-clamp rate=${(genericExpected / personalExpected).toFixed(3)}, final rate=${personalizedRate.toFixed(3)}`;

  const data = {
    openThreshold,
    closeThreshold,
    yawThreshold,
    pitchThreshold,
    msPerSyllablePersonal,
    baseWordMsPersonal,
    personalizedRate,
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
    MS_PER_SYLLABLE = data.msPerSyllablePersonal;
    BASE_WORD_MS = data.baseWordMsPersonal;
    PERSONALIZED_RATE = data.personalizedRate;
    speedCalibrationValueEl.textContent =
      `custom (${PERSONALIZED_RATE.toFixed(2)}x rate, ${Math.round(MS_PER_SYLLABLE)}ms/syllable)`;
  } else {
    MS_PER_SYLLABLE = DEFAULT_MS_PER_SYLLABLE;
    BASE_WORD_MS = DEFAULT_BASE_WORD_MS;
    PERSONALIZED_RATE = DEFAULT_PERSONALIZED_RATE;
    speedCalibrationValueEl.textContent = 'using default pacing (calibrate to personalize)';
  }
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
  lastWordBoundaryTime = performance.now();
  currentSpokenWordExpectedMs = estimateWordDuration(wordSpans[idx].span.textContent);
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
  lastYaw = yaw;
  lastPitch = pitch;

  const facing = Math.abs(yaw) < YAW_THRESHOLD && Math.abs(pitch) < PITCH_THRESHOLD;
  if (facing === isFacingScreen) return; // no state change, nothing else to do

  isFacingScreen = facing;
  facingStateEl.textContent = isFacingScreen ? 'facing screen' : 'looking away';
  // Phase 11b: a real gate trip is exactly the kind of hard-failure moment
  // the sharp pulse cue is for (Entry 17 Q2) — fire it here rather than
  // waiting for the slow ambient score to notice, since the gate trip is
  // itself the event, not a gradual buildup.
  if (!isFacingScreen && readingActive) {
    maybeFireTroublePulse();
  }
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

  // Phase 9 (diagnostic): fresh utterance, fresh count. A stall theory is
  // only meaningful measured within one utterance's boundary stream.
  boundaryEventCount = 0;
  boundaryCountValueEl.textContent = '0';

  // Phase 11b bugfix: prime the per-word cadence clock for the word at the
  // resume point right away, rather than only waiting for onboundary/
  // highlightWordAt to set it — there's a real gap between speak() being
  // called and the browser's first word-boundary callback landing, and
  // highlightWordAt also no-ops if this word is already the active one
  // (e.g. resuming the same word after a brief mouth close), which would
  // otherwise leave a stale clock in place right when a fresh one matters most.
  const resumeWordIdx = wordSpans.findIndex(w => offset >= w.start && offset < w.end);
  lastWordBoundaryTime = performance.now();
  currentSpokenWordExpectedMs = resumeWordIdx !== -1
    ? estimateWordDuration(wordSpans[resumeWordIdx].span.textContent)
    : 0;

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
  currentUtterance = new SpeechSynthesisUtterance(READING_TEXT.slice(offset));

  // Phase 11: PERSONALIZED_RATE is applied unconditionally now (it defaults
  // to 1.0 — the untouched Web Speech default — until the user calibrates,
  // so an uncalibrated session sounds exactly as it did before this phase).
  // When tone (Phase 8a) is also on, the two multiply rather than one
  // overriding the other: tone's rate is a per-sentence *expressive* nudge
  // (excited/curious), personalized rate is the user's *baseline* mumbling
  // speed — both should apply at once rather than tone silently discarding
  // the personalization, or personalization ignoring tone's intent.
  if (toneEnabled) {
    const sentenceEnd = findSentenceEnd(READING_TEXT, offset);
    const sentenceText = READING_TEXT.slice(offset, sentenceEnd);
    const tone = getToneForSentence(sentenceText);
    currentUtterance.pitch = tone.pitch;
    currentUtterance.rate = tone.rate * PERSONALIZED_RATE;
    toneValueEl.textContent = tone.label;
  } else {
    currentUtterance.rate = PERSONALIZED_RATE;
    toneValueEl.textContent = 'off';
  }

  currentUtterance.onboundary = (event) => {
    if (event.name !== 'word') return;
    lastBoundaryOffset = event.charIndex;
    // Phase 9 (diagnostic): record that a real boundary event landed.
    boundaryEventCount += 1;
    lastBoundaryEventTime = performance.now();
    boundaryCountValueEl.textContent = String(boundaryEventCount);
    highlightWordAt(baseOffset + event.charIndex);
  };

  currentUtterance.onend = () => {
    isSpeakingChunk = false;
    if (manualCancel) {
      // This 'end' event fired because WE called cancel() (closing the mouth
      // or looking away), not because the text actually finished. Chromium
      // fires 'end' either way.
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
  resetTroubleShading(); // Phase 11b: no active session left to reflect, so settle the border calm
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
  resetTroubleShading(); // Phase 11b: fresh session shouldn't inherit a lingering score/pulse cooldown
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
  return !readingActive && !calibration.active;
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

  // Phase 9 (diagnostic): live "ago" readout, independent of onboundary itself
  // firing — this is the whole point, since a stalled boundary stream is
  // exactly the case where nothing else would update this number for you.
  if (readingActive && isSpeakingChunk && lastBoundaryEventTime > 0) {
    lastBoundaryAgoValueEl.textContent = Math.round(performance.now() - lastBoundaryEventTime).toString();
  }

  // Phase 11b: reads mouthState/cadence/pose state that's all fresh as of
  // this same frame's updates above. Skipped during calibration for the same
  // reason head-pose gating is skipped — no active reading session for it to
  // reflect, and calibration.active already makes computeRawTroubleScore()
  // return 0 via the readingActive check, so this is mostly a perf/clarity
  // skip rather than a correctness-critical one.
  if (!calibration.active) {
    updateTroubleShading();
  }

  scheduleNextFrame();
}

setup();