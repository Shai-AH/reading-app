# PROGRESS LOG — "Mumblew" (reading app)
Last updated: July 30, 2026 (Entry 44)

> HOW TO USE: Single source of truth. Claude reads this first in every new chat.
> Update before ending each session. If Claude contradicts this file, trust this file.
> Section 6 stays terse — grouped summary lines for older work, one line per recent
> entry. Real decisions/reasoning live in Section 3.
> **This pass (Entry 44):** Phase 12b (voice quality) is now RESOLVED — CLOSED, not
> a "top priority" anymore. Stage A (local-only voice picker) shipped; Stage B
> (Kokoro local TTS) benchmarked on two real devices and ruled out (fragile
> breakeven on good hardware, a multi-minute browser freeze on old hardware);
> installing OS-native "Natural" voices was also investigated and ruled out (not
> exposed to the browser without fragile third-party hacks, and reintroduces an
> install barrier against the app's no-buttons design goal). A real,
> previously-invisible bug was found and fixed along the way: iframe recycling
> (from the Phase 9a fix) could orphan an in-progress utterance, audible as two
> overlapping voices — fixed by tracking the actual speaking synth instance
> instead of trusting whatever's live at cancel() time. All of Phase 12b's
> investigation detail (diagnostic tables, two-device benchmark numbers, voice-
> installation research) is collapsed to settled conclusions here, same as 9a's
> trim in Entry 43. The app was also deployed to Vercel this session (student-
> initiated, for mobile testing) — first deploy since Phase 10a. Roadmap
> reordered per student request: Speed Calibration discussion and Mobile issues
> and Quality-of-life phases added, slotted after Distance/Head-Pose calibration
> work, before PWA/security/shipping. Keep future additions lean — conclusions
> and current values, not attempt logs, once something closes or settles.

---

## 1. The Idea (Owner: student)

**Name: Mumblew.** Privacy-first app: reads/listens to text using quiet mouth
movement (subvocalization) as the pacing signal, narrating via TTS driven by
webcam lip-tracking instead of buttons/timers.

Audiences: reading in the dark/bed without light/sound (**lying down is a real,
expected use case, not an edge case**); neurodivergent/low-focus readers needing
active engagement; people who can move their mouth but can't vocalize (ALS,
severe stutter, vocal cord paralysis) — assistive/humanitarian use case. This
last point is why the app avoids relying on buttons/taps as a control mechanism
wherever possible (see Entry 43, head-pose gating decision; Entry 44, why a
voice-quality install path was rejected).

Three-state design: **State 1** (core, done) mouth movement = play/pace signal,
text is known ground truth. **State 3** (done) click-to-word manual resync.
**State 2** (done) cadence-based pacing informs pacing/close sensitivity.

Privacy goal: on-device/local-first (MediaPipe), video never leaves device.

**ALS/paralysis audience (research-backed, Entry 17):** viable for early/moderate
bulbar ALS and vocal-cord paralysis with preserved oral-motor control. NOT viable
for late-stage bulbar ALS — biological ceiling, not a design gap.

## 2. Person's context

- 2nd semester CS student. Comfortable with logic, rusty on Python/HTML/CSS/JS.
- **Budget: $0**, no exceptions until final native app-store step (if ever).
- **Timeline:** flexible, rough target Dec 2026.
- Claude = architecture lead ("captain"); student executes ("navigator").
- **Working style:** wait for explicit "start"/"next". Ask before updating the log;
  proactively suggest updating if a chat runs long.
- **Deploy reminder:** Claude proactively asks about deploy status at the end of any
  phase touching `main.js`/`index.html`.
- **Testing requests:** clear numbered step-by-step instructions (what to click,
  what to watch, what to note down) — never a vague "try it and see." Student wants
  MORE tests, not fewer; err toward thorough over quick.
- **Bug-confirmation policy:** before asking the student to test a suspected
  bug/fix in the real app, first build a standalone, isolated test page that tries
  to confirm or rule out the specific mechanism. Only fall back to testing inside
  the real app if the isolated version can't reproduce the thing being tested (or
  the mechanism genuinely requires live mouth-tracking to test — gating/cadence
  tuning falls in this category and gets diagnostic-instrumented live testing
  instead).
  **Corollary (Entry 41):** an isolated harness is itself code and can have its
  own bugs — verify the harness's own logic/timeouts are sound before trusting a
  "reproduced" or "clean" result from it.
- **Cross-device discipline:** target platforms are laptop, mobile (portrait +
  landscape), tablets/iPads. Any fix aimed at one platform must be checked for
  regressions on the others before being considered done.

## 3. Key decisions

- Web app, Chrome-first. Stack: MediaPipe Face Landmarker (in-browser), Web Speech
  API TTS, Vercel hosting. No build tools — plain HTML/JS + `<script type="module">`,
  MediaPipe via jsdelivr CDN. Landmarks used: 13/14 (lips), 61/291 (mouth corners).

- **Speech architecture — RESOLVED, deployed (Entry 40-44).** `speak()`/
  `cancel()` only, never `pause()`/`resume()` (permanent Edge/Windows TTS freeze,
  confirmed, don't re-investigate unless Edge is ever in scope). One utterance runs
  while the mouth stays open; `cancel()` on close, resuming from the last completed
  word (`onboundary` char offset). Settled facts from the 9a investigation
  (Entries 22-24, 33, 39, 40 — narrative collapsed, only conclusions kept):
  - Sentence-chunked utterances are a real Web Speech API ceiling on this
    browser — reverted, not revisited without a fundamentally different mechanism.
  - `onend` never fires after a manual `cancel()` on this browser — **fixed**:
    `main.js` polls `speechSynthesis.speaking` (20ms tick) instead. `onend`
    stays wired as a harmless fallback and fires correctly on natural completion.
  - The mid-word overshoot bug was cadence-gating logic, not a browser bug.
    **Fixed** by Fix 3c/3c-2: tight gating only within `RISK_WINDOW_HALF_MS=120`
    ms of an estimated lip-closing-consonant (`b`/`m`/`p`) moment; loose
    everywhere else. See `estimateRiskyConsonantTimings()` / `isWithinRiskyWindow()`
    in `main.js`. Live-tested clean (15/15 runs, Entry 41).
  - **Tab/window visibility safety gap (Entry 42) — fixed.** `predictLoop()`
    (and every mouth/face safety check) depends on `requestAnimationFrame`,
    which browsers suspend when backgrounded; `speechSynthesis` has no such
    throttling. Fixed via a `document.visibilitychange` listener: on hidden,
    stops speech and forces `mouthState = 'closed'`; on visible again, does
    NOT auto-resume — waits for a fresh real mouth-open detection.
  - **Iframe-recycling orphaned-utterance bug (Entry 44) — found and fixed.**
    Every `cancel()` call site *outside* `speakFrom()` (mouth-close, the
    looking-away/no-face gate trip, word-click resync, calibration start,
    startBtn reset) used to call `ttsEngine.synth.cancel()` on whatever
    `ttsEngine.synth` happened to be live — wrong the moment a recycle has
    happened since the current utterance started, since the utterance
    actually playing is on the *old*, now-orphaned iframe. Invisible with the
    default voice (both utterances sound identical); became audible as two
    overlapping voices once distinct custom voices were in play (see Phase
    12b below — this is how it was found). **Fixed:** a module-level
    `activeSpeechSynth`, set once per `speakFrom()` call, that every external
    cancel site now uses via `cancelActiveSpeech()` instead of the live
    (possibly-stale) reference. `startBtn`'s hard-reset path keeps a
    belt-and-suspenders raw `ttsEngine.synth.cancel()` in addition, since
    that path is explicitly meant to distrust all app state.
  - **Current status: deployed to Vercel (Entry 44),** student-initiated for
    mobile testing. First deploy since Phase 10a — includes all of Phase 9a,
    Phase 12b Stage A, and the orphaned-utterance fix above.
  - Diagnostics still live and harmless: duplicate-boundary counter,
    early-close counter, session-wide `speak()` counter, iframe-recycle count
    (`IFRAME_TTS_RECYCLE_ENABLED=true`, every 6 calls), the Fix-3c/3c-2
    risky-window row, the Phase 12b voice-selection row.

- **Voice quality (Phase 12b) — CLOSED, Entry 44.**
  - **Stage A shipped:** a voice picker (`voiceSelect`) built from
    `speechSynthesis.getVoices()`, **restricted to local/on-device voices
    only** (`isVoiceAllowed()` filters on `voice.localService === true`). An
    isolated diagnostic harness testing all 22 voices on the dev machine
    found Google's network voices silently drop `onboundary` events (0/17
    words on most) — this breaks both word-highlight tracking (resume point
    never advances) and the Fix 3c/3c-2 cadence-gating safety logic. Too
    unreliable to expose regardless of any individual test run's result,
    since cloud-synthesis timing is non-deterministic. Local Microsoft
    voices (David/Mark/Zira on the dev machine) passed cancel-reliability
    and boundary-accuracy cleanly, but do **not** honor `rate` linearly
    (~1.3-1.4x actual speedup for a requested 2x) — each voice also has a
    different intrinsic baseline WPM, so a calibration tuned against one
    voice doesn't transfer cleanly to another (see the new Speed Calibration
    discussion phase in the roadmap). Selection persists via `readingAppVoice`
    in localStorage (stores `voiceURI`, not the object), re-resolved fresh
    from `window.speechSynthesis` at every `speakFrom()` call.
  - **Stage B (Phase 13.5, local Kokoro TTS) — tested, ruled out.** A capable
    laptop's benchmark (Entries 35-38) found synthesis converges to ~0ms
    perceived wait only above a **~555ms/word breakeven pace — single-laptop
    number, WebGPU/fp32** — the dev's own calibration (650ms/word) cleared
    it, uncalibrated defaults (426ms/word) didn't; already fragile. A second,
    weaker device (i5-2410M, 4GB RAM, no WebGPU) **hard-froze the browser tab
    for several minutes** running WASM synthesis on 3 short test sentences —
    a genuine failure, not just slow, which breaks the "never worse than
    today" safety bar this was supposed to meet. Making that safe would need
    real extra engineering (Web Worker isolation, a hardware pre-check) for a
    payoff still capped by the breakeven math even in the best case — not
    worth building.
  - **Also ruled out: installing higher-quality OS-native voices** (e.g.
    Windows 11 Narrator "Natural" voices, or a hypothetical Kokoro-as-SAPI-
    driver). These aren't exposed to `speechSynthesis.getVoices()` without
    third-party adapters that rely on undocumented internals and can break on
    any OS update — and any such path reintroduces a mandatory install step
    for every reader, directly against the no-buttons/no-barriers design goal
    for the ALS/paralysis audience (Section 1).
  - **Decision: the local voice picker is the practical ceiling for a $0
    browser-only stack. Not revisiting unless the browser/hardware landscape
    changes materially in the future.**

- **Cadence-based pacing:** `estimateWordDuration(word) = BASE_WORD_MS +
  syllables * MS_PER_SYLLABLE` (defaults 120/220), personalized per-user via the
  speed-calibration wizard step. Dynamically scales the mouth-close-detection
  threshold — see Fix 3c/3c-2 above. Digit/accent handling in
  `estimateSyllables()` shipped and closed (Phase 12a).
  **Open question (Entry 44), see new Speed Calibration roadmap phase:**
  Phase 12b's diagnostic found TTS `rate` scaling isn't linear/consistent
  across voices, and each voice has a different baseline WPM — meaning the
  current single-voice calibration may need revisiting once Distance/Head-
  Pose work is done.
- **Movement-range smoothing:** `WINDOW_MS=300`. Working correctly, not
  implicated in any open bug.
- **Calibration mode:** 4-step wizard (neutral → mutter → facing → turned away)
  + speed step, saved to `localStorage` (`readingAppCalibration`), per-device/
  per-browser. **Pending update once head-pose removal is built** — the
  facing/turned-away steps will be dropped.
- **Emotional tone toggle (Phase 8a):** punctuation-based heuristic (`!`/`?`/
  default), off by default, decided once per resume (per-sentence chaining
  tried twice, rejected — same freeze-class bug as the old 9a ceiling).
- **Explicitly rejected, not deferred:** mic-based audible-speech safeguard
  (dead weight for the ALS/paralysis audience); ROI cropping; per-sentence tone
  chaining; sentence-chunked TTS utterances; Kokoro/local-TTS (Phase 12b,
  Entry 44); installing OS-native voices (Phase 12b, Entry 44).
- **Phase 7c:** dynamic frame rate, `IDLE_FRAME_INTERVAL_MS=100`.
- **Text input / UI redesign / PDF upload (Phases 10a/10c/10d) — all shipped,
  closed, no open flags.** `currentText` (mutable), paste/type + `.txt`/`.pdf`
  upload via lazy-loaded `pdfjs-dist`, saved text persists via IndexedDB
  (`mumblewDB`/`savedText`), calibration data stays on localStorage. Full
  dark-themed redesign shipped (logo, webcam/mesh hidden during reading,
  collapsible debug panel).

### 3b. Scope decisions

- Platform: Web app, Chrome-first. Cross-browser support not a priority pre-demo.
- Security: `textContent` never `innerHTML` (XSS guard), pinned CDN versions, CSP
  header, camera-privacy disclosure, HTTPS via Vercel. Full review at Phase 14.

## 3d. Priority order for remaining work (reset Entry 44 — Phase 12b's closure
frees this up; new phases added per student request, Entry 44)

1. **Head-pose gating removal** — decided (Entry 43), not yet built. Drops the
   facing/turned-away calibration steps, resolves 9c by making it moot.
2. **Phase 13** (distance/recalibration robustness) — easier to isolate once
   #1 removes the pose-gating confound.
3. **Speed calibration discussion** (new, Entry 44) — student wants to revisit
   calibration once #1/#2 land, motivated partly by Phase 12b's finding that
   TTS rate-scaling isn't linear/consistent across voices. Not yet scoped —
   discussion, not a build, to start.
4. **Mobile issues** (new, Entry 44) — long-paused since Entries 22-24;
   resurfaced during this session's mobile Vercel deploy ("numerous issues",
   unspecified by student yet). Needs its own dedicated session.
5. **Quality-of-life changes** (new, Entry 44) — not yet scoped.
6. **PWA packaging** (Entry 43) — manifest + service worker + icons, mostly
   free. iOS Safari camera-in-installed-PWA access is historically unreliable
   — plan to keep the camera-dependent reading flow tested and working in
   regular Safari-tab mode as the iPad fallback.
7. **Phase 14** (security review), **Phase 15** (shipping prep + paywall,
   with the standing ethical note: ALS/paralysis audience means a default
   paywall deserves a deliberate decision, not a default) — last, unchanged.

## 4. Roadmap

- [x] **Phases 0-8a:** webcam/facemesh, MAR play/pause, word highlighting +
      head-pose gating, click-to-word resync, Vercel deploy, movement-range
      smoothing, cadence-based pacing, calibration wizard, dynamic frame rate,
      emotional tone toggle. All deployed.
- [ ] **Phase 8b:** Voice cloning — needs a scope conversation, not started.
- [ ] **Phase 8c:** Offline mode — not started, feasible free; PWA work
      would give this a head start.
- [x] **Phase 9a:** Mobile/session speech-engine reliability — **RESOLVED and
      DEPLOYED (Entry 40-44).** Real causes: `onend` broken after `cancel()`,
      cadence-gating flaw, tab-backgrounding safety gap, iframe-recycling
      orphaned-utterance bug (Entry 44). See Section 3.
- [x] **Phase 9b:** No-face-detected safety gap — fixed, tested, closed.
- [x] **Phase 9c:** Off-axis/lying-down pose calibration — superseded, moot
      once head-pose gating removal ships.
- [x] **Phase 10:** UI redesign + text input — fully shipped, closed.
- [x] **Phase 11 / 11b:** Speed calibration + ambient trouble-shading —
      shipped, closed (but see "Speed calibration discussion", new phase above).
- [x] **Phase 12b:** Voice quality — **CLOSED (Entry 44).** Local-only voice
      picker shipped as the practical ceiling; Kokoro (13.5) and OS-native
      voice installation both investigated and ruled out. See Section 3.
- [x] **Phase 12a / 12c / 12d:** Duration estimation, auto-scroll, sticky-word
      diagnosis — all shipped/closed.
- [x] **Phase 13.5:** Local on-device TTS — **CLOSED/ruled out (Entry 44).**
      See Phase 12b in Section 3 for the two-device benchmark reasoning.
- [x] **Phase 13.6:** Continuous speed control — **moot, closed alongside
      13.5** (rode entirely on it, no independent path).
- [ ] **Phase 13:** Distance/recalibration robustness — not started, clearer
      once head-pose removal ships.
- [ ] **Head-pose gating removal** — decided, not yet built. See Section 3.
- [ ] **Speed calibration discussion** (new, Entry 44) — not yet scoped.
- [ ] **Mobile issues** (new, Entry 44) — long-paused, resurfaced Entry 44,
      not yet scoped.
- [ ] **Quality-of-life changes** (new, Entry 44) — not yet scoped.
- [ ] **PWA packaging** — decided as a direction, not yet built. iOS caveat,
      see Section 3d.
- [ ] **Phase 14:** Full security review pass — not yet started.
- [ ] **Phase 15:** Shipping prep + paywall — last. Ethical flag stands: ALS/
      paralysis audience means a default paywall needs a deliberate decision.

## 5. Current status

Project folder `reading-app`: `index.html` + `main.js`. **Deployed to Vercel
this session (Entry 44)** — student-initiated, for mobile testing. This is the
first deploy since Phase 10a, and includes everything through Phase 9a's full
resolution, Phase 12b Stage A (local voice picker), and the orphaned-utterance
fix. Student reports the mobile experience felt more natural than desktop
despite "numerous mobile issues" surfacing — unspecified so far, queued as the
new Mobile Issues phase.

**Phases 0-8a, 9a, 9b, 10, 11/11b, 12a/12b/12c/12d all shipped and deployed.**
Phase 13.5/13.6 closed without shipping (ruled out, not abandoned-for-later).

**This session (Entry 44):** Built and shipped the Phase 12b voice picker
(local-only, after an isolated diagnostic harness across 22 voices found
network voices silently break `onboundary` tracking). Found and fixed a real
bug along the way: iframe-recycling could orphan an in-progress utterance,
audible as overlapping voices — fixed via a tracked `activeSpeechSynth`.
Built and ran a two-device Kokoro benchmark harness; ruled Kokoro out (fragile
breakeven on a capable laptop, multi-minute browser freeze on an old one).
Investigated and ruled out installing OS-native "Natural" voices as an
alternative path. Closed Phase 12b entirely. Student deployed to Vercel and
tested on mobile. Roadmap reordered per student request: head-pose removal →
Phase 13 → new Speed Calibration discussion → new Mobile Issues phase → new
Quality-of-life phase → PWA → security → shipping.

Diagnostics still live in the debug panel (harmless, kept): boundary/
duplicate-boundary/early-close/session-speak counters, iframe-recycle count,
the Fix-3c/3c-2 risky-window row, the Phase 12b voice-selection row.

## 6. Log of sessions

- **Entries 1-14 (Jul 6-11):** Built and deployed Phases 0-7. Fixed the Edge
  `speechSynthesis` freeze bug. Scoped Phases 9-14.
- **Entries 15-21 (Jul 11-19):** Built Phase 8a (tone toggle). Built and
  shipped Phase 11 (speed calibration) and 11b (ambient trouble-shading).
- **Entries 22-24 (Jul 19-24):** Mobile testing session — diagnosed and split
  Phase 9 into 9a/9b/9c. Fixed Phase 9b. Attempted and reverted Phase 9a's
  first fix (sentence chunking) after it caused a worse laptop freeze —
  confirmed a real Web Speech API ceiling. Mobile-specific work paused after
  this (resurfaced Entry 44).
- **Entries 25-29 (Jul 24-25):** Scoped and shipped Phase 10 (text input,
  visual redesign, PDF upload + IndexedDB migration).
- **Entries 30-34 (Jul 25-26):** Scoped Phase 12c/12d and Phase 13.5 in depth.
  Shipped 12a (duration estimation) and 12c (auto-scroll).
- **Entries 35-38 (Jul 26-28):** Phase 13.5 benchmark arc — timing-data
  feasibility, WASM/WebGPU tradeoffs, dual-worker parallelism (ruled out).
  Diagnosed 12d (one real clock bug fixed; remaining stalls folded into 9a).
- **Entry 39 (Jul 28):** Revived Phase 9a via an iframe-recycle candidate fix
  (tested live — 20 sessions, no freeze). A new laptop overshoot regression
  surfaced, investigated in Entry 40.
- **Entry 40 (Jul 29):** Root-caused Entry 39's regression: `onend` broken
  after `cancel()` (fixed via `speaking`-poll) and a cadence-gating flaw
  (fixed via Fix 3c/3c-2).
- **Entry 41 (Jul 29):** Isolated long-utterance test found no evidence for a
  suspected premature-`finishReading()` bug — decided to stop chasing it. 15
  live back-to-back test runs of a previously-sticky paragraph came back
  clean with Fix 3c/3c-2. Recommended shipping.
- **Entry 42 (Jul 29):** Found and fixed the tab-backgrounding safety gap —
  speech kept playing after switching to a different application entirely.
  Fixed via `document.visibilitychange`. Confirmed working live.
- **Entry 43 (Jul 29):** Scoping discussion only, no code changed. Agreed
  direction on five fronts: voice quality (two-stage plan), continuous speed
  control, head-pose gating removal (decided), distance calibration
  (separate concern), PWA packaging (feasible, iOS caveat). File trimmed
  substantially this session.
- **Entry 44 (Jul 30):** Built and shipped Phase 12b Stage A (local-only
  voice picker), after an isolated diagnostic harness across 22 voices found
  network voices silently break `onboundary` tracking. Found and fixed a real
  bug: iframe-recycling could orphan an in-progress utterance (heard as
  overlapping voices) — fixed via a tracked `activeSpeechSynth` used by every
  `cancel()` call site. Built and ran a two-device Kokoro benchmark harness;
  ruled Kokoro out (fragile breakeven on a capable laptop, multi-minute
  browser freeze on an old i5-2410M/4GB laptop). Investigated and ruled out
  installing OS-native "Natural" voices as an alternative. Closed Phase 12b
  entirely — local voice picker is the practical ceiling. Student deployed to
  Vercel (first deploy since Phase 10a) and tested on mobile — felt more
  natural than desktop despite unspecified mobile issues, queued as a new
  roadmap phase. Roadmap reordered per student request: head-pose removal →
  Phase 13 → new Speed Calibration discussion phase → new Mobile Issues phase
  → new Quality-of-life phase → PWA → security → shipping. This file trimmed:
  Phase 12b's full investigation narrative (diagnostic tables, benchmark
  numbers, voice-installation research) collapsed to settled conclusions;
  Section 3c (old detailed Kokoro benchmark writeup) removed entirely, folded
  into the Phase 12b closure summary.
