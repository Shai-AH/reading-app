// voice.js — local-voice selection (dropdown, persistence, resolution).
// Extracted from main.js (Entry 55 modularization, Section 3d #1).
// Fully self-contained: main.js only calls resolveSelectedVoice(synth),
// always with window.speechSynthesis as the argument.

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
export function resolveSelectedVoice(synth) {
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
