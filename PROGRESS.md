# PROGRESS LOG — "Reading App" (working title)
Last updated: July 19, 2026 (Entry 20)

> HOW TO USE: Single source of truth. Claude reads this first in every new chat.
> Update before ending each session. If Claude contradicts this file, trust this file.
> Section 6 (session log) is intentionally kept terse — one line per entry. All real
> decisions/reasoning live in Section 3, not Section 6. Don't re-expand Section 6.

---

## 1. The Idea (Owner: student)

Privacy-first app: reads/listens to text using quiet mouth movement (subvocalization)
as the pacing signal, narrating via TTS driven by webcam lip-tracking instead of
buttons/timers.

Audiences: reading in the dark without light/sound; neurodivergent/low-focus readers
needing active engagement; people who can move their mouth but can't vocalize
(ALS, severe stutter, vocal cord paralysis) — assistive/humanitarian use case.

Three-state design:
- **State 1** (core, done): mouth movement = play/pace signal, text is known ground truth.
- **State 3** (done): click-to-word manual resync.
- **State 2** (done — cadence-based pacing): syllable-duration estimate informs
  pacing/close sensitivity. Not full stumble/viseme-shape matching (descoped, see
  Section 3).

Privacy goal: on-device/local-first (MediaPipe), video never leaves device.

Nice-to-haves (Phase 8, not started): emotional tone toggle, voice cloning, offline
mode. Battery optimization (dynamic frame rate) shipped in Phase 7c; ROI cropping
evaluated and explicitly descoped — not carried forward.

**ALS/paralysis audience refined (Entry 17), research-backed:** viable for
early/moderate bulbar ALS and vocal-cord paralysis with preserved oral-motor
control — early-stage bulbar ALS shows *larger* compensatory jaw movement, a
good detection signal. NOT viable for late-stage bulbar ALS — facial muscles
weaken to where patients shift to eye-tracking/AAC devices instead. Biological
ceiling, not a design gap; don't try to engineer around it.

## 2. Person's context

- 2nd semester CS student. Comfortable with logic, rusty on Python/HTML/CSS/JS.
- **Budget: $0**, no exceptions until final native app-store step (if ever taken).
  Default plan: ship as free web app (Vercel/Netlify/GitHub Pages).
- **Timeline:** flexible, part-time through semester, rough target Dec 2026.
- Claude = architecture lead ("captain"); student executes ("navigator").
- **Working style:** wait for explicit "start"/"next" before proceeding. At natural
  milestones, ask whether to update log now or keep going. Proactively suggest a log
  update if a chat is running long. Student prefers **starting a new chat per
  phase** (from Phase 9 onward) — this file is what carries context across that
  boundary, so keep it accurate and self-sufficient.
- **Deploy reminder:** Claude proactively asks about deploy status at the end of
  any phase that changes `main.js`/`index.html`.

## 3. Key decisions

- Web app (not native) — avoids store fees, TrueDepth limits, cross-platform via
  browser webcam APIs.
- Stack: MediaPipe Face Landmarker (in-browser, free) for face/mouth/head-pose;
  Web Speech API for TTS; Vercel/GitHub Pages for hosting. No build tools/npm — plain
  HTML/JS + `<script type="module">`, MediaPipe via jsdelivr CDN.
- Dev workflow: VS Code + Live Server (webcam needs secure context).
- **Speech architecture (locked in Phase 3):** `pause()`/`resume()` on
  `speechSynthesis` is NOT used anywhere — it caused Edge's TTS engine to permanently
  freeze after a few readings (Windows-level bug). Fixed by using only
  `speak()`/`cancel()`: one continuous utterance runs while the mouth stays open;
  closing the mouth calls `cancel()` and remembers the last completed word (via
  `onboundary` char offset); reopening starts a fresh utterance from that offset.
  **`utterance.rate` is never set** (confirmed Entry 14 by direct code check) — TTS
  always plays at the Web Speech API default (1.0), regardless of user. This is the
  hook Phase 11 (see below) will use.
- Head-pose gating (yaw/pitch, from MediaPipe's `facialTransformationMatrix`) blocks
  the mouth signal from resuming/advancing speech when the user isn't facing the
  screen. No new model — reuses data already computed each frame. Gating also
  actively stops/resumes in-flight speech on facing-state change (Phase 7a fix) —
  looking away mid-utterance now correctly stops speech, not just blocks new starts.
- **Click-to-word resync (Phase 4):** clicking a word reuses the exact same
  `cancel()` path as mouth-close, then reuses the same `baseOffset`/
  `lastBoundaryOffset` bookkeeping `onMouthOpen` already relies on.
- **Phase 6 scope decision:** Option B (cadence-based pacing via duration
  prediction) chosen over (A) stumble-detection-only and (C) full viseme/shape
  matching. C explicitly rejected as out of scope — needs a new ML model, conflicts
  with no-library/no-budget constraint.
- **Cadence-based pacing (Phase 6b, refined Entry 13):** `estimateSyllables(word)`
  approximates syllable count via vowel-cluster counting, no dictionary. Handles:
  punctuation stripped before checking; consonant+"le" endings (table/little/single)
  correctly NOT treated as silent-e; true silent-e (home/like/time/sentence) IS
  subtracted; **mid-word silent-e suffixes** (`SILENT_E_SUFFIXES`:
  ment/ness/less/ful/ly/ship/ward/some — e.g. "movement", "careless") also correctly
  subtracted (Entry 13 fix, was a known gap before that). No remaining known gaps in
  the syllable estimator as of Entry 13.
  `estimateWordDuration(word) = BASE_WORD_MS (120) + syllables * MS_PER_SYLLABLE (220)`
  — both constants are still unvalidated starting guesses, identical for every user,
  not live-tuned like MAR was. **Phase 11 will personalize these per-user** instead
  of just doing a general tuning pass (see below) — flagged Entry 10, addressed
  Entry 15.
  Expected duration dynamically scales the mouth-close-detection threshold (stricter
  while under expected time, looser once past it).
- **Head-pose live-calibration (Phase 7a):** `YAW_THRESHOLD = 26°`,
  `PITCH_THRESHOLD = 21°` — live-boundary-tested defaults, same tier as MAR/cadence.
  May be overridden per-device by Phase 7b calibration.
- **Mic-based audible-speech safeguard: explicitly rejected (Entry 11), not
  deferred.** Dead weight for the ALS/vocal-cord-paralysis audience (never fires for
  them); requires a new mic-permission prompt for everyone, undercutting the "no
  sound needed" pitch; existing defenses (MAR hysteresis, movement-range smoothing,
  head-pose gating) already cover most practical false-trigger cases.
- **Calibration mode (Phase 7b):** Scoped to MAR (open/close) + head-pose
  (yaw/pitch) only. Movement-range threshold and cadence constants stay fixed —
  they were tuned from live reading behavior across multiple entries, not a single
  static pose, so a short guided step can't derive them the same way. 4-step wizard
  (neutral face → silent mouthing → facing screen → turned away), results saved to
  `localStorage` (`readingAppCalibration`), falls back to `DEFAULT_*` constants if
  nothing saved. Threshold derivation: MAR close/open at 33%/67% of the
  neutral-to-mutter gap; yaw/pitch taken from the measured turned-away boundary,
  floored at `MIN_POSE_THRESHOLD = 8°`. `MIN_MAR_GAP = 0.015` and the pose floor
  double as validation — failed runs are rejected (nothing saved) with a retry
  prompt. Failure/retry branch confirmed live for both failure modes (Entry 13) —
  retry restarts the full wizard from step 1, by design. **This wizard framework is
  what Phase 11 extends with a 5th step** — same "watch a live number while doing a
  specific action" pattern, not new architecture.
- **Phase 7c — dynamic frame rate (done):** `predictLoop` throttled to
  `IDLE_FRAME_INTERVAL_MS = 100` (~10fps) whenever neither `readingActive` nor
  `calibration.active` is true. Full rate preserved during active reading and
  calibration. `scheduleNextFrame()` wraps the choice between plain
  `requestAnimationFrame` and a `setTimeout`-delayed one.
- **ROI cropping: explicitly evaluated and rejected (Entry 13), not deferred.**
  Cropping risks silently shifting the live-calibrated yaw/pitch numbers from
  Phase 7a/7b (head-pose estimation is sensitive to field-of-view). Given the model
  already runs GPU-delegated and dynamic frame rate already addresses the largest
  real battery cost (idle polling), the payoff didn't justify the recalibration risk.
- **Phase 7 (a/b/c) confirmed fully deployed to Vercel as of Entry 13/14** —
  including the dynamic frame rate + silent-e fixes (verified present in `main.js`
  and confirmed pushed by student, Entry 14). No outstanding deploy debt.

- **Phase 8 split into 8a/8b/8c (Entry 16).** Originally one phase (emotional
  tone toggle, voice cloning, offline mode). Split like Phase 6/7 were, since
  the three features have very different risk/budget profiles:
  - **8a — Emotional tone toggle: done, with a documented limitation.**
  - **8b — Voice cloning: not started.** Flagged as likely in conflict with
    the $0 budget and the "video/data never leaves device" privacy pitch —
    real cloning needs a cloud model. Needs its own scope conversation
    (same treatment as ROI cropping/mic safeguard) before any build attempt.
  - **8c — Offline mode: not started.** Free/feasible (service worker +
    cache), untouched so far.
- **Phase 8a — emotional tone toggle (Entry 16): per-sentence chaining
  explicitly rejected, same category as ROI cropping / the mic safeguard.**
  Punctuation-based heuristic (`getToneForSentence`): `!` → pitch 1.3/rate
  1.1, `?` → pitch 1.15/rate 1.0, `.`/default → neutral (pitch/rate 1.0,
  identical to the untouched Web Speech default). `findSentenceEnd()` locates
  the next `.`/`!`/`?` via regex from a given offset; known limitation, not
  handled: doesn't distinguish abbreviations ("Mr.") from real sentence ends.
  Three attempts at true per-sentence precision within this one session, all
  failed:
  1. Chunk speech per-sentence, chain `speak()` calls back-to-back from
     inside `onend` to auto-continue into the next sentence. Wedged
     Chrome's speech engine into a desynced state (UI showing "closed" +
     "speaking" simultaneously, stuck sessions) — same bug *class* as the
     documented Edge pause/resume freeze (Section 3), different trigger.
     Reverted to one utterance per resume (tone decided once, from the
     sentence at the resume point) — but this meant tone rarely updates
     during smooth continuous reading, since real mouth-closes are
     intentionally rare (Phase 6a smoothing) — the original problem the
     student reported ("feels almost the same as original").
  2. Re-attempted chaining with a 150ms delay before each continuation, plus
     re-checking mouth/facing state when it fires, plus cleanup if the mouth
     closes mid-gap. Failed differently: `speak()` calls stopped firing any
     events at all (silent freeze, "open" + "speaking" shown but no
     progress) — matches Chromium's documented unreliability with repeated
     `speak()` calls in one session, not something catchable/recoverable
     from application code.
  3. Considered reworking Phase 6a's movement-range smoothing to allow a
     genuine mouth-close at sentence boundaries specifically (so tone would
     have a real resume point at every sentence). Rejected: would mean the
     app forcing an artificial stop the user didn't actually make with their
     mouth, undercutting the core State-1 principle that the user's real
     mouth movement is ground truth (Section 1) — too high a risk to a
     carefully-tuned core mechanism for a secondary feature.
  **Final shipped design:** one utterance per resume (mouth-open after a
  real close, or a click) — i.e. the pre-Phase-8 speech architecture,
  completely unchanged when tone is off. Tone is decided once per resume,
  from whichever sentence the resume point falls inside, and holds for the
  rest of that utterance. Accepted, documented limitation: during smooth
  continuous reading, tone may rarely change — a real tradeoff, not a bug.
  Pitch/rate values above are unvalidated starting guesses (never actually
  judged by ear — every test session got derailed by the stability bugs
  above first); may need live tuning like every other threshold here.
- **Head-pose "looking away" reported too strict (Entry 16) — flagged,
  NOT investigated or resolved.** Student reported the gating triggering
  even while facing the screen, requiring an unnaturally straight pose.
  Leading theory (untested): the Calibrate wizard was run before every test
  this session, and its "turned away" step may have only measured a slight
  turn, saving an overly tight threshold (floored at `MIN_POSE_THRESHOLD =
  8°`, see Phase 7b). Student dropped the issue mid-session ("never mind, it
  is ok") before diagnostic numbers (live Yaw/Pitch at rest vs. at the
  calibration turn-away point, and whether "Calibration" debug line showed
  calibrated vs. default) were collected. Revisit if it recurs — start with
  those numbers before changing anything.

- **Ambient trouble-shading (Entry 17): scoped, not built. New Phase 11b.**
  Addresses the detection-legibility paradox — reader can't feel their own MAR
  value, so silent misses feel arbitrary. Design: persistent border/strip around
  the reading pane (NOT the word highlight, which resets every word) drifts
  through red shades as a combined trouble score rises — slowly enough to feel
  ambient, not alarming — and fades back faster than it accumulates, so
  correction doesn't linger as false-red. Mockup built and validated live.
  Open questions before build: (1) one blended trouble score vs. one that hints
  which subsystem (MAR/pose/cadence) is unhappy; (2) needs a second, fast/sharp
  cue for hard failures — slow drift is the wrong shape for stuck-word-style
  failures; (3) should read off Phase 7b/11 calibrated thresholds (% distance
  from *this user's* threshold), not raw values — so it logically follows
  Phase 11; (4) hue alone insufficient for accessibility (red/green
  colorblindness) — pair with opacity/saturation.

- **Phase 11b — Ambient trouble-shading, shipped (Entry 19).** Built on top
  of Phase 11's calibrated thresholds, per plan. Answers to Entry 17's four
  open questions, locked in this session:
  1. **One blended score, not per-subsystem.** Combined via `max()` of pose
     trouble and cadence trouble (not average) — one badly-off subsystem
     should read as trouble even if others are fine, and an ambient signal
     is meant to be felt peripherally, not consciously parsed across
     multiple simultaneous hues.
  2. **Separate sharp pulse cue for hard failures** — a real head-pose gate
     trip, or a word stuck open well past its expected duration — layered on
     via `box-shadow` (not hue) on top of the slow ambient drift, so the two
     channels can't be confused as the same signal.
  3. **Reads off calibrated thresholds**, not raw values: pose trouble is
     `|yaw|/YAW_THRESHOLD` vs `|pitch|/PITCH_THRESHOLD` (this user's
     Phase 7b thresholds); cadence trouble is elapsed vs.
     `currentWordExpectedMs` (Phase 11's personalized cadence). Both fall
     back to `DEFAULT_*` automatically the same way everything else already
     does when uncalibrated.
  4. **Hue paired with opacity + saturation**, not hue alone, for red/green
     colorblind accessibility — calm state is low-opacity/low-saturation,
     trouble raises both together with the red hue fixed.
  Explicit audience-driven call (raised this session, not just a general
  restatement of the project motto): "room for error, not zero error" is the
  deliberately *correct* target here, not just acceptable — a jumpy,
  quick-to-redden border would read as the app scolding exactly the kind of
  movement variability its target audience (dark-reading, low-focus,
  early-stage-bulbar-ALS/vocal-cord-paralysis users, Section 1) is expected
  to have. This is why accumulate/recover rates are asymmetric
  (`TROUBLE_ACCUMULATE_RATE = 0.04` vs `TROUBLE_RECOVER_RATE = 0.12`, ~3x
  faster recovery) and the pulse has a `TROUBLE_PULSE_COOLDOWN_MS = 1500`
  debounce — both new, not carried over from an existing pattern.
  Mechanics (`main.js`):
  - `computePoseTrouble()` / `computeCadenceTrouble()`: both normalized 0-1
    against calibrated thresholds; cadence trouble ramps to 1 at
    `TROUBLE_CADENCE_OVERRUN_CAP = 2.5`x the expected word duration, and is
    0 whenever no word is currently open (not just "not reading").
  - `updateTroubleShading()`: runs once per frame in `predictLoop` (skipped
    during calibration, mirroring the existing head-pose-gating skip);
    smooths the raw score into `displayedTroubleScore` with the asymmetric
    rates above, then paints `#readingPane`'s `border-color` as
    `hsla(0, saturation%, 45%, opacity)`.
  - `checkReadingStallPulse()`: a live-reading analog of calibration's
    stall detection (Phase 11), but non-blocking — nothing aborts or
    retries, it only fires the sharp pulse. Deliberately looser
    (`READING_STALL_FACTOR = 3`) than calibration's hard-fail factor (5x),
    since firing earlier is fine/useful for a non-blocking nudge, and real
    reading has genuine long pauses (re-reading, thinking) that aren't
    errors — exactly what the cooldown protects against over-flagging.
  - `maybeFireTroublePulse()`: also called directly from `updateHeadPose` on
    an actual gate trip (facing → looking away while `readingActive`), not
    just from the stall check — a gate trip is itself the event, not
    something that needs to be inferred from a gradually rising score.
  - `resetTroubleShading()`: called on every fresh Start Reading click and
    on `finishReading()`, so a new session (or the calm-down after finishing)
    doesn't inherit a lingering score or pulse cooldown from before.
  - New debug line: `Trouble score: <span id="troubleValue">`, same pattern
    as every other live value already on screen.
  - No new libraries, no new permissions, no data leaving the device —
    entirely derived from state already computed each frame.
  **Not built this session** (left for real testing, not guessed at):
  actual live tuning of `TROUBLE_ACCUMULATE_RATE` / `TROUBLE_RECOVER_RATE` /
  `TROUBLE_CADENCE_OVERRUN_CAP` / `READING_STALL_FACTOR` against a real
  reading session — all four are reasoned starting guesses (same tier as
  every other new-feature constant in this project before its first live
  test), not yet watched against a live debug readout the way MAR/pose/
  cadence originally were.

  **Bugfix (Entry 20): cadence trouble was using the wrong clock, causing a
  permanently red/blinking border during completely normal smooth reading.**
  Student caught it live: MAR/mouth/speech/pose all showed a clean "facing
  screen, speaking, mouth open" read, yet Trouble score sat at 1.00, with
  Cadence (elapsed/expected) reading `20576 / 574ms`. Root cause: the first
  cut of `computeCadenceTrouble()`/`checkReadingStallPulse()` reused
  `mouthOpenStartTime`/`currentWordExpectedMs` (Phase 6b), which only reset
  on a closed→open *transition* — during smooth continuous reading (Phase
  6a's whole point is that real mouth-closes stay rare), the mouth can stay
  "open" across dozens of words in a row, so "elapsed since mouth opened"
  kept climbing across the entire open stretch while being compared against
  just the *one* word's expected duration from when that stretch began. The
  smoothest, most successful reading was the exact case that maxed out the
  trouble score — the opposite of the intended behavior.
  Fix: introduced a separate clock, `lastWordBoundaryTime` +
  `currentSpokenWordExpectedMs`, reset on every real word boundary (inside
  `highlightWordAt`, which fires on every `onboundary` event regardless of
  whether the mouth itself closed) rather than only on mouth-open
  transitions. Also primed at the top of `speakFrom()` for the resume word
  specifically, covering two gaps `onboundary`-only resetting would've
  missed: (a) the delay between `speak()` being called and the browser's
  first boundary callback landing, and (b) `highlightWordAt`'s existing
  no-op-if-same-word guard, which would otherwise leave a stale clock in
  place when resuming the same word after a brief mouth close — exactly
  when a fresh clock matters most.
  `mouthOpenStartTime`/`currentWordExpectedMs` themselves were NOT touched —
  they're still correct and still used for their original Phase 6b job (the
  mouth-close smoothing gate in `updateMouthState`'s `dynamicRangeThreshold`
  logic, which legitimately does want "since this open phase began").
  Trouble-shading now has its own independent, per-word-accurate clock
  instead of borrowing one built for a different purpose.
  Side benefit, not yet exercised: because this clock now tracks real
  `onboundary` events specifically, a genuinely frozen/stalled TTS engine
  (the documented Chromium `speak()` freeze — Section 3, Phase 8a) would
  also now surface as trouble-shading/pulse activity, not just a stuck
  reader mouth — untested, but a reasonable expectation given the mechanism.

- **Phase 11 — Speed calibration step, shipped (Entry 18).** 5th wizard step
  ("Your pace"), `main.js`. Mechanism: peak-trough envelope detection on
  (lightly EMA-smoothed) MAR — NOT absolute open/close crossing like the main
  reading loop — confirms a word boundary at each local minimum that dips by
  `prominenceThreshold` below the preceding peak. Chosen after live testing
  showed absolute-threshold detection badly merges words during natural
  connected mouthing (a negative regression slope was the tell).
  Key mechanics/constants (all in `main.js`, all live-tuned from real testing
  this entry, not guesses):
  - `SAMPLE_SENTENCE`/`SAMPLE_WORDS`: fixed sentence, syllable-diverse (via
    the app's own `estimateSyllables`, spread 1-5). Mouthed **twice**
    (`RATE_PASSES = 2`) — one pass produced a noisy regression even with
    zero detection failures (syllable count is a crude proxy for real
    timing); pooling two passes lets each word's noise average against an
    independent second measurement of that same word.
  - `RATE_PROMINENCE_FRACTION = 0.15` (was 0.25): lowered after diagnostic
    logging showed words with less inherent jaw-drop ("fluttered",
    "quietly", "enormous") producing swings near/under the old threshold on
    genuine attempts — not a speed issue, a phonetic-content one (MAR
    measures vertical opening; lip/tongue-heavy words are quieter on that
    axis regardless of clarity). "Quietly" in particular has stalled/needed
    repeats in 3+ separate test runs — flagged as a known soft spot, not
    something needing more engineering.
  - `MIN_INTER_TROUGH_MS = 200`: refractory period after each confirmed
    trough. Needed after testing showed loose/fast mumbling can produce
    enough within-word wobble to trigger multiple false boundaries per real
    word (detector visibly "raced ahead" of the speaker) — standard
    peak-detection debounce fix.
  - Reaction-time bug (fixed): first-word duration was being measured from
    the countdown's end, not from when real movement started, silently
    folding in reaction-time lag. Fixed via a baseline+prominence-gated
    commit out of an initial 'unknown' state before the clock starts.
  - Stall detection (working as designed, confirmed live Entry 18): if a
    word isn't detected within `RATE_STALL_FACTOR` (5x) its generic
    estimated duration (floored `RATE_STALL_MIN_MS = 2500`), the step fails
    outright with a named-word message rather than let the user push through
    repeats — repeats were found to silently corrupt every capture after
    them (wordIndex desyncs from the real spoken word with no way to detect
    it downstream). Confirmed live: a real stall was caught cleanly and
    named the correct word.
  - Outlier rejection: MAD-based (`RATE_OUTLIER_Z_THRESHOLD = 3.0`) on
    per-word PACE (duration/syllables, not raw duration) before the
    regression fit — real hesitation pauses happen even in a clean capture.
  - **No live per-word target display** — deliberately generic "Captured X
    of Y" text only, no word name shown during sampling. Found live: naming
    the target word turned "mouth at your natural pace" into "watch the
    screen and react to it," which measurably distorted the very pace being
    measured (syllable/duration correlation inverted when users could see
    what was expected next).
  - **Tried and reverted: adaptive prominenceThreshold** (re-derived from a
    rolling average of recently confirmed word swings, meant to track
    amplitude decline over a long utterance). Made results actively worse —
    a repeat's merged/inflated swing raises the threshold for the *next*
    word too, a feedback loop where one failure compounds the next. Fixed
    threshold (above) kept instead.
  - **Open, unresolved:** clamp bounds (`MIN_MS_PER_SYLLABLE = 80`,
    `MAX_BASE_WORD_MS = 300`, `MIN/MAX_PERSONALIZED_RATE = 0.5/2.0`) were
    guessed early against the *default* assumption that per-syllable cost
    dominates. Real fits across this entry's testing consistently show the
    opposite shape (large fixed per-word cost, small/near-zero per-syllable
    cost) — `personalizedRate` keeps landing on the exact same clamped
    corner value (1.272) across unrelated runs, meaning personalization may
    currently be reflecting the clamp, not the user. Needs real
    investigation before trusting `personalizedRate` in production — revisit
    before shipping this to end users, not blocking for internal
    testing/Phase 11b.
  - `MIN_RATE_WORDS_CAPTURED = 6`, `MIN_RATE_SYLLABLE_SPREAD = 2`: still
    original unvalidated starting guesses — never hit as the binding
    constraint in any real test (stall detection or outlier rejection
    always resolved runs first), so no real data to tune them from yet.
  - Applied in `speakFrom`: `utterance.rate = PERSONALIZED_RATE` always now
    (was unconditionally unset before this phase); multiplied by tone's rate
    when tone is on (`tone.rate * PERSONALIZED_RATE`), per explicit decision
    — personalized rate is the baseline, tone is an expressive nudge on top.
  - Backward compatible: pre-Phase-11 saved calibrations lack these fields;
    `applyCalibration` falls back to `DEFAULT_*` cleanly.
  - **Current status: accepted as "minimum error, not perfection."** Typical
    outcome is a clean pass; occasional single-word stalls happen and are
    caught cleanly with a clean retry (same failure/retry UX as the other 4
    wizard steps) — not chasing zero-stall reliability further.

### 3b. Scope decisions (Entry 6)

- **Platform:** Web app, Chrome-first (desktop). NOT building cross-browser/cross-device
  responsive support upfront — revisit post-demo based on real feedback.
- **Text input:** Scoped in Entry 6 for "Phase 4/5" (paste-textbox + `.txt` upload)
  but **never actually built** — confirmed Entry 14, `READING_TEXT` is still a
  hardcoded string in `main.js`. This is now Phase 10 (see roadmap). `.pdf` upload
  via `pdf.js` (CDN, sandboxed/worker mode) is part of the same phase.
- **Security (no backend = most classic upload/server attack surface doesn't apply):**
  - User text must render via `textContent`, never `innerHTML` (XSS guard).
  - Deployed already: SRI-equivalent (pinned CDN version, no `@latest` — true SRI
    doesn't apply since MediaPipe loads via JS `import`, not `<script>`), CSP header
    (`vercel.json`, includes `'wasm-unsafe-eval'` for MediaPipe's WASM compile),
    "video never leaves device" verified via DevTools Network tab, on-page
    camera-privacy disclosure line. HTTPS via Vercel (free, required for
    `getUserMedia` anyway).
  - Remaining security work deliberately deferred to **Phase 13**, scheduled after
    Phase 10 (upload) — see 3c.

### 3c. Phases 9-14 — scoped Entry 14, revised Entry 15, not yet built

Numbering starts at 9 (not 8) because Phase 8 is already reserved for the stretch
goals in Section 1 (emotional tone toggle, voice cloning, offline mode) — unstarted,
lower priority than 9-14. Order below is deliberate, agreed with student:

- **Phase 9 — Mobile TTS restart bug fix.** Small, isolated, existing feature
  currently broken — cheap win, do first. **Root cause is NOT a hover/skip button**
  (checked: no such element exists in the code — each word span only has a plain
  `click` listener, no hover-triggered logic at all; student's initial theory ruled
  out by inspection, Entry 14). Working theory (consistent with Entry 8's original
  note): on the affected mobile browser/TTS voice, `onboundary` events aren't firing
  reliably, so `lastBoundaryOffset` goes stale and reopening the mouth resumes from
  an old position instead of where reading actually stopped. Needs live device
  testing to confirm before fixing.
- **Phase 10 — UI redesign + text input.** Paste-textbox, `.txt` upload, `.pdf`
  upload (`pdf.js`, sandboxed/worker mode), and a real visual/interaction design
  pass (currently bare-bones functional CSS only). Sequenced early because later
  phases (calibration extension, security, shipping) don't mean much while the app
  only reads one hardcoded paragraph — and it's the largest single chunk of
  remaining work, so tackling it while scope is fresh.
- **Phase 11 — Personalized speed calibration (new, added Entry 15).** Student's
  observation: TTS always plays at the Web Speech API default rate (confirmed fixed,
  see Section 3), which can feel like it's forcing a fast natural mumbler to slow
  down. `utterance.rate` (0.1-10 range) already exists as an unused lever. Plan: add
  a 5th step to the Phase 7b calibration wizard — user mumbles a known sample
  sentence, app times it — and use that measurement to personalize **both**:
  (a) `MS_PER_SYLLABLE`/`BASE_WORD_MS` for that user (currently identical fixed
  guesses for everyone, per Phase 6b), and (b) `utterance.rate` itself. Both must be
  calibrated together, not just the TTS rate alone — speeding up TTS without also
  loosening the mouth-close cadence thresholds would make the app race ahead of a
  fast mumbler instead of matching them. Placed directly after Phase 10 (not
  dependent on it, but both are core UX before anything ships) and grouped next to
  Phase 12 since both extend the same Phase 7b calibration framework.
- **Phase 12 — Distance / recalibration robustness** (renumbered from 11). MAR is a
  ratio so it's not totally distance-dependent, but landmark noise increases at
  range and Phase 7a/7b calibration was measured at one distance — head-pose
  thresholds especially may not hold if the user moves significantly farther away
  after calibrating. Likely approach: detect face-box size drift since calibration
  and prompt to recalibrate, rather than trying to make thresholds fully
  distance-invariant. Grouped with Phase 11 — both are extensions of the same
  calibration system, sensible to build back-to-back.
- **Phase 13 — Full security review pass** (renumbered from 12). Deliberately
  sequenced AFTER Phase 10, not before — file upload (arbitrary `.txt`/`.pdf`
  content, `pdf.js` parsing) is what actually expands the attack surface; reviewing
  security ahead of that feature existing would mean redoing the review anyway.
  Current backend-free architecture already keeps the surface small (no server, no
  stored data besides calibration numbers in `localStorage`).
- **Phase 14 — Shipping prep + paywall** (renumbered from 13). Sequenced last —
  depends on Phase 9-12 being done so a stranger's first impression isn't a mobile
  bug, a hardcoded demo paragraph, or TTS that feels like it's fighting them.
  Paywall requires *some* way to verify payment, which the current fully-backend-free
  architecture doesn't have. Two options to weigh when this phase starts: (a)
  no-backend — Stripe Payment Links or Gumroad handle payment off-infrastructure,
  gate access with a license key (cheap, no server to maintain); (b) light-backend —
  one Vercel serverless function checks payment status (still near-free, but a new
  moving part, changes the "no backend" privacy story slightly). Ethical flag to
  revisit at that time: target audience includes ALS/vocal-cord-paralysis users —
  an assistive tool behind a paywall by default is worth a deliberate decision, not
  a default.

## 4. Roadmap

- [x] **Phase 0:** Dev environment set up
- [x] **Phase 1:** Webcam + MediaPipe face mesh rendering
- [x] **Phase 2:** MAR-based mouth open/closed → play/pause TTS (hardcoded sentence)
- [x] **Phase 3:** Word-by-word highlighting + head-pose gating. Edge/Windows
      `speechSynthesis` freeze bug found and fixed (see Decisions).
- [x] **Phase 4:** Click-to-word manual resync (State 3).
- [x] **Phase 5:** Deployed live on Vercel (github.com/Shai-AH/reading-app,
      auto-deploy on push). CSP header, camera-privacy disclosure, privacy check
      passed.
- [x] **Phase 6a (Option A):** Movement-range smoothing on the mouth-close trigger.
- [x] **Phase 6b (Option B):** Cadence-based pacing via syllable-duration estimate.
- [x] **Phase 7a:** Head-pose yaw/pitch live-calibration + gating bug fix. Mic-based
      safeguard rejected (see Decisions).
- [x] **Phase 7b:** Calibration mode (guided in-app wizard, MAR + head-pose only).
      Happy path and failure/retry path both confirmed live.
- [x] **Phase 7c:** Dynamic frame rate (idle throttling). ROI cropping evaluated
      and explicitly descoped. Mid-word silent-e cadence gap fixed.
      **All of Phase 7 (a/b/c) confirmed deployed to Vercel — no deploy debt.**
- [x] **Phase 8a:** Emotional tone toggle. Done, with a documented
      limitation (tone rarely updates during smooth continuous reading —
      accepted tradeoff, not a bug). Per-sentence chaining explicitly
      rejected after 3 failed attempts within one session (Entry 16) — see
      Decisions.
- [ ] **Phase 8b:** Voice cloning. Not started — needs a scope conversation
      first (budget/privacy tension), not a build session.
- [ ] **Phase 8c:** Offline mode. Not started, feasible free.
- [ ] **Phase 9:** Mobile TTS restart bug fix. See 3c for working theory.
- [ ] **Phase 10:** UI redesign + text input (paste / `.txt` / `.pdf` upload).
- [x] **Phase 11:** Personalized speed calibration (TTS rate + cadence, calibrated
      together). Shipped Entry 18 — peak-trough word detection, two-pass
      sample sentence, stall/outlier/refractory protections. See Decisions.
      **Open flag carried forward:** clamp bounds need real investigation
      before trusting `personalizedRate` in production (see Decisions) —
      not blocking Phase 11b.
- [x] **Phase 11b:** Ambient trouble-shading (color-coded feedback border).
      Shipped Entry 19 — blended max() score (pose + cadence), separate sharp
      pulse cue for hard failures, reads off Phase 11's calibrated
      thresholds, hue paired with opacity/saturation for accessibility. See
      Decisions. **Cadence-clock bug found and fixed Entry 20** (was pinning
      the border red during normal smooth reading — see Decisions).
      **Ready to deploy** — confirm push to Vercel before starting the next phase.
      **Open flag carried forward:** accumulate/recover rates and cadence/
      stall constants are still reasoned starting guesses, not yet live-tuned
      against a real session (now that the underlying clock is correct).
- [ ] **Phase 12:** Distance / recalibration robustness.
- [ ] **Phase 13:** Full security review pass (after Phase 10).
- [ ] **Phase 14:** Shipping prep + paywall.

## 5. Current status

Project folder `reading-app`: `index.html` + `main.js`. **Phases 0-7 (all
sub-phases) complete and deployed to Vercel — confirmed, no deploy debt as of
Entry 14.** Next up: Phase 9 (mobile bug fix), in a new chat.

**Key technical values / state:** MAR hysteresis, movement-range smoothing,
cadence formula, head-pose thresholds, and `utterance.rate` status are all fully
detailed in Section 3 (Key decisions) — not repeated here to avoid drift between
two copies. Landmarks used: 13/14 (lips), 61/291 (mouth corners).
- **Edge confirmed unsupported/broken for TTS timing** — do not re-investigate
  unless Edge support is ever added to scope.
- **Mobile Chrome bug (now Phase 9):** closing the mouth mid-utterance restarts the
  word instead of resuming. Working theory: `onboundary` word events not firing
  reliably on that TTS voice/platform — see 3c for detail.
- "Start Reading" button requires a real user gesture (Chrome/Edge speechSynthesis
  restriction).
- Debug UI on screen: MAR, mouth state, speech state, yaw, pitch, head-pose state,
  movement range, cadence (elapsed/expected), calibration status — keep all for
  future recalibration.
- CSS: `#container` needs explicit height (absolute-positioned children collapse it
  otherwise) — already fixed, don't reintroduce.
- Word spans have `cursor: pointer` + hover highlight (CSS-only, no JS hover logic)
  in addition to the `.active` highlight.
- **Phase 7b calibration:** `#calibrateBtn` wizard, saves to `localStorage`
  (`readingAppCalibration`). Full mechanics in Section 3.
- **Phase 7c:** `IDLE_FRAME_INTERVAL_MS = 100`, no regression confirmed.
- **Text input is still hardcoded** (`READING_TEXT` constant in `main.js`) — no
  paste box, no upload UI yet. This is Phase 10.
- **Phase 8a (tone toggle):** `#toneToggle` checkbox, off by default. Full
  mechanics and values in Section 3. `READING_TEXT` has a temporary trailing
  `?`/`!` sentence for testing — remove at Phase 10.

- **Phase 11 (Speed calibration): shipped Entry 18.** Full mechanics/constants
  in Section 3. One open flag carried forward (clamp bounds need real
  investigation before trusting `personalizedRate` in production) — doesn't
  block Phase 11b.

- **Phase 11b (ambient trouble-shading): shipped Entry 19, cadence-clock bug
  fixed Entry 20.** Full mechanics/constants in Section 3. Modifies
  `index.html` (new `#readingPane` wrapper div + CSS, new debug line) and
  `main.js` (new scoring/smoothing/pulse functions using a dedicated
  per-word clock, small hooks into `predictLoop`, `updateHeadPose`,
  `highlightWordAt`, `speakFrom`, Start Reading click, and `finishReading`).
  **Not deployed yet — this touches both files, so per the standing deploy
  reminder (Section 2), push to Vercel before starting the next phase.**

**Next action:** Deploy Phase 11b (including the Entry 20 bugfix) to Vercel,
then a real live-testing pass on Phase 11b's constants (accumulate/recover
rates, cadence overrun cap, stall factor) now that the underlying clock is
correct — same "watch it live before trusting it" pattern used for every
other threshold in this project, and worth doing now specifically since the
Entry 20 bug means nothing about the border's behavior during normal reading
has actually been validated yet. After that: Phase 12 (distance/
recalibration robustness) or Phase 9 (mobile bug fix) — both still open,
just deprioritized, not abandoned.

## 6. Log of sessions (archive — one line each, full reasoning lives in Section 3)

- **Entry 1-2 (Jul 6):** Scoped project, set constraints, built Phase 0-1.
- **Entry 3 (Jul 7):** Built Phase 2 (MAR hysteresis + Web Speech play/pause).
- **Entry 4 (Jul 7):** Identified false-trigger risk; chose head-pose gating over gaze tracking.
- **Entry 5 (Jul 8):** Built Phase 3; fixed Edge `speechSynthesis` freeze bug + restart bug.
- **Entry 6 (Jul 8):** Scoping session — locked platform/text-input/security decisions (3b).
- **Entry 7 (Jul 8):** Built Phase 4 (click-to-word resync).
- **Entry 8 (Jul 9):** Built Phase 5 (Vercel deploy, CSP, privacy check). Found Edge TTS latency bug (not a blocker) and mobile-Chrome restart bug (logged, now Phase 9).
- **Entry 9 (Jul 9):** Built Phase 6a (movement-range smoothing). Deploy forgotten this entry.
- **Entry 10 (Jul 9):** Built Phase 6b (cadence-based pacing). Deployed 6a+6b together.
- **Entry 11 (Jul 10):** Built Phase 7a (head-pose calibration + gating bug fix). Rejected mic-based safeguard.
- **Entry 12 (Jul 10):** Built Phase 7b (calibration wizard). Failure/retry branch untested this entry.
- **Entry 13 (Jul 10):** Deployed 7a+7b. Verified 7b failure/retry live. Built Phase 7c (dynamic frame rate + silent-e fix). Descoped ROI cropping.
- **Entry 14 (Jul 11):** Confirmed Phase 7c deployed (no deploy debt). Reviewed `main.js`/`index.html` directly — confirmed silent-e fix and dynamic frame rate present, confirmed text input still hardcoded. Discussed and scoped Phases 9-13 (mobile bug fix → UI/upload → distance robustness → security → shipping/paywall). Ruled out student's hover-button theory for the mobile bug by inspection. Restructured log: compressed Section 6 to one line per entry.
- **Entry 15 (Jul 11):** Student proposed personalized mumble-speed calibration (TTS `utterance.rate` + cadence constants calibrated together, using the same wizard pattern as Phase 7b). Confirmed `utterance.rate` is currently unused/fixed at default. Added as new Phase 11, renumbering old 11→12 (distance robustness), 12→13 (security), 13→14 (shipping/paywall) — inserted before the calibration-adjacent phase (12) and well before shipping (14), not tacked onto the end.
- **Entry 16 (Jul 14):** Built Phase 8a (emotional tone toggle) — punctuation-based pitch/rate heuristic. Attempted per-sentence chaining twice (immediate `speak()` chaining, then a delayed/re-checked version); both wedged Chrome's speech engine differently (state desync, then a silent freeze). Permanently rejected per-sentence chaining after the second failure — same category as ROI cropping/mic safeguard. Considered and rejected reworking Phase 6a smoothing to force sentence-boundary stops (conflicts with core "mouth = ground truth" principle). Shipped final design: tone locks in once per resume, documented limitation (rarely updates during smooth reading). Split Phase 8 into 8a/8b/8c. Student also reported head-pose gating feeling too strict; dropped mid-session, unresolved — flagged for next time.
- **Entry 17 (Jul 17):** Student raised a project-level concern: app technically works but feels forced to a real reader, not just a tester. Traced to generic/unvalidated thresholds everywhere — confirms Phase 11 as the real fix, not 8b. New issue: small mouth-opens sometimes not registering — reframed as a detection-legibility gap (no feedback on why/whether detected), not a bug. Researched ALS mouth-movement literature — confirmed audience split (early-stage viable, late-stage isn't; biological, not design, limit). Student proposed ambient color-shading feedback (slow accumulate, fast recover); validated, scoped as new Phase 11b, mockup built. Reprioritized roadmap: Phase 11 (then 11b) now next, ahead of 8b/8c/9. Trimmed duplicated technical-value listings between Section 3 and Section 5 to reduce file size.
- **Entry 18 (Jul 19):** Built Phase 11's Speed calibration step end-to-end — long iterative session, several live-tested reverts (absolute-threshold detection → peak-trough; a feedback-loop-prone adaptive threshold tried and reverted). Landed on: peak-trough MAR envelope detection, two-pass sample sentence, fixed prominence threshold (evidence-tuned from live diagnostic logging, not guessed), refractory period, stall detection, MAD-based outlier rejection. Found and fixed a reaction-time contamination bug in word-1 timing. Found (via live testing, not assumption) that showing the live target word made users consciously pace against the display, distorting the natural pace being measured — removed. Confirmed stall detection correctly catches and names real stuck words rather than silently corrupting the run. One open item carried forward: clamp bounds on `personalizedRate`/`MS_PER_SYLLABLE` were guessed against the wrong assumed ratio — real fits keep landing on the same clamp corner, needs real investigation before production use, not blocking Phase 11b. Full mechanics/constants/reasoning in Section 3 (kept dense given how load-bearing this is for anyone touching `main.js`'s rate step again).
- **Entry 19 (Jul 19):** Resolved Entry 17's four open questions for Phase 11b (blended max() score; separate sharp pulse for hard failures; read off calibrated thresholds; hue+opacity/saturation for accessibility) and built it end-to-end — `#readingPane` ambient border in `index.html`, scoring/smoothing/pulse logic in `main.js`, reads off Phase 11's calibrated pose/cadence thresholds. Explicit audience-driven design call: asymmetric accumulate/recover rates and a pulse cooldown are deliberate, in service of "room for error, not zero error" for this app's specific low-motor-control audience, not just a general restatement of the project motto. Not yet deployed (deploy debt flagged) or live-tuned against a real session. Full mechanics in Section 3.
- **Entry 20 (Jul 19):** Student live-tested Phase 11b before deploy and caught a real bug: border pinned at Trouble score 1.00 during completely normal smooth reading (clean MAR/pose/speech state), traced via the debug readout to Cadence showing `20576 / 574ms`. Root cause: cadence trouble was reusing `mouthOpenStartTime`/`currentWordExpectedMs` (Phase 6b), which only reset on a closed→open transition — Phase 6a's continuous-reading design means that transition can be dozens of words in the past, so "elapsed since mouth opened" grew unbounded against just one word's expected duration. Fixed with a dedicated per-word clock (`lastWordBoundaryTime`/`currentSpokenWordExpectedMs`) reset on every real word boundary via `highlightWordAt`, plus primed at the top of `speakFrom` to cover the pre-first-boundary gap and the same-word-resume case `highlightWordAt`'s no-op guard would've missed. Did not touch the original Phase 6b clock — still correct for its own (different) purpose. Deploy still outstanding — student to push both files to Vercel.