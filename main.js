import { FaceLandmarker, FilesetResolver, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const videoContainer = document.getElementById('container');

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
  if (e.key !== ' ' || isTypingContext() || !readingActive) return;
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

// --- Phase 12a: digit-aware syllable estimation -----------------------------
// estimateSyllables previously stripped everything outside [a-z], which
// silently deleted digits entirely — "1999," estimated as 1 syllable when
// Web Speech will actually speak something like "one thousand nine hundred
// ninety-nine" (or, on some voices, "nineteen ninety-nine" — browsers aren't
// consistent about year-style vs cardinal reading of bare numbers, and we
// have no reliable way to know which a given voice will pick). We expand to
// the *standard cardinal* reading (not year-style) as a deterministic,
// voice-independent approximation: it lands in the right order of magnitude
// for pacing purposes even when it doesn't match a particular voice's exact
// phrasing, which is what actually caused the bug (running 1 syllable vs the
// several actually spoken, not the specific choice of phrasing).
//
// Each number word's syllable count is looked up directly (small closed
// vocabulary) rather than vowel-counted, since counting vowels in "thousand"
// or "eight" is no more reliable than just knowing the answer.
const NUMBER_WORD_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const NUMBER_WORD_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const NUMBER_WORD_SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];
const NUMBER_WORD_SYLLABLES = {
  zero: 2, one: 1, two: 1, three: 1, four: 1, five: 1, six: 1, seven: 2, eight: 1, nine: 1, ten: 1,
  eleven: 3, twelve: 1, thirteen: 2, fourteen: 2, fifteen: 2, sixteen: 2, seventeen: 3, eighteen: 2, nineteen: 2,
  twenty: 2, thirty: 2, forty: 2, fifty: 2, sixty: 2, seventy: 3, eighty: 2, ninety: 2,
  hundred: 2, thousand: 2, million: 2, billion: 2, trillion: 2, point: 1, negative: 3
};

function threeDigitGroupToWords(n) {
  const words = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) {
    words.push(NUMBER_WORD_ONES[hundreds], 'hundred');
  }
  if (rest > 0) {
    if (rest < 20) {
      words.push(NUMBER_WORD_ONES[rest]);
    } else {
      const tens = Math.floor(rest / 10);
      const ones = rest % 10;
      words.push(NUMBER_WORD_TENS[tens]);
      if (ones > 0) words.push(NUMBER_WORD_ONES[ones]);
    }
  }
  return words;
}

function integerDigitsToWords(digits) {
  let s = digits.replace(/^0+(?=\d)/, '');
  if (s === '' || parseInt(s, 10) === 0) return ['zero'];
  // Beyond our scale-word list (quadrillion+) — vanishingly unlikely in real
  // reading text, and reading digit-by-digit is still a reasonable fallback
  // rather than crashing or guessing wildly.
  if (s.length > 15) {
    return s.split('').map(d => NUMBER_WORD_ONES[parseInt(d, 10)]);
  }
  const groups = [];
  let rem = s;
  while (rem.length > 0) {
    const len = rem.length % 3 === 0 ? 3 : rem.length % 3;
    groups.push(rem.slice(0, len));
    rem = rem.slice(len);
  }
  const words = [];
  for (let i = 0; i < groups.length; i++) {
    const g = parseInt(groups[i], 10);
    if (g === 0) continue;
    const scaleIdx = groups.length - 1 - i;
    words.push(...threeDigitGroupToWords(g));
    if (scaleIdx > 0 && NUMBER_WORD_SCALES[scaleIdx]) words.push(NUMBER_WORD_SCALES[scaleIdx]);
  }
  return words;
}

// numStr: a run of digits, optionally with '-' sign, ',' thousands
// separators, and one '.' decimal point (whatever a single regex match of
// /\d[\d,]*(?:\.\d+)?/ can capture — see call site).
function estimateNumberWordSyllables(numStr) {
  const negative = numStr.startsWith('-');
  const body = negative ? numStr.slice(1) : numStr;
  const parts = body.split('.');
  const intDigits = parts[0].replace(/,/g, '') || '0';
  let words = integerDigitsToWords(intDigits);
  if (negative) words = ['negative', ...words];
  if (parts.length > 1 && parts[1].length > 0) {
    words.push('point');
    for (const d of parts[1]) {
      if (/\d/.test(d)) words.push(NUMBER_WORD_ONES[parseInt(d, 10)]);
    }
  }
  return words.reduce((sum, w) => sum + (NUMBER_WORD_SYLLABLES[w] || 1), 0);
}

function estimateSyllables(word) {
  // Digit runs (handles things like "1999,", "3.14", "$45.50", or a
  // hyphenated run like "555-1234" as two separate runs) are pulled out and
  // syllable-counted via the number-word expansion above, then removed from
  // the string before the original letter-based logic runs on what's left
  // (so e.g. "COVID-19" counts "covid" by the normal rules and "19" via the
  // number path, rather than either double-counting or the digits vanishing).
  const numberRuns = word.match(/\d[\d,]*(?:\.\d+)?/g) || [];
  let numberSyllables = 0;
  for (const run of numberRuns) {
    numberSyllables += estimateNumberWordSyllables(run);
  }
  const lettersOnly = word.replace(/\d[\d,]*(?:\.\d+)?/g, '');

  // --- Accented/non-English characters --------------------------------
  // The old `[^a-z]` strip deleted accent marks along with their base
  // letter, which could silently merge two vowels that should stay
  // separate (e.g. "jalapeño" -> "jalapeo", collapsing 'e'+'o' into one
  // cluster and undercounting). Fold to the base letter instead (é -> e,
  // ñ -> n) so consonant diacritics still act as consonants (keeping
  // vowels on either side separate) and vowel diacritics still contribute
  // a vowel to the count.
  const hadAccentedFinalE = /[éèêë]$/i.test(lettersOnly.trim());
  // A diaeresis (naïve, Zoë, Chloë) specifically exists to mark a vowel as
  // pronounced separately from an *adjacent* vowel rather than merged into
  // one sound/cluster — insert a break for exactly that case before the
  // mark itself is stripped, so e.g. "naive" (from "naïve") doesn't get
  // "a"+"i" counted as a single cluster the way an unmarked word would.
  let nfd = lettersOnly.toLowerCase().normalize('NFD');
  nfd = nfd.replace(/([aeiouy])([aeiouy]\u0308)/g, '$1|$2');
  const cleanedWithBreaks = nfd.replace(/[\u0300-\u036f]/g, '').replace(/[^a-z|]/g, '');
  const cleaned = cleanedWithBreaks.replace(/\|/g, '');

  const matches = cleanedWithBreaks.match(/[aeiouy]+/g);
  let syllables = matches ? matches.length : 0;

  const endsInConsonantLe = /[^aeiouy]le$/.test(cleaned);
  if (cleaned.endsWith('e') && !endsInConsonantLe && !hadAccentedFinalE && syllables > 1) {
    syllables -= 1;
  }

  if (!hadAccentedFinalE) {
    for (const suffix of SILENT_E_SUFFIXES) {
      if (cleaned.endsWith(suffix) && cleaned.length > suffix.length) {
        const stem = cleaned.slice(0, -suffix.length);
        if (/[aeiouy][^aeiouy]e$/.test(stem) && syllables > 1) {
          syllables -= 1;
        }
        break; // only one suffix can match the end of a word
      }
    }
  }

  return Math.max(1, syllables + numberSyllables);
}

function estimateWordDuration(word) {
  return BASE_WORD_MS + estimateSyllables(word) * MS_PER_SYLLABLE;
}

// --- Fallback-advance timing (see scheduleFallbackAdvance) -----------------
// Layered ON TOP of estimateWordDuration() rather than changing it directly —
// that formula was hand-tuned against real mouth-mimicry data (Entry 47) for
// mouth-close cadence gating, and touching it there risks de-tuning those
// anchor values for a problem that's actually specific to fallback-highlight
// scheduling. Entry 47 already flagged, but deliberately deferred, exactly
// the two biases that matter here:
//   - sentence-final words (before . ! ?) are UNDER-estimated, since real
//     TTS engines pause for punctuation and the per-syllable formula has no
//     concept of that. On desktop (where onboundary DOES fire, just slightly
//     late across a punctuation pause), this let the fallback timer fire
//     BEFORE the real, delayed event arrived — the two-word forward/back
//     flicker seen around commas/periods in live testing.
//   - short function words ("a", "to", "is") are OVER-estimated, which made
//     the fallback wait longer than the word actually took, compounding
//     into a highlighter that visibly lagged behind real TTS output over a
//     paragraph (also seen in live testing, with Simulate-mobile on).
// These constants are the same kind of starting-guess this project always
// ships first and tunes from real data later (see MS_PER_SYLLABLE's own
// history) — not claimed to be precise, just a meaningfully better default
// than ignoring punctuation/short-words entirely.
function estimateFallbackDelayMs(word) {
  const base = estimateWordDuration(word);
  const lettersOnly = word.replace(/[^a-zA-Z']/g, '');
  let adjusted = base;
  if (/[.!?]["')]?$/.test(word)) adjusted += 350;      // sentence-final pause
  else if (/[,;:]["')]?$/.test(word)) adjusted += 150; // comma-ish pause
  if (lettersOnly.length > 0 && lettersOnly.length <= 2) adjusted *= 0.7; // counter short-word over-estimate
  return adjusted * fallbackRateFactor; // measured correction — see fallbackRateFactor above
}

// --- Phase 11: sample sentence for the Speed calibration step ---
// Deliberately spans a range of syllable counts (per this file's own
// estimateSyllables — used elsewhere for real reading text; this sentence
// itself is reused as the Entry 46 test-voice preview phrase for the manual
// Speed step (see testRateVoice), and previously fed the now-removed
// regression's word-timing samples.
const SAMPLE_SENTENCE = "The cat slowly wandered through an unexpectedly enormous garden " +
  "while butterflies fluttered quietly overhead.";

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

// --- Phase 12b Stage A: voice picker -----------------------------------
// Cheap, zero-architectural-risk first pass at the "robotic voice" problem
// (Entry 43): let the reader pick from whatever voices this browser/OS
// already ships, rather than silently using the Web Speech default. If this
// isn't enough on its own, Stage B (Phase 13.5, local Kokoro TTS) is the
// planned fallback — see PROGRESS.md Section 3/3c.
//
// LOCAL VOICES ONLY (Entry 44). An isolated 22-voice diagnostic harness
// (cancel-reliability / onboundary-accuracy / rate-honoring, see
// harness/voice-diagnostic.html) found that Chrome's network/cloud voices
// (Google's non-default voices) essentially never fire `onboundary` — 0/17
// word events on 19 of 22 voices tested, with the 3 "passes" almost
// certainly a network-timing fluke rather than a real guarantee, since
// cloud-synthesis latency is non-deterministic run to run. That single gap
// explained two live-app symptoms at once: word highlighting snapping back
// to a stale position (lastBoundaryOffset never updates without
// `onboundary`), and speech continuing past a mouth close (Fix 3c/3c-2's
// gating logic resets its timing anchor on every `onboundary`; with none
// firing, that anchor goes stale for the whole utterance). `cancel()`
// itself tested 100% reliable across all 22 voices in isolation — it's the
// app's own logic for deciding *when* to call it that broke down.
// Excluding network voices is a categorical, architectural decision (not
// "these specific ones failed today") — a mechanism that can silently pass
// on a fast connection and fail on a slow one is not acceptable for a
// safety-critical stop signal.
//
// Design notes (unchanged from initial Stage A build):
// - We persist the voice's `voiceURI` (a stable identifier), not the
//   SpeechSynthesisVoice object itself. Voice objects are re-fetched fresh
//   at speak time (see resolveSelectedVoice() in speakFrom) rather than
//   cached, because Phase 9a's TTS-iframe recycling (IFRAME_TTS_RECYCLE_ENABLED)
//   periodically swaps ttsEngine.synth to a brand-new iframe's
//   speechSynthesis instance — a voice object captured from the OLD
//   instance is not guaranteed to be valid/assignable on the new one, even
//   though voiceURI stays stable across them (same underlying platform
//   voice list). Re-resolving by URI at call time sidesteps that entirely.
// - getVoices() is notoriously async-on-first-load in Chrome (empty array
//   until the 'voiceschanged' event fires) — we populate on both the
//   initial call and every 'voiceschanged' firing, and re-apply the saved
//   selection each time so a late-arriving voice list doesn't silently
//   fall back to "Browser default" after the user already chose something.
const VOICE_STORAGE_KEY = 'readingAppVoice';
let selectedVoiceURI = ''; // '' = explicit "Browser default", no utterance.voice assignment
const voiceSelectEl = document.getElementById('voiceSelect');
const voiceValueEl = document.getElementById('voiceValue');

// Single source of truth for "is this voice allowed" — used by both
// populateVoiceList() (what shows in the dropdown) and resolveSelectedVoice()
// (what actually gets assigned to an utterance), so a stale localStorage
// value from before Entry 44 (e.g. a previously-picked network voice) can
// never silently slip through and get applied even though it's no longer
// in the visible list.
function isVoiceAllowed(v) {
  return v.localService === true;
}

function loadSavedVoiceURI() {
  try {
    selectedVoiceURI = localStorage.getItem(VOICE_STORAGE_KEY) || '';
  } catch (err) {
    console.error('Could not read saved voice preference:', err);
    selectedVoiceURI = '';
  }
}

function saveSelectedVoiceURI(uri) {
  try {
    localStorage.setItem(VOICE_STORAGE_KEY, uri);
  } catch (err) {
    console.error('Could not save voice preference:', err);
  }
}

// Rebuilds the <select> options from whatever LOCAL voices are currently
// available. Safe to call repeatedly (e.g. on every 'voiceschanged') —
// re-applies selectedVoiceURI each time so the user's choice survives a
// voice list that fills in gradually.
function populateVoiceList() {
  const allVoices = window.speechSynthesis.getVoices();
  if (allVoices.length === 0) return; // nothing to show yet, wait for voiceschanged
  const voices = allVoices.filter(isVoiceAllowed);

  // English voices first (most likely relevant to this app's audience),
  // then everything else, each group alphabetized by name.
  const english = voices.filter(v => v.lang.toLowerCase().startsWith('en'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const other = voices.filter(v => !v.lang.toLowerCase().startsWith('en'))
    .sort((a, b) => a.name.localeCompare(b.name));

  voiceSelectEl.innerHTML = '<option value="">Browser default</option>';
  for (const group of [english, other]) {
    for (const v of group) {
      const opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})`;
      voiceSelectEl.appendChild(opt);
    }
  }

  // Re-apply saved selection now that options exist. If the saved voice
  // isn't in this browser's *allowed* list (removed device, or a stale
  // pre-Entry-44 network-voice pick), fall back to "Browser default"
  // rather than silently applying something that shouldn't be used.
  const match = voices.find(v => v.voiceURI === selectedVoiceURI);
  voiceSelectEl.value = match ? selectedVoiceURI : '';
  if (!match) {
    selectedVoiceURI = '';
    saveSelectedVoiceURI(''); // clean up the stale value so it doesn't keep tripping this fallback
  }
  voiceValueEl.textContent = match ? `${match.name} (${match.lang})` : 'browser default';
}

voiceSelectEl.addEventListener('change', () => {
  selectedVoiceURI = voiceSelectEl.value;
  saveSelectedVoiceURI(selectedVoiceURI);
  const voices = window.speechSynthesis.getVoices().filter(isVoiceAllowed);
  const match = voices.find(v => v.voiceURI === selectedVoiceURI);
  voiceValueEl.textContent = match ? `${match.name} (${match.lang})` : 'browser default';
});

loadSavedVoiceURI();
populateVoiceList(); // no-op if the list isn't ready yet — voiceschanged below covers that
window.speechSynthesis.addEventListener('voiceschanged', populateVoiceList);

// Looks up the live voice object matching selectedVoiceURI from whichever
// speechSynthesis instance is about to be used (main window or the current
// recycled iframe — see the design note above). Returns null for "Browser
// default" or if the saved voice isn't found on this instance, in which
// case the caller should simply not set utterance.voice.
function resolveSelectedVoice(synth) {
  if (!selectedVoiceURI) return null;
  const voices = synth.getVoices();
  const match = voices.find(v => v.voiceURI === selectedVoiceURI);
  // Belt-and-suspenders: even if selectedVoiceURI somehow points at a
  // disallowed (network) voice at this exact moment — e.g. another tab
  // wrote a stale value to localStorage between loadSavedVoiceURI() and
  // now — never hand it to an utterance. populateVoiceList() is the
  // primary guard (keeps the dropdown/localStorage clean); this is the
  // last line of defense at the actual point of use.
  return (match && isVoiceAllowed(match)) ? match : null;
}

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

const TEXT_STORAGE_KEY = 'readingAppText'; // old localStorage key — read once for migration, then unused

// --- Text persistence: IndexedDB (not localStorage) ---
// Decided at 10d ship time: PDF-extracted text can get much larger than
// typed/pasted or .txt text, and localStorage (i) has a hard ~5-10MB
// per-origin quota shared with the calibration data, and (ii) is
// synchronous, so a big write can jank the main thread. IndexedDB has no
// practically-relevant size ceiling for this use case and is async by
// design. Calibration data (Phase 7b/11) stays on localStorage — it's a
// few numbers, not a growing-text problem, no reason to touch it.
//
// Single object store, single fixed-key record — this isn't a real
// multi-record database, just a bigger/async localStorage replacement for
// one blob, so no keyPath/indexes are needed.
const TEXT_DB_NAME = 'mumblewDB';
const TEXT_DB_VERSION = 1;
const TEXT_STORE_NAME = 'savedText';
const TEXT_RECORD_KEY = 'current';

function openTextDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TEXT_DB_NAME, TEXT_DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(TEXT_STORE_NAME)) {
        req.result.createObjectStore(TEXT_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSetText(data) {
  const db = await openTextDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEXT_STORE_NAME, 'readwrite');
    tx.objectStore(TEXT_STORE_NAME).put(data, TEXT_RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetText() {
  const db = await openTextDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEXT_STORE_NAME, 'readonly');
    const req = tx.objectStore(TEXT_STORE_NAME).get(TEXT_RECORD_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDeleteText() {
  const db = await openTextDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEXT_STORE_NAME, 'readwrite');
    tx.objectStore(TEXT_STORE_NAME).delete(TEXT_RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

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
  el.style.height = `${Math.max(el.scrollHeight, minHeight)}px`;
}

let readingActive = false;      // true from Start Reading click until the whole text finishes
let isSpeakingChunk = false;    // true while a (possibly multi-word) utterance is actively speaking
let manualCancel = false;       // true right before we intentionally cancel() due to mouth closing
let cancelRequestedTime = null; // performance.now() when cancel() was requested — diagnostic, see handleUtteranceStop()
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
let lastWordBoundaryTime = 0;        // Phase 11b (fixed): performance.now() at the most recent onboundary
let currentSpokenWordExpectedMs = 0; // expected duration for the word currently being spoken
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
  let delayMs = estimateFallbackDelayMs(wordText);
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
  fallbackAdvanceTimerId = setTimeout(() => {
    fallbackAdvanceTimerId = null;
    if (generation !== speakGeneration) return; // this utterance was superseded/cancelled — stale timer
    if (!isSpeakingChunk) return; // speech already stopped — don't advance past where it actually stopped
    if (activeWordIndex !== forWordIndex) return; // a real boundary (or another fallback tick) already moved us on
    const nextIdx = forWordIndex + 1;
    fallbackAdvanceCount += 1;
    if (fallbackAdvanceCountValueEl) fallbackAdvanceCountValueEl.textContent = String(fallbackAdvanceCount);
    console.log(`[fallback-highlight] no onboundary for "${wordSpans[forWordIndex].span.textContent}" within ${Math.round(delayMs)}ms — advancing on estimate instead`);
    lastBoundaryOffset = wordSpans[nextIdx].start - baseOffset;
    highlightWordAt(baseOffset + lastBoundaryOffset);
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
let noFaceSince = null; // performance.now() timestamp of when landmarks last went missing, or null while a face is being seen

// Head-pose gating (Phase 3) removed (Entry 45 — decided Entry 43, scoped
// Entry 44): the biological ceiling here (ALS-associated head-drop; lying
// down as a primary, not edge, use case — Section 1) meant "facing the
// screen" was an unreliable proxy for engagement for exactly the audience
// this app most needs to serve, and mouth movement already is the honest
// signal. isFaceVisible now means only "MediaPipe currently sees a face at
// all" (Phase 9b's job) — no yaw/pitch involved.
let isFaceVisible = true;

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
// Anchor values below are Entry-47 DATA-TUNED (final), using noise-filtered
// data from a temporary logging tool used for this tuning pass (since
// removed once tuning closed out — see PROGRESS.md Entry 47/48 for the
// full test history). First pass over-corrected: it was contaminated
// by forced/rushed taps on words that were physically hard to mouth
// cleanly at the slider extremes, which skewed the average down and led to
// anchors that were cut too aggressively (180/105 slow, 120/55 fast).
// Filtering closes under 150ms and re-testing with genuinely natural
// pacing showed the opposite problem — clean avg elapsed/expected ratio
// was 1.28 at 0.5x and 1.13 at 1.75x (n=25/26), meaning those first-pass
// anchors were now too SHORT. Values below scale the first-pass anchors up
// by those clean ratios, landing close to (but not identical to) the
// original starting guesses — net conclusion: the original guesses were
// closer to right than assumed; genuine cadence gating noise mostly came
// from strained mimicry at the extremes, not from the anchor numbers
// themselves being far off.
// Known residual gap NOT addressed here: estimateWordDuration() has no
// per-word sense of sentence-final punctuation or emphasis, so short
// function words still get over-estimated and sentence-ending words still
// get under-estimated relative to each other — a formula-level limitation,
// out of scope for anchor tuning. The 1.0 anchor still reuses the existing
// DEFAULT_* pair (untested by this pass — extremes only) so a user who
// leaves the slider untouched still sees no behavior change.
const RATE_SLIDER_MIN = 0.5;
const RATE_SLIDER_MAX = 1.75;
const RATE_SLOW_MS_PER_SYLLABLE = 230;
const RATE_SLOW_BASE_WORD_MS = 135;
const RATE_FAST_MS_PER_SYLLABLE = 135;
const RATE_FAST_BASE_WORD_MS = 62;

const RATE_ANCHORS = [
  { rate: RATE_SLIDER_MIN, msPerSyllable: RATE_SLOW_MS_PER_SYLLABLE, baseWordMs: RATE_SLOW_BASE_WORD_MS },
  { rate: 1.0, msPerSyllable: DEFAULT_MS_PER_SYLLABLE, baseWordMs: DEFAULT_BASE_WORD_MS },
  { rate: RATE_SLIDER_MAX, msPerSyllable: RATE_FAST_MS_PER_SYLLABLE, baseWordMs: RATE_FAST_BASE_WORD_MS },
];

// Piecewise-linear interpolation across RATE_ANCHORS. Verified against an
// isolated harness before wiring in (clamping + mid-point math) — see
// Entry 46. Clamps to the slider's own range first, so a value can't sneak
// in from outside RATE_SLIDER_MIN/MAX and hit the "no segment matched"
// fallthrough below.
function interpolateCadence(rate) {
  const clamped = Math.min(RATE_SLIDER_MAX, Math.max(RATE_SLIDER_MIN, rate));
  for (let i = 0; i < RATE_ANCHORS.length - 1; i++) {
    const a = RATE_ANCHORS[i], b = RATE_ANCHORS[i + 1];
    if (clamped >= a.rate && clamped <= b.rate) {
      const t = (clamped - a.rate) / (b.rate - a.rate);
      return {
        msPerSyllable: a.msPerSyllable + t * (b.msPerSyllable - a.msPerSyllable),
        baseWordMs: a.baseWordMs + t * (b.baseWordMs - a.baseWordMs),
      };
    }
  }
  // Unreachable given the clamp above; kept as a defensive fallback.
  return { msPerSyllable: DEFAULT_MS_PER_SYLLABLE, baseWordMs: DEFAULT_BASE_WORD_MS };
}

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
  if (!readingActive || mouthState !== 'open' || currentSpokenWordExpectedMs <= 0) return 0;
  const elapsedMs = performance.now() - lastWordBoundaryTime;
  const ratio = elapsedMs / currentSpokenWordExpectedMs;
  if (ratio <= 1) return 0;
  return Math.min(1, (ratio - 1) / (TROUBLE_CADENCE_OVERRUN_CAP - 1));
}

function computeRawTroubleScore() {
  if (!readingActive) return 0; // calm border whenever there's no active session to have trouble in
  // Head-pose removed (Entry 45) — cadence overrun is the only remaining
  // continuous trouble source. max() kept as the combining shape in case a
  // future signal joins it, even though there's only one input today.
  return Math.max(computeCadenceTrouble());
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
  updateWarningBox();
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
  currentWarningReason = null;
  warningBoxMinimized = false;
  cadenceWarningActiveUntil = 0;
  warningBoxEl.classList.add('warning-hidden');
  updateWarningBoxMinimizedUI();
  warningDebugValueEl.textContent = 'none';
}

// Phase 7b's 'facing'/'away' pose-calibration steps removed Entry 45
// alongside the rest of head-pose gating — wizard is 3 steps now, not 5.
const CALIBRATION_STEPS = [
  {
    id: 'neutral',
    label: 'Step 1 of 3 — Neutral face',
    instruction: 'Relax your mouth naturally, like you\'re not reading. Hold still.',
    prepMs: 1000,
    sampleMs: 3000,
    metric: 'mar'
  },
  {
    id: 'mutter',
    label: 'Step 2 of 3 — Silent mouthing',
    instruction: 'Silently mouth this sentence as if reading aloud, no need to make sound: ' +
      '"The quick brown fox jumps over the lazy dog."',
    prepMs: 1000,
    sampleMs: 4000,
    metric: 'mar'
  },
  {
    id: 'rate',
    // Entry 46: rebuilt from a timed mouthing sample into a manual slider —
    // see PROGRESS.md Section 3 for the full reasoning. No prepMs/sampleMs;
    // this step doesn't run through the per-frame prep/sampling pipeline at
    // all (updateCalibration() returns immediately for metric === 'rate').
    // Advancing happens via the "Set speed" button (finishRateStep below),
    // not a countdown.
    label: 'Step 3 of 3 — Your pace',
    instruction: 'Drag the slider to a speed that feels comfortable, and use "Test voice" to hear it. ' +
      'You can fine-tune this later too.',
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

function average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function startCalibration() {
  // Stop any active reading first — calibration and reading shouldn't run
  // at the same time, and this reuses the same safe-reset pattern as the
  // Start Reading button (cancel() is safe even if nothing is speaking).
  manualCancel = true;
  cancelActiveSpeech();
  isSpeakingChunk = false;
  readingActive = false;
  speechStateEl.textContent = 'idle (calibrating)';

  calibration = {
    active: true,
    stepIndex: 0,
    phase: 'prep',
    phaseStartTime: performance.now(),
    currentSamples: [],
    results: {},
    selectedRate: DEFAULT_PERSONALIZED_RATE
  };

  startBtn.disabled = true;
  calibrateBtn.disabled = true;
  speechSwitchBtn.classList.add('is-inactive'); // predictLoop skips the per-frame sync during calibration, so set explicitly here
  calibrationRetryBtn.style.display = 'none';
  calibrationMessageEl.textContent = '';
  calibrationPanel.style.display = 'block';
  setCalibrationVideoVisible(true); // student needs to see themselves to position for calibration
  renderCalibrationStep();
}

function cancelCalibration() {
  calibration.active = false;
  calibrationPanel.style.display = 'none';
  setCalibrationVideoVisible(false);
  updateStartButtonState();
  calibrateBtn.disabled = false;
}

function renderCalibrationStep() {
  const step = CALIBRATION_STEPS[calibration.stepIndex];
  calibrationStepEl.textContent = step.label;
  calibrationInstructionEl.textContent = step.instruction;

  const isRateStep = step.metric === 'rate';
  rateStepPanelEl.style.display = isRateStep ? 'block' : 'none';
  calibrationCountdownEl.style.display = isRateStep ? 'none' : 'block';
  if (isRateStep) {
    calibration.selectedRate = DEFAULT_PERSONALIZED_RATE;
    rateSliderEl.value = String(DEFAULT_PERSONALIZED_RATE);
    updateRateSliderReadout();
  }
}

// Entry 46: slider UI for the manual Speed step. Live-updates the readout
// and calibration.selectedRate on every drag/arrow-key tick; nothing is
// applied to the live app until finishRateStep() commits it, same
// "preview vs commit" separation the old step had (sampling vs finish).
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
    calibration.phase = 'prep';
    calibration.phaseStartTime = now;
    calibration.currentSamples = [];
    renderCalibrationStep();
    // Entry 46: if the step we just moved into is the manual rate step,
    // show its slider UI immediately — there's no prep countdown to wait
    // through first (see renderCalibrationStep).
  }
}

// Entry 46: the 'rate' step no longer runs through the per-frame prep/
// sampling pipeline at all — it's a manual slider the user sets and
// confirms via a button click (see renderCalibrationStep/finishRateStep
// below), not something measured from live MAR frames. updateCalibration
// is only ever called with mar/pose steps now; guard added defensively in
// case it's ever invoked while a 'rate' step is current.
function updateCalibration(mar) {
  const step = CALIBRATION_STEPS[calibration.stepIndex];
  if (step.metric === 'rate') return; // handled entirely by the slider UI, not per-frame

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
  // Entry 50: also record the live brightness reading alongside each MAR
  // sample. Costs nothing extra — sampleBrightness() already runs on its
  // own interval and currentBrightness is just read here, not recomputed.
  // Only the 'neutral' step's samples actually get used (see
  // finishCalibration()) — this step is the natural "what does normal
  // reading light look like for this person" moment, since it already asks
  // them to sit still in their real reading position/lighting.
  calibration.currentSamples.push({ mar, brightness: currentBrightness });
  const remaining = Math.max(0, step.sampleMs - elapsed);
  calibrationCountdownEl.textContent = `Hold it... ${Math.ceil(remaining / 1000)}`;

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
    showCalibrationFailure(
      'Not enough difference between the neutral and mouthing steps. ' +
      'Try exaggerating the silent mouthing a bit more, then retry.'
    );
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

  calibrationStepEl.textContent = 'Calibration complete';
  // Entry 50 follow-up: doesn't block calibration (the neutral/mutter MAR
  // gap check above already covers whether mouth-tracking itself worked) —
  // just an honest heads-up, matching the project's usual "tell them, don't
  // fail silently" approach. Reuses ABSOLUTE_DARK_EXIT_THRESHOLD as the
  // reference point rather than inventing a third light constant.
  const isDimCalibration = typeof lightBaseline === 'number' && lightBaseline < ABSOLUTE_DARK_EXIT_THRESHOLD;
  if (isDimCalibration) {
    calibrationInstructionEl.textContent =
      'Your thresholds have been saved for this device. Heads up: it looks fairly dim right now — ' +
      'for the most reliable low-light warnings later, consider redoing this step somewhere brighter when you can.';
  } else {
    calibrationInstructionEl.textContent = 'Your thresholds have been saved for this device.';
  }
  calibrationCountdownEl.textContent = '';
  calibration.active = false;
  updateStartButtonState();
  calibrateBtn.disabled = false;
  setTimeout(() => {
    calibrationPanel.style.display = 'none';
    setCalibrationVideoVisible(false);
  }, isDimCalibration ? 6000 : 2000); // longer hold so the advisory is actually readable
}

function showCalibrationFailure(message) {
  calibration.active = false;
  calibrationMessageEl.textContent = message;
  calibrationRetryBtn.style.display = 'inline-block';
  updateStartButtonState();
  calibrateBtn.disabled = false;
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

  // Entry 50: low-light thresholds, relative to this device's own
  // calibrated baseline rather than a fixed number — see the comment block
  // above LIGHT_SAMPLE_SIZE for the full reasoning. Same fallback pattern
  // as the speed block above: no baseline yet (calibration predates this
  // feature, or the neutral step's brightness samples somehow came back
  // empty) means keep using the fixed DEFAULT_* values, not `undefined`.
  const lightBaselineValueEl = document.getElementById('lightBaselineValue');
  if (typeof data.lightBaseline === 'number' && data.lightBaseline > 0) {
    LOW_LIGHT_ENTER_THRESHOLD = data.lightBaseline * LOW_LIGHT_ENTER_RATIO;
    LOW_LIGHT_EXIT_THRESHOLD = data.lightBaseline * LOW_LIGHT_EXIT_RATIO;
    if (lightBaselineValueEl) {
      lightBaselineValueEl.textContent =
        `custom (baseline ${data.lightBaseline.toFixed(1)}, warns below ${LOW_LIGHT_ENTER_THRESHOLD.toFixed(1)})`;
    }
  } else {
    LOW_LIGHT_ENTER_THRESHOLD = DEFAULT_LOW_LIGHT_ENTER_THRESHOLD;
    LOW_LIGHT_EXIT_THRESHOLD = DEFAULT_LOW_LIGHT_EXIT_THRESHOLD;
    if (lightBaselineValueEl) {
      lightBaselineValueEl.textContent = 'using default fallback (calibrate to personalize)';
    }
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
  startBtn.disabled = !hasLoadedText() || (calibration && calibration.active);
}

function wordCount(text) {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

// Single entry point for adopting new reading text, whether from the Load
// Text button, a restored localStorage session, or (future) 10d's PDF
// extraction. Hard-stops any in-progress reading session first — loading new
// text mid-read would otherwise leave baseOffset/wordSpans pointing at text
// that no longer matches what's on screen. cancel() is safe to call even
// when nothing is speaking (same reasoning as startBtn's click handler).
function setCurrentText(text, sourceLabel, opts = {}) {
  const persist = opts.persist !== false;

  manualCancel = true;
  cancelActiveSpeech();
  isSpeakingChunk = false;
  readingActive = false;

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

// --- Phase 10d: .pdf upload ---
// pdf.js is loaded lazily (dynamic import), only once a .pdf is actually
// picked — students who only ever paste/type or use .txt never pay for it.
// Same CDN-via-jsdelivr pattern already used for MediaPipe (Section 3 of
// PROGRESS.md), pinned to a specific version like MediaPipe's @0.10.14 pin,
// not @latest, so a future upstream release can't silently change behavior
// under us. pdf.js 5.x ships ESM-only, so this is a plain dynamic import,
// no bundler needed — consistent with the project's no-build-tools stack.
// The worker file needs its own CSP allowance (vercel.json worker-src) since
// browsers instantiate it directly from the given URL rather than treating
// it as a same-origin script.
const PDFJS_VERSION = '5.6.205';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/`;

let pdfjsLibPromise = null;
function loadPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(PDFJS_BASE + 'pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.mjs';
      return lib;
    });
  }
  return pdfjsLibPromise;
}

// Text-only extraction (no rendering/canvas involved) — pulls each page's
// text items and joins them, page breaks as blank lines so paragraph shape
// survives roughly intact. Scanned/image-only PDFs have no text layer at
// all, so they'll come back empty — surfaced as a normal "no text found"
// status message rather than an error, since nothing actually went wrong.
async function extractPdfText(file) {
  const pdfjsLib = await loadPdfJs();
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const pageTexts = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    pageTexts.push(content.items.map((item) => item.str).join(' ').trim());
  }
  return pageTexts.join('\n\n');
}

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

// Phase 10d: sane upload-size ceiling. Not a security boundary (nothing in
// an uploaded file executes — see rendering path, which is textContent-only)
// but a huge file can hang the tab mid-parse or blow past localStorage's
// quota silently. 20MB is generous headroom above any real reading text
// (a 20MB .txt is ~a shelf of books; a 20MB PDF is a large document) while
// still catching accidental wrong-file selections early with a clear message
// instead of a stuck "Reading..." status.
const MAX_UPLOAD_FILE_SIZE_BYTES = 20 * 1024 * 1024;

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
  const word = wordSpans[wordIndex];

  if (isSpeakingChunk) {
    manualCancel = true;
    cancelActiveSpeech();
    clearFallbackAdvance();
    isSpeakingChunk = false;
  }

  baseOffset = word.start;
  lastBoundaryOffset = 0;
  readingActive = true; // allow resync to also restart a finished reading
  autoScrollEnabled = true; // Phase 12c: a click is itself an intentional jump, resume following
  if (resumeAutoScrollTimer !== null) { clearTimeout(resumeAutoScrollTimer); resumeAutoScrollTimer = null; }
  highlightWordAt(baseOffset);
  speechStateEl.textContent = 'waiting for mouth to open';

  // If the mouth is already open and a face is visible at click time, don't
  // make the reader close-then-reopen their mouth just to kick things off.
  if (mouthState === 'open' && isFaceVisible && manualSpeechEnabled) {
    speakFrom(baseOffset);
  }
}

function highlightWordAt(charIndex) {
  const idx = wordSpans.findIndex(w => charIndex >= w.start && charIndex < w.end);
  if (idx === -1) return;

  // Phase 12d diagnostic: a boundary event landed but mapped into the
  // SAME word that's already active — either a genuinely duplicate event
  // for one word, or evidence the browser's charIndex for this word drifted
  // backward/stayed put instead of advancing. Either way it means this
  // boundary did NOT refresh lastWordBoundaryTime/currentSpokenWordExpectedMs,
  // which is exactly the kind of gap that could read as a "stall."
  if (idx === activeWordIndex) {
    duplicateBoundaryCount += 1;
    duplicateBoundaryValueEl.textContent = String(duplicateBoundaryCount);
    console.log(`[Phase 12d diag] duplicate/non-advancing boundary for already-active word "${wordSpans[idx].span.textContent}" (charIndex=${charIndex})`);
    return;
  }

  // Phase 12d diagnostic: how long did THIS word's boundary event actually
  // take to arrive, vs. how long the PREVIOUS word was expected to take?
  // A stall shows up here as gapMs far exceeding prevExpectedMs, tagged
  // with exactly which word it landed on.
  const nowForDiag = performance.now();
  const prevExpectedMs = currentSpokenWordExpectedMs;
  const gapMs = Math.round(nowForDiag - lastWordBoundaryTime);
  const newWordText = wordSpans[idx].span.textContent;
  console.log(`[Phase 12d diag] boundary -> "${newWordText}" | gap since prev boundary: ${gapMs}ms (prev word expected ~${Math.round(prevExpectedMs)}ms)`);
  lastWordTextValueEl.textContent = newWordText;
  lastWordGapValueEl.textContent = `${gapMs}ms`;
  lastWordExpectedValueEl.textContent = `${Math.round(prevExpectedMs)}ms`;

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
  currentWordRiskyTimings = estimateRiskyConsonantTimings(wordSpans[idx].span.textContent, currentSpokenWordExpectedMs);
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

  if (mouthState === 'closed' && mar > OPEN_THRESHOLD) {
    mouthState = 'open';
    onMouthOpen();
  } else if (mouthState === 'open') {
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
    const elapsedMs = now - lastWordBoundaryTime;
    cadenceValueEl.textContent = `${Math.round(elapsedMs)} / ${Math.round(currentSpokenWordExpectedMs)}ms`;

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
      `${elapsedMs < currentSpokenWordExpectedMs ? 'under' : 'over'} phase)`;

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
      const underExpected = elapsedMs < currentSpokenWordExpectedMs;
      const activeWordText = activeWordIndex !== -1 ? wordSpans[activeWordIndex].span.textContent : '';
      if (underExpected) {
        earlyCloseCount += 1;
        earlyCloseValueEl.textContent = String(earlyCloseCount);
      }
      console.log(
        `[Fix 3c/3c-2 diag] mouth-close on "${activeWordText}" | elapsed=${Math.round(elapsedMs)}ms expected=${Math.round(currentSpokenWordExpectedMs)}ms | ` +
        `${underExpected ? 'EARLY (under expected)' : 'over expected'} | riskyTimings=[${currentWordRiskyTimings.join(',')}] | ` +
        `inRiskyWindow=${wasInRiskyWindow} | nearestRiskyDelta=${nearestRiskyDelta === null ? 'n/a (no risky sound)' : Math.round(nearestRiskyDelta) + 'ms'}`
      );
      lastCloseInRiskyWindowValueEl.textContent = `${wasInRiskyWindow} (word: "${activeWordText}")`;
      lastCloseRiskyDeltaValueEl.textContent = nearestRiskyDelta === null ? 'n/a' : `${Math.round(nearestRiskyDelta)}ms`;

      mouthState = 'closed';
      onMouthClosed();
    }
  }
  mouthStateEl.textContent = mouthState;
}

// --- Manual ON/OFF speech switch (Entry 45+) ---
// A user-controlled pause layered ALONGSIDE mouth-tracking, not replacing
// it — added after head-pose removal to give the reader an explicit,
// deliberate way to pause (interruption, dry mouth throwing off MAR, wants
// to think) without relying on the app to infer disengagement. Hard-stop on
// OFF per explicit decision: cancels immediately, no partial-word grace.
// Deliberately does NOT touch mouthState — the mouth may still be
// physically open; this is independent of the mouth-open/closed signal.
let manualSpeechEnabled = true;
const speechSwitchBtn = document.getElementById('speechSwitchBtn');
const switchDebugValueEl = document.getElementById('switchDebugValue');

function updateSpeechSwitchUI() {
  speechSwitchBtn.setAttribute('aria-pressed', manualSpeechEnabled ? 'true' : 'false');
  speechSwitchBtn.querySelector('.switch-state').textContent = manualSpeechEnabled ? 'ON' : 'OFF';
  speechSwitchBtn.title = manualSpeechEnabled ? 'Pause reading (Space)' : 'Resume reading (Space)';
  if (switchDebugValueEl) switchDebugValueEl.textContent = manualSpeechEnabled ? 'on' : 'off';
}

function setManualSpeechEnabled(enabled) {
  if (enabled === manualSpeechEnabled) return;
  manualSpeechEnabled = enabled;
  updateSpeechSwitchUI();
  if (!manualSpeechEnabled) {
    if (isSpeakingChunk) {
      manualCancel = true;
      cancelRequestedTime = performance.now();
      cancelActiveSpeech();
      isSpeakingChunk = false;
    }
    speechStateEl.textContent = 'paused (switch off)';
  } else if (mouthState === 'open') {
    // Recovery pattern matching isFaceVisible/tab-visibility: resume
    // immediately if the mouth is already open when flipped back on.
    onMouthOpen();
  } else {
    speechStateEl.textContent = 'waiting for mouth to open';
  }
}

function toggleManualSpeechSwitch() {
  if (!readingActive) return; // no-op outside an active session
  setManualSpeechEnabled(!manualSpeechEnabled);
}

// Resets to enabled+ON at the start of every fresh session (startBtn click)
// so a previous session's OFF state can't silently carry into a new one.
function resetSpeechSwitch() {
  manualSpeechEnabled = true;
  updateSpeechSwitchUI();
}

speechSwitchBtn.addEventListener('click', () => toggleManualSpeechSwitch());

// --- Low-light detection (Entry 50) ---
// PROGRESS.md Section 3d #1 / Entry 49's root-cause finding: dim ambient
// light measurably degrades MediaPipe's landmark precision, which is what
// actually causes the sticky-word bug — not a threshold-tunable bug in
// isolation. Entry 49's diagnostics (Light Test Helper, closeEventLog) only
// ever summarize a session AFTER the fact by looking at where closes
// clustered — useful for confirming the theory, useless as a live signal to
// warn a reader mid-session. This is a separate, real-time measurement:
// direct pixel luminance sampled straight from the video feed, independent
// of MediaPipe/MAR entirely. That independence is deliberate — it measures
// the actual thing we mean ("is there enough light") rather than inferring
// it secondhand from a tracking symptom, so it stays honest even if the
// tracking-precision relationship ever changes.
//
// Drawn onto a small offscreen canvas (downsampled to LIGHT_SAMPLE_SIZE x
// LIGHT_SAMPLE_SIZE) rather than reading the full webcam frame — this makes
// getImageData cheap regardless of the source camera's real resolution, and
// keeps this safe to run on mobile too (no per-platform special-casing
// needed, per the project's cross-device discipline). Sampled on an
// interval, not every frame — ambient light doesn't change frame-to-frame,
// so there's no reason to pay the pixel-read cost 60x/sec.
const LIGHT_SAMPLE_SIZE = 16; // px — small enough getImageData is effectively instant
const LIGHT_SAMPLE_INTERVAL_MS = 500;

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
// CLOSE_THRESHOLD and the speed anchors — see finishCalibration()/
// applyCalibration() for where the baseline is captured and applied.
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
// applyCalibration()). Also unvalidated guesses — "dim enough to matter"
// as a fraction of a personal baseline is still a judgment call, just a
// more portable one than a raw pixel number. Revisit if real feedback
// says the warning fires too eagerly or not eagerly enough.
const LOW_LIGHT_ENTER_RATIO = 0.6; // warn once brightness drops below 60% of baseline
const LOW_LIGHT_EXIT_RATIO = 0.75; // must climb back above 75% of baseline to clear
let LOW_LIGHT_ENTER_THRESHOLD = DEFAULT_LOW_LIGHT_ENTER_THRESHOLD;
let LOW_LIGHT_EXIT_THRESHOLD = DEFAULT_LOW_LIGHT_EXIT_THRESHOLD;

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
const ABSOLUTE_DARK_ENTER_THRESHOLD = 40;
const ABSOLUTE_DARK_EXIT_THRESHOLD = 52;

const lightSampleCanvas = document.createElement('canvas');
lightSampleCanvas.width = LIGHT_SAMPLE_SIZE;
lightSampleCanvas.height = LIGHT_SAMPLE_SIZE;
const lightSampleCtx = lightSampleCanvas.getContext('2d', { willReadFrequently: true });

let lastLightSampleTime = 0;
// Optimistic default (bright) until the first real sample comes in, so a
// webcam that hasn't produced a frame yet can't flag a false low-light
// warning before startup.
let currentBrightness = 255;
let isLowLight = false;
const brightnessValueEl = document.getElementById('brightnessValue');
const lowLightDebugValueEl = document.getElementById('lowLightDebugValue');

function sampleBrightness() {
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
    const relativeCleared = currentBrightness >= LOW_LIGHT_EXIT_THRESHOLD;
    const absoluteCleared = currentBrightness >= ABSOLUTE_DARK_EXIT_THRESHOLD;
    if (relativeCleared && absoluteCleared) isLowLight = false;
  } else {
    const relativeTripped = currentBrightness < LOW_LIGHT_ENTER_THRESHOLD;
    const absoluteTripped = currentBrightness < ABSOLUTE_DARK_ENTER_THRESHOLD;
    if (relativeTripped || absoluteTripped) isLowLight = true;
  }

  if (brightnessValueEl) brightnessValueEl.textContent = currentBrightness.toFixed(1);
  if (lowLightDebugValueEl) lowLightDebugValueEl.textContent = isLowLight ? 'low light' : 'ok';
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
  if (!readingActive) return null;
  if (!manualSpeechEnabled) return 'switch-off'; // highest priority — always wins
  if (!isFaceVisible) return 'no-face';
  // Entry 50: ranked ahead of 'cadence' deliberately — Entry 49 found dim
  // light is often the actual root cause behind a cadence stall (landmark
  // precision degrading, not the reader genuinely pausing), so naming the
  // real cause first is more useful than reporting the downstream symptom.
  if (isLowLight) return 'low-light';
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

function onMouthOpen() {
  // Phase 12d diagnostic: if a "repeat/next-word mouth action" is what
  // releases a stall, THIS call is that action landing — log which guard
  // (if any) makes it a no-op, so a stall can be traced to "the resume
  // never actually fired" vs. "it fired but resumed from the wrong place."
  console.log(`[Phase 12d diag] onMouthOpen() | isFaceVisible=${isFaceVisible} manualSpeechEnabled=${manualSpeechEnabled} readingActive=${readingActive} isSpeakingChunk=${isSpeakingChunk} resumeOffset=${baseOffset + lastBoundaryOffset}`);
  if (!isFaceVisible) return; // gated: don't resume while no face is detected (Phase 9b; head-pose gate removed Entry 45)
  if (!manualSpeechEnabled) return; // gated: user has manually paused via the switch
  if (!readingActive) return; // no active reading session
  if (isSpeakingChunk) return; // already flowing, nothing to do

  const resumeOffset = baseOffset + lastBoundaryOffset;
  speakFrom(resumeOffset);
}

function onMouthClosed() {
  console.log(`[Phase 12d diag] onMouthClosed() | isSpeakingChunk=${isSpeakingChunk}`);
  if (!isSpeakingChunk) return;

  // Stop the current utterance with cancel() rather than pause() — cancel()
  // fully resets speechSynthesis's internal state instead of parking it in a
  // paused limbo, which is the specific state that was wedging Edge's speech
  // engine after repeated use. We remember exactly where we got to (the last
  // completed word boundary) so the next mouth-open can pick up from there.
  manualCancel = true;
  cancelRequestedTime = performance.now();
  cancelActiveSpeech();
  clearFallbackAdvance();
  isSpeakingChunk = false;
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
  lastWordBoundaryTime = performance.now();
  currentSpokenWordExpectedMs = resumeWordIdx !== -1
    ? estimateWordDuration(wordSpans[resumeWordIdx].span.textContent)
    : 0;
  currentWordRiskyTimings = resumeWordIdx !== -1
    ? estimateRiskyConsonantTimings(wordSpans[resumeWordIdx].span.textContent, currentSpokenWordExpectedMs)
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
  if (toneEnabled) {
    const sentenceEnd = findSentenceEnd(currentText, offset);
    const sentenceText = currentText.slice(offset, sentenceEnd);
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

    isSpeakingChunk = false;
    if (manualCancel) {
      // This utterance stopped because WE called cancel() (closing the mouth
      // or looking away), not because the text actually finished.
      //
      // Diagnostic: how long between us requesting cancel() and `speaking`
      // actually confirming it stopped? Isolated testing (see the comment on
      // speakGeneration) showed this is consistently small (~15ms avg) even
      // under simulated CPU load — evidence cancel() itself is not the slow
      // part; the up-to-~300-400ms detection window is the far bigger factor
      // in any perceived overshoot.
      if (cancelRequestedTime !== null) {
        const stopGapMs = Math.round(performance.now() - cancelRequestedTime);
        console.log(`[Phase 9 diag] cancel() to stop-confirmed gap: ${stopGapMs}ms`);
        cancelStopGapValueEl.textContent = `${stopGapMs}ms`;
        cancelRequestedTime = null;
      }
      manualCancel = false;
      return;
    }
    // Natural completion — the one moment we get real ground truth even on
    // a browser with zero onboundary events. See recordFallbackCalibrationSample.
    const realStartTime = utteranceRealStartTime !== null ? utteranceRealStartTime : utteranceCallTime;
    recordFallbackCalibrationSample(performance.now() - realStartTime, resumeWordIdx);
    finishReading();
  }

  currentUtterance.onend = handleStop;

  isSpeakingChunk = true;
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
  readingActive = false;
  isSpeakingChunk = false;
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
  manualCancel = true;
  cancelActiveSpeech();
  ttsEngine.synth.cancel();
  clearFallbackAdvance();
  isSpeakingChunk = false;
  readingActive = false;

  wordSpans = buildWordSpans(currentText);
  activeWordIndex = -1;
  baseOffset = 0;
  lastBoundaryOffset = 0;
  readingActive = true;
  autoScrollEnabled = true; // Phase 12c: fresh session, resume following the active word
  if (resumeAutoScrollTimer !== null) { clearTimeout(resumeAutoScrollTimer); resumeAutoScrollTimer = null; }
  marBuffer = []; // fresh window so a stale pre-click buffer can't cause a false stop
  resetTroubleShading(); // Phase 11b: fresh session shouldn't inherit a lingering score/pulse cooldown
  resetSpeechSwitch(); // fresh session shouldn't inherit a previous session's OFF state
  speechStateEl.textContent = 'waiting for mouth to open';

  // If the mouth is already open right when the button is clicked, start
  // speaking immediately from the beginning. Otherwise wait for mouth-open.
  if (mouthState === 'open' && isFaceVisible) {
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
    console.log(`[visibility] tab hidden | readingActive=${readingActive} mouthState=${mouthState}`);
    if (readingActive) {
      onMouthClosed();
      mouthState = 'closed';
      mouthStateEl.textContent = mouthState;
      facingStateEl.textContent = 'tab hidden — reading paused';
      // Entry 45 fix: force a fresh face-visible confirmation once the tab
      // returns, so this label doesn't linger forever. Before head-pose
      // removal, updateHeadPose() ran every frame and overwrote this label
      // as a side effect of its own pose check; that side effect is gone
      // now, so predictLoop's face-reappear branch needs an actual
      // false->true transition to fire and update the text. Same "recovery
      // is free" pattern as the no-face timeout.
      isFaceVisible = false;
    }
    noFaceSince = null;
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

  // Entry 50: independent of face detection below — brightness only needs
  // a video frame, not a detected face, so a dark room with no face found
  // still gets sampled (arguably the exact case where the reading is most
  // relevant). Interval-gated, not every frame — see comment at
  // sampleBrightness().
  const nowForLightSample = performance.now();
  if (nowForLightSample - lastLightSampleTime >= LIGHT_SAMPLE_INTERVAL_MS) {
    lastLightSampleTime = nowForLightSample;
    sampleBrightness();
  }

  const results = faceLandmarker.detectForVideo(video, performance.now());

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (results.faceLandmarks && results.faceLandmarks.length > 0) {
    noFaceSince = null; // Phase 9b: a face is visible again, clear the gap timer

    // Phase 9b recovery, folded in here Entry 45: this used to happen inside
    // updateHeadPose() (which ran regardless of facing state, so it always
    // noticed a fresh face). With head-pose gating gone, this branch is now
    // the only place a "face reappeared" transition is observed, so the
    // recovery has to live here instead. Mirrors the old behavior: resume
    // immediately if the mouth is already open, rather than waiting for a
    // fresh open edge that may never come.
    if (!isFaceVisible) {
      isFaceVisible = true;
      facingStateEl.textContent = 'face detected';
      if (mouthState === 'open') {
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

    if (calibration.active) {
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
    if (noFaceSince === null) {
      noFaceSince = performance.now();
    } else if (readingActive && isFaceVisible && (performance.now() - noFaceSince) >= NO_FACE_TIMEOUT_MS) {
      isFaceVisible = false;
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
    // Entry 45+ fix: sync every frame off readingActive directly, rather
    // than each call site (startBtn, onWordClick, finishReading...)
    // remembering to update it — onWordClick can also start a session
    // independent of startBtn, and was the one path this got missed on.
    speechSwitchBtn.classList.toggle('is-inactive', !readingActive);
  }

  scheduleNextFrame();
}

// --- Shared coach-mark tour engine (Entry 51) ---------------------------
// One generic step-based walkthrough, reused for both the main app tour
// and the calibration intro, per the shared-system decision made with the
// student rather than building two separate coach-mark implementations.
// A step is either UI-anchored ({ targetId, title, body } — highlights a
// real element) or a plain info slide ({ title, body }, no targetId — a
// centered card with no spotlight, used for welcome/summary slides that
// aren't "about" any one button).
//
// "Seen" state persists per tour id in localStorage (TOUR_STORAGE_PREFIX +
// id) so a returning user isn't shown the same tour unprompted every
// visit — but nothing is ever permanently hidden: both tours stay
// manually re-runnable (helpTourBtn for the main tour; the calibration
// intro re-runs any time hasSeenTour() is false, and finishing/skipping it
// always proceeds into the real wizard either way — see onCalibrateClick).
// Same "always leave a way back" pattern as the warning box elsewhere.
const TOUR_STORAGE_PREFIX = 'readingAppTourSeen_';

let activeTour = null; // { tourId, steps, index }

const tourOverlayEl = document.getElementById('tourOverlay');
const tourHighlightEl = document.getElementById('tourHighlight');
const tourTooltipEl = document.getElementById('tourTooltip');
const tourStepCounterEl = document.getElementById('tourStepCounter');
const tourTitleEl = document.getElementById('tourTitle');
const tourBodyEl = document.getElementById('tourBody');
const tourBackBtn = document.getElementById('tourBackBtn');
const tourNextBtn = document.getElementById('tourNextBtn');
const tourSkipBtn = document.getElementById('tourSkipBtn');
const helpTourBtn = document.getElementById('helpTourBtn');

function hasSeenTour(tourId) {
  try {
    return localStorage.getItem(TOUR_STORAGE_PREFIX + tourId) === '1';
  } catch (err) {
    return false; // storage unavailable — treat as "not seen" rather than crash
  }
}

function markTourSeen(tourId) {
  try {
    localStorage.setItem(TOUR_STORAGE_PREFIX + tourId, '1');
  } catch (err) {
    // Non-fatal — worst case the tour just auto-shows again next visit.
  }
}

function startTour(tourId, steps) {
  if (!steps || steps.length === 0) return;
  activeTour = { tourId, steps, index: 0 };
  tourOverlayEl.style.display = 'block';
  window.addEventListener('resize', repositionActiveTourStep);
  window.addEventListener('scroll', repositionActiveTourStep, true);
  renderTourStep();
}

// Returns the id of the tour that just ended, so the caller (see
// tourNextBtn/tourSkipBtn below) can decide what happens next — e.g. the
// calibration intro always hands off into the real wizard.
function endTour() {
  if (!activeTour) return null;
  const finishedTourId = activeTour.tourId;
  markTourSeen(finishedTourId);
  tourOverlayEl.style.display = 'none';
  tourOverlayEl.classList.remove('tour-centered');
  tourHighlightEl.style.display = 'none';
  window.removeEventListener('resize', repositionActiveTourStep);
  window.removeEventListener('scroll', repositionActiveTourStep, true);
  activeTour = null;
  return finishedTourId;
}

function renderTourStep() {
  if (!activeTour) return;
  const step = activeTour.steps[activeTour.index];
  tourStepCounterEl.textContent = `${activeTour.index + 1} of ${activeTour.steps.length}`;
  tourTitleEl.textContent = step.title;
  tourBodyEl.textContent = step.body;
  tourBackBtn.style.display = activeTour.index === 0 ? 'none' : 'inline-block';
  tourNextBtn.textContent = activeTour.index === activeTour.steps.length - 1 ? 'Done' : 'Next';

  const target = step.targetId ? document.getElementById(step.targetId) : null;
  if (target) {
    tourOverlayEl.classList.remove('tour-centered');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Give the smooth scroll a moment to settle before measuring —
    // getBoundingClientRect() called immediately after scrollIntoView can
    // still reflect the pre-scroll position on some browsers.
    setTimeout(() => positionTourStep(target), 260);
  } else {
    // No targetId, or the referenced element genuinely isn't in the DOM
    // right now (defensive — shouldn't happen with the fixed step lists
    // below, but a silently-missing highlight is worse than a graceful
    // fallback to a centered slide).
    tourOverlayEl.classList.add('tour-centered');
    tourHighlightEl.style.display = 'none';
    positionTooltipCentered();
  }
}

function positionTourStep(target) {
  if (!activeTour) return;
  const rect = target.getBoundingClientRect();
  const pad = 6;
  tourHighlightEl.style.display = 'block';
  tourHighlightEl.style.left = `${rect.left - pad}px`;
  tourHighlightEl.style.top = `${rect.top - pad}px`;
  tourHighlightEl.style.width = `${rect.width + pad * 2}px`;
  tourHighlightEl.style.height = `${rect.height + pad * 2}px`;

  const spaceBelow = window.innerHeight - rect.bottom;
  const tooltipGoesBelow = spaceBelow > 180 || rect.top < 180;
  if (tooltipGoesBelow) {
    tourTooltipEl.style.top = `${rect.bottom + pad + 12}px`;
    tourTooltipEl.style.transform = 'none';
  } else {
    tourTooltipEl.style.top = `${rect.top - pad - 12}px`;
    tourTooltipEl.style.transform = 'translateY(-100%)';
  }
  const maxLeft = Math.max(window.innerWidth - 300, 12);
  const left = Math.min(Math.max(rect.left, 12), maxLeft);
  tourTooltipEl.style.left = `${left}px`;
}

function positionTooltipCentered() {
  tourTooltipEl.style.top = '50%';
  tourTooltipEl.style.left = '50%';
  tourTooltipEl.style.transform = 'translate(-50%, -50%)';
}

function repositionActiveTourStep() {
  if (!activeTour) return;
  const step = activeTour.steps[activeTour.index];
  const target = step.targetId ? document.getElementById(step.targetId) : null;
  if (target) positionTourStep(target);
}

// What happens after a tour ends (finished OR skipped — skipping means
// "I get it, move on," not "cancel the flow"). Only the calibration intro
// currently needs a hand-off; the main app tour just ends.
function onTourFinished(tourId) {
  if (tourId === 'calibrationIntro') {
    startCalibration();
  }
}

tourNextBtn.addEventListener('click', () => {
  if (!activeTour) return;
  if (activeTour.index >= activeTour.steps.length - 1) {
    onTourFinished(endTour());
  } else {
    activeTour.index += 1;
    renderTourStep();
  }
});
tourBackBtn.addEventListener('click', () => {
  if (!activeTour || activeTour.index === 0) return;
  activeTour.index -= 1;
  renderTourStep();
});
tourSkipBtn.addEventListener('click', () => {
  onTourFinished(endTour());
});

// --- Main app tour content -------------------------------------------
// Walks the controls actually present in index.html today. Ordered so the
// mobile heads-up lands early (step 3) — seen before anyone invests real
// time in the rest of the walkthrough, per the student's explicit request.
const MAIN_APP_TOUR_STEPS = [
  {
    title: 'Welcome to Mumblew 👋',
    body: 'Mumblew reads text aloud, paced by your own quiet mouth movement instead of buttons or timers. This quick guide covers the basics — takes about a minute.'
  },
  {
    targetId: 'privacyNote',
    title: 'Your camera stays private',
    body: 'Video is processed entirely on your device and is never uploaded, recorded, or sent anywhere.'
  },
  {
    title: 'Best on a laptop or desktop',
    body: "Mumblew works best on a laptop or desktop browser right now. Mobile support is still being finished, so tracking may be unreliable on a phone — for the best experience, use a computer."
  },
  {
    targetId: 'textInputPanel',
    title: 'Add something to read',
    body: 'Paste or type text here, or upload a .txt or .pdf file.'
  },
  {
    targetId: 'calibrateBtn',
    title: 'Calibrate (one-time setup)',
    body: 'A quick ~15-second setup that teaches the app your own mouth movements and reading pace. Only needs to be done once per device.'
  },
  {
    targetId: 'startBtn',
    title: 'Start Reading',
    body: "Once you've calibrated and loaded some text, tap here. The app reads aloud for as long as your mouth is moving, and pauses when it stops."
  },
  {
    targetId: 'speechSwitchBtn',
    title: 'Pause / resume anytime',
    body: 'Click this switch, or just press Spacebar, to pause or resume reading anytime — no need to touch your mouth to do it.'
  },
  {
    targetId: 'readingControls',
    title: 'Heads-up messages',
    body: "If something's off — low light, can't see your face, and so on — a plain-English note appears in this corner, so you always know why reading paused."
  },
  {
    targetId: 'readingText',
    title: 'Jump to any word',
    body: 'Once text is loaded, tap any word directly to jump the narration straight to it.'
  }
];

// --- Calibration intro content ----------------------------------------
// Shown before the existing 3-step wizard (CALIBRATION_STEPS above) the
// first time someone clicks Calibrate — see onCalibrateClick(). Deliberately
// short: this is a preview, not a replacement for the wizard's own
// per-step instructions.
const CALIBRATION_INTRO_STEPS = [
  {
    title: "Let's set up calibration",
    body: 'This teaches Mumblew your own mouth movements and reading pace, so tracking fits you specifically. Takes about 15 seconds, and only needs to happen once per device.'
  },
  {
    targetId: 'container',
    title: "You'll see yourself here",
    body: "Your camera preview shows up in this box during calibration (and only during calibration) — just to help you frame your face."
  },
  {
    title: 'Three quick steps',
    body: '1) Relax your mouth naturally. 2) Silently mouth a sample sentence. 3) Pick a comfortable reading pace with a slider. Ready when you are.'
  }
];

// Calibrate button now shows the intro tour first time only, then always
// proceeds into the real wizard either way (see onTourFinished above) —
// skipping the intro is "I already know this," not "cancel calibration."
function onCalibrateClick() {
  if (!hasSeenTour('calibrationIntro')) {
    startTour('calibrationIntro', CALIBRATION_INTRO_STEPS);
  } else {
    startCalibration();
  }
}
calibrateBtn.removeEventListener('click', startCalibration);
calibrateBtn.addEventListener('click', onCalibrateClick);

if (helpTourBtn) {
  helpTourBtn.addEventListener('click', () => startTour('mainApp', MAIN_APP_TOUR_STEPS));
}

// Student-flagged gap: the calibration intro previously had NO way back —
// it only ever showed automatically, the very first time Calibrate was
// clicked (hasSeenTour('calibrationIntro') === false), with no button to
// replay it afterward. This is that button, visible at the top of the
// calibration panel on every run. Bypasses hasSeenTour() deliberately —
// this is an explicit "show it to me again" request, not the automatic
// first-time trigger. Note: since onTourFinished('calibrationIntro') always
// hands off into startCalibration() (see above), clicking this mid-wizard
// restarts calibration from step 1 once the intro finishes/is skipped —
// acceptable given the whole flow is ~15 seconds either way.
const calibrationIntroReplayBtn = document.getElementById('calibrationIntroReplayBtn');
if (calibrationIntroReplayBtn) {
  calibrationIntroReplayBtn.addEventListener('click', () => {
    startTour('calibrationIntro', CALIBRATION_INTRO_STEPS);
  });
}

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

// Entry 52 (2nd revision): first-visit sequencing is now gate-driven, not
// an unconditional page-load timer. See the "Welcome gate" block at the
// end of this file for the actual trigger — on first visit, NOTHING (not
// the app, not the guide, not the intro) shows until the user resolves the
// full-screen welcome gate by picking Watch or Skip. A returning visitor
// (gate already resolved) skips straight past the gate with no delay.

// --- Intro sequence (Entry 52, revised) ----------------------------------
// 8-panel illustrated problem/solution story. NEVER auto-plays and NEVER
// autoplays audio — only ever starts from an explicit click, either the
// first-visit invite card (introInviteCard, below) or the "▶ Replay Intro"
// button in the main controls. This is a deliberate reversal from the
// first version of this feature: an unrequested full-screen takeover with
// sound right at page load broke the app's own hands-free/no-forced-action
// premise, and did so on the very first thing a new visitor experiences —
// a bad note to open on for an app that exists partly to serve people who
// may not be able to click reliably (see PROGRESS.md Section 1, ALS/
// paralysis audience). Starting only from a real click has a useful side
// effect too: it sidesteps browser autoplay-audio blocking entirely, since
// playback always follows a genuine user gesture.
//
// Deliberately its own small player rather than a reuse of
// startTour()/renderTourStep() above — that engine is built around
// highlighting a DOM control with a text tooltip, and has no notion of a
// full-bleed image or an attached audio track. Follows the same
// conventions as the tour engine (hasSeenTour/markTourSeen storage keys,
// dark overlay + teal accent, always-visible Skip) for consistency.
//
// Panel 8 is deliberately silent (no narration-8.mp3 — the story's payoff
// beat is visual, not spoken) and is the one panel that does NOT
// auto-advance: it holds on the image, fades in the logo + tagline, and
// waits for an explicit "Get Started" click — same reasoning as above,
// applied to how the sequence ends as well as how it begins.
const INTRO_PANEL_COUNT = 8;
const INTRO_ASSET_BASE = 'assets/intro/';
// Panel 8 has no entry here — it's handled as the silent final beat below.
const INTRO_PANELS = [
  { image: `${INTRO_ASSET_BASE}panel-1.jpg`, audio: `${INTRO_ASSET_BASE}narration-1.mp3`,
    caption: 'This is John. Looks like he is trying to read something interesting, but... why does he look so desperate?' },
  { image: `${INTRO_ASSET_BASE}panel-2.jpg`, audio: `${INTRO_ASSET_BASE}narration-2.mp3`,
    caption: "But his mind keeps drifting. A sentence in, and he's already somewhere else." },
  { image: `${INTRO_ASSET_BASE}panel-3.jpg`, audio: `${INTRO_ASSET_BASE}narration-3.mp3`,
    caption: "He tries to mumble a little louder, but unluckily, that's enough to disturb the people around him." },
  { image: `${INTRO_ASSET_BASE}panel-4.jpg`, audio: `${INTRO_ASSET_BASE}narration-4.mp3`,
    caption: 'His sister notices — she has seen this before.' },
  { image: `${INTRO_ASSET_BASE}panel-5.jpg`, audio: `${INTRO_ASSET_BASE}narration-5.mp3`,
    caption: "Try this. You don't tap anything — you just read like you normally would, quietly, and it keeps pace with you." },
  { image: `${INTRO_ASSET_BASE}panel-6.jpg`, audio: `${INTRO_ASSET_BASE}narration-6.mp3`,
    caption: "Reading life changes for John. For the first time in a while, reading doesn't feel like a fight." },
  { image: `${INTRO_ASSET_BASE}panel-7.jpg`, audio: `${INTRO_ASSET_BASE}narration-7.mp3`,
    caption: 'Just your lips. Your device and a pair of headphones. That\u2019s all you need...' },
];
const INTRO_FINAL_PANEL_IMAGE = `${INTRO_ASSET_BASE}panel-8.jpg`;

const introOverlayEl = document.getElementById('introOverlay');
const introImgEl = document.getElementById('introImg');
const introCaptionEl = document.getElementById('introCaption');
const introProgressDotsEl = document.getElementById('introProgressDots');
const introSkipBtn = document.getElementById('introSkipBtn');
const introReplayBtn = document.getElementById('introReplayBtn');
const introLogoOverlayEl = document.getElementById('introLogoOverlay');
const introGetStartedBtn = document.getElementById('introGetStartedBtn');

let introState = null; // { index, audioEl, onComplete, advanceTimerId }

function buildIntroProgressDots() {
  introProgressDotsEl.textContent = '';
  const totalDots = INTRO_PANEL_COUNT;
  for (let i = 0; i < totalDots; i++) {
    const dot = document.createElement('div');
    dot.className = 'intro-dot';
    introProgressDotsEl.appendChild(dot);
  }
}

function setIntroActiveDot(index) {
  const dots = introProgressDotsEl.querySelectorAll('.intro-dot');
  dots.forEach((dot, i) => dot.classList.toggle('intro-dot-active', i === index));
}

// Preload every panel image up front (they're small post-compression —
// ~150-250KB each, ~1.6MB total) so later panels don't pop in with a
// blank/half-loaded frame while the story is mid-flow.
function preloadIntroImages() {
  INTRO_PANELS.forEach((panel) => { new Image().src = panel.image; });
  new Image().src = INTRO_FINAL_PANEL_IMAGE;
}

function startIntroSequence(onComplete) {
  introState = { index: 0, audioEl: null, onComplete, advanceTimerId: null };
  buildIntroProgressDots();
  preloadIntroImages();
  introOverlayEl.classList.add('intro-visible');
  introSkipBtn.style.display = 'block';
  introLogoOverlayEl.classList.remove('intro-logo-visible');
  playIntroPanel(0);
}

function stopIntroAudio() {
  if (introState && introState.audioEl) {
    introState.audioEl.pause();
    introState.audioEl.onended = null;
    introState.audioEl = null;
  }
  if (introState && introState.advanceTimerId) {
    clearTimeout(introState.advanceTimerId);
    introState.advanceTimerId = null;
  }
}

function playIntroPanel(index) {
  if (!introState) return;
  introState.index = index;
  setIntroActiveDot(index);

  if (index >= INTRO_PANEL_COUNT - 1) {
    // Final panel (8): silent landing beat — image only, no audio, no
    // auto-advance. Hold briefly, then fade in the logo + Get Started.
    introImgEl.classList.remove('intro-img-visible');
    introImgEl.src = INTRO_FINAL_PANEL_IMAGE;
    introCaptionEl.textContent = '';
    introImgEl.onload = () => introImgEl.classList.add('intro-img-visible');
    introState.advanceTimerId = setTimeout(() => {
      introLogoOverlayEl.classList.add('intro-logo-visible');
    }, 1600);
    return;
  }

  const panel = INTRO_PANELS[index];
  introImgEl.classList.remove('intro-img-visible');
  introImgEl.src = panel.image;
  introCaptionEl.textContent = panel.caption;
  introImgEl.onload = () => introImgEl.classList.add('intro-img-visible');

  const audio = new Audio(panel.audio);
  introState.audioEl = audio;
  audio.onended = () => {
    if (!introState) return; // sequence was skipped/ended mid-playback
    playIntroPanel(index + 1);
  };
  // If audio fails to load/play (blocked autoplay policy, missing file,
  // etc.) don't strand the user on a silent panel forever — fall back to a
  // fixed hold so the sequence still progresses.
  audio.onerror = () => {
    if (!introState) return;
    introState.advanceTimerId = setTimeout(() => playIntroPanel(index + 1), 4000);
  };
  const playPromise = audio.play();
  if (playPromise && playPromise.catch) {
    playPromise.catch(() => {
      if (!introState) return;
      introState.advanceTimerId = setTimeout(() => playIntroPanel(index + 1), 4000);
    });
  }
}

function endIntroSequence() {
  if (!introState) return;
  const onComplete = introState.onComplete;
  stopIntroAudio();
  markTourSeen('introSequence');
  introOverlayEl.classList.remove('intro-visible');
  introLogoOverlayEl.classList.remove('intro-logo-visible');
  introSkipBtn.style.display = 'none';
  introState = null;
  if (onComplete) onComplete();
}

introSkipBtn.addEventListener('click', endIntroSequence);
introGetStartedBtn.addEventListener('click', endIntroSequence);

// "▶ Replay Intro" — explicit re-watch request, always available regardless
// of hasSeenTour('introSequence'). No onComplete chain here: replaying
// doesn't need to also re-trigger the main app tour afterward.
if (introReplayBtn) {
  introReplayBtn.addEventListener('click', () => {
    startIntroSequence(null);
  });
}

// --- Intro invite card (Entry 52 revision) -------------------------------
// Replaces the old auto-play trigger entirely. A small, dismissible,
// non-blocking card — same "honest heads-up, never forced" spirit as the
// mobile-viewport banner. Shown once per unseen state near the top of the
// page; clicking it plays the intro (a real user gesture, so audio always
// works), dismissing it just hides it for this pageview without marking
// the sequence "seen" — the student can still find it later via "▶ Replay
// Intro" in the main controls either way.
// --- Welcome gate (Entry 52, 2nd revision) --------------------------------
// Full-screen first-visit gate — replaces the earlier inline invite card.
// While ungated visitors are viewing the app normally, a genuine first-time
// visitor sees ONLY this (see body.app-gated in the CSS, which hides
// #appLayout/#feedbackWidget/#mobileNoticeBanner entirely) until they pick
// one of the two options below. Either path ends the same way: the gate
// closes, the app becomes visible, and the coach-mark guide fires exactly
// as it always has — the only thing that changed is WHEN that first
// reveal happens, and whether the intro story played first.
const welcomeGateEl = document.getElementById('welcomeGate');
const welcomeGateWatchBtn = document.getElementById('welcomeGateWatchBtn');
const welcomeGateSkipBtn = document.getElementById('welcomeGateSkipBtn');

// Resolves the gate visually (app becomes visible, gate marked seen) but
// does NOT decide when/whether the guide tour fires — callers do that
// explicitly, since the two paths need different timing (see below).
function resolveWelcomeGate() {
  document.body.classList.remove('app-gated');
  markTourSeen('welcomeGate');
}

function maybeStartMainTour() {
  if (!hasSeenTour('mainApp')) {
    setTimeout(() => startTour('mainApp', MAIN_APP_TOUR_STEPS), 400);
  }
}

if (welcomeGateWatchBtn) {
  welcomeGateWatchBtn.addEventListener('click', () => {
    // Reveal the app first (so it's not hidden behind two stacked
    // full-screen overlays), then immediately hand off into the intro
    // sequence, which draws its own overlay on top — same visual result
    // as before (full-screen story), just via one gate instead of two.
    // The guide tour is intentionally NOT scheduled here — it would fire
    // ~400ms later, while the ~45s intro story is still playing underneath
    // it. Instead it's passed as the intro's onComplete callback, so it
    // only appears once the story has actually finished (or been skipped
    // via the intro's own Skip button).
    resolveWelcomeGate();
    startIntroSequence(maybeStartMainTour);
  });
}
if (welcomeGateSkipBtn) {
  welcomeGateSkipBtn.addEventListener('click', () => {
    resolveWelcomeGate();
    maybeStartMainTour();
  });
}

// Note: the gate's INITIAL hidden state is applied synchronously by the
// inline <script> at the top of <body> in index.html — not here. This
// module script is deferred by the browser (type="module"), so by the
// time this file runs, the page has already painted; relying on this code
// to apply the class would flash the real app UI first on every visit,
// defeating the point of the gate. This block only ever REMOVES the class
// (via resolveWelcomeGate(), wired to the two buttons above).


// --- Feedback widget (Entry 51) ----------------------------------------
// Small-ship user feedback, collected via Formspree (free tier, no backend
// of our own to write or secure — see PROGRESS.md Section 3 for the
// reasoning). Two kinds of data go up per submission:
//   1) What the tester explicitly gives us: star rating, quick tags,
//      optional free text.
//   2) What we capture automatically, at zero cost to the tester: browser/
//      viewport info, whether calibration is set up, and the current speed
//      setting — the context that turns "tracking felt off" into an
//      actionable bug report instead of a shrug.
// None of this touches the camera/lip-tracking pipeline; it's fully
// separate from the app's core privacy promise (video never leaves the
// device — this is just opt-in text the tester types themselves).
const FORMSPREE_ENDPOINT = 'https://formspree.io/f/xkoddvqj';

const feedbackWidgetEl = document.getElementById('feedbackWidget');
const feedbackToggleBtn = document.getElementById('feedbackToggleBtn');
const feedbackPanelEl = document.getElementById('feedbackPanel');
const feedbackCloseBtn = document.getElementById('feedbackCloseBtn');
const feedbackFormViewEl = document.getElementById('feedbackFormView');
const feedbackThanksViewEl = document.getElementById('feedbackThanksView');
const feedbackStarsEl = document.getElementById('feedbackStars');
const feedbackTagsEl = document.getElementById('feedbackTags');
const feedbackTextAreaEl = document.getElementById('feedbackTextArea');
const feedbackHoneypotEl = document.getElementById('feedbackHoneypot');
const feedbackSubmitBtn = document.getElementById('feedbackSubmitBtn');
const feedbackErrorMsgEl = document.getElementById('feedbackErrorMsg');

let feedbackRating = 0;
const feedbackSelectedTags = new Set();

function openFeedbackPanel() {
  feedbackPanelEl.hidden = false;
  feedbackToggleBtn.setAttribute('aria-expanded', 'true');
}
function closeFeedbackPanel() {
  feedbackPanelEl.hidden = true;
  feedbackToggleBtn.setAttribute('aria-expanded', 'false');
}
feedbackToggleBtn.addEventListener('click', () => {
  if (feedbackPanelEl.hidden) openFeedbackPanel(); else closeFeedbackPanel();
});
feedbackCloseBtn.addEventListener('click', closeFeedbackPanel);

function renderFeedbackStars() {
  feedbackStarsEl.querySelectorAll('.feedback-star').forEach((btn) => {
    const val = parseInt(btn.dataset.value, 10);
    btn.classList.toggle('feedback-star-filled', val <= feedbackRating);
    btn.setAttribute('aria-pressed', val === feedbackRating ? 'true' : 'false');
  });
}
feedbackStarsEl.querySelectorAll('.feedback-star').forEach((btn) => {
  btn.addEventListener('click', () => {
    feedbackRating = parseInt(btn.dataset.value, 10);
    renderFeedbackStars();
  });
});

feedbackTagsEl.querySelectorAll('.feedback-tag').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tag = btn.dataset.tag;
    if (feedbackSelectedTags.has(tag)) {
      feedbackSelectedTags.delete(tag);
      btn.classList.remove('feedback-tag-selected');
    } else {
      feedbackSelectedTags.add(tag);
      btn.classList.add('feedback-tag-selected');
    }
  });
});

function resetFeedbackForm() {
  feedbackRating = 0;
  feedbackSelectedTags.clear();
  renderFeedbackStars();
  feedbackTagsEl.querySelectorAll('.feedback-tag').forEach((btn) => btn.classList.remove('feedback-tag-selected'));
  feedbackTextAreaEl.value = '';
  feedbackHoneypotEl.value = '';
  feedbackErrorMsgEl.textContent = '';
  feedbackFormViewEl.hidden = false;
  feedbackThanksViewEl.hidden = true;
}

// Soft client-side cooldown — NOT a real security boundary (anyone can
// bypass client-side JS), just stops accidental double-taps/rapid re-
// submits from one honest tester from cluttering the dashboard. Formspree's
// own spam filtering + the honeypot field below are the actual defenses.
const FEEDBACK_COOLDOWN_MS = 15000;
let feedbackLastSubmitAt = 0;

async function submitFeedback() {
  feedbackErrorMsgEl.textContent = '';

  // Honeypot tripped: silently pretend success. Never tell a bot its
  // submission was rejected — that just teaches it to try again differently.
  if (feedbackHoneypotEl.value.trim() !== '') {
    feedbackFormViewEl.hidden = true;
    feedbackThanksViewEl.hidden = false;
    setTimeout(() => { closeFeedbackPanel(); resetFeedbackForm(); }, 2500);
    return;
  }

  const now = Date.now();
  if (now - feedbackLastSubmitAt < FEEDBACK_COOLDOWN_MS) {
    feedbackErrorMsgEl.textContent = 'Already sent — thanks! Give it a moment before sending more.';
    return;
  }
  if (feedbackRating === 0 && feedbackSelectedTags.size === 0 && feedbackTextAreaEl.value.trim() === '') {
    feedbackErrorMsgEl.textContent = 'Add a rating, a tag, or a note first.';
    return;
  }

  feedbackSubmitBtn.disabled = true;
  feedbackSubmitBtn.textContent = 'Sending…';

  let hasCalibration = false;
  try {
    hasCalibration = !!localStorage.getItem(CALIBRATION_STORAGE_KEY);
  } catch (e) { /* localStorage unavailable — leave false, not worth failing the submit over */ }

  const payload = {
    rating: feedbackRating || null,
    tags: Array.from(feedbackSelectedTags),
    message: feedbackTextAreaEl.value.trim(),
    // Auto-captured context (Section 3's "useful FOR US" requirement):
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    hasCalibration,
    speedSetting: rateSliderEl.value,
    pageUrl: window.location.href,
    submittedAt: new Date().toISOString(),
    _gotcha: '' // honeypot, confirmed empty above
  };

  try {
    const response = await fetch(FORMSPREE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error('Formspree responded with an error');

    feedbackLastSubmitAt = now;
    feedbackFormViewEl.hidden = true;
    feedbackThanksViewEl.hidden = false;
    setTimeout(() => { closeFeedbackPanel(); resetFeedbackForm(); }, 2500);
  } catch (err) {
    feedbackErrorMsgEl.textContent = "Couldn't send — check your connection and try again.";
  } finally {
    feedbackSubmitBtn.disabled = false;
    feedbackSubmitBtn.textContent = 'Send feedback';
  }
}
feedbackSubmitBtn.addEventListener('click', submitFeedback);

// Note: the welcome gate itself (above) runs synchronously as this script
// executes, immediately toggling body.app-gated before first paint settles
// — no deferred call needed here, unlike the old invite-card version.

setup();