// kokoro-worker.js
//
// Phase 13.5 benchmark round 2. Runs Kokoro entirely off the main thread.
// This is not optional: Entry 35 confirmed running Kokoro inline froze the
// tab solid. The worker owns a single model instance, loaded once via
// {type:'load'}, then answers {type:'synthesize'} requests one at a time.
//
// Pinned to kokoro-js@1.2.1 (current npm latest as of this session — same
// pinned-CDN-version convention as pdfjs-dist@5.6.205 in the main app).
import { KokoroTTS, TextSplitterStream } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

let tts = null;

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === "load") {
    const { device, dtype } = msg;

    if (device === "webgpu" && !self.navigator?.gpu) {
      self.postMessage({
        type: "error",
        phase: "load",
        message: "navigator.gpu is undefined in this worker context — WebGPU isn't available here (unsupported browser/OS, or blocked in a worker specifically). Try device=wasm to confirm the worker/model path itself is fine.",
      });
      return;
    }

    const t0 = performance.now();
    try {
      tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype, device });
      const loadMs = performance.now() - t0;
      self.postMessage({ type: "loaded", loadMs, device, dtype });
    } catch (err) {
      self.postMessage({
        type: "error",
        phase: "load",
        message: (err && err.message) || String(err),
      });
    }
    return;
  }

  if (msg.type === "synthesize") {
    const { id, text, voice } = msg;
    if (!tts) {
      self.postMessage({
        type: "error",
        phase: "synthesize",
        id,
        message: "Model not loaded yet — click Load model first.",
      });
      return;
    }
    const t0 = performance.now();
    try {
      const audio = await tts.generate(text, { voice: voice || "af_sky" });
      const synthMs = performance.now() - t0;

      // NOTE (flagged for live debugging): kokoro-js's RawAudio return shape
      // is expected to be { audio: Float32Array, sampling_rate: Number } per
      // its published examples (audio.save("audio.wav")), but this wasn't
      // runnable in the sandbox this was written in — no network access
      // there. If this throws or samples come back undefined, console.log
      // the `audio` object first to confirm the real property names, then
      // adjust the two lines below accordingly.
      const samples = audio.audio;
      const sampleRate = audio.sampling_rate;

      // Transfer the underlying buffer instead of copying it across the
      // postMessage boundary — cheap and avoids doubling memory per chunk.
      self.postMessage(
        { type: "result", id, synthMs, sampleRate, samples },
        [samples.buffer]
      );
    } catch (err) {
      self.postMessage({
        type: "error",
        phase: "synthesize",
        id,
        message: (err && err.message) || String(err),
      });
    }
    return;
  }

  if (msg.type === "synthesizeStream") {
    // Tests Kokoro's streaming API (tts.stream()) instead of generate().
    // Pushes the whole text in at once (not word-by-word like the README
    // example — we're not simulating an LLM, we already have the full
    // sentence) then reports how long each yielded chunk took to arrive,
    // so we can compare time-to-FIRST-chunk against generate()'s
    // time-to-only-chunk. If TextSplitterStream only yields one chunk for
    // this input, that's a valid result too — it means streaming doesn't
    // add anything at this granularity, not that something broke.
    const { id, text, voice } = msg;
    if (!tts) {
      self.postMessage({
        type: "error",
        phase: "synthesizeStream",
        id,
        message: "Model not loaded yet — click Load model first.",
      });
      return;
    }
    const t0 = performance.now();
    try {
      const splitter = new TextSplitterStream();
      const stream = tts.stream(splitter, { voice: voice || "af_sky" });
      splitter.push(text);
      splitter.close();

      let chunkIndex = 0;
      for await (const chunk of stream) {
        const arrivedMs = performance.now() - t0;
        const samples = chunk.audio.audio;
        const sampleRate = chunk.audio.sampling_rate;
        self.postMessage(
          {
            type: "streamChunk",
            id,
            chunkIndex,
            chunkText: chunk.text,
            arrivedMs,
            sampleRate,
            samples,
          },
          [samples.buffer]
        );
        chunkIndex++;
      }
      const totalMs = performance.now() - t0;
      self.postMessage({ type: "streamDone", id, totalMs, chunkCount: chunkIndex });
    } catch (err) {
      self.postMessage({
        type: "error",
        phase: "synthesizeStream",
        id,
        message: (err && err.message) || String(err),
      });
    }
    return;
  }
};
