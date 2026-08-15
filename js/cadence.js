// cadence.js — word-duration estimation and personalized speed calibration.
// Lives in js/, alongside future extracted modules.
// Extracted from main.js (Entry 55 modularization, Section 3d #1).
// Pure math + one piece of shared mutable state (personalized cadence),
// deliberately exposed only via get/set functions below rather than as
// raw exported `let`s — see PROGRESS.md Section 2 on why shared state
// needs a deliberate export design, not a mechanical split.

// --- Personalized cadence state ---------------------------------------
// Set once from a saved Speed calibration (see loadSavedCalibration in the
// calibration module) or left at defaults for an uncalibrated user.
export const DEFAULT_MS_PER_SYLLABLE = 220;
export const DEFAULT_BASE_WORD_MS = 120; // floor so even a 1-syllable word gets a sane estimate
export const DEFAULT_PERSONALIZED_RATE = 1.0;

let msPerSyllable = DEFAULT_MS_PER_SYLLABLE;
let baseWordMs = DEFAULT_BASE_WORD_MS;
let personalizedRate = DEFAULT_PERSONALIZED_RATE;

export function getPersonalizedCadence() {
  return { msPerSyllable, baseWordMs, personalizedRate };
}

export function setPersonalizedCadence({ msPerSyllable: ms, baseWordMs: base, personalizedRate: rate }) {
  msPerSyllable = ms;
  baseWordMs = base;
  personalizedRate = rate;
}

export function resetPersonalizedCadence() {
  msPerSyllable = DEFAULT_MS_PER_SYLLABLE;
  baseWordMs = DEFAULT_BASE_WORD_MS;
  personalizedRate = DEFAULT_PERSONALIZED_RATE;
}

// How much the Option A range threshold gets tightened/relaxed based on
// whether we're under or over the current word's expected duration.
// Under expected duration → likely mid-word → demand a flatter (stricter)
// window before accepting a close. Over expected duration → the word has
// had its expected time already → relax the bar so we don't lag on words
// that are naturally quick to close after.
export const CADENCE_UNDER_FACTOR = 0.6; // stricter: threshold * 0.6
export const CADENCE_OVER_FACTOR = 1.5;  // looser: threshold * 1.5

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

export function estimateSyllables(word) {
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

export function estimateWordDuration(word) {
  return baseWordMs + estimateSyllables(word) * msPerSyllable;
}

// --- Fallback-advance timing (see scheduleFallbackAdvance in the speech
// module) -----------------------------------------------------------------
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
//
// fallbackRateFactor is owned by the mouth-tracking/speech module (it's an
// EMA measured from real onboundary-vs-fallback deltas), so it's passed in
// rather than read from a module-global here — keeps this module's only
// mutable state the personalized cadence above.
export function estimateFallbackDelayMs(word, fallbackRateFactor) {
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
export const SAMPLE_SENTENCE = "The cat slowly wandered through an unexpectedly enormous garden " +
  "while butterflies fluttered quietly overhead.";

// --- Phase 11: speed-calibration slider anchors ---
// utterance.rate was confirmed unused/fixed at the Web Speech default (1.0)
// through Phase 8 (see PROGRESS.md Section 3) — the personalized rate above
// is the lever that finally uses it. Derived from the same Speed
// calibration step as msPerSyllable/baseWordMs (never tuned independently —
// see speakFrom in the speech module), so TTS pacing and mouth-close
// cadence detection move together instead of racing ahead of/lagging behind
// a user's real mumbling speed.
//
// DEFAULT_* is the fallback used whenever no saved speed calibration exists
// yet (either a brand-new install, or a pre-Phase-11 saved calibration that
// only has MAR/pose fields) — an uncalibrated speed setting behaves exactly
// as before.
//
// Anchor values below are Entry-47 DATA-TUNED (final), using noise-filtered
// data from a temporary logging tool used for this tuning pass (since
// removed once tuning closed out — see PROGRESS.md Entry 47/48 for the full
// test history). First pass over-corrected: it was contaminated by
// forced/rushed taps on words that were physically hard to mouth cleanly at
// the slider extremes, which skewed the average down and led to anchors
// that were cut too aggressively (180/105 slow, 120/55 fast). Filtering
// closes under 150ms and re-testing with genuinely natural pacing showed
// the opposite problem — clean avg elapsed/expected ratio was 1.28 at 0.5x
// and 1.13 at 1.75x (n=25/26), meaning those first-pass anchors were now
// too SHORT. Values below scale the first-pass anchors up by those clean
// ratios, landing close to (but not identical to) the original starting
// guesses — net conclusion: the original guesses were closer to right than
// assumed; genuine cadence gating noise mostly came from strained mimicry
// at the extremes, not from the anchor numbers themselves being far off.
// Known residual gap NOT addressed here: estimateWordDuration() has no
// per-word sense of sentence-final punctuation or emphasis, so short
// function words still get over-estimated and sentence-ending words still
// get under-estimated relative to each other — a formula-level limitation,
// out of scope for anchor tuning. The 1.0 anchor still reuses the existing
// DEFAULT_* pair (untested by this pass — extremes only) so a user who
// leaves the slider untouched still sees no behavior change.
export const RATE_SLIDER_MIN = 0.5;
export const RATE_SLIDER_MAX = 1.75;
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
export function interpolateCadence(rate) {
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
