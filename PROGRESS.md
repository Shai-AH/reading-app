# PROGRESS LOG — "Mumblew" (reading app)
Last updated: July 29, 2026 (Entry 43)

> HOW TO USE: Single source of truth. Claude reads this first in every new chat.
> Update before ending each session. If Claude contradicts this file, trust this file.
> Section 6 stays terse — grouped summary lines for older work, one line per recent
> entry. Real decisions/reasoning live in Section 3.
> **This pass (Entry 43):** Phase 9a is now resolved/shipped (speaking-poll fix +
> Fix 3c/3c-2 gating + tab-visibility fix, deploy recommended) — its entire
> multi-entry investigation narrative (Entries 22-24, 33, 39, 40) is collapsed to
> settled conclusions in Section 3/3c and the roadmap; none of the blow-by-blow
> (iframe freeze-test attempts, sentence-chunking reverts, EMA-tremor tuning,
> broken test-harness iterations) is preserved beyond what's needed to explain
> current code. Also trimmed: Phase 10a/10c/10d and 11/11b/12a/12c/12d detail,
> long-closed and unlikely to need revisiting, down to shipped-facts only. Kept in
> full: anything still open (head-pose removal decision, voice-quality plan,
> Phase 13/13.5/13.6/14/15, PWA). Keep future additions lean — conclusions and
> current values, not attempt logs, once something closes or settles.

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
wherever possible (see Entry 43, head-pose gating decision).

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
  the real app if the isolated version can't reproduce the thing being tested (or,
  per Entry 43, the mechanism genuinely requires live mouth-tracking to test —
  gating/cadence tuning falls in this category and gets diagnostic-instrumented
  live testing instead, same as Entry 23's original approach).
  **Corollary (Entry 41, learned the hard way):** an isolated harness is itself
  code and can have its own bugs (a bad pre-trial nudge, too-short timeouts) that
  produce misleading "stuck" results — verify the harness's own logic/timeouts
  are sound (e.g. does a long utterance actually get enough time to finish at
  natural speech rate?) before trusting a "reproduced" or "clean" result from it.
- **Cross-device discipline:** target platforms are laptop, mobile (portrait +
  landscape), tablets/iPads. Any fix aimed at one platform must be checked for
  regressions on the others before being considered done.

## 3. Key decisions

- Web app, Chrome-first. Stack: MediaPipe Face Landmarker (in-browser), Web Speech
  API TTS, Vercel hosting. No build tools — plain HTML/JS + `<script type="module">`,
  MediaPipe via jsdelivr CDN. Landmarks used: 13/14 (lips), 61/291 (mouth corners).

- **Speech architecture — RESOLVED, ready to deploy (Entry 40-42).** `speak()`/
  `cancel()` only, never `pause()`/`resume()` (permanent Edge/Windows TTS freeze,
  confirmed, don't re-investigate unless Edge is ever in scope). One utterance runs
  while the mouth stays open; `cancel()` on close, resuming from the last completed
  word (`onboundary` char offset). Settled facts from the full 9a investigation
  (Entries 22-24, 33, 39, 40 — narrative collapsed, only conclusions kept):
  - Sentence-chunked utterances are a real Web Speech API ceiling on this
    browser (raises `speak()`-call frequency past Chromium's tolerance,
    session-cumulative, not mobile-exclusive) — reverted, not revisited without
    a fundamentally different mechanism.
  - `onend` never fires after a manual `cancel()` on this browser (confirmed via
    isolated testing) — **fixed**: `main.js` now polls `speechSynthesis.speaking`
    (20ms tick) instead, which also fixed a dormant bug where natural text
    completion never called `finishReading()` (that path only ever ran through
    the dead `onend` event). `onend` stays wired as a harmless fallback and does
    fire correctly on natural completion (confirmed, Entry 41) — it's
    specifically post-`cancel()` firing that's broken.
  - The mid-word overshoot bug was cadence-gating logic (a flat average-duration
    switch that stalled most real words), not a browser bug. **Fixed** by Fix
    3c/3c-2: tight gating only within `RISK_WINDOW_HALF_MS=120` ms of an
    estimated lip-closing-consonant (`b`/`m`/`p`, any position including word-
    initial) moment; loose everywhere else. See `estimateRiskyConsonantTimings()`
    / `isWithinRiskyWindow()` / `currentWordRiskyTimings` in `main.js`.
  - **Entry 41 — isolated re-test of the "premature finishReading" theory
    (suspected spurious single-tick `false` blip in the `speaking` poll) found
    no evidence** across a genuinely long (186-word), natural, uninterrupted
    utterance (3 clean completed trials, 0 blips, `onend` fired correctly each
    time). Combined with the student's own live report (caught once, ever, and
    possibly a calibration artifact), this is being treated as a rare glitch,
    not a structural bug — **decision: stop chasing it, ship as-is, revisit only
    if it recurs with real data attached.**
  - **Entry 41 — live re-test of Fix 3c/3c-2 (15 back-to-back runs of a
    paragraph that previously triggered sticky words) found zero sticky words.**
    A new debug-panel row + console log (`[Fix 3c/3c-2 diag]`, shows whether a
    detected close was inside/outside the risky window and its ms delta from
    the nearest estimated risky moment) was added for future monitoring — no
    behavior change, kept live. **Decision: consider this closed-enough to
    ship; if it recurs in normal use, the new diagnostic gives exact tuning
    data without needing another dedicated test session.**
  - **Entry 42 — new bug found and fixed: tab/window visibility safety gap.**
    `predictLoop()` only runs via `requestAnimationFrame`, which browsers
    throttle or fully suspend once the tab/window is backgrounded (switching to
    a different application backgrounds Chrome harder than switching tabs).
    Since every mouth/face safety check (head-pose gating, the no-face timeout,
    ordinary mouth-close detection) depends on `predictLoop` running,
    backgrounding the tab silently stopped all of them while `speechSynthesis`
    — which has no such throttling — kept talking. **Fixed** via a
    `document.visibilitychange` listener (works independent of `predictLoop`):
    on hidden, stops speech immediately and forces `mouthState = 'closed'` so a
    stale "still open" reading can't cause a blind resume; on visible again,
    deliberately does NOT auto-resume — waits for a fresh real mouth-open
    detection, same recovery pattern already used for looking-away recovery.
    Live-tested and confirmed working by student.
  - **Current status: main.js/index.html have NOT yet been deployed to Vercel.**
    All three fixes above (speaking-poll, Fix 3c/3c-2, tab-visibility) are live
    in the local files and tested; deploy is the next action, pending student.
  - Diagnostics still live and harmless, kept for monitoring: duplicate-boundary
    counter, early-close counter, session-wide `speak()` counter, iframe-recycle
    count (`IFRAME_TTS_RECYCLE_ENABLED=true`, recycles every 6 calls — the
    freeze this targeted is now understood to have been the `onend`/gating bugs
    above, not something the iframe swap itself fixed or broke; left enabled
    since it's neutral-to-positive and removing it isn't worth the churn right
    now), the new Fix-3c/3c-2 risky-window row.

- **Local TTS parallelism — ruled out (Entry 38).** Dual-worker Kokoro synthesis
  costs ~2x per worker under concurrent load (GPU contention on this hardware,
  confirmed after fixing a buffer-depth test-harness bug) — no net throughput
  gain from splitting work across two workers.

- **No-face-detected safety gap (Phase 9b) — fixed, tested, closed.**
  `predictLoop()` tracks a gap timer (`NO_FACE_TIMEOUT_MS=500`); past the
  timeout during an active session it trips the facing gate the same way a
  yaw/pitch trip does. Passed a full extreme-case test pass. Note: this only
  covers "camera sees no face while the tab is visible and predictLoop is
  running" — see Entry 42 above for the separate tab-backgrounding gap this
  didn't cover.

- **Head-pose gating — REMOVAL DECIDED (Entry 43), not yet built.** Current
  implementation: yaw/pitch from MediaPipe's `facialTransformationMatrix`
  (`DEFAULT_YAW_THRESHOLD=26°`, `DEFAULT_PITCH_THRESHOLD=21°`, EMA-smoothed,
  `POSE_SMOOTHING_ALPHA=0.2`, overridable per-device via the calibration
  wizard), gates the mouth signal and stops/resumes speech on facing-state
  change. **Reasoning for removal:** yaw/pitch is camera-relative with no way
  to distinguish "genuinely looking away" from "camera's at an odd angle
  because I'm lying down" — and lying down is an explicitly core use case
  (Section 1), not an edge case. Phase 9c (off-axis/lying-down calibration
  breaking down) was never root-caused across two sessions of attempts, and
  the student's own broader live experience is that it's oversensitive to
  ordinary position changes generally, not just lying down — this reads as a
  sensing-model limitation, not a tuning gap. Rather than adding a manual
  pause button as a replacement (student's alternate proposal), the plan is to
  simply rely on the already-core, already-buttonless mouth-movement signal
  (State 1) as the sole pacing control — closing your mouth already pauses
  reading; a tap-to-pause button would reintroduce exactly the kind of barrier
  the mouth-signal design exists to avoid for the ALS/paralysis audience.
  **Scope once built:** remove yaw/pitch thresholds, EMA smoothing, the
  facing/turned-away calibration wizard steps; keep neutral+mutter(+speed)
  steps. This makes 9c moot (nothing left to root-cause).
  **Relationship to Phase 13 (distance calibration, Entry 43):** separate
  concern (MAR/mouth-geometry drift vs. head-angle) — removing pose gating
  doesn't fix Phase 13, but it does remove a confound (a future "stuck" moment
  can no longer be caused by bad pose thresholds), making Phase 13 easier to
  isolate and diagnose whenever it's picked up.

- **Cadence-based pacing:** `estimateWordDuration(word) = BASE_WORD_MS +
  syllables * MS_PER_SYLLABLE` (defaults 120/220), personalized per-user via the
  speed-calibration wizard step. Dynamically scales the mouth-close-detection
  threshold — see Fix 3c/3c-2 above for the current (resolved) version of this.
  Digit/accent handling in `estimateSyllables()` shipped and closed (Phase 12a).
- **Movement-range smoothing:** `WINDOW_MS=300`. Working correctly, not
  implicated in any open bug.
- **Calibration mode:** 4-step wizard (neutral → mutter → facing → turned away)
  + speed step, saved to `localStorage` (`readingAppCalibration`), per-device/
  per-browser. **Pending update once head-pose removal is built** — the
  facing/turned-away steps will be dropped (see above).
- **Emotional tone toggle (Phase 8a):** punctuation-based heuristic (`!`/`?`/
  default), off by default, decided once per resume (per-sentence chaining
  tried twice, rejected — same freeze-class bug as the old 9a ceiling).
  **Robotic-voice problem (Phase 12b, Entry 43 — now the top priority, see
  Section 3d):** two-stage plan — Stage A: expose `speechSynthesis.getVoices()`
  as a picker (free, zero architectural risk, do first). Stage B (if Stage A
  isn't enough): commit to Phase 13.5 (local Kokoro TTS) — benchmarking is
  already done (see below), just needs a second-device breakeven-pace check
  and the pace-floor safeguard before committing.
- **Explicitly rejected, not deferred:** mic-based audible-speech safeguard
  (dead weight for the ALS/paralysis audience); ROI cropping; per-sentence tone
  chaining; sentence-chunked TTS utterances (confirmed platform ceiling, not a
  design choice).
- **Phase 7c:** dynamic frame rate, `IDLE_FRAME_INTERVAL_MS=100`.
- **Text input / UI redesign / PDF upload (Phases 10a/10c/10d) — all shipped,
  closed, no open flags.** `currentText` (mutable) replaced the old hardcoded
  test paragraph; paste/type + `.txt`/`.pdf` upload (via lazy-loaded
  `pdfjs-dist`) share one "Load Text" action; saved text persists via
  IndexedDB (`mumblewDB`/`savedText`; migrated from localStorage at the PDF-
  upload point since extracted text can be large); calibration data stays on
  localStorage. Full dark-themed redesign shipped (logo `mumblew_logo.png`,
  webcam/mesh hidden during actual reading — `.video-hidden` class, tracking
  keeps running underneath — shown only during calibration; collapsible debug
  panel; light `prefers-reduced-motion`-aware animation). Surfaced Phase 12a
  (numbers/accents in duration estimation, since shipped) and 12b (voice
  quality, see above) as follow-on work.

### 3b. Scope decisions

- Platform: Web app, Chrome-first. Cross-browser support not a priority pre-demo.
- Security: `textContent` never `innerHTML` (XSS guard), pinned CDN versions, CSP
  header, camera-privacy disclosure, HTTPS via Vercel. Full review at Phase 14.

### 3c. Phase 13.5 — Local on-device TTS engine (proposed, now likely — Entry 43)

Replaces `speechSynthesis` playback with a locally-cached WASM TTS model
(Kokoro, Apache 2.0 — Piper ruled out, license moved MIT→GPL-3.0 Oct 2025)
played via `<audio>`/Web Audio, giving continuous `playbackRate` control with
zero re-synthesis calls. Would resolve Phase 12b (voice quality) and enable
Phase 13.6 (continuous speed control) in one build. Web Speech stays as a
permanent fallback regardless of outcome.

**Settled findings (Entries 35-38, full narrative in harnesses `/benchmark`,
`/benchmark-round2`, `/benchmark-round3` if ever needed again):**
- No free word/phoneme timestamps from Kokoro in-browser — resolved by
  distributing each chunk's measured audio duration across its words via the
  existing syllable/cadence weighting.
- Concurrent MediaPipe+Kokoro frame-rate impact is moderate (WASM ~40%,
  WebGPU ~48% degradation on the dev laptop, an i7-8650U). WebGPU roughly
  halves synth time vs. WASM. fp32 is the only usable WebGPU dtype (fp16
  glitchy, q4 slower and degraded on this GPU backend).
- Deeper pre-buffering doesn't help (single-Kokoro-instance throughput
  ceiling). Dual-worker parallelism ruled out (Entry 38, see Section 3).
- **Core finding:** synth runs ~5.6-5.7s/sentence (WebGPU/fp32) regardless of
  buffering/parallelism. Wait converges to ~0ms only if the reader's
  calibrated pace clears a **~555ms/word breakeven — measured on one laptop
  only.** The dev's real calibration (650ms/word) clears it; uncalibrated
  defaults (426ms/word) don't.
- **Not committed. One direction open:** a pace floor/clamp on top of speed
  calibration — readers faster than breakeven get effective TTS pace clamped;
  slower readers keep true pace. **Needs a second, weaker-device benchmark
  before locking in a floor value** — the one number above is single-laptop
  only. This is the concrete next step if Stage A (voice picker) doesn't
  resolve Phase 12b on its own (see Section 3).

## 3d. Priority order for remaining work (reset Entry 43 — 9a's resolution
frees this up substantially; head-pose removal reprioritized in)

1. **Deploy current build** (speaking-poll fix, Fix 3c/3c-2, tab-visibility
   fix) — ready now, pending student action.
2. **Voice quality Stage A** — `getVoices()` picker. Cheap, do first, no
   architectural risk.
3. **Head-pose gating removal** — decided (Entry 43), not yet built. Drops the
   facing/turned-away calibration steps, resolves 9c by making it moot.
4. **Voice quality Stage B** — commit to Phase 13.5 (local TTS) if Stage A
   isn't enough. Needs a second-device benchmark first. Also unlocks Phase
   13.6 (continuous speed control) as a side effect.
5. **Phase 13** (distance/recalibration robustness) — easier to isolate once
   #3 removes the pose-gating confound.
6. **PWA packaging** (Entry 43) — manifest + service worker + icons, mostly
   free. iOS Safari camera-in-installed-PWA access is historically unreliable
   (permission not persisted in standalone mode, no native install-prompt API
   on iOS) — plan to keep the camera-dependent reading flow tested and
   working in regular Safari-tab mode as the iPad fallback, don't assume
   installed-mode camera access "just works" there without real device
   testing. Best slotted near Phase 15 once the core experience is settled.
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
      (Entry 43) would give this a head start.
- [x] **Phase 9a:** Mobile/session speech-engine reliability — **RESOLVED,
      ready to deploy (Entry 40-42).** Real causes: `onend` broken after
      `cancel()` (fixed via `speaking`-poll), cadence-gating flaw (fixed via
      Fix 3c/3c-2, live-monitored not exhaustively proven), tab-backgrounding
      safety gap (fixed via visibilitychange listener, Entry 42). See Section 3.
- [x] **Phase 9b:** No-face-detected safety gap — fixed, tested, closed.
- [x] **Phase 9c:** Off-axis/lying-down pose calibration — **superseded, moot
      once head-pose gating removal (Entry 43) ships**; no longer being
      root-caused as its own item.
- [x] **Phase 10:** UI redesign + text input (10a/10c/10d) — fully shipped,
      closed. See Section 3.
- [x] **Phase 11 / 11b:** Speed calibration + ambient trouble-shading —
      shipped, closed.
- [ ] **Phase 12b:** Voice quality / robotic tone — **now top priority
      (Entry 43).** Two-stage plan in Section 3/3c. Not started.
- [x] **Phase 12a / 12c / 12d:** Duration estimation, auto-scroll, sticky-word
      diagnosis — all shipped/closed. 12d's real clock bug fixed; remaining
      stalls were the same root cause as 9a, resolved there.
- [ ] **Phase 13.5:** Local on-device TTS — proposed, likely next after Stage
      A. Findings settled, see Section 3c. Needs a second-device benchmark
      before committing to a pace-floor value.
- [ ] **Phase 13:** Distance/recalibration robustness — not started, clearer
      to tackle once head-pose removal ships (Section 3d).
- [ ] **Phase 13.6:** Continuous speed control — rides on Phase 13.5, no
      independent path (browser hard limit: `speechSynthesis.rate` can't
      change mid-utterance).
- [ ] **Head-pose gating removal** (new, Entry 43) — decided, not yet built.
      See Section 3.
- [ ] **PWA packaging** (new, Entry 43) — decided as a direction, not yet
      built. See Section 3d for the iOS caveat.
- [ ] **Phase 14:** Full security review pass — after Phase 10 (done), not
      yet started.
- [ ] **Phase 15:** Shipping prep + paywall — last. Ethical flag stands: ALS/
      paralysis audience means a default paywall needs a deliberate decision.

## 5. Current status

Project folder `reading-app`: `index.html` + `main.js`, previously deployed to
Vercel through Phase 10a. **Phases 0-8a, 9b, 10, 11/11b, 12a/12c/12d all
shipped and deployed.**

**Phase 9a is now resolved** (Entry 40-42): the `speaking`-poll fix, Fix
3c/3c-2 gating, and the new tab-visibility fix are all live in the local
`main.js`/`index.html` and tested clean, but **not yet deployed to Vercel** —
that's the immediate next action, pending the student.

**This session (Entry 41-43):**
- Entry 41: isolated long-utterance test found no evidence for the suspected
  premature-`finishReading()` blip theory; 15 live back-to-back test runs
  found no sticky words with Fix 3c/3c-2. Decision: ship as-is, monitor via
  the new diagnostic (debug panel + `[Fix 3c/3c-2 diag]` console log) rather
  than continuing to chase either as a dedicated investigation.
- Entry 42: found and fixed a real, previously-undiscovered bug — speech kept
  playing after switching away from the browser tab entirely, because the
  whole mouth/face detection loop depends on `requestAnimationFrame`, which
  browsers suspend when backgrounded. Fixed via the Page Visibility API,
  confirmed working live by the student.
- Entry 43: major scoping discussion (no code) on five fronts — voice quality
  (two-stage plan, Stage A next), continuous speed control (rides on 13.5),
  head-pose gating (removal decided, not yet built), distance calibration
  (separate from head-pose, easier once head-pose is gone), and PWA packaging
  (feasible, iOS camera-in-PWA caveat flagged). See Section 3/3d for full
  reasoning and the updated priority order.

Diagnostics still live in the debug panel (harmless, kept): boundary/
duplicate-boundary/early-close/session-speak counters, iframe-recycle count,
the new Fix-3c/3c-2 risky-window row. Key technical values/constants are all
in Section 3 — not duplicated here.

## 6. Log of sessions

- **Entries 1-14 (Jul 6-11):** Built and deployed Phases 0-7. Fixed the Edge
  `speechSynthesis` freeze bug. Scoped Phases 9-14.
- **Entries 15-21 (Jul 11-19):** Built Phase 8a (tone toggle). Built and
  shipped Phase 11 (speed calibration) and 11b (ambient trouble-shading).
- **Entries 22-24 (Jul 19-24):** Mobile testing session — diagnosed and split
  Phase 9 into 9a/9b/9c. Fixed Phase 9b (no-face safety gap) and a Phase 11
  clamp-bounds bug. Attempted and reverted Phase 9a's first fix (sentence
  chunking) after it caused a worse laptop freeze — confirmed a real Web
  Speech API ceiling, not an implementation bug. Mobile-specific work (9a,
  9c) paused after this.
- **Entries 25-29 (Jul 24-25):** Scoped and shipped Phase 10 (10a text input,
  10c visual redesign — Mumblew name/logo, 10d PDF upload + IndexedDB
  migration). 10b dropped as a standalone phase, folded into 10c.
- **Entries 30-34 (Jul 25-26):** Scoped Phase 12c/12d and Phase 13.5 (local
  TTS) in depth — architecture, security, licensing, build-order decisions.
  Shipped 12a (duration estimation) and 12c (auto-scroll).
- **Entries 35-38 (Jul 26-28):** Phase 13.5 benchmark arc — timing-data
  feasibility, WASM/WebGPU tradeoffs, pre-buffering, dual-worker parallelism
  (ruled out). Diagnosed 12d (one real clock bug fixed; remaining stalls
  folded into 9a as the same root cause).
- **Entry 39 (Jul 28):** Revived Phase 9a via an iframe-recycle candidate fix
  (synthetic freeze-reproduction failed across 4 attempts; tested live
  instead — 20 sessions, no freeze). A new laptop overshoot regression
  surfaced during that testing, investigated in Entry 40.
- **Entry 40 (Jul 29):** Root-caused Entry 39's regression: ruled out the
  iframe swap (reproduced on a non-iframe deploy), found the real causes —
  `onend` broken after `cancel()` (fixed via `speaking`-poll) and a
  cadence-gating design flaw (fixed via Fix 3c/3c-2). A new suspected
  premature-`finishReading()` bug surfaced during this testing, queued for
  isolated testing next session.
- **Entry 41 (Jul 29):** Built an isolated long-utterance test harness for
  the premature-`finishReading()` theory. Two harness bugs found and fixed
  along the way (a cancel-before-speak nudge that wedged the engine; a
  25s timeout too short for natural long-text speech rate) before getting a
  trustworthy result: 3/3 clean completed trials, 0 spurious blips. Decided
  to stop chasing this theory. Added a Fix-3c/3c-2 tuning diagnostic
  (in/out of risky window, ms delta) to `main.js`/`index.html`, no behavior
  change; 15 live back-to-back test runs of a previously-sticky paragraph
  came back clean. Discussed deploy readiness — recommended shipping given
  both remaining concerns are now rare/unreproduced, not systematic.
- **Entry 42 (Jul 29):** Investigated and fixed a new bug reported by the
  student: speech kept playing after switching to a different application
  entirely, mouth closed, camera not covered. Root cause: `predictLoop()`
  (and therefore every mouth/face safety check) depends on
  `requestAnimationFrame`, which is suspended when the tab/window is
  backgrounded; `speechSynthesis` has no such throttling. Fixed via a
  `document.visibilitychange` listener that stops speech and clears state
  independent of `predictLoop`, without auto-resuming on return. Confirmed
  working live by the student.
- **Entry 43 (Jul 29):** Scoping discussion only, no code changed. Student
  raised five forward-looking questions. Agreed direction on all five: (1)
  voice quality — two-stage plan, cheap `getVoices()` picker first, Phase
  13.5 (local TTS) as the fallback; (2) continuous speed control rides on
  Phase 13.5, no independent path; (3) head-pose gating — **removal decided**
  (yaw/pitch can't distinguish "looking away" from "lying down," a core use
  case, and the student's own broader experience is that it's oversensitive
  generally; mouth-close already provides a buttonless pause, so no manual
  toggle needed as a replacement); (4) distance calibration (Phase 13) is a
  separate concern from head-pose, but removing head-pose gating removes a
  diagnostic confound and makes Phase 13 easier to isolate later; (5) PWA
  packaging is feasible and mostly free, with a flagged iOS Safari caveat
  (camera access inside an installed/standalone PWA has a rocky history —
  plan to keep the camera flow tested in regular Safari-tab mode on iPad as
  a fallback). Updated priority order in Section 3d. This file trimmed
  substantially in the same session — Phase 9a's full investigation
  narrative (Entries 22-24, 33, 39, 40) and old shipped-phase detail
  (10a/10c/10d, 11/11b, 12a/12c/12d) collapsed to settled conclusions now
  that 9a is resolved and those phases are long-closed.
