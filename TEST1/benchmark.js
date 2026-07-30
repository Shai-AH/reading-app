// Phase 13.5 concurrent-load benchmark.
// Standalone, isolated from main.js/index.html (Entry 34 build-order decision).
// Measures MediaPipe FaceLandmarker frame timing alone ("baseline"), then with
// Kokoro TTS WASM inference running concurrently ("concurrent"), on real
// hardware. The app's active-tracking loop runs at rAF (~60fps target, see
// main.js's predictLoop / IDLE_FRAME_INTERVAL_MS=100 comment) — that's the
// number this benchmark is checking doesn't collapse under concurrent TTS load.
//
// Kokoro runs in kokoro-worker.js (a dedicated Worker), not inline here.
// v1 of this harness ran it on the main thread and it froze the tab solid —
// WASM inference blocks synchronously while computing, so it directly
// stalled the same rAF loop it was supposed to run alongside. Worker
// isolation is also the real architecture Phase 13.5 would ship with.

import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

// Kokoro runs inside kokoro-worker.js (a dedicated Worker), not on the main
// thread — WASM inference blocks synchronously while computing, and running
// it inline would directly freeze the MediaPipe rAF loop this benchmark is
// trying to measure alongside it (confirmed the hard way in the first run).
const KOKORO_VERSION = "1.2.1";

// Configurable — swap if a different export turns out to work better.
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

let kokoroWorker = null;
let msgId = 0;
const pending = new Map();

function callWorker(type, payload) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    kokoroWorker.postMessage({ type, id, payload });
  });
}

function initWorkerListener() {
  kokoroWorker.onmessage = (e) => {
    const { type, id, ...rest } = e.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (type === "error") {
      entry.reject(new Error(rest.message));
    } else {
      entry.resolve(rest);
    }
  };
  kokoroWorker.onerror = (e) => {
    log(`Worker error: ${e.message}`);
  };
}

const SAMPLE_SENTENCES = [
  "The quiet room held nothing but the sound of turning pages.",
  "She read slowly, letting each word settle before moving to the next.",
  "Outside, the rain kept its own steady rhythm against the window.",
  "He had always found comfort in stories that took their time.",
  "The library was empty except for the low hum of the lights.",
];

const MEDIAPIPE_WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

const logEl = document.getElementById("log");
const startBtn = document.getElementById("startBtn");
const exportBtn = document.getElementById("exportBtn");
const videoEl = document.getElementById("webcam");
const resultsPanel = document.getElementById("resultsPanel");
const resultsTable = document.getElementById("resultsTable");
const verdictEl = document.getElementById("verdict");

let lastResults = null;

function log(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `\n[${time}] ${msg}`;
  logEl.scrollTop = logEl.scrollHeight;
}

function stats(samples) {
  if (samples.length === 0) {
    return { avg: 0, median: 0, p95: 0, max: 0, fps: 0, n: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const max = sorted[sorted.length - 1];
  return {
    avg,
    median,
    p95,
    max,
    fps: avg > 0 ? 1000 / avg : 0,
    n: samples.length,
  };
}

async function initWebcam() {
  log("Requesting camera…");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
  });
  videoEl.srcObject = stream;
  await new Promise((resolve) => {
    videoEl.onloadeddata = resolve;
  });
  log("Camera ready.");
  return stream;
}

async function initFaceLandmarker() {
  log("Loading MediaPipe FaceLandmarker…");
  const filesetResolver = await FilesetResolver.forVisionTasks(
    MEDIAPIPE_WASM_BASE
  );
  const landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    outputFacialTransformationMatrixes: true,
    runningMode: "VIDEO",
    numFaces: 1,
  });
  log("FaceLandmarker ready.");
  return landmarker;
}

async function initKokoro(dtype) {
  log(`Loading Kokoro TTS (dtype=${dtype}) in a worker… this downloads the model on first run.`);
  kokoroWorker = new Worker("kokoro-worker.js", { type: "module" });
  initWorkerListener();
  const { loadMs } = await callWorker("load", {
    version: KOKORO_VERSION,
    modelId: KOKORO_MODEL_ID,
    dtype,
  });
  log(`Kokoro loaded in ${(loadMs / 1000).toFixed(1)}s (off main thread).`);
  return { loadMs };
}

// Runs the MediaPipe detect loop via rAF for durationMs, recording per-frame
// processing time (the detectForVideo call itself) and real frame-to-frame
// interval (captures main-thread contention from anything else running,
// e.g. concurrent TTS WASM work). Returns { procSamples, intervalSamples }.
function runMediaPipeLoop(landmarker, durationMs) {
  return new Promise((resolve) => {
    const procSamples = [];
    const intervalSamples = [];
    let lastFrameTime = null;
    const startTime = performance.now();

    function frame() {
      const now = performance.now();
      if (lastFrameTime !== null) {
        intervalSamples.push(now - lastFrameTime);
      }
      lastFrameTime = now;

      const t0 = performance.now();
      landmarker.detectForVideo(videoEl, now);
      procSamples.push(performance.now() - t0);

      if (performance.now() - startTime < durationMs) {
        requestAnimationFrame(frame);
      } else {
        resolve({ procSamples, intervalSamples });
      }
    }
    requestAnimationFrame(frame);
  });
}

// Fires TTS generate() calls back-to-back (awaited, not overlapping — mirrors
// how the real app would consume one utterance at a time) for durationMs,
// cycling through sample sentences. Returns per-call latencies.
async function runTTSLoad(durationMs) {
  const latencies = [];
  const startTime = performance.now();
  let i = 0;
  while (performance.now() - startTime < durationMs) {
    const sentence = SAMPLE_SENTENCES[i % SAMPLE_SENTENCES.length];
    i++;
    const t0 = performance.now();
    try {
      await callWorker("generate", { text: sentence, voice: "af_bella" });
    } catch (err) {
      log(`TTS generate() error: ${err.message}`);
      break;
    }
    const latency = performance.now() - t0;
    latencies.push(latency);
    log(`  TTS call #${i} latency: ${(latency / 1000).toFixed(1)}s`);
  }
  return latencies;
}

function renderResults(baseline, concurrent, kokoroLoadMs, ttsLatencies, dtype) {
  resultsPanel.style.display = "block";

  const rows = [
    ["Metric", "Baseline (MediaPipe only)", "Concurrent (+ Kokoro TTS)"],
    [
      "Frame interval avg",
      `${baseline.avg.toFixed(1)} ms (${baseline.fps.toFixed(1)} fps)`,
      `${concurrent.avg.toFixed(1)} ms (${concurrent.fps.toFixed(1)} fps)`,
    ],
    [
      "Frame interval median",
      `${baseline.median.toFixed(1)} ms`,
      `${concurrent.median.toFixed(1)} ms`,
    ],
    [
      "Frame interval p95",
      `${baseline.p95.toFixed(1)} ms`,
      `${concurrent.p95.toFixed(1)} ms`,
    ],
    [
      "Frame interval max",
      `${baseline.max.toFixed(1)} ms`,
      `${concurrent.max.toFixed(1)} ms`,
    ],
    ["Frames sampled", `${baseline.n}`, `${concurrent.n}`],
  ];

  resultsTable.textContent = "";
  rows.forEach((row, idx) => {
    const tr = document.createElement("tr");
    row.forEach((cell) => {
      const el = document.createElement(idx === 0 ? "th" : "td");
      el.textContent = cell;
      tr.appendChild(el);
    });
    resultsTable.appendChild(tr);
  });

  const ttsStats = stats(ttsLatencies);
  const extraRow = document.createElement("tr");
  const label = document.createElement("td");
  label.textContent = "Kokoro generate() avg latency / calls completed";
  const val = document.createElement("td");
  val.textContent = `${ttsStats.avg.toFixed(0)} ms / ${ttsStats.n} calls`;
  val.colSpan = 2;
  extraRow.appendChild(label);
  extraRow.appendChild(val);
  resultsTable.appendChild(extraRow);

  // Median, not average, drives the verdict — a single backgrounded-tab or
  // system-sleep event during a run can blow the average up by 100x while
  // barely touching the median. Average is still shown in the table for
  // transparency, but median is the sustained-performance number that matters.
  const baselineFps = baseline.median > 0 ? 1000 / baseline.median : 0;
  const concurrentFps = concurrent.median > 0 ? 1000 / concurrent.median : 0;
  const degradationPct =
    baseline.median > 0
      ? ((concurrent.median - baseline.median) / baseline.median) * 100
      : 0;

  const meanMedianGapWarning =
    baseline.avg > baseline.median * 3 || concurrent.avg > concurrent.median * 3
      ? " (Note: average was much higher than median this run — likely a backgrounded tab or system sleep during the test, not real compute contention. Judged on median instead.)"
      : "";

  let verdictClass = "good";
  let verdictText = `Looks healthy: concurrent median ~${concurrentFps.toFixed(
    1
  )}fps (${degradationPct.toFixed(0)}% slower than baseline). Active tracking targets ~60fps rAF — this is holding up.${meanMedianGapWarning}`;

  if (concurrentFps < 24 || degradationPct > 60) {
    verdictClass = "bad";
    verdictText = `Concerning: concurrent median dropped to ~${concurrentFps.toFixed(
      1
    )}fps (${degradationPct.toFixed(
      0
    )}% slower than baseline). That's likely to visibly hurt mouth-tracking responsiveness during active reading. Kokoro WASM inference is probably too heavy to run alongside MediaPipe on this device at dtype=${dtype} — worth re-testing at a lighter dtype (q4) before concluding 13.5 isn't viable here.${meanMedianGapWarning}`;
  } else if (concurrentFps < 45 || degradationPct > 25) {
    verdictClass = "warn";
    verdictText = `Borderline: concurrent median ~${concurrentFps.toFixed(
      1
    )}fps (${degradationPct.toFixed(
      0
    )}% slower than baseline). Not collapsed, but noticeably degraded from the ~60fps rAF target — worth judging by feel (does tracking feel laggy during the concurrent phase?) rather than the number alone.${meanMedianGapWarning}`;
  }

  verdictEl.className = `verdict ${verdictClass}`;
  verdictEl.textContent = verdictText;

  lastResults = {
    timestamp: new Date().toISOString(),
    dtype,
    kokoroLoadMs,
    baseline,
    concurrent,
    degradationPct,
    ttsStats,
    userAgent: navigator.userAgent,
  };
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  const dtype = document.getElementById("dtype").value;
  const durationMs = parseInt(document.getElementById("duration").value, 10);

  try {
    log(
      `crossOriginIsolated: ${crossOriginIsolated} (should be true — confirms COOP/COEP headers from serve.py are active, enabling threaded WASM)`
    );
    await initWebcam();
    const landmarker = await initFaceLandmarker();

    log(`Running baseline (MediaPipe only) for ${durationMs / 1000}s…`);
    const baselineRaw = await runMediaPipeLoop(landmarker, durationMs);
    const baseline = stats(baselineRaw.intervalSamples);
    log(
      `Baseline done: avg ${baseline.avg.toFixed(1)}ms (${baseline.fps.toFixed(
        1
      )}fps).`
    );

    const { loadMs } = await initKokoro(dtype);

    log(`Running concurrent phase (MediaPipe + Kokoro TTS in worker) for ${durationMs / 1000}s…`);
    const [concurrentRaw, ttsLatencies] = await Promise.all([
      runMediaPipeLoop(landmarker, durationMs),
      runTTSLoad(durationMs),
    ]);
    const concurrent = stats(concurrentRaw.intervalSamples);
    log(
      `Concurrent done: avg ${concurrent.avg.toFixed(
        1
      )}ms (${concurrent.fps.toFixed(1)}fps). TTS calls completed: ${
        ttsLatencies.length
      }.`
    );

    renderResults(baseline, concurrent, loadMs, ttsLatencies, dtype);
    log("Benchmark complete.");
  } catch (err) {
    log(`ERROR: ${err.message}`);
    console.error(err);
  } finally {
    startBtn.disabled = false;
  }
});

exportBtn.addEventListener("click", async () => {
  if (!lastResults) return;
  const json = JSON.stringify(lastResults, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    log("Results copied to clipboard as JSON.");
  } catch {
    log("Clipboard write failed — here's the JSON to copy manually:");
    log(json);
  }
});
