# PROGRESS LOG — "Mumblew" (reading app)
Last updated: July 24, 2026 (Entry 28)

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

**Name: Mumblew** (Entry 27). Student has a logo already.

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
  mobile fix silently break laptop behavior that already works. **Entry 24 result:**
  this discipline caught a real problem — a mobile-motivated fix (9a) broke laptop
  worse than the mobile bug it was meant to solve. Fully reverted as a result.

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
  separate mobile symptoms: the click-to-word "sticky" resume bug, mouth-close
  overshoot, and the Phase 11b trouble border staying pinned/blinking.
  **Phase 9a attempted and reverted (Entry 24) — shelved as unsolved, not just "not
  yet built."** Built: bounded each utterance to one sentence (`findSentenceEnd()`)
  instead of all remaining text, so a `cancel()` overrun would be capped. First
  version auto-continued into the next sentence from inside `onend` when the mouth
  was still open — this reproduced Entry 16's freeze (`speak()` called off a
  previous utterance's `onend`) even though it was routed through `onMouthOpen()`'s
  normal gating; the browser doesn't care which function triggers it. Reverted that
  part — natural chunk completion only updates the resume point and waits for a
  genuine fresh mouth-open/click, never calls `speak()` itself. **Still froze on
  laptop**, mid-sentence, unrecoverable by any mouth action for the rest of the
  session (confirmed live: audio silent, `onboundary` stuck at 3 events, cadence
  blown out ~10x, no recovery via mouth tricks or clicking a different word). Root
  cause: Entry 16's warning wasn't only about *chained* `speak()` calls specifically
  — it's repeated `speak()` calls generally within one session that wedge
  Chromium's engine. Sentence-chunking raises call frequency across a reading
  session a lot (was ~1 `speak()` per manual resume across the whole text; became
  ~1 per sentence encountered), enough on its own to hit the same ceiling even
  through the fully explicit, non-chained, mouth-open-only path. **Fully reverted
  `main.js` to pre-9a (one utterance per manual resume) — confirmed stable again.**
  This is a real platform ceiling in the Web Speech API, not an implementation bug;
  a fix needs a different bounding mechanism entirely (or accepting the ceiling and
  solving overrun another way) — needs a dedicated session, not a quick patch.
  Mobile remains affected by the original three symptoms, untouched since revert.
- **No-face-detected safety gap (Phase 9b) — fixed and tested, Entry 24. Closed, no
  open flags.** `predictLoop()` tracks a gap timer (`NO_FACE_TIMEOUT_MS=500`) when
  MediaPipe returns zero landmarks; past the timeout during an active reading
  session it trips the facing gate the same way a yaw/pitch threshold trip does
  (`onMouthClosed()`, trouble pulse, indicator text). Recovery is free —
  `updateHeadPose()`'s existing resume-on-return logic picks it up once a face
  reappears, no duplicate code needed. Passed a full extreme-case test pass:
  correct resume word after a mid-sentence camera-cover, no false-trip on a
  sub-500ms wave-across, clean behavior across rapid cover/uncover, silent no-op
  when mouth was already closed, a long (10-15s) cover held stable, trouble-pulse
  fires on trip. One accepted cosmetic quirk, not a bug: if the yaw/pitch gate
  already tripped ("looking away") and the camera is then also covered, the label
  stays "looking away" rather than switching to "no face detected" —
  `isFacingScreen` is already `false` so the label-setting branch doesn't run.
  Harmless since speech is already stopped either way; low priority to special-case
  if ever revisited.
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
  **One pose issue still open (Entry 23), not yet fixed:**
  - **(9c) Off-axis calibration doesn't hold across reading postures:** thresholds
    calibrated sitting upright, camera centered. Lying down (a real target-audience
    use case) shifts the face's position in-frame in a way that seems to affect
    yaw/pitch beyond genuine head-angle change — student had real difficulty
    registering "facing screen" while lying down. Not yet root-caused. May connect
    conceptually to Phase 13 (recalibration robustness), which is about distance
    drift rather than off-axis position — worth checking whether it's the same
    underlying gap once investigated. **Set aside alongside 9a for now (Entry 24)
    — not pursuing mobile/pose-edge-case work further right now.**
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
  **New gap found Entry 26, not yet fixed — scoped as Phase 12a:**
  `estimateSyllables()` strips everything outside `[a-z]` before counting vowel
  clusters. Two consequences, both invisible under the old fixed `READING_TEXT`
  (which had neither) and now real now that Phase 10a allows arbitrary text:
  - **Numbers undercounted:** `"1999,"` → 1 syllable, but Web Speech will actually
    speak it as "nineteen ninety-nine" (far more syllables) — cadence pacing runs
    ahead of the real spoken duration on any numeric-heavy text (dates, prices,
    addresses).
  - **Accented/non-English words unreliable:** `"café"` → 1, `"naïve"` → 1 (should
    be ~2), `"jalapeño"` → 3 — accent-stripping wasn't designed with loanwords in
    mind.
  Confirmed via a scripted test pass (Entry 26) against a battery of arbitrary text
  (whitespace/newlines, curly quotes, em-dashes, hyphenation, ALL CAPS, a 20k-word
  stress test) — word-splitting itself held up cleanly (no crashes, no zero-length
  spans) and all previously-tuned silent-e regression cases still pass; only the
  syllable-counting rules for digits/accents need extending. Deterministic fix,
  no `speechSynthesis` involved — low risk, doesn't need its own dedicated session
  the way 9a/12b do.
- **Movement-range smoothing (Phase 6a):** `WINDOW_MS=300`. Confirmed still working
  correctly on mobile (Entry 23 diagnostics) — not implicated in the overshoot bug.
- **Calibration mode (Phase 7b):** 4-step wizard (neutral → mutter → facing →
  turned away) + Phase 11's 5th step (speed), saved to `localStorage`
  (`readingAppCalibration`) — **per-device/per-browser, does not sync** between
  e.g. desktop Chrome and mobile Chrome. Falls back to `DEFAULT_*` if nothing saved.
- **Emotional tone toggle (Phase 8a):** punctuation-based heuristic only
  (`!`/`?`/default), off by default. Tone decided once per resume, not
  per-sentence — per-sentence chaining was tried twice and explicitly rejected
  (wedged Chrome's speech engine both times, same bug *class* as the Edge freeze,
  and the same bug class Phase 9a hit a third time via a disguised chain — Entry
  24).
  **Robotic-voice problem surfaced Entry 26, scoped as Phase 12b (not yet
  started):** the tone toggle exists but wasn't enough to fix perceived voice
  quality — with real (non-test-paragraph) text now loading via Phase 10a, the
  default Web Speech browser voice reads as noticeably flat/robotic. Root cause is
  the browser's default voice's prosody itself, not something Phase 8a's
  punctuation heuristic was ever going to solve on its own. **Deliberately NOT
  bundled with Phase 12a (duration estimation)** even though both surfaced in the
  same session — 12a is a pure, deterministic string-logic fix; this one requires
  listening/tuning against the live `speechSynthesis` engine, the same subsystem
  that has already caused two confirmed freezes (Entry 16, Entry 24). Gets the
  same caution and its own dedicated session as 9a, not folded into a "fix voice
  stuff" grab-bag. Candidate directions to evaluate when this phase starts (not
  decided yet): trying alternate installed voices via `speechSynthesis.getVoices()`
  (quality varies a lot browser/OS-to-browser/OS, still $0), revisiting whether a
  non-chaining variant of per-sentence tone application is possible now that Phase
  9a's root cause (call-frequency ceiling, not chaining specifically) is better
  understood, or accepting current voice quality as a platform limitation the same
  way 9a's ceiling was accepted.
- **Explicitly rejected, not deferred:** mic-based audible-speech safeguard (dead
  weight for the ALS/paralysis audience, new permission prompt); ROI cropping
  (recalibration risk not worth the battery gain vs. dynamic frame rate); per-
  sentence tone chaining (see above); **sentence-chunked TTS utterances (Phase 9a,
  Entry 24 — not rejected by design choice, but by a confirmed platform ceiling;
  see above, may be revisited with a different mechanism)**.
- **Phase 7c:** dynamic frame rate, `IDLE_FRAME_INTERVAL_MS=100`.
- **Text input (Phase 10a) — shipped, deployed to Vercel, Entry 26.**
  `READING_TEXT` (hardcoded const) replaced with `currentText` (mutable, starts
  `null`). Textarea is the single source of truth for both manual typing/testing
  and `.txt` uploads — a file's contents load into the box rather than bypassing
  it, so one "Load Text" action handles both paths and the student can review/edit
  an uploaded file before committing it. `hasLoadedText()` gates Start Reading
  everywhere it's re-enabled (including all three calibration-flow exit points,
  which previously unconditionally re-enabled it) via a shared
  `updateStartButtonState()`. Loading new text hard-stops any in-progress session
  first (`cancel()` + flag reset, same pattern already used elsewhere) before
  rebuilding word spans, so `baseOffset`/`wordSpans` can never end up pointing at
  stale text. Persisted to `localStorage` (`readingAppText`, same pattern as
  `readingAppCalibration`) and auto-restored on load. Old fixed test paragraph
  kept only as a textarea *prefill* (not baked into `currentText`), so one-click
  quick testing still works without typing anything. Test pass against arbitrary
  text (see cadence entry above) confirmed word-splitting itself is solid; the
  numbers/accents gap that pass surfaced became Phase 12a.
- **Webcam/mesh visibility during reading (Entry 27, decided as part of scoping
  10c, not yet built):** the live webcam feed + mesh overlay will be hidden by
  default while actually reading — visible only during the calibration wizard,
  where the student needs to see themselves to position correctly. Rationale:
  Mumblew's actual audience (reading in bed/dark, low-focus readers, ALS/paralysis
  users) has no reason to want to watch their own face on a green mesh while
  trying to read or fall asleep; it belongs to the "test harness" phase of the
  project, not the product. Tracking/MediaPipe processing keeps running underneath
  regardless (the mouth/pose signal still needs it) — this is a *rendering* choice
  only, not a functional one. Folded into Phase 10c rather than treated as a
  separate mobile-layout fix (see Phase 10 entry below for why 10b was dropped as
  a standalone phase).

### 3b. Scope decisions

- Platform: Web app, Chrome-first. Cross-browser support not a priority pre-demo.
- Security: `textContent` never `innerHTML` (XSS guard), pinned CDN versions, CSP
  header, camera-privacy disclosure, HTTPS via Vercel. Full review deferred to
  Phase 14 (after file upload in Phase 10 actually expands the attack surface).

### 3c. Phases 9-15 (scoped Entry 14/15, revised Entry 22-27)

- **Phase 9 — Mobile bug fixes**, split as issues were found live-testing (Entry
  22-23):
  - **9a — Mobile speech-engine event unreliability. Attempted and reverted, Entry
    24 — shelved as unsolved, not just "not yet built."** Root cause of the
    original mobile symptoms still confirmed (see Section 3), but the chunking fix
    hit a real Web Speech API ceiling (repeated `speak()` calls per session, not
    just chained ones, wedge Chromium) — reproduced on desktop too. Needs a
    different approach and a dedicated session, not a quick follow-up.
  - **9b — No-face-detected safety gap. Fixed, tested, closed — Entry 24.** Not
    mobile-exclusive; benefits both platforms. See Section 3.
  - **9c — Off-axis/lying-down pose calibration.** Not yet root-caused. Set aside
    for now alongside 9a/mobile-specific work (Entry 24 decision).
- **Phase 10 — UI redesign + text input.** Now three sub-phases (revised Entry
  27 — was four; 10b dropped, see below). Self-contained — doesn't touch the
  fragile speech or pose subsystems at all. **Build order: 10a → 10c → 10d.**
  - **10a — Text input. Shipped, deployed to Vercel — Entry 26.** Paste/type +
    `.txt` upload, wired to replace the hardcoded `READING_TEXT`. Test pass done
    (see Section 3). Surfaced two follow-on issues, deliberately spun out rather
    than fixed inline: duration-estimation gaps on numbers/foreign words (→ Phase
    12a) and a robotic-voice-quality concern (→ Phase 12b, unrelated root cause,
    kept separate).
  - ~~**10b — Portrait/vertical mobile layout fix.**~~ **Dropped as a standalone
    phase (Entry 27).** Originally scoped to fix the hardcoded 640×480
    `#container`/`#webcam`/`#overlay` stretching a portrait phone camera stream.
    Reconsidered once the student pointed out (1) mobile-specific work is
    already paused (9a/9c) and (2) more fundamentally, 10c is going to hide the
    webcam/mesh view during actual reading anyway (see Section 3) — so a
    general-purpose portrait fix for a view most readers won't be looking at
    during reading was solving the wrong scope. What actually still needs
    portrait handling is much narrower: just the **calibration view**, where the
    video is genuinely shown. That's a small piece of layout work, folded into
    10c and designed once alongside the webcam-visibility decision, rather than
    patched separately beforehand and possibly thrown away once 10c changes when
    the video is even shown.
  - **10c — Full visual redesign. Shipped, Entry 28. No open flags.** Logo
    integrated (`mumblew_logo.png` — background removed from student's source
    file, cropped clear of corner decoration). Dark palette (teal/blue/gold/
    coral/pink accents on a near-black teal-tinted bg) themed site-wide via CSS
    vars. Webcam/mesh hidden by default (`.video-hidden` class: opacity+1px
    box, not `display:none`, so MediaPipe keeps reading frames underneath —
    resolves Entry 27's open question), shown only during calibration
    (`setCalibrationVideoVisible()`, toggled at calibration start/cancel/
    finish, but *not* on failure so the retry view stays visible). Former 10b's
    portrait fix folded in as `updateVideoBoxSize()` — sizes the calibration
    video box to the real stream's aspect ratio instead of a hardcoded 640x480.
    Debug panel converted to a native `<details>`, closed by default, no JS
    needed. Light CSS-only animation last (entrance fades, button hover,
    Start-Reading ready-glow, border shimmer) — all teal/neutral, never red,
    never touches `.word.active`, wrapped in `prefers-reduced-motion`.
  - **10d — `.pdf` upload:** full PDF text-extraction support, split out as
    its own sub-phase rather than deferred/cut (Entry 25 correction — student
    wants this feature, just isolated since it's the one piece with real
    added complexity). Needs `pdf.js` as a new CDN dependency (same pattern as
    MediaPipe — loaded from jsdelivr) plus a `vercel.json` CSP update
    (`script-src`/`connect-src`) to allow it. Comes after 10a/10c so the
    simpler text-input paths (paste/`.txt`) and the redesigned UI they live in
    are solid first; the PDF upload control's placement/styling in 10c should
    still leave room for it to slot in without another layout pass. Once 10d
    ships, revisit whether `localStorage` is still the right persistence layer
    for Phase 10a's saved text — PDF-extracted text can get much larger than
    typed/pasted text, and IndexedDB (considered and deliberately deferred at
    10a, Entry 26) may be worth it then, not before.
- **Phase 11 — Personalized speed calibration.** Shipped Entry 18, clamp bug fixed
  Entry 23. Closed, no open flags.
- **Phase 11b — Ambient trouble-shading.** Shipped Entry 19-21. Mobile
  blinking symptom traced to the same root cause as 9a — still open on mobile
  since 9a is shelved, not separate work.
- **Phase 12a — Duration estimation accuracy (new, Entry 26). Not started.**
  Extend `estimateSyllables()` to handle numbers (digit-aware syllable
  approximation) and accented/non-English characters, surfaced by Phase 10a's
  test pass. Deterministic, no `speechSynthesis` involved — low risk, doesn't
  need a dedicated session the way 12b does. See Section 3 for full detail.
- **Phase 12b — Voice quality / robotic tone (new, Entry 26). Not started.**
  Address the flat/robotic default Web Speech voice, surfaced once real text
  (rather than the old test paragraph) started going through the app. Touches the
  live `speechSynthesis` engine — same caution and dedicated-session treatment as
  9a, deliberately not bundled with 12a. Candidate directions listed in Section 3,
  none decided yet.
- **Phase 13 — Distance/recalibration robustness** (renumbered from 12, Entry 26).
  Not started. May turn out related to Phase 9c.
- **Phase 14 — Full security review** (renumbered from 13, Entry 26; after Phase
  10).
- **Phase 15 — Shipping prep + paywall** (renumbered from 14, Entry 26). Ethical
  flag to revisit then: target audience includes ALS/paralysis users — a paywall
  by default deserves a deliberate decision, not a default.

## 4. Roadmap

- [x] **Phases 0-8a:** webcam/facemesh, MAR play/pause, word highlighting +
      head-pose gating, click-to-word resync, Vercel deploy, movement-range
      smoothing, cadence-based pacing, head-pose calibration wizard, dynamic frame
      rate, emotional tone toggle. All deployed. Full details in Section 3.
- [ ] **Phase 8b:** Voice cloning — needs a scope conversation (budget/privacy
      tension), not a build session.
- [ ] **Phase 8c:** Offline mode — not started, feasible free.
- [ ] **Phase 9a:** Mobile speech-engine event unreliability — attempted and
      reverted (Entry 24), shelved as an unsolved platform ceiling. Revisit in a
      dedicated session, different approach needed.
- [x] **Phase 9b:** No-face-detected safety gap — fixed, tested, closed (Entry 24).
      No open flags.
- [ ] **Phase 9c:** Off-axis/lying-down pose calibration — not yet root-caused.
      Set aside alongside 9a for now.
- [ ] **Phase 10:** UI redesign + text input. Three sub-phases (revised Entry
      27): 10a / 10c / 10d. Build order: 10a → 10c → 10d.
  - [x] **10a:** Text input (paste + `.txt`) — shipped, deployed to Vercel
        (Entry 26). Surfaced Phase 12a/12b as follow-on work.
  - ~~**10b:** Portrait/vertical mobile layout fix~~ — dropped as a standalone
        phase (Entry 27); the narrow piece still needed (calibration-view
        portrait handling) folded into 10c.
  - [x] **10c:** Full visual redesign — shipped, Entry 28. No open flags.
  - [ ] **10d:** `.pdf` upload (needs `pdf.js` + CSP update) — not deferred,
        own sub-phase. Also the point to revisit `localStorage` vs IndexedDB
        for saved text. **Next up.**
- [x] **Phase 11:** Personalized speed calibration — shipped, clamp bug fixed
      Entry 23. No open flags.
- [x] **Phase 11b:** Ambient trouble-shading — shipped; mobile blinking is a 9a
      symptom, still open since 9a is shelved.
- [ ] **Phase 12a:** Duration estimation accuracy (numbers, foreign words) — new,
      Entry 26. Not started. Low-risk, deterministic fix.
- [ ] **Phase 12b:** Voice quality / robotic tone — new, Entry 26. Not started.
      Touches live speech engine — needs its own dedicated session, like 9a.
- [ ] **Phase 13:** Distance / recalibration robustness (renumbered from 12).
- [ ] **Phase 14:** Full security review pass (renumbered from 13; after Phase 10).
- [ ] **Phase 15:** Shipping prep + paywall (renumbered from 14).

## 5. Current status

Project folder `reading-app` (app name: **Mumblew**): `index.html` + `main.js`,
deployed to Vercel. Phases 0-8a complete and deployed. Phase 11/11b shipped (11b
has an open mobile symptom, tied to shelved 9a). Phase 10a shipped and deployed to
Vercel (Entry 26) — student tested locally and confirmed live.

**Mobile-specific work remains paused (Entry 24).** 9b is fixed/closed. 9a was
attempted, caused a worse regression than the bug it targeted, and was fully
reverted — shelved as an unsolved platform ceiling. 9c (lying-down pose) remains
unexplained. Not being chased right now.

**Phase 10c shipped (Entry 28)** — see Section 3 for full detail. `index.html`/
`main.js` now include the dark theme, logo, webcam-hidden-by-default behavior,
collapsible debug panel, and light animation, on top of Phase 10a's text input.
Project now has a third asset: `mumblew_logo.png` (transparent, dark-mode ready)
sits alongside `index.html`/`main.js`.

**Phases 12a/12b (Entry 26) remain not-yet-started, unaffected by 10c:**
duration-estimation gaps (numbers/accented words) and robotic default-voice
quality — see Section 3 for detail on each.

**Next up: Phase 10d** (`.pdf` upload).

Temporary diagnostics still live in the debug panel from the Entry 22-23
mobile-testing effort (boundary event counter, last-onboundary timer, speed-fit
raw readout, sticky detection-gap and cancel-to-stop-gap readouts). Since 9a is
shelved rather than closed, leave these in place — they're exactly what a future
9a attempt will need again, and stripping them now just means rebuilding them
later.

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
- **Entry 24 (Jul 24):** Built Phase 9a — bounded TTS utterances to one sentence
  instead of all remaining text. Found and fixed a real bug in the first version
  (resume point would re-speak a sentence's last word). First version also
  auto-continued into the next sentence from `onend`, disguised through
  `onMouthOpen()`'s gating — this reproduced Entry 16's freeze; removed it. A
  second, worse freeze still surfaced on **laptop** mid-sentence, unrecoverable
  for the rest of the session — traced to sentence-chunking simply raising
  `speak()`-call frequency past Chromium's tolerance in general, not just chained
  calls specifically — a real platform ceiling, not an implementation bug. Fully
  reverted `main.js` to pre-9a. Built and fully tested Phase 9b (no-face-detected
  safety gap) — six-case extreme test pass, all passed; closed, no open flags.
  Decided to stop pursuing mobile-specific work (9a, 9c) for now; Phase 10 next.
- **Entry 25 (Jul 24):** Scoping discussion only, no code changed. Broke Phase
  10 into 10a (text input: paste/`.txt`) / 10b (portrait/mobile layout fix) /
  10c (full visual redesign — student clarified this is a deliberate shift
  from "test harness" toward a real product for the app's actual audience,
  not just cosmetic cleanup) / 10d (`.pdf` upload via `pdf.js` + CSP update —
  student corrected an earlier plan to stub/defer this: it's not cut, just
  isolated as its own sub-phase since it's the one piece with real added
  complexity). Build order confirmed: 10a → 10b → 10c → 10d. Decided the
  debug panel gets made collapsible/toggleable, hidden by default, in 10c
  rather than removed — its diagnostics still need to stay reachable for a
  future 9a attempt. Next session starts 10a.
- **Entry 26 (Jul 24):** Built and shipped Phase 10a. Replaced hardcoded
  `READING_TEXT` with mutable `currentText`; added paste/type textarea +
  `.txt` upload sharing one "Load Text" action; gated Start Reading behind
  `hasLoadedText()` everywhere it's re-enabled (including all three
  calibration-flow exit points); new text hard-stops any active session
  before rebuilding word spans; persisted to `localStorage`
  (`readingAppText`, same pattern as calibration) with auto-restore on load;
  old test paragraph kept only as a textarea prefill. Chose `localStorage`
  over IndexedDB for now (typed/pasted/`.txt` text is small; revisit once
  10d's PDF text can get large). Ran a scripted test pass against arbitrary
  text (whitespace, curly quotes, em-dashes, hyphenation, ALL CAPS, a
  20k-word stress test, full silent-e regression check) — word-splitting
  held up cleanly; surfaced a real gap in `estimateSyllables()` on numbers
  and accented/foreign words, invisible under the old fixed test paragraph.
  Student tested locally and deployed to Vercel; confirmed live. Student
  then flagged the default Web Speech voice sounds noticeably more robotic
  on real text than it did on the old test paragraph. Discussed and split
  the two newly-surfaced issues into separate phases rather than one bundled
  fix: **Phase 12a** (duration estimation on numbers/foreign words —
  deterministic, low-risk) and **Phase 12b** (voice quality/robotic tone —
  touches the live `speechSynthesis` engine, gets 9a-style dedicated-session
  caution, candidate directions listed but nothing decided). Inserted both
  before the old Phase 12, renumbering it and everything after
  (12→13 distance/recalibration, 13→14 security, 14→15 shipping/paywall).
  Phase 10's own build order (10a→10b→10c→10d) unaffected. Next up: 10b.
- **Entry 27 (Jul 24):** Scoping discussion only, no code changed. Student
  questioned whether standalone Phase 10b still made sense, given mobile
  work is paused and — more importantly — 10c will hide the webcam/mesh view
  during actual reading, making a general portrait layout fix for that view
  largely moot. Agreed: dropped 10b as a standalone phase; folded its one
  still-relevant piece (portrait handling for the calibration view, where
  video is genuinely shown) into 10c. Clarified and expanded 10c's scope in
  detail: branding foundation first (app name **Mumblew** confirmed, student
  has a logo already), then theme applied site-wide, then the
  webcam/mesh-hidden-during-reading change (with calibration-view portrait
  handling folded in here), then the existing collapsible-debug-panel plan,
  then light/restrained animation last — kept deliberately light so it
  doesn't compete with existing functional motion (trouble-border,
  word-highlight) or add load on top of the live MediaPipe loop. Flagged one
  open question for when 10c starts: whether the hidden webcam view should
  be removed from the DOM or just visually hidden while tracking continues
  underneath (assumption: the latter, not yet confirmed). Renamed project
  header/title in this file to Mumblew. Next up: Phase 10c.
- **Entry 28 (Jul 24):** Built and shipped Phase 10c (all 5 steps — see
  Section 3). Logo processed from student's source image (bg removed,
  cropped clear of corner decoration) into `mumblew_logo.png`. No open
  flags. Next up: Phase 10d.
