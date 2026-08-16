// fallback-drift-diagnostic.js — standalone module, loaded via <script src>
// rather than inline, because this project's CSP (script-src 'self' ...) has
// no 'unsafe-inline' — same reason gate-init.js exists (see PROGRESS.md
// Section 3, Intro sequence entry). Do NOT inline this back into the HTML
// file; it will silently fail in production exactly like this just did.
import { estimateWordDuration, estimateFallbackDelayMs } from './js/cadence.js';

const textInput = document.getElementById('textInput');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const tapBtn = document.getElementById('tapBtn');
const ignoreRealBoundaryEl = document.getElementById('ignoreRealBoundary');
const logEl = document.getElementById('log');
const summaryEl = document.getElementById('summary');
const fallbackWordNumEl = document.getElementById('fallbackWordNum');
const humanWordNumEl = document.getElementById('humanWordNum');

function log(msg) {
  const line = document.createElement('div');
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

let words = [];
let utteranceStartTime = 0; // performance.now() at onstart (real ground-truth anchor)
let fallbackTimerId = null;
let fallbackIdx = -1;          // 0-based index of the word the FALLBACK believes is current
let boundaryEventCount = 0;    // mirrors main.js's confidence-guard counter, same sticky behavior
let fallbackRateFactor = 1.0;  // fresh each run deliberately — see note in chat
let fallbackLog = [];          // { idx, time } every time fallbackIdx advances
let humanLog = [];             // { idx, time } every tap
let running = false;
let utterance = null;

function clearFallbackTimer() {
  if (fallbackTimerId !== null) { clearTimeout(fallbackTimerId); fallbackTimerId = null; }
}

// Faithful reproduction of scheduleFallbackAdvance's logic from main.js,
// including the confidence-guard 2.2x multiplier, so we can see if/when it
// engages on this device too.
function scheduleFallbackAdvance(forIdx) {
  clearFallbackTimer();
  if (forIdx === -1 || forIdx + 1 >= words.length) return;
  let delayMs = estimateFallbackDelayMs(words[forIdx], fallbackRateFactor);
  if (boundaryEventCount > 0) delayMs *= 2.2;
  delayMs = Math.max(60, delayMs);
  fallbackTimerId = setTimeout(() => {
    fallbackTimerId = null;
    if (!running) return;
    if (fallbackIdx !== forIdx) return;
    const nextIdx = forIdx + 1;
    fallbackIdx = nextIdx;
    const t = performance.now() - utteranceStartTime;
    fallbackLog.push({ idx: nextIdx, time: t });
    fallbackWordNumEl.textContent = String(nextIdx + 1);
    log(`[fallback] -> word #${nextIdx + 1} "${words[nextIdx]}" at ${Math.round(t)}ms (scheduled delay was ${Math.round(delayMs)}ms)`);
    scheduleFallbackAdvance(nextIdx);
  }, delayMs);
}

startBtn.addEventListener('click', () => {
  words = textInput.value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) { alert('Enter a longer paragraph (at least a few words).'); return; }

  fallbackIdx = -1;
  boundaryEventCount = 0;
  fallbackRateFactor = 1.0;
  fallbackLog = [];
  humanLog = [];
  logEl.innerHTML = '';
  summaryEl.style.display = 'none';
  fallbackWordNumEl.textContent = '–';
  humanWordNumEl.textContent = '–';
  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  tapBtn.disabled = false;

  utterance = new SpeechSynthesisUtterance(words.join(' '));
  utterance.rate = 1.0;

  utterance.onstart = () => {
    utteranceStartTime = performance.now();
    fallbackIdx = 0;
    fallbackLog.push({ idx: 0, time: 0 });
    fallbackWordNumEl.textContent = '1';
    log(`[onstart] real audio begins — anchor set`);
    scheduleFallbackAdvance(0);
  };

  utterance.onboundary = (event) => {
    if (event.name !== 'word') return;
    const t = performance.now() - utteranceStartTime;
    boundaryEventCount += 1;
    log(`[REAL onboundary #${boundaryEventCount}] charIndex=${event.charIndex} at ${Math.round(t)}ms` +
        (ignoreRealBoundaryEl.checked ? ' (ignored — pure fallback mode)' : ''));
    if (!ignoreRealBoundaryEl.checked) {
      // Best-effort: map charIndex to a word index for logging parity.
      let charCount = 0, idx = 0;
      for (let i = 0; i < words.length; i++) {
        if (charCount >= event.charIndex) { idx = i; break; }
        charCount += words[i].length + 1;
      }
      fallbackIdx = idx;
      fallbackLog.push({ idx, time: t });
      fallbackWordNumEl.textContent = String(idx + 1);
      scheduleFallbackAdvance(idx);
    }
  };

  utterance.onend = () => {
    log(`[onend] utterance finished naturally`);
    finish();
  };

  speechSynthesis.speak(utterance);
});

function registerTap() {
  if (!running) return;
  const idx = humanLog.length; // 0-based, sequential
  const t = performance.now() - utteranceStartTime;
  humanLog.push({ idx, time: t });
  humanWordNumEl.textContent = String(idx + 1);
  log(`[YOU HEARD] word #${idx + 1} at ${Math.round(t)}ms`);
}

tapBtn.addEventListener('click', registerTap);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && running) { e.preventDefault(); registerTap(); }
});

stopBtn.addEventListener('click', () => { speechSynthesis.cancel(); finish(); });

function finish() {
  running = false;
  clearFallbackTimer();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  tapBtn.disabled = true;
  renderSummary();
}

function fallbackIdxAtTime(t) {
  let result = -1;
  for (const entry of fallbackLog) {
    if (entry.time <= t) result = entry.idx; else break;
  }
  return result;
}

function renderSummary() {
  if (humanLog.length === 0) {
    summaryEl.style.display = 'block';
    summaryEl.innerHTML = '<p>No taps recorded — nothing to compare.</p>';
    return;
  }
  let rows = '';
  let maxDriftWords = 0, maxDriftMs = 0;
  // Sample every 3rd tap (or all, if short) to keep the table readable.
  const step = humanLog.length > 20 ? Math.ceil(humanLog.length / 20) : 1;
  for (let i = 0; i < humanLog.length; i += step) {
    const h = humanLog[i];
    const f = fallbackIdxAtTime(h.time);
    const driftWords = h.idx - f;
    const fEntry = [...fallbackLog].reverse().find(e => e.time <= h.time);
    const driftMs = fEntry ? Math.round(h.time - fEntry.time) : Math.round(h.time);
    if (driftWords > maxDriftWords) maxDriftWords = driftWords;
    if (driftMs > maxDriftMs) maxDriftMs = driftMs;
    rows += `<tr><td>#${h.idx + 1} "${words[h.idx] || ''}"</td><td>${Math.round(h.time)}</td><td>#${f + 1}</td><td>${driftWords}</td></tr>`;
  }
  const last = humanLog[humanLog.length - 1];
  const lastFallback = fallbackIdxAtTime(last.time);
  const finalDrift = last.idx - lastFallback;

  summaryEl.style.display = 'block';
  summaryEl.innerHTML = `
    <p><strong>Plain-English result:</strong> by the last word you tapped (#${last.idx + 1}),
    the fallback highlighter believed it was on word #${lastFallback + 1} —
    <strong>${finalDrift} word(s) behind</strong>. Real onboundary events fired
    ${boundaryEventCount} time(s) this run (0 means this device gives no real
    boundary events at all, matching the earlier 0/14 harness result).</p>
    <table>
      <tr><th>You heard</th><th>at (ms)</th><th>Fallback thought</th><th>Drift (words)</th></tr>
      ${rows}
    </table>
  `;
  log(`\n=== SUMMARY: final drift ${finalDrift} words, max drift seen ${maxDriftWords} words / ${maxDriftMs}ms, real onboundary count = ${boundaryEventCount} ===`);
}
