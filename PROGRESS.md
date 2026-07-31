# PROGRESS LOG — "Mumblew" (reading app)
Last updated: July 31, 2026 (Entry 47)

> HOW TO USE: Single source of truth. Claude reads this first in every new chat.
> Update before ending each session. If Claude contradicts this file, trust this file.
> Section 6 stays terse — grouped summary lines for older work, one line per recent
> entry. Real decisions/reasoning live in Section 3.
> **This pass (Entry 47):** Closed out Section 3d #1 (speed-calibration anchor
> tuning). Built a temporary logging tool (now removed) to capture real
> elapsed-vs-expected mouth-close data at both slider extremes without requiring
> the student to write numbers down mid-session. Two rounds of real testing: the
> first was contaminated by forced/rushed mouth-taps on words too hard to mouth
> cleanly at 0.5x/1.75x (a known noise mode for this kind of live-mimicry test,
> same root problem the old Phase-11 regression was killed for); the tool was
> updated with a 150ms noise floor and a natural-pacing retest gave a clean
> signal. Final anchors: slow 230ms/syllable + 135ms base (was 300/180), fast
> 135ms/syllable + 62ms base (was 150/70) — landing closer to the original
> guesses than the first, noise-contaminated correction suggested. Logging tool
> fully removed from main.js/index.html per its own "temporary" design. Not yet
> deployed — still holding Entry 45 AND 46's changes too.

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
  the mechanism genuinely requires live mouth-tracking to test).
  **Corollary (Entry 41):** an isolated harness is itself code and can have its
  own bugs — verify the harness's own logic/timeouts are sound before trusting a
  "reproduced" or "clean" result from it.
  **Corollary (Entry 45):** a bug reported as "works via keyboard but not mouse
  click" is a strong signal the two input paths are wired to different gating
  logic — check for that divergence first before assuming a one-off browser quirk.
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
  word (`onboundary` char offset). Settled facts:
  - Sentence-chunked utterances are a real Web Speech API ceiling on this
    browser — reverted, not revisited without a fundamentally different mechanism.
  - `onend` never fires after a manual `cancel()` on this browser — **fixed**:
    `main.js` polls `speechSynthesis.speaking` (20ms tick) instead.
  - Mid-word overshoot bug was cadence-gating logic, not a browser bug. **Fixed**
    by Fix 3c/3c-2: tight gating only within `RISK_WINDOW_HALF_MS=120` ms of an
    estimated lip-closing-consonant moment; loose everywhere else.
  - Tab/window visibility safety gap — fixed (`document.visibilitychange`
    listener stops speech, forces closed state, does NOT auto-resume on return).
  - Iframe-recycling orphaned-utterance bug — fixed via module-level
    `activeSpeechSynth` + `cancelActiveSpeech()`.
  - Diagnostics still live and harmless: duplicate-boundary counter,
    early-close counter, session-wide `speak()` counter, iframe-recycle count,
    the Fix-3c/3c-2 risky-window row, the Phase 12b voice-selection row.

- **Head-pose gating (Phase 3) — REMOVED, Entry 45.** "Facing the screen" is an
  unreliable engagement proxy for this app's core audiences (ALS head-drop,
  lying-down reading), and mouth movement already is the honest signal. Gaze/
  eye-contact tracking as a "smarter" alternative was considered and rejected —
  it's built ON TOP OF head-pose as a prior, so it compounds the same bad-geometry
  problem rather than fixing it. `isFacingScreen` renamed `isFaceVisible`
  (means only "MediaPipe sees a face," no yaw/pitch). Calibration wizard went
  from 5 steps to 3 (facing/turned-away steps removed).

- **Manual ON/OFF speech switch — shipped, Entry 45.** User-controlled pause
  layered alongside mouth-tracking. Hard-stop on OFF, no partial-word grace.
  Toggle via click or Spacebar (guarded off typing contexts and off
  `readingActive`). Two Entry-45 bugs fixed: visual state now syncs every frame
  off `readingActive` (was missing the click-to-word-resync entry path); switch
  uses a CSS class (`is-inactive`) instead of the native `disabled` attribute so
  click and Spacebar share one gate.

- **Plain-English trouble explainer (warning box) — shipped, Entry 45.** Single
  message at a time by priority (switch-off > no-face > cadence-stall), hangs off
  the same smoothed `displayedTroubleScore` the ambient border already uses.
  `WARNING_BOX_MIN_DISPLAY_MS = 3000` prevents fast-recovering scores from
  flashing the message for under a second. Minimizable; auto-re-expands on a
  NEW condition.

- **Speed calibration — REBUILT Entry 46.** Old mechanism (Phase 11, Entries
  15-21 + mobile-testing-session tuning) is fully removed from main.js: a
  timed "mouth this sentence twice" sample, peak-trough word-boundary
  detection, hesitation-outlier rejection, and an OLS regression producing
  `MS_PER_SYLLABLE`/`BASE_WORD_MS`/`PERSONALIZED_RATE`. Replaced because it
  was inferring numbers from noisy live mouth-timing data — noise a directly
  user-picked value doesn't have. New mechanism:
  - Step 3 is a **continuous slider**, 0.5x-1.75x (`RATE_SLIDER_MIN/MAX`),
    not discrete presets — chosen over discrete because a fixed lookup table
    only works for a finite input space; continuous needed a different tool.
  - **3 hand-tuned anchor points** (`RATE_ANCHORS`: 0.5, 1.0, 1.75), each
    mapped to `{msPerSyllable, baseWordMs}` — the 1.0 anchor reuses the
    existing `DEFAULT_MS_PER_SYLLABLE`/`DEFAULT_BASE_WORD_MS` so an untouched
    slider changes nothing. `interpolateCadence(rate)` does piecewise-linear
    interpolation between anchors for any in-between value the user picks —
    keeps TTS rate and mouth-close cadence gating moving together, same
    coupling goal the old regression had, without per-user measurement noise.
  - Slider value IS `PERSONALIZED_RATE` directly, no derivation needed.
  - "▶ Test voice" button speaks `SAMPLE_SENTENCE` at the live slider value.
    "Set speed" button confirms and advances (`finishRateStep()`) — no
    prep/sample countdown for this step anymore, `updateCalibration()` returns
    immediately for `metric === 'rate'`.
  - Accessibility: 26px custom slider thumb (large touch/click target) +
    native keyboard-arrow stepping (0.01 increments) — a fallback for users
    who can't precisely drag, discussed explicitly against the ALS/paralysis
    audience's possible motor-control limits (setup-only interaction, not
    part of the reading loop itself, so a lower accessibility bar than
    in-session controls applies).
  - **TUNED, Entry 47** — see dedicated entry below for the full test
    history and reasoning. Final: slow anchor 230ms/syllable + 135ms base,
    fast anchor 135ms/syllable + 62ms base.

- **Speed calibration anchor tuning — CLOSED, Entry 47.** Section 3d #1.
  Built a temporary logging tool (`rateTuningLog` + a debug-panel "Show
  rate tuning summary" / "Clear tuning log" pair, since fully removed) that
  auto-recorded elapsed-vs-expected timing at every detected mouth-close,
  so the anchor values could be checked against real data without the
  student hand-transcribing numbers mid-session.
  - **Round 1 (contaminated, not trusted):** avg elapsed/expected ratio
    0.59 at 0.5x, 0.80 at 1.75x (n=35-40). Anchors scaled down accordingly
    (180/105 slow, 120/55 fast) — this was WRONG, see round 2.
  - **What went wrong:** at the slider's extremes, some words are
    physically hard to mouth cleanly, so the student was sometimes forced
    into a quick random open/close on hard words rather than a genuine
    completed mouthing. Those forced taps register as very-early closes
    and drag the average down — same root failure mode ("inferring numbers
    from noisy live mouth-timing data") the old Phase-11 regression was
    killed for in Entry 46, just resurfacing at the anchor-tuning level
    instead of the whole-calibration level.
  - **Fix:** added a 150ms noise floor to the logging tool — closes faster
    than that aren't a real "finished saying this word" signal, so they're
    excluded from the average and reported separately instead of silently
    skewing it.
  - **Round 2 (clean, trusted):** with the noise floor applied and the
    student mouthing at a genuine pace rather than forcing rushed taps on
    hard words, avg ratio was 1.28 at 0.5x, 1.13 at 1.75x (n=25-26 clean
    entries after filtering). This was the opposite direction from round
    1's uncorrected number — round 1's anchors were now too short.
  - **Final anchors:** round-1 anchors scaled up by round-2's clean
    ratios — slow 230ms/syllable + 135ms base (was 300/180 originally),
    fast 135ms/syllable + 62ms base (was 150/70 originally). Net finding:
    the original starting guesses were closer to correct than the
    round-1 data suggested; most of the apparent miscalibration was
    testing noise from strained mimicry at the extremes, not the anchor
    numbers themselves.
  - **Known residual gap, not addressed:** `estimateWordDuration()` has no
    per-word sense of sentence-final punctuation or emphasis — short
    function words ("a", "to") still get over-estimated and sentence-final
    words ("bank.", "risks.") still get under-estimated relative to each
    other, even after this pass. That's a formula-level limitation (single
    global per-syllable rate), not something a global anchor scale can
    fix. Not revisited unless real use surfaces it as a concrete problem.
  - **Open product question raised, not resolved:** the student noted some
    words were genuinely hard to mouth cleanly at the 0.5x/1.75x extremes.
    Worth watching whether that's just an artifact of forced test
    conditions (unnaturally sustained extreme pacing) or a sign the
    slider's actual range is uncomfortable for real use — revisit if real
    reading sessions at the extremes feel bad, not pre-emptively.
  - Logging tool fully removed from main.js/index.html once tuning closed
    (matches its own "temporary, remove once done" design and the
    project's general pattern of deleting closed-out mechanisms rather
    than leaving them dormant — see Entry 46).

- **Cadence-based pacing:** `estimateWordDuration(word) = BASE_WORD_MS +
  syllables * MS_PER_SYLLABLE`. Digit/accent handling in `estimateSyllables()`
  shipped and closed (Phase 12a). Dynamically scales the mouth-close-detection
  threshold — see Fix 3c/3c-2 above.
- **Movement-range smoothing:** `WINDOW_MS=300`. Working correctly.
- **Calibration mode:** 3-step wizard (neutral → mutter → pace) + saved to
  `localStorage` (`readingAppCalibration`), per-device/per-browser.
- **Emotional tone toggle (Phase 8a):** punctuation-based heuristic, off by
  default, decided once per resume.
- **Explicitly rejected, not deferred:** mic-based audible-speech safeguard;
  ROI cropping; per-sentence tone chaining; sentence-chunked TTS utterances;
  Kokoro/local-TTS (Phase 12b); installing OS-native voices (Phase 12b);
  head-pose gating in any form including gaze-combined (Entry 45); discrete
  speed presets / lookup table in favor of continuous + interpolation (Entry 46).
- **Phase 7c:** dynamic frame rate, `IDLE_FRAME_INTERVAL_MS=100`.
- **Text input / UI redesign / PDF upload (Phases 10a/10c/10d) — all shipped,
  closed.** `currentText` (mutable), paste/type + `.txt`/`.pdf` upload via
  lazy-loaded `pdfjs-dist`, saved text persists via IndexedDB (`mumblewDB`/
  `savedText`), calibration data stays on localStorage. Full dark-themed
  redesign shipped.

### 3b. Scope decisions

- Platform: Web app, Chrome-first. Cross-browser support not a priority pre-demo
  (Entry 45's switch fixes verified on both Chrome and Edge).
- Security: `textContent` never `innerHTML` (XSS guard), pinned CDN versions, CSP
  header, camera-privacy disclosure, HTTPS via Vercel. Full review at Phase 14.

## 3d. Priority order for remaining work (reset Entry 47)

1. **Phase 13** (distance/recalibration robustness) — likely NOT needed;
   MAR is already a ratio (vertical lip gap / mouth width), self-normalizing
   against camera distance by design. Real remaining gap, if any, is landmark
   noise at extreme range/low light — better addressed via `WINDOW_MS` tuning
   than a dedicated calibration step. Revisit only if real testing shows a
   concrete problem, don't build pre-emptively.
2. **Mobile issues** — long-paused since Entries 22-24; resurfaced Entry 44
   ("numerous issues", unspecified). Needs its own dedicated session.
3. **Quality-of-life changes** — not yet scoped.
4. **PWA packaging** (Entry 43) — manifest + service worker + icons, mostly
   free. iOS Safari camera-in-installed-PWA access is historically unreliable
   — keep the camera-dependent flow tested in regular Safari-tab mode as
   the iPad fallback.
5. **Phase 14** (security review), **Phase 15** (shipping prep + paywall,
   with the standing ethical note: ALS/paralysis audience means a default
   paywall deserves a deliberate decision) — last, unchanged.

**Also open, not prioritized above:** Entry 47 raised a product question —
whether the 0.5x-1.75x slider range is comfortable for real use at its
extremes, or only survivable under forced test conditions. Watch for this
during Mobile issues/QoL sessions rather than a dedicated pass.

## 4. Roadmap

- [x] **Phases 0-8a:** webcam/facemesh, MAR play/pause, word highlighting +
      head-pose gating (later removed, Entry 45), click-to-word resync, Vercel
      deploy, movement-range smoothing, cadence-based pacing, calibration
      wizard, dynamic frame rate, emotional tone toggle. All deployed.
- [ ] **Phase 8b:** Voice cloning — needs a scope conversation, not started.
- [ ] **Phase 8c:** Offline mode — not started, feasible free; PWA work
      would give this a head start.
- [x] **Phase 9a:** Mobile/session speech-engine reliability — RESOLVED, deployed.
- [x] **Phase 9b:** No-face-detected safety gap — fixed, tested, closed.
- [x] **Phase 9c:** Off-axis/lying-down pose calibration — moot, resolved by
      Phase 3's removal (Entry 45).
- [x] **Phase 10:** UI redesign + text input — fully shipped, closed.
- [x] **Phase 11 / 11b:** Speed calibration (regression) + ambient
      trouble-shading — regression REPLACED Entry 46 (see Section 3);
      trouble-shading unaffected, still shipped/closed.
- [x] **Phase 12a-d:** Duration estimation, voice quality (local picker
      shipped, Kokoro/OS-voice-install ruled out), auto-scroll, sticky-word
      diagnosis — all shipped/closed.
- [x] **Phase 13.5 / 13.6:** Local on-device TTS / continuous speed control —
      closed/ruled out on cost, but Entry 46's slider gets a lightweight
      version of "continuous" back (set-then-play, not live-during-utterance,
      which is what 13.6 actually ruled out — see Entry 46 discussion).
- [ ] **Phase 13:** Distance/recalibration robustness — likely NOT needed,
      see Section 3d #1.
- [x] **Phase 3 (Head-pose gating) — REMOVED, Entry 45.**
- [x] **Manual ON/OFF speech switch — shipped, Entry 45.**
- [x] **Plain-English trouble explainer (warning box) — shipped, Entry 45.**
- [x] **Speed calibration rebuild (manual slider) — shipped, Entry 46.**
      Anchor tuning CLOSED, Entry 47 — see Section 3.
- [ ] **Mobile issues** — long-paused, resurfaced Entry 44, not yet scoped.
- [ ] **Quality-of-life changes** — not yet scoped.
- [ ] **PWA packaging** — decided as a direction, not yet built. iOS caveat,
      see Section 3d.
- [ ] **Phase 14:** Full security review pass — not yet started.
- [ ] **Phase 15:** Shipping prep + paywall — last. Ethical flag stands.

## 5. Current status

Project folder `reading-app`: `index.html` + `main.js`. **Not yet deployed to
Vercel** — Entry 45's changes (head-pose removal, ON/OFF switch, warning box),
Entry 46's speed-calibration rebuild, AND Entry 47's anchor tuning are all
tested locally only so far. Last live deploy remains Entry 44's (Phase 9a full
resolution, Phase 12b Stage A, orphaned-utterance fix).

**This session (Entry 47):** Closed out Section 3d #1 (speed-calibration
anchor tuning). Built a temporary debug-panel logging tool to capture real
mouth-close timing data without hand-transcription, ran two rounds of live
testing (first contaminated by forced taps on hard-to-mouth words at the
slider extremes, second clean after adding a 150ms noise floor and re-testing
with natural pacing), and landed on data-informed final anchors: slow
230ms/syllable + 135ms base (was 300/180), fast 135ms/syllable + 62ms base
(was 150/70). Net finding: original starting guesses were closer to correct
than the first round of data suggested. Logging tool fully removed once
tuning closed. Flagged one open product question (is the slider's 0.5x-1.75x
range comfortable at the extremes for real use, or only survivable under
forced test conditions) without resolving it — watch during future sessions.
**Deploy status: still pending — three entries' worth of local-only changes
now (45, 46, 47). Ask before next session.**

## 6. Log of sessions

- **Entries 1-14 (Jul 6-11):** Built and deployed Phases 0-7. Fixed the Edge
  `speechSynthesis` freeze bug. Scoped Phases 9-14.
- **Entries 15-21 (Jul 11-19):** Built Phase 8a (tone toggle). Built and
  shipped Phase 11 (speed calibration, since replaced Entry 46) and 11b
  (ambient trouble-shading, still live).
- **Entries 22-24 (Jul 19-24):** Mobile testing session — diagnosed and split
  Phase 9 into 9a/9b/9c. Fixed Phase 9b. Reverted Phase 9a's first fix
  (sentence chunking) — confirmed a real Web Speech API ceiling.
- **Entries 25-29 (Jul 24-25):** Shipped Phase 10 (text input, visual
  redesign, PDF upload + IndexedDB migration).
- **Entries 30-38 (Jul 25-28):** Shipped 12a/12c (duration estimation,
  auto-scroll). Scoped and ruled out Phase 13.5 (local TTS breakeven math).
  Fixed one real clock bug (12d), folded remaining stalls into 9a.
- **Entries 39-44 (Jul 28-30):** Completed Phase 9a's full resolution and
  closed Phase 12b (voice quality). Deployed to Vercel. Scoping discussion
  (Entry 43) landed the head-pose removal decision later built in Entry 45.
- **Entry 45 (Jul 31):** Removed head-pose gating (Phase 3). Calibration
  wizard trimmed 5→3 steps. Shipped manual ON/OFF speech switch and
  plain-English trouble-explainer box. Fixed three bugs found in local
  testing (stale tab-hidden label, click-vs-spacebar mismatch, stuck
  disabled-look switch on word-click session start). Not deployed.
- **Entry 46 (Jul 31):** Rebuilt Speed calibration from a timed-mouthing
  regression into a manual continuous slider + test-voice preview, with
  anchor-point interpolation for cadence-gating values. Discussed and
  rejected discrete presets in favor of continuous + interpolation.
  Confirmed Phase 13 (distance calibration) is likely unnecessary — MAR's
  ratio design already handles it. Not deployed; anchor values not yet tuned.
- **Entry 47 (Jul 31):** Closed out speed-calibration anchor tuning (Section
  3d #1). Built and later removed a temporary rate-tuning logger; two rounds
  of live testing (first noisy/contaminated, second clean after adding a
  noise floor) produced final anchors close to, but slightly more moderate
  than, Entry 46's original guesses. Flagged an open product question about
  the slider's comfortable range at the extremes. Not deployed.
