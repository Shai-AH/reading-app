# PROGRESS LOG — "Reading App" (working title)
Last updated: July 22, 2026 (Entry 23)

> HOW TO USE: Single source of truth. Claude reads this first in every new chat.
> Update before ending each session. If Claude contradicts this file, trust this file.
> Section 6 stays terse — grouped summary lines for older work, one line per recent
> entry. Real decisions/reasoning live in Section 3.
> **Trimmed Entry 23** to control file size (was 600+ lines): verbose tuning
> narratives for fully-shipped, validated phases were cut down to their settled
> conclusions; all still-open items were kept in full. Keep future additions lean —
> conclusions and current values, not blow-by-blow attempt logs, once a phase closes.

---

## 1. The Idea (Owner: student)

Privacy-first app: reads/listens to text using quiet mouth movement (subvocalization)
as the pacing signal, narrating via TTS driven by webcam lip-tracking instead of
buttons/timers.

Audiences: reading in the dark/bed without light/sound (**lying down is a real,
expected use case, not an edge case — Entry 23**); neurodivergent/low-focus readers
needing active engagement; people who can move their mouth but can't vocalize (ALS,
severe stutter, vocal cord paralysis) — assistive/humanitarian use case.

Three-state design: **State 1** (core, done) mouth movement = play/pace signal, text
is known ground truth. **State 3** (done) click-to-word manual resync. **State 2**
(done) cadence-based pacing informs pacing/close sensitivity.

Privacy goal: on-device/local-first (MediaPipe), video never leaves device.

Nice-to-haves (Phase 8b/8c, not started): voice cloning, offline mode.

**ALS/paralysis audience (research-backed, Entry 17):** viable for early/moderate
bulbar ALS and vocal-cord paralysis with preserved oral-motor control (early-stage
shows *larger* compensatory jaw movement — a good detection signal). NOT viable for
late-stage bulbar ALS — biological ceiling (patients shift to eye-tracking/AAC), not
a design gap.

## 2. Person's context

- 2nd semester CS student. Comfortable with logic, rusty on Python/HTML/CSS/JS.
- **Budget: $0**, no exceptions until final native app-store step (if ever).
- **Timeline:** flexible, rough target Dec 2026.
- Claude = architecture lead ("captain"); student executes ("navigator").
- **Working style:** wait for explicit "start"/"next". Ask before updating the log;
  proactively suggest updating if a chat runs long. New chat per phase from Phase 9
  onward — this file carries context across that boundary, keep it accurate and lean.
- **Deploy reminder:** Claude proactively asks about deploy status at the end of any
  phase touching `main.js`/`index.html`.
- **Cross-device discipline (Entry 23):** target platforms are laptop, mobile
  (portrait + landscape), tablets/iPads. Any fix aimed at one platform must be
  checked for regressions on the others before being considered done — don't let a
  mobile fix silently break laptop behavior that already works.

## 3. Key decisions

- Web app, Chrome-first. Stack: MediaPipe Face Landmarker (in-browser), Web Speech
  API TTS, Vercel hosting. No build tools — plain HTML/JS + `<script type="module">`,
  MediaPipe via jsdelivr CDN. Landmarks used: 13/14 (lips), 61/291 (mouth corners).
- **Speech architecture:** `speak()`/`cancel()` only, never `pause()`/`resume()`
  (caused a permanent Edge/Windows TTS freeze — confirmed, don't re-investigate
  unless Edge support is ever added to scope). One utterance runs while the mouth
  stays open; `cancel()` on close, remembering the last completed word (`onboundary`
  char offset) to resume from.
  **Confirmed broken on mobile Chrome (Entry 22-23): `onboundary` never fires at all
  on mobile (not just unreliable — 0 events across full utterances), and `cancel()`
  doesn't reliably trigger `onend` either — audio can keep playing well after
  `cancel()` is called, unsupervised.** This single root cause explains three
  separate mobile symptoms: the click-to-word "sticky" resume bug (nothing ever
  advances `lastBoundaryOffset`, so every resume falls back to the last
  `speakFrom()` call), mouth-close overshoot (extra words spoken after closing —
  confirmed via a `cancel()`-to-`onend` gap measurement that came back empty, i.e.
  `onend` never arrived), and the Phase 11b trouble border staying pinned/blinking
  (its clock also only resets via `onboundary`). **Fix not yet built — Phase 9a.**
  Direction: bound each utterance to a smaller chunk (e.g. one sentence) so a
  `cancel()` has less runway to overrun, rather than one utterance per resume
  covering arbitrary remaining text. This is a different mechanism than Entry 16's
  rejected auto-chaining (which called `speak()` from inside `onend` to
  self-continue) — the next `speak()` would still only ever fire from an explicit
  mouth-open/click, same as today. Still touches the same fragile subsystem that's
  broken twice already — build carefully, verify on desktop too before shipping.
- **Head-pose gating:** yaw/pitch from MediaPipe's `facialTransformationMatrix`
  (`DEFAULT_YAW_THRESHOLD=26°`, `DEFAULT_PITCH_THRESHOLD=21°`, overridable per-device
  by the Phase 7b wizard). Gates the mouth signal and actively stops/resumes speech
  on facing-state change.
  **EMA-smoothed as of Entry 23** (`POSE_SMOOTHING_ALPHA=0.2`, unvalidated starting
  guess): raw per-frame yaw/pitch was fine on a stationary laptop, but a handheld
  phone's hand tremor reads as false head rotation (yaw/pitch are camera-relative —
  can't otherwise distinguish tremor from real movement). On-screen display stays
  raw; only the values feeding the facing gate and trouble score are smoothed.
  Fixed mobile gating oversensitivity and (partly — see Phase 9a) the trouble
  border.
  **Two more pose issues open (Entry 23), not yet fixed:**
  - **(9b) No-face-detected gap:** confirmed by code inspection — if MediaPipe
    returns zero landmarks (camera pointed away entirely), `updateHeadPose()` is
    never called that frame, so `isFacingScreen`/`mouthState` just freeze at their
    last value. TTS keeps speaking indefinitely with no face in frame. Distinct
    from the already-handled "yaw/pitch exceeds threshold" case. **Not
    mobile-exclusive** — same gap likely exists on laptop, just less likely to be
    triggered there.
  - **(9c) Off-axis calibration doesn't hold across reading postures:** thresholds
    calibrated sitting upright, camera centered. Lying down (a real target-audience
    use case) shifts the face's position in-frame in a way that seems to affect
    yaw/pitch beyond genuine head-angle change — student had real difficulty
    registering "facing screen" while lying down. Not yet root-caused. May connect
    conceptually to Phase 12 (recalibration robustness), which is about distance
    drift rather than off-axis position — worth checking whether it's the same
    underlying gap once investigated.
- **Cadence-based pacing:** `estimateWordDuration(word) = BASE_WORD_MS +
  syllables * MS_PER_SYLLABLE` (defaults 120/220), personalized per-user via the
  Phase 11 wizard (regression fit from a mouthed sample sentence). Dynamically
  scales the mouth-close-detection threshold (stricter under expected time, looser
  past it — `CADENCE_UNDER_FACTOR=0.6`/`CADENCE_OVER_FACTOR=1.5` on
  `STOPPED_RANGE_THRESHOLD=0.03`). **Confirmed via live mobile testing (Entry 23)
  this is NOT the cause of the mouth-overshoot bug** — detection gap measured
  healthy (~330ms, in line with the `WINDOW_MS=300` movement-range buffer).
  **Clamp-bounds bug fixed Entry 23:** old bounds (`MIN_MS_PER_SYLLABLE=80,
  MAX_BASE_WORD_MS=300`) assumed per-syllable cost dominates a word's duration;
  real fits showed the opposite (large fixed per-word cost, ~0 per-syllable cost)
  and got inverted by the clamp into an audibly-fast TTS rate (raw fit gave
  rate≈0.93, clamped gave 1.272). Bounds widened to `MIN_MS_PER_SYLLABLE=0,
  MAX_BASE_WORD_MS=800`; confirmed fixed via a clean recalibration
  (`final rate=1.024`). Multiplies with the Phase 8a tone-toggle rate when tone is
  on. **Closed, no open flags.**
- **Movement-range smoothing (Phase 6a):** `WINDOW_MS=300`. Confirmed still working
  correctly on mobile (Entry 23 diagnostics) — not implicated in the overshoot bug.
- **Calibration mode (Phase 7b):** 4-step wizard (neutral → mutter → facing →
  turned away) + Phase 11's 5th step (speed), saved to `localStorage`
  (`readingAppCalibration`) — **per-device/per-browser, does not sync** between
  e.g. desktop Chrome and mobile Chrome. Falls back to `DEFAULT_*` if nothing saved.
- **Emotional tone toggle (Phase 8a):** punctuation-based heuristic only
  (`!`/`?`/default), off by default. Tone decided once per resume, not
  per-sentence — per-sentence chaining was tried twice and explicitly rejected
  (wedged Chrome's speech engine both times, same bug *class* as the Edge freeze).
- **Explicitly rejected, not deferred:** mic-based audible-speech safeguard (dead
  weight for the ALS/paralysis audience, new permission prompt); ROI cropping
  (recalibration risk not worth the battery gain vs. dynamic frame rate); per-
  sentence tone chaining (see above).
- **Phase 7c:** dynamic frame rate, `IDLE_FRAME_INTERVAL_MS=100`.

### 3b. Scope decisions

- Platform: Web app, Chrome-first. Cross-browser support not a priority pre-demo.
- Text input still hardcoded (`READING_TEXT` in `main.js`) — Phase 10.
- Security: `textContent` never `innerHTML` (XSS guard), pinned CDN versions, CSP
  header, camera-privacy disclosure, HTTPS via Vercel. Full review deferred to
  Phase 13 (after file upload in Phase 10 actually expands the attack surface).

### 3c. Phases 9-14 (scoped Entry 14/15, revised Entry 22-23)

- **Phase 9 — Mobile bug fixes**, split as issues were found live-testing (Entry
  22-23):
  - **9a — Mobile speech-engine event unreliability.** Root cause confirmed (see
    Section 3). Fixes the sticky click bug, mouth-overshoot, and trouble-border
    blinking at once. Not yet built. Regression-check desktop before done.
  - **9b — No-face-detected safety gap.** Not mobile-exclusive. Not yet built.
  - **9c — Off-axis/lying-down pose calibration.** Not yet root-caused.
- **Phase 10 — UI redesign + text input** (paste/`.txt`/`.pdf`). Also where
  **portrait/vertical mobile layout** gets fixed — `#container`/`#webcam`/
  `#overlay` are hardcoded to 640×480, stretching a portrait camera stream.
  Flagged Entry 22, deliberately not touched mid-mobile-bug-fixing.
- **Phase 11 — Personalized speed calibration.** Shipped Entry 18, clamp bug fixed
  Entry 23. Closed, no open flags.
- **Phase 11b — Ambient trouble-shading.** Shipped Entry 19-21. **Still
  blinking/pinned red on mobile — same root cause as 9a, will resolve once 9a is
  fixed, not separate work.**
- **Phase 12 — Distance/recalibration robustness.** Not started. May turn out
  related to Phase 9c.
- **Phase 13 — Full security review** (after Phase 10).
- **Phase 14 — Shipping prep + paywall.** Ethical flag to revisit then: target
  audience includes ALS/paralysis users — a paywall by default deserves a
  deliberate decision, not a default.

## 4. Roadmap

- [x] **Phases 0-8a:** webcam/facemesh, MAR play/pause, word highlighting +
      head-pose gating, click-to-word resync, Vercel deploy, movement-range
      smoothing, cadence-based pacing, head-pose calibration wizard, dynamic frame
      rate, emotional tone toggle. All deployed. Full details in Section 3.
- [ ] **Phase 8b:** Voice cloning — needs a scope conversation (budget/privacy
      tension), not a build session.
- [ ] **Phase 8c:** Offline mode — not started, feasible free.
- [ ] **Phase 9a:** Mobile speech-engine event unreliability — root cause
      confirmed, fix not yet built.
- [ ] **Phase 9b:** No-face-detected safety gap — confirmed by code, not yet built.
- [ ] **Phase 9c:** Off-axis/lying-down pose calibration — not yet root-caused.
- [ ] **Phase 10:** UI redesign + text input (also fixes portrait/vertical mobile
      layout).
- [x] **Phase 11:** Personalized speed calibration — shipped, clamp bug fixed
      Entry 23. No open flags.
- [x] **Phase 11b:** Ambient trouble-shading — shipped; mobile blinking is a
      Phase 9a symptom, not separate work.
- [ ] **Phase 12:** Distance / recalibration robustness.
- [ ] **Phase 13:** Full security review pass (after Phase 10).
- [ ] **Phase 14:** Shipping prep + paywall.

## 5. Current status

Project folder `reading-app`: `index.html` + `main.js`, deployed to Vercel. Phases
0-8a complete and deployed. Phase 11/11b shipped (11b has an open mobile symptom,
see 9a).

**Mobile testing (started Entry 22) is in progress, not complete.** Root-caused 3
of 4 reported mobile issues this session (9a's event unreliability; 9b's no-face
gap; head-pose hand-tremor jitter — fixed via EMA smoothing). One (9c, lying-down
pose) still unexplained. **9a/9b/9c are the next actions, in a new chat**, per
working style.

Temporary diagnostics currently live in the debug panel from this mobile-testing
effort (not permanent features): boundary event counter, last-onboundary timer,
speed-fit raw readout, sticky detection-gap and cancel-to-stop-gap readouts. Useful
for 9a's work — fine to leave in place until 9a is built and verified, then strip.

Key technical values/constants are all in Section 3 — not duplicated here.

## 6. Log of sessions

- **Entries 1-14 (Jul 6-11):** Built and deployed Phases 0-7 (webcam/facemesh, MAR
  play/pause, word highlighting + head-pose gating, click-to-word resync, Vercel
  deploy, movement-range smoothing, cadence-based pacing, head-pose calibration
  wizard, dynamic frame rate). Fixed the Edge `speechSynthesis` freeze bug. Scoped
  Phases 9-14. Full decisions in Section 3.
- **Entries 15-21 (Jul 11-19):** Built Phase 8a (tone toggle; per-sentence
  chaining tried and rejected twice). Built Phase 11 (speed calibration wizard —
  peak-trough detection, two-pass sampling, stall/outlier handling; flagged a
  clamp-bounds issue, resolved Entry 23). Built and shipped Phase 11b (ambient
  trouble-shading; fixed a cadence-clock bug; live-validated on Vercel). Full
  decisions in Section 3.
- **Entry 22 (Jul 19):** Chose Phase 9 (mobile bug fix) over Phase 12 as next
  action — regression on working functionality, small/isolated, working theory
  already narrowed.
- **Entry 23 (Jul 22):** Mobile testing session. Added temporary diagnostics
  (boundary counter, onboundary timer, sticky detection/cancel-stop gap
  readouts). Confirmed root cause of the click-to-word "sticky" bug: `onboundary`
  never fires on mobile Chrome at all. Found and fixed the Phase 11 speed
  clamp-bounds bug using real calibration console data — confirmed via clean
  recalibration. Found and fixed head-pose hand-tremor oversensitivity via EMA
  smoothing. Diagnosed the mouth-close word-overshoot bug down to `cancel()` not
  reliably triggering `onend` on mobile — same root cause also explains the
  still-blinking Phase 11b trouble border. Ruled out cadence gating and movement-
  range smoothing as causes via live on-device measurement. Found (code
  inspection) a no-face-detected safety gap — not mobile-exclusive. Found (live
  testing) that pose calibration doesn't hold well while lying down — not yet
  root-caused. Split remaining mobile work into Phase 9a/9b/9c. Added a standing
  cross-device regression-check principle to Section 2. Trimmed this file
  substantially per student's request to control file size.
