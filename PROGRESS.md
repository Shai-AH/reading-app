# PROGRESS LOG — "Mumblew" (reading app)
Last updated: August 3, 2026 (Entry 50)

> HOW TO USE: Single source of truth. Claude reads this first in every new chat.
> Update before ending each session. If Claude contradicts this file, trust this file.
> Section 6 stays terse — grouped summary lines for older work, one line per recent
> entry. Real decisions/reasoning live in Section 3.
> **Length discipline (added Entry 49):** once an investigation is CLOSED, compress
> it to outcome + final numbers only — drop the blow-by-blow (round-by-round data,
> intermediate failed attempts, per-word breakdowns). Implementation-level detail
> that's already documented in main.js code comments does NOT need to be duplicated
> here — point to the comment/function name instead of re-explaining the mechanism.
> **This pass (Entry 50):** Closed out the Entry 49 sticky-word/lighting
> investigation with a shipped (local) fix — see Section 3's low-light bullet.
> Also built, at the student's request, an interactive onboarding system (shared
> tour engine: main app tour + calibration intro, both re-triggerable; standalone
> mobile-viewport notice) and a layout restructure (wide-viewport sidebar for the
> debug panel, auto-grow text input) — see Section 3's onboarding/layout bullet.
> All of it live-tested and confirmed by the student, including two real bugs the
> student caught (a resize-blind mobile-notice check, and a dim-calibration blind
> spot in the low-light detector — see Section 2's new corollary). Entry 49's
> temporary diagnostics are fully removed. Deploy + this log update were both
> deliberately deferred until the student's full to-do list for this chat was
> done — now it is. Next up: Small Ship (Section 3d #3).

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
during the reading loop itself (setup/calibration is a different situation —
see Entry 46's slider, built with keyboard-stepping + a large touch target for
exactly this reason).

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
- Claude = architecture lead / sole developer ("captain"); student = navigator,
  executes and directs priority ("architect" in spirit, but roles/labels per
  this file are captain/navigator — confirmed Entry 49).
- **Working style:** wait for explicit "start"/"next". Ask before updating the log;
  proactively suggest updating if a chat runs long.
- **Deploy reminder:** Claude proactively asks about deploy status at the end of any
  phase touching `main.js`/`index.html`.
- **Testing requests:** clear numbered step-by-step instructions (what to click,
  what to watch, what to note down) — never a vague "try it and see." Student wants
  MORE tests, not fewer; err toward thorough over quick. **Prefer on-screen plain-
  English output over console/debug-panel digging when building test tools for the
  student** (Entry 49 — the debug panel got too cluttered; standalone simple
  panels with copy-to-clipboard are the new default for anything student-facing).
- **Bug-confirmation policy:** before asking the student to test a suspected
  bug/fix in the real app, first build a standalone, isolated test page/diagnostic
  that tries to confirm or rule out the specific mechanism, ideally with real
  numbers, not a guess. Only fall back to testing inside the real app if the
  isolated version can't reproduce the thing being tested (or the mechanism
  genuinely requires live mouth-tracking to test).
  **Corollary (Entry 41):** an isolated harness is itself code and can have its
  own bugs — verify the harness's own logic/timeouts are sound before trusting a
  "reproduced" or "clean" result from it.
  **Corollary (Entry 45):** a bug reported as "works via keyboard but not mouse
  click" is a strong signal the two input paths are wired to different gating
  logic — check for that divergence first before assuming a one-off browser quirk.
  **Corollary (Entry 49):** don't assume the most recently-changed code is the
  cause just because a symptom appeared after it shipped — check whether the
  changed values are even structurally reachable under the student's actual
  usage (e.g. Entry 47's anchors were provably inert at the student's default
  slider position) before investigating further. Also: ruling one plausible
  mechanism OUT (e.g. "frozen tracking") with real data is as valuable as
  confirming one IN — don't stop at the first plausible story, test it.
  **Corollary (Entry 50):** a self-calibrating/relative-baseline fix can
  silently defeat itself if calibration happens under the exact bad condition
  it's meant to detect later (e.g. calibrating in a dim room) — pair any
  personal-baseline threshold with an absolute floor that doesn't depend on
  the baseline. Also: a check that only runs once at page load (e.g. a
  viewport-size check) needs its own re-check trigger (resize, etc.) to
  behave correctly under live testing, not just at first paint — both caught
  by the student's own testing, not anticipated up front.
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
  word (`onboundary` char offset). Key settled facts: sentence-chunked utterances
  are a real Web Speech API ceiling (reverted, not revisited); `onend` never fires
  after manual `cancel()` on this browser, fixed by polling `speechSynthesis.speaking`
  instead; mid-word overshoot was cadence-gating logic (Fix 3c/3c-2: tight gating
  only within `RISK_WINDOW_HALF_MS=120ms` of an estimated b/m/p closing-consonant
  moment, loose everywhere else — see `updateMouthState`/`isWithinRiskyWindow` in
  main.js for the live mechanism); tab-visibility safety gap fixed; iframe-recycling
  orphaned-utterance bug fixed via `activeSpeechSynth`/`cancelActiveSpeech()`.
  Diagnostics still live and harmless: duplicate-boundary counter, early-close
  counter, session-wide `speak()` counter, iframe-recycle count, Fix-3c/3c-2 risky-
  window row, Phase 12b voice-selection row.

- **Head-pose gating (Phase 3) — REMOVED, Entry 45.** "Facing the screen" is an
  unreliable engagement proxy for this app's core audiences (ALS head-drop,
  lying-down reading); gaze-tracking alternative considered and rejected (same
  bad-geometry problem, compounded). `isFacingScreen` renamed `isFaceVisible`
  (means only "MediaPipe sees a face," no yaw/pitch). Calibration wizard 5→3 steps.

- **Manual ON/OFF speech switch — shipped, Entry 45.** Hard-stop on OFF, no
  partial-word grace. Click or Spacebar, guarded off typing contexts and off
  `readingActive`. Uses a CSS class (`is-inactive`) so click/Spacebar share one gate.

- **Plain-English trouble explainer (warning box) — shipped, Entry 45.** Single
  message at a time by priority (switch-off > no-face > low-light > cadence-
  stall), off the smoothed `displayedTroubleScore`.
  `WARNING_BOX_MIN_DISPLAY_MS=3000` prevents flashing. Minimizable;
  auto-re-expands on a new condition. **Extended Entry 50** with the
  `'low-light'` reason — see that bullet below.

- **Speed calibration — REBUILT Entry 46, TUNED Entry 47, anchors RULED OUT
  as sticky-word cause Entry 49.** Old regression-based mechanism (noisy live-
  timing inference) fully removed. Continuous slider (0.5x-1.75x,
  `RATE_SLIDER_MIN/MAX`) with 3 hand-tuned anchor points (`RATE_ANCHORS`),
  piecewise-linear interpolated (`interpolateCadence`). **The 1.0x anchor
  always reuses `DEFAULT_MS_PER_SYLLABLE`/`DEFAULT_BASE_WORD_MS`, untouched by
  any tuning pass — anchor changes only affect gating when the slider is off
  1.0x.** Final tuned anchors (Entry 47, via two rounds of live-logged data,
  second round corrected for a forced-tap contamination bug in round one):
  slow 230ms/syllable + 135ms base, fast 135ms/syllable + 62ms base. Known
  residual gap, not addressed: `estimateWordDuration()` has no per-word sense
  of punctuation/emphasis (formula-level limitation, not anchor-fixable).
  Slider-range comfort at the extremes flagged as an open product question,
  revisit only if real use surfaces it.

- **Mobile highlighter-freeze fix — BUILT, Entry 48, still NOT deployed /
  NOT mobile-tested.** Root cause confirmed via isolated harness
  (`tts-boundary-diagnostic.html`, standalone): `onboundary` fires 0/14 times
  on the student's mobile browser, main window, no iframe involved — rules
  out Phase 9a's iframe recycling. Fix: a per-word fallback timer
  (`scheduleFallbackAdvance`, state `fallbackAdvanceTimerId`) that advances
  the highlight/resume point on a clock only when a real `onboundary` doesn't
  arrive in time; a real event always wins and resyncs it — self-correcting,
  no browser detection needed. Desktop test toggle added
  (`DEBUG_SIMULATE_NO_ONBOUNDARY`) to exercise the fallback path without a
  phone. Desktop testing found & fixed three timing bugs in the fallback
  itself — punctuation-adjacent jitter, first-word-only jitter (now anchored
  to the utterance's `onstart` event), and paragraph-level drift (fixed with
  a self-calibrating `fallbackRateFactor`, EMA-smoothed, persisted to
  `readingAppFallbackRateFactor`) — full mechanism documented in main.js
  comments at each function. **Status: desktop-verified only. The
  self-calibration retest and any real mobile pass never happened** —
  session was paused for the sticky-word investigation (now resolved,
  Entry 49, unrelated cause). Resume only after the Section 3d sequencing
  below reaches this phase.

- **Low-light detection — RESOLVED + SHIPPED (local), Entry 49–50.** Root
  cause (Entry 49): ambient light measurably degrades MediaPipe's landmark
  precision — not a threshold-tunable bug, not frozen tracking, not Entry 47's
  anchors or Entry 48's fallback mechanism. Dim light makes genuinely real MAR
  movement read smaller, broadly across many words, not just consonant-heavy
  ones. Fix (Entry 50): direct pixel-luminance sampling (`sampleBrightness()`),
  independent of MediaPipe entirely — hybrid detection combining (a) a
  per-device baseline captured for free during calibration's neutral step
  (`finishCalibration()`/`applyCalibration()`; relative trip point = 60% of
  baseline) with (b) an absolute-darkness floor
  (`ABSOLUTE_DARK_ENTER_THRESHOLD`/`_EXIT_THRESHOLD`, data-tuned to 40/52 from
  the student's real test numbers) as a backstop — needed because a pure
  relative approach silently fails if calibration itself happens in a dim
  room (student-caught, see Section 2's Entry 50 corollary). Calibration also
  now shows a non-blocking advisory if done somewhere too dim. Plugged into
  the Entry-45 warning-box priority system (`'low-light'`, ranked after
  `'no-face'`, before `'cadence'`). Student live-tested normal/dim/dark rooms
  plus the dim-calibration edge case — all confirmed working. Entry 49's
  temporary diagnostics (Light Test Helper, close-event/reopen/risky-window-
  fail loggers) are fully removed from main.js/index.html.

- **Onboarding (tour system) + layout restructure — BUILT, Entry 50, local
  only.** One shared coach-mark engine (`startTour()`/`renderTourStep()`,
  `#tourOverlay` markup) drives two content sets: `MAIN_APP_TOUR_STEPS`
  (auto-shows once on first visit; includes an early "mobile isn't ready yet"
  slide) and `CALIBRATION_INTRO_STEPS` (auto-shows before the first-ever
  wizard run). Both manually re-triggerable — "❓ Guide" button for the main
  tour, "❓ Show intro again" inside the calibration panel. Separate
  standalone mobile-viewport banner (`checkMobileNotice()`), re-checks live
  on resize. Page restructured into `#appLayout`/`#mainColumn`/`#sideColumn`:
  reading column keeps a fixed comfortable width regardless of screen size
  (readability over raw width); debug panel moves into a height-capped,
  internally-scrolling sticky sidebar on wide (≥1040px) viewports instead of
  leaving empty margins. Text input textarea now auto-grows to content
  (`resizeTextareaToFit()`) instead of a fixed row count. All student-flagged
  and re-tested; two real bugs caught and fixed along the way (see Section
  2's Entry 50 corollary).

- **Cadence-based pacing:** `estimateWordDuration(word) = BASE_WORD_MS +
  syllables * MS_PER_SYLLABLE`. Dynamically scales the mouth-close-detection
  threshold — see Fix 3c/3c-2 above. `WINDOW_MS=300` movement-range smoothing.
- **Calibration mode:** 3-step wizard (neutral → mutter → pace), saved to
  `localStorage` (`readingAppCalibration`), per-device/per-browser.
- **Emotional tone toggle (Phase 8a):** punctuation-based heuristic, off by
  default, decided once per resume.
- **Explicitly rejected, not deferred:** mic-based audible-speech safeguard;
  ROI cropping; per-sentence tone chaining; sentence-chunked TTS utterances;
  Kokoro/local-TTS; installing OS-native voices; head-pose gating in any form
  including gaze-combined; discrete speed presets (favor continuous +
  interpolation); a full self-calibrating adaptive close-threshold system
  (Entry 49 — real drawbacks identified: noisy bootstrap data with no
  independent ground truth to calibrate against, can't distinguish poor
  camera precision from the user genuinely mouthing less, automates rather
  than removes the strict/loose tradeoff risk, harder to debug, persistence
  risk if a bad calibration carries across sessions — revisit only if the
  Entry 50 low-light warning, now shipped and confirmed working, turns out
  insufficient after real user feedback).
- **Phase 7c:** dynamic frame rate, `IDLE_FRAME_INTERVAL_MS=100`.
- **Text input / UI redesign / PDF upload (Phases 10a/10c/10d) — all shipped,
  closed.** `currentText` (mutable), paste/type + `.txt`/`.pdf` upload via
  lazy-loaded `pdfjs-dist`, saved text persists via IndexedDB (`mumblewDB`/
  `savedText`), calibration data on localStorage. Full dark-themed redesign shipped.

### 3b. Scope decisions

- Platform: Web app, Chrome-first. Cross-browser support not a priority pre-demo
  (Entry 45's switch fixes verified on both Chrome and Edge).
- Security: `textContent` never `innerHTML` (XSS guard), pinned CDN versions, CSP
  header, camera-privacy disclosure, HTTPS via Vercel. Full review at Phase 14.

## 3d. Priority order for remaining work (revised Entry 49; #1-2 closed Entry 50)

**Rationale (Entry 49):** student proposed inserting an early real-user-feedback
round (10-20 outside readers) ahead of the remaining build phases — solo
algorithm-tuning has hit diminishing returns; real users will surface more per
hour than another tuning pass. Agreed. Amendment: don't small-ship while mobile
is silently broken or the light issue silently fails mid-sentence — both need
at least an honest heads-up first, or tester feedback just restates known bugs
instead of teaching anything new.

1. ~~Lighting warning~~ — **DONE, Entry 50** (see Section 3's low-light bullet).
2. ~~Onboarding tour (app guide + calibration intro) + layout polish~~ —
   **DONE, Entry 50.** Added mid-sequence at the student's request (pre-ship
   polish: non-technical users need more than the debug panel to understand
   the app) — see Section 3's onboarding/layout bullet.
3. **Small ship, scoped honestly** — NEXT UP. Desktop/laptop only (the app
   tour already says so), recommend decent lighting. Gather feedback from
   ~10-20 outside readers.
4. **Let feedback decide next priority** among: finishing the Entry 48
   mobile highlighter fix (built, desktop-tested, needs mobile pass +
   deploy), the fuller adaptive light system (if the shipped warning proves
   insufficient), or whatever else surfaces. Don't pre-commit further than
   this until feedback is in hand.
5. **Phase 13** (distance/recalibration robustness) — still likely NOT
   needed; MAR's ratio design is self-normalizing against camera distance.
   Revisit only if real testing shows a concrete problem.
6. **PWA packaging** — manifest + service worker + icons, mostly free. iOS
   Safari camera-in-installed-PWA access is historically unreliable — keep
   the camera flow tested in regular Safari-tab mode as the iPad fallback.
7. **Phase 14** (security review), **Phase 15** (shipping prep + paywall,
   with the standing ethical note: ALS/paralysis audience means a default
   paywall deserves a deliberate decision) — last, unchanged.
8. **Quality-of-life changes** — not yet scoped; likely informed by feedback.

## 4. Roadmap

- [x] **Phases 0-8a, 9a-9c, 10, 11/11b, 12a-d, 13.5/13.6:** webcam/facemesh,
      MAR play/pause, word highlighting, click-to-word resync, movement-range
      smoothing, cadence-based pacing, calibration wizard, dynamic frame rate,
      emotional tone toggle, mobile speech-engine reliability, no-face safety
      gap, UI redesign + text input + PDF upload, speed calibration (rebuilt
      Entry 46, replacing the old regression), ambient trouble-shading, voice
      quality, auto-scroll — all shipped, deployed, closed. (Head-pose gating,
      Phase 3, later REMOVED — see Entry 45 below.)
- [ ] **Phase 8b:** Voice cloning — needs a scope conversation, not started.
- [ ] **Phase 8c:** Offline mode — not started, feasible free; PWA work
      would give this a head start.
- [x] **Phase 3 (Head-pose gating) — REMOVED, Entry 45.**
- [x] **Manual ON/OFF speech switch + plain-English warning box — shipped,
      Entry 45.** Extended Entry 50 with the low-light reason.
- [x] **Speed calibration rebuild (manual slider) — shipped, Entry 46.**
      Anchor tuning closed Entry 47; ruled out as sticky-word cause, Entry 49.
- [ ] **Mobile highlighter-freeze fix** — built, desktop-tested only, NOT
      deployed, NOT mobile-tested. Parked pending Section 3d sequencing.
- [x] **Low-light detection — root cause found Entry 49, fix BUILT + TESTED
      + CONFIRMED Entry 50** (self-calibrating baseline + absolute-floor
      backstop). Local only, not yet deployed.
- [x] **Onboarding tour + layout restructure — BUILT + TESTED Entry 50.**
      Local only, not yet deployed.
- [ ] **Small ship + gather user feedback (10-20 readers)** — Section 3d #3, NEXT.
- [ ] **Distance/recalibration robustness (Phase 13)** — likely not needed.
- [ ] **PWA packaging** — decided as a direction, not yet built.
- [ ] **Phase 14:** Full security review pass — not yet started.
- [ ] **Phase 15:** Shipping prep + paywall — last. Ethical flag stands.
- [ ] **Quality-of-life changes** — not yet scoped.

## 5. Current status

Project folder `reading-app`: `index.html` + `main.js`. **Entries 45-47 are
deployed to Vercel.** Entries 48-50 (mobile-highlighter fallback, low-light
detection, onboarding tour, layout restructure) all exist in the local
`main.js`/`index.html` only — not deployed, not mobile-tested. Deploy was
deliberately held until the student's full to-do list for this chat was
done (student's call, confirmed Entry 50).

Entry 49's temporary diagnostics are fully removed — nothing local-only-and-
temporary left to strip out.

**Immediate next step (per Section 3d):** deploy Entries 48-50 together, then
scope and prep a small-ship release for outside feedback (desktop/laptop
only, mobile explicitly flagged as in-progress via the app tour). Mobile
highlighter fix and the fuller adaptive light system both stay parked until
feedback tells us which matters more.

## 6. Log of sessions

- **Entries 1-14 (Jul 6-11):** Built and deployed Phases 0-7. Fixed the Edge
  `speechSynthesis` freeze bug. Scoped Phases 9-14.
- **Entries 15-21 (Jul 11-19):** Built Phase 8a (tone toggle). Built and
  shipped Phase 11 (speed calibration, since replaced Entry 46) and 11b
  (ambient trouble-shading, still live).
- **Entries 22-24 (Jul 19-24):** Mobile testing session — diagnosed and split
  Phase 9 into 9a/9b/9c. Fixed 9b. Reverted 9a's sentence-chunking fix.
- **Entries 25-29 (Jul 24-25):** Shipped Phase 10 (text input, redesign, PDF).
- **Entries 30-38 (Jul 25-28):** Shipped 12a/12c. Ruled out Phase 13.5.
- **Entries 39-44 (Jul 28-30):** Closed Phase 9a and 12b. Deployed. Scoping
  discussion landed the head-pose removal decision (built Entry 45).
- **Entry 45 (Jul 31):** Removed head-pose gating. Shipped ON/OFF switch and
  warning box. Not deployed.
- **Entry 46 (Jul 31):** Rebuilt speed calibration as manual slider +
  anchor interpolation, replacing the old regression. Not deployed.
- **Entry 47 (Jul 31):** Closed speed-calibration anchor tuning via two
  rounds of temporary live-logged data. Not deployed.
- **Entry 48 (Aug 1):** Confirmed Entries 45-47 deployed. Diagnosed and built
  a fix for the mobile highlighter-freeze bug (root cause: `onboundary`
  never fires on mobile). Desktop-tested only; paused before mobile
  testing/deploy to flag an unconfirmed sticky-word concern.
- **Entry 49 (Aug 2):** Investigated the sticky-word concern from scratch.
  Ruled out Entry 47's anchors and Entry 48's fallback mechanism. Ruled out
  frozen tracking via a purpose-built diagnostic. Confirmed the real cause:
  ambient light affects MediaPipe's precision broadly, not just at b/m/p
  words. Discussed and deferred a full adaptive-threshold fix (real
  drawbacks identified). Agreed a new priority order with the student:
  cheap lighting warning → small ship → gather outside user feedback →
  let feedback decide between finishing mobile, building the fuller
  adaptive light system, or other surfaced issues → security → full
  shipping → QoL. Trimmed this file's length per the student's request.
- **Entry 50 (Aug 3):** Built and shipped (local) the low-light fix: hybrid
  detection (per-device baseline from calibration + absolute-darkness floor
  backstop), retuned from the student's real test data, all edge cases
  confirmed. Removed Entry 49's temporary diagnostics. At the student's
  request, also built an interactive onboarding system (shared tour engine:
  main app tour + calibration intro, both re-triggerable, mobile-viewport
  notice) and a layout restructure (wide-viewport debug sidebar, auto-grow
  text input) — both live-tested, with two real student-caught bugs fixed
  along the way. Deploy and this log update both deferred until now, per
  the student. Next: Small Ship (Section 3d #3).
