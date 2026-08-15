// tone.js — sentence-end detection + punctuation-based tone mapping.
// Extracted from main.js (Entry 55 modularization, Section 3d #1).
// Both pure functions, no external state; called only from speakFrom
// (js/speech.js once that's extracted — for now, main.js).

// Finds the end (exclusive-of-nothing, i.e. index right after the punctuation
// mark) of the sentence starting at fromOffset. Falls back to the end of the
// text if no sentence-ending punctuation is found (last sentence, or text
// doesn't end with one) — this matches the pre-Phase-8 default of speaking
// everything remaining in one chunk. Known limitation, not handled: doesn't
// distinguish abbreviations like "Mr." from real sentence ends — acceptable
// for the current heuristic-first scope.
export function findSentenceEnd(text, fromOffset) {
  const rest = text.slice(fromOffset);
  const match = rest.match(/[.!?]/);
  if (!match) return text.length;
  return fromOffset + match.index + 1;
}

// Punctuation -> {pitch, rate, label}. Neutral matches the untouched Web
// Speech defaults (pitch 1.0, rate 1.0) so a plain '.' sentence sounds
// identical to how every sentence sounded before this phase.
export function getToneForSentence(sentenceText) {
  const trimmed = sentenceText.trim();
  const lastChar = trimmed[trimmed.length - 1];
  if (lastChar === '!') return { pitch: 1.3, rate: 1.1, label: 'on, excited (!)' };
  if (lastChar === '?') return { pitch: 1.15, rate: 1.0, label: 'on, curious (?)' };
  return { pitch: 1.0, rate: 1.0, label: 'on, neutral' };
}
