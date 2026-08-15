// storage.js — IndexedDB text persistence + PDF text extraction.
// Extracted from main.js (Entry 55 modularization, Section 3d #1).
// Scope note: this module owns storage PRIMITIVES only. setCurrentText()/
// loadSavedText() in main.js call these but stay in the orchestrator, since
// they also touch speech state, UI panels, and progress indicator — see
// PROGRESS.md Section 2 on why shared state needs a deliberate export
// design, not a mechanical split. Other localStorage keys (voice,
// calibration, fallback-rate, tour) are NOT here — each is tightly local to
// its own future module (calibration/speech/tour), not a generic "storage"
// concern, so pulling them into this file would just recreate a
// clean-sounding module name over a false boundary.

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

// Old localStorage key — read once for migration by loadSavedText() in
// main.js, then unused. Exported so the migration logic and this module
// agree on the exact key without duplicating the string literal.
export const LEGACY_TEXT_STORAGE_KEY = 'readingAppText';

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

export async function idbSetText(data) {
  const db = await openTextDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEXT_STORE_NAME, 'readwrite');
    tx.objectStore(TEXT_STORE_NAME).put(data, TEXT_RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGetText() {
  const db = await openTextDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEXT_STORE_NAME, 'readonly');
    const req = tx.objectStore(TEXT_STORE_NAME).get(TEXT_RECORD_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDeleteText() {
  const db = await openTextDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEXT_STORE_NAME, 'readwrite');
    tx.objectStore(TEXT_STORE_NAME).delete(TEXT_RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

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
// all, so they'll come back empty — surfaced by the caller as a normal "no
// text found" status message rather than an error, since nothing actually
// went wrong.
export async function extractPdfText(file) {
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

// Phase 10d: sane upload-size ceiling. Not a security boundary (nothing in
// an uploaded file executes — see rendering path, which is textContent-only)
// but a huge file can hang the tab mid-parse or blow past localStorage's
// quota silently. 20MB is generous headroom above any real reading text
// (a 20MB .txt is ~a shelf of books; a 20MB PDF is a large document) while
// still catching accidental wrong-file selections early with a clear message
// instead of a stuck "Reading..." status.
export const MAX_UPLOAD_FILE_SIZE_BYTES = 20 * 1024 * 1024;
