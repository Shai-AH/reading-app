# PROGRESS LOG — "Mumblew" (reading app)
Last updated: Aug 15, 2026 (Entry 57)

> This file = Claude's memory. Read first every session. Trust this file over
> assumptions. Update before ending a session. Section 3 = decisions +
> mechanism (source of truth). Section 6 = index only, no re-narration of
> Section 3 content — one line per entry, pointer not story. Don't duplicate
> main.js code-comment detail here; name the function/constant instead.

---

## 1. The Idea

Privacy-first reading app: quiet mouth movement (subvocalization) = pacing
signal, TTS driven by webcam lip-tracking, not buttons/timers.

Audiences: dark/lying-down reading (real use case, not edge case);
neurodivergent/low-focus readers; ALS/severe-stutter/vocal-cord-paralysis
users who can move mouth but not vocalize (why no buttons/taps during the
reading loop itself — calibration is exempt, see Entry 46 slider).

States: 1 (mouth=play/pace, text=ground truth), 2 (cadence informs
sensitivity), 3 (click-to-word resync) — all done.

Privacy: on-device/local-first (MediaPipe), video never leaves device.

ALS fit: viable early/moderate bulbar ALS, vocal-cord paralysis w/ preserved
oral-motor control. NOT late-stage bulbar — biological ceiling (Entry 17).

## 2. Working rules

- $0 budget, no exceptions pre-app-store. Timeline flexible, ~Dec 2026.
- Wait for explicit "start"/"next." Ask before updating log; proactively
  suggest logging if a session runs long OR context is visibly degrading
  (not just long — Entry 55).
- Ask about deploy status after any main.js/index.html-touching phase.
- Testing: numbered step-by-step, never "try it and see." More tests > fewer.
  On-screen plain-English output > console digging for student-facing tools.
- Bug policy: build an isolated diagnostic to confirm/rule out a mechanism
  with real numbers before asking student to test in the real app (skip only
  if isolation can't reproduce it or it needs live mouth-tracking).
- Learned: harnesses can have their own bugs, verify them too (E41). Keyboard-
  works/mouse-doesn't = divergent gating logic, check that first (E45). Don't
  assume newest code = cause without checking reachability under actual
  usage; ruling OUT with data is as useful as confirming IN (E49). Relative-
  baseline fixes can self-defeat if calibrated under the bad condition —
  pair w/ absolute floor. Load-once checks need re-check triggers, not just
  first-paint (E50).
- Cross-device: laptop + mobile (portrait/landscape) + tablet. Fix on one →
  check regressions on others.
- Verify JS: `node --input-type=module --check < main.js` (stdin, not arg).
  `node --check file.js` misses errors in top-level-import files (E54).

**Process rules adopted E57 (student directive, standing from here on):**
- This file is Claude's memory, not a report — Claude owns its structure/
  content, records own errors-not-to-repeat as needed, not just decisions.
- Every session start: ask student specifically which module files are
  needed for that session's task. Don't assume/request the whole codebase.
- Enforce strict modularization on all new code going forward — no new
  logic gets bolted into main.js or left interleaved without a deliberate
  reason (same bar as the speech/mouth-tracking/calibration exception,
  which required an explicit rationale, not a default).
- End-of-session log update must show module connectivity (who imports/
  reads/writes whom), not just a changelog of what got built.
- If student's own testing setup/method is the actual problem, say so
  directly and explain the correct test — don't silently adapt around a
  false symptom or build a fix for a bug that isn't real.
- All testing instructions: numbered, step-by-step, complete, no skipped
  steps — student tests as often as needed, treat that as a cheap resource.
- After every major change: remind student to small-ship (deploy that
  increment) before stacking more unshipped changes.
- Watch conversation length; proactively flag when it's dragged long enough
  that token/context conservation calls for wrapping or logging soon.
- Actively check for and flag dead code when relevant (leftover
  functions/vars from refactors, orphaned declarations, etc.), not just
  wait for student to notice (see E54 orphaned-function bug for the class
  of thing to watch for).

## 3. Decisions (source of truth)

Stack: MediaPipe Face Landmarker (in-browser), Web Speech API, Vercel, no
build tools, `<script type="module">`, MediaPipe via jsdelivr. Landmarks
13/14 (lips), 61/291 (mouth corners).

**Speech — done, deployed.** `speak()`/`cancel()` only, never `pause/resume`
(permanent Edge/Windows freeze, don't revisit). Resumes from `onboundary`
char offset. `onend` unreliable after manual cancel → poll
`speechSynthesis.speaking` instead. Mid-word overshoot fix: tight gating
within `RISK_WINDOW_HALF_MS=120ms` of b/m/p closes (`updateMouthState`/
`isWithinRiskyWindow`). iframe-recycle fix: `activeSpeechSynth`/
`cancelActiveSpeech()`. Sentence-chunked utterances: real API ceiling,
rejected.

**Head-pose gating — removed.** Bad proxy for ALS head-drop/lying-down
reading; gaze-tracking alternative rejected too (same problem).
`isFacingScreen`→`isFaceVisible` (face-present only, no yaw/pitch).

**ON/OFF switch — done.** Hard-stop, no partial-word grace. Click/Spacebar,
guarded off typing + `readingActive`.

**Warning box — done.** One message by priority: switch-off > no-face >
low-light > cadence-stall. `WARNING_BOX_MIN_DISPLAY_MS=3000`. Minimizable.

**Speed calibration — done, tuned, ruled out as sticky-word cause.** Slider
0.5–1.75x (`RATE_SLIDER_MIN/MAX`), `RATE_ANCHORS` (3pt), piecewise-linear
`interpolateCadence`. 1.0x = `DEFAULT_MS_PER_SYLLABLE`/`DEFAULT_BASE_WORD_MS`
always. Tuned: slow 230ms/syl+135ms base, fast 135ms/syl+62ms base. Gap:
`estimateWordDuration()` has no punctuation/emphasis sense (formula limit).

**Mobile highlighter — BUILT, NOT deployed, still broken (E55 confirmed
live).** Cause: `onboundary` 0/14 on mobile (`tts-boundary-diagnostic.html`,
not iframe-related). Fix: `scheduleFallbackAdvance`/`fallbackAdvanceTimerId`,
real event always wins. `DEBUG_SIMULATE_NO_ONBOUNDARY` = desktop test toggle.
Fixed 3 fallback timing bugs (punctuation jitter, first-word jitter →
anchored to `onstart`, drift → EMA `fallbackRateFactor`/
`readingAppFallbackRateFactor`). **Still needed: self-calibration retest +
real mobile pass — never done.** Symptom per E55: highlighter stalls under
playing TTS, catches up when TTS stops → fallback engages late/inconsistent,
not absent. **Next major build item (E55).**

**Low-light — done, deployed.** Cause: ambient light degrades MediaPipe
precision broadly (not threshold/anchor/fallback issue). Fix:
`sampleBrightness()` (independent of MediaPipe) — relative (60% of
calibration-neutral-step baseline) + absolute floor
(`ABSOLUTE_DARK_ENTER/EXIT_THRESHOLD`=40/52) backstop, since relative alone
fails if calibration itself is dim. Plugged into warning-box as `'low-light'`.

**Onboarding tour — done, deployed. Being replaced (E55).** `startTour()`/
`renderTourStep()`, `#tourOverlay`, `MAIN_APP_TOUR_STEPS` +
`CALIBRATION_INTRO_STEPS`. → Replacing w/ contextual just-in-time hints tied
to accordion steps, no separate tour. Build after flow-state pacing (#3 in
3d) since that changes what needs explaining.

**Cadence pacing:** `estimateWordDuration = BASE_WORD_MS + syl*MS_PER_SYLLABLE`.
`WINDOW_MS=300` smoothing. **Calibration:** 3-step wizard, `localStorage`
`readingAppCalibration`. **Tone toggle:** punctuation heuristic, off default.

**Rejected (not deferred):** mic safeguard, ROI cropping, per-sentence tone
chaining, sentence-chunked TTS, Kokoro/local-TTS, OS-native voices, head-pose
(any form), discrete speed presets, full self-calibrating adaptive threshold
(noisy bootstrap, no ground truth, can't distinguish camera-precision from
real behavior, debug-hard, persistence risk — revisit only if low-light fix
proves insufficient).

**Text input/PDF (10a/c/d) — done.** `currentText` mutable, paste/type +
`.txt`/`.pdf` via `pdfjs-dist` (lazy), IndexedDB `mumblewDB`/`savedText`.

**Feedback widget — done, deployed.** Formspree, `submitFeedback()`,
honeypot+cooldown. Fixed: CSP `connect-src` needed `formspree.io`.

**10-reader review findings:** real gaps = onboarding comprehension (tour
insufficient) + camera/privacy trust (prompt read as suspicious). NOT mobile
fix or adaptive light (zero mentions). Design tension noted, not bug:
sustained open-mouth reads as "engaged" — could mask disengagement (mirror of
E55's flow-state ambiguity, opposite direction).

**Intro sequence — done, deployed. Content being redesigned (E55).**
8-panel story behind full-screen `#welcomeGate` (`body.app-gated` hides
everything). 3 revisions before landing here: autoplay+sound (rejected,
violated no-forced-action) → floating card (fixed consent, not sequencing)
→ full gate (final). Permanent via `hasSeenTour('welcomeGate')`; rewatch via
"▶ Replay Intro." Panel 8 silent, waits for click, no auto-advance. Fixed:
guide-tour race (now fires on intro's `onComplete`, not a flat timer); CSP
`script-src` block (inline script silently blocked in prod → moved to
standalone `gate-init.js`, non-module non-deferred; did NOT weaken CSP).
**E55: gate/no-forced-action framing stays, story content under question
(student thinks current story underperforms) — demo-vs-narrative undecided,
design when this phase starts.**

**Camera/privacy trust — done, deployed.** Fix: `getUserMedia()` only via
`requestCameraAccess()` on explicit click (`#cameraGateCard`/
`#cameraTrustBlock`), was auto-firing on load (no-forced-action violation).
Trust copy → "did you know" offline-capable tip (video never leaves device),
worded "once running" since MediaPipe WASM still loads live from CDN (no PWA
caching yet). `calibrateBtn`/`startBtn` gated via `updateCalibrateButtonState`/
`updateStartButtonState`. Denied-permission: inline retry, not `alert()`.

**UI cleanup (progressive disclosure) — done, deployed. Being extended
(E55).** 3-dot progress strip + accordion, `updateProgressUI()`, driven by
existing state (`hasLoadedText()`, `hasCustomCalibration`, `cameraGranted`).
`.step-glow`/`setStepGlow()` marks active step. Settings+debug → corner
widgets (feedback-widget pattern). `#sideColumn` removed, `.ambient-glow`
(≥1040px) fills space. Fixed: Voice-dropdown flexbox overflow (stacked row);
stale `max-width:640px` on `#readingPane`/`#cameraGateCard` (removed).
**E55: extending w/ Zen Mode + format-preserving text + PDF/OCR (3d #5).**

**On-camera calibration redesign — built (unscoped addition).**
`#calibrationOverlay`, scrim bands. Button-gated, not timer-gated: detection
only unlocks/times-out a button. Step1 `awaiting-stillness`: rolling MAR
variance (`STILLNESS_WINDOW_MS`/`_MAR_RANGE_MAX`/`_MIN_HOLD_MS`) → 3s sample
w/ countdown. Step2 `awaiting-mouth-open`: amber card w/ sentence, watches
mouth-open (`MOUTH_OPEN_RELATIVE_DELTA`/`_ABSOLUTE_FLOOR`, same pattern as
low-light). Both gates: `STILLNESS_TIMEOUT_MS`/`MOUTH_OPEN_TIMEOUT_MS`
fallback (ALS accommodation). New sentence: "Mumblew helps people read by
watching quiet mouth movements." (hits b/m/p word-initial+mid-word; old
"quick brown fox" had zero). Fixed: sentence was hiding on mouth-open trigger
(backwards) → stays visible + `calSentenceTimerEl` indicator instead.
**Detection constants are reasoned starting values, NOT tuned on real data —
needs a live-tuning pass.**

**Deploy-blocking bug, fixed (E54).** `str_replace` orphaned
`updateRateSliderReadout()` (deleted decl, kept body+stray `}`). Also fixed
the verification gap that missed it (see Section 2).

**E57 bug fixes — 3 fixed, 2 parked.** Student-caught, laptop-only (not
mobile-verified). All 3 fixed bugs confirmed pass by student, live-tested
post-deploy.

- **Fixed: `onWordClick` spoke without mouth-gating during calibration.**
  Root cause: during calibration, `predictLoop()` routes MAR to
  `updateCalibration()` instead of `updateMouthState()`, so `onMouthOpen`/
  `onMouthClosed` never fire from the frame loop while calibrating — by
  design, calibration owns the mouth signal exclusively then. But
  `onWordClick()` (State-3 resync) never checked `getCalibrationActive()`,
  so a click during calibration could read a stale pre-calibration
  `getMouthState()==='open'` and call `speakFrom()` directly — then nothing
  during calibration ever called `onMouthClosed()` to stop it. Same failure
  shape as the old no-face bug, different trigger. Fix: `onWordClick` now
  returns immediately if `getCalibrationActive()` is true — word-click
  resync is a reading-only action, ignored entirely while calibration owns
  the mouth signal. One-line guard, matches existing `isIdle()`/button-
  disable pattern already used elsewhere for this same state.
- **Fixed: Load Text button disappeared on long paste.** Two compounding
  causes: `resizeTextareaToFit()` grew the textarea to `scrollHeight` with
  no cap, and `.accordion-panel.expanded .panel-body` (index.html) was
  `max-height: 480px; overflow: hidden` — so a tall textarea pushed the
  button (and anything else below it in that panel) past the clip boundary
  and it was silently cut off, not scrolled off as it looked like. Fix:
  `resizeTextareaToFit()` now caps growth at 260px and switches the
  textarea itself to `overflow-y: auto` past that point (scrolls
  internally, button stays put); `.panel-body` (expanded) changed from
  `overflow: hidden` to `overflow-y: auto` as a backstop so nothing in that
  pattern can silently clip again for an unrelated reason later.
- **Fixed: feedback cooldown bypassed by page reload.** `feedbackLastSubmitAt`
  was a plain in-memory variable in `feedback.js`, reset to 0 every reload —
  trivial one-click bypass of the 15s soft cooldown. Fix: persisted to
  `localStorage` (`readingAppFeedbackLastSubmitAt`), read on module load,
  written on successful submit, both wrapped in try/catch (falls back to 0/
  no-op silently if storage is unavailable — not worth surfacing to the
  tester over a soft anti-spam nicety). Still not a hard security boundary
  (clearing storage or switching browsers resets it) — Formspree's own
  filtering + the honeypot remain the real defenses, this just closes the
  obvious one-click hole. **New cross-domain fact:** `feedback.js` now reads
  `localStorage` directly for the first time (previously fully self-
  contained except the `getContext()` callback injection) — doesn't change
  its module boundary/ownership, just worth remembering next time
  `feedback.js` is touched.
- **Parked: calibration-guide box points at nothing** (highlights an area
  during a step where the camera isn't shown yet). Deliberately not fixed —
  lives inside the tour/guide system already slated for full rework at 3d
  #4 (contextual hints + intro redesign) and/or the planned
  accessibility-apps-inspiration session. Fixing box placement now risks
  wasted effort if the whole guide changes shape. Revisit when that phase
  starts, not before.
- **Parked: ambient border + warning box both read as visual distraction**
  (not a bug, a design call). Folded into the existing "UI cleanup being
  extended" work (3d #4/#5) rather than treated standalone.

**main.js modularization — partial, done to the point of diminishing
returns (E56).** 10 of 14 planned pieces cleanly extracted to `js/`; the
rest (speech/mouth-tracking/calibration) deliberately left in main.js —
see rationale below. main.js: 4272 → 2723 lines.

`js/` module map (who owns what, who imports whom):
- `readingState.js` — the shared-state contract. No logic, just get/set for
  fields written by one domain and read by others (`mouthState`,
  `readingActive`, `isSpeakingChunk`, `calibrationActive`,
  `manualSpeechEnabled`, `manualCancel`, boundary/cadence timing). Imported
  by main.js and `warningBox.js`.
- `cadence.js` — syllable/word-duration math + personalized speed state.
  Imported by main.js.
- `storage.js` — IndexedDB text persistence + PDF extraction. Imported by
  main.js.
- `lighting.js` — brightness sampling + low-light detection. Threshold set
  via `setLowLightBaseline()`, called from main.js's `applyCalibration()`.
  Imported by main.js and `warningBox.js`.
- `warningBox.js` — trouble-shading + the warning box. Reads
  `readingState.js` + `lighting.js`, owns nothing external. Imported by
  main.js.
- `voice.js`, `tone.js` — voice picker and punctuation-tone mapping, self-
  contained. Imported by main.js.
- `tour.js` — tour engine, intro sequence, welcome gate. One coupling point
  (`wireCalibrateIntro`) takes main.js's `startCalibration` as a callback.
- `feedback.js` — Formspree widget. Takes a `getContext()` callback from
  main.js for calibration-status/speed-setting. **Since E57:** also reads/
  writes `localStorage` directly (`readingAppFeedbackLastSubmitAt`, cooldown
  persistence) — its first direct browser-storage dependency, no longer
  fully side-effect-free from just the callback. Doesn't change ownership,
  main.js still doesn't need to know about it.
- `panels.js` — settings/debug panel toggles. No exports, self-wiring.
- main.js — orchestrator + everything still too interleaved to split:
  speech (TTS lifecycle, fallback timing, `speakFrom`), mouth-tracking
  (`getMAR`/`updateMouthState`/`predictLoop`), calibration wizard. Imports
  all of the above.

**Why speech/mouth-tracking/calibration stayed put:** mapped in detail
(E56) — not simply large, genuinely one unit. `onMouthOpen`/`onMouthClosed`
call directly into speech every frame; calibration writes mouth-tracking's
OPEN/CLOSE_THRESHOLD and lighting's baseline directly; ~20 speech-internal
variables (`wordSpans`, `activeWordIndex`, `ttsEngine`, etc.) are each used
in 3-4 physically separate regions of the file. Splitting further would
mean bridge getters/setters for state that's really one module's own
internals, not a real domain boundary — same trap the tour.js/warningBox.js
extractions avoided by checking usage counts BEFORE cutting. Revisit only
in a dedicated future session, not as a continuation of this one.

### Scope
Chrome-first, cross-browser not pre-demo priority. Security: `textContent`
never `innerHTML`, pinned CDN versions, CSP, camera disclosure, HTTPS. Full
review at Phase 14.

## 3d. Build order (set Entry 55, 14-item scoping session, no build done)

1. **main.js → modules — done partial (E56, see Section 3 module map).**
   Speech/mouth-tracking/calibration stayed in main.js, too interleaved to
   split without artificial bridge APIs — see rationale in Section 3.
   **+ debug panel:** smaller, docks instead of floats over text; add small
   mirrored live feed w/ face mesh (privacy-proof + demo-recording use).
   Not yet built.
2. **Mobile highlighter fix** (finish E48 — see Section 3 entry above: why
   fallback engages late, real mobile pass, self-cal retest).
   **+ analytics:** Vercel Analytics (cookieless) + milestone events
   (`cameraGranted`, calibration done, `readingActive` start) on existing
   state, no per-user ID/session replay. Disclose in trust copy.
3. **Flow-state-aware autonomous pacing** (new, significant). NOT detecting
   flow state (unmeasurable) — detect sustained near-zero MAR *after* active
   mumbling → hand pacing to autonomous TTS at calibrated speed. Movement
   resuming → control back immediately. Low error cost: worst case = a few
   unabsorbed sentences, recoverable via State-3 resync. Open Q for build
   time: does any movement always reclaim control, or can user stay
   autonomous through occasional mumbling?
4. **UI guide → contextual hints + intro redesign** (after #3, since pacing
   changes what needs explaining). Tour → hints tied to accordion steps.
   Intro: gate/framing stays, content (demo vs narrative) undecided.
5. **Text-handling cluster:** Zen Mode (hide all but reading text on
   `readingActive`, need escape hatch); format-preserving pane (keep
   HTML/Markdown instead of flattening — word-tracking unaffected, display
   only); PDF format-aware extraction (`pdfjs-dist getTextContent()`
   position/font → infer headings, heuristic not ground truth); image OCR
   via **Tesseract.js** (in-browser WASM, $0, photos+screenshots same path)
   — text extraction reliable, formatting best-effort only. **True PDF-page
   rendering (highlight over actual rendered page) explicitly deferred to
   its own future session** — real reading-order/coordinate-mapping problem,
   too large for this pass.
6. **Unchanged tail:** Phase 13 (distance/recal, likely not needed) → PWA
   packaging → Phase 14 (security review) → Phase 15 (shipping+paywall,
   ethical flag stands re: ALS audience) → QoL (unscoped). Fuller adaptive
   light stays parked, no feedback surfaced it.

**Process (adopted E55):** repeat small-ship→feedback cycle (validated by
E51's 10-reader round). Claude flags degraded-context sessions proactively,
not just long ones.

## 4. Roadmap

- [x] Phases 0-8a,9a-9c,10,11/11b,12a-d,13.5/13.6 — all shipped (webcam/
      facemesh, MAR pacing, highlighting, resync, calibration wizard, frame
      rate, tone toggle, mobile speech reliability, no-face gap, UI/text/PDF,
      speed calib, trouble-shading, voice quality, auto-scroll). Head-pose
      later removed.
- [ ] Phase 8b: Voice cloning — not started, needs scoping.
- [ ] Phase 8c: Offline mode — not started, PWA gives head start.
- [x] Head-pose removed, ON/OFF switch + warning box shipped.
- [x] Speed calibration rebuilt+tuned, ruled out as sticky-word cause.
- [~] **Mobile highlighter fix — built, not deployed, confirmed still broken.
      Next major build item.**
- [x] Low-light detection — shipped, deployed.
- [x] Onboarding tour — deployed. **Being replaced w/ contextual hints.**
- [x] Feedback widget — shipped, deployed.
- [x] Small-ship feedback round (10 readers) — done.
- [x] Intro sequence — deployed. **Content being redesigned.**
- [x] UI cleanup (progressive disclosure) — deployed. **Being extended.**
- [x] On-camera calibration redesign — built, needs constant-tuning pass.
- [x] Camera/privacy trust messaging — built, deployed.
- [~] main.js modularization — 10/14 pieces done (E56). Speech/mouth-
      tracking/calibration deliberately stay in main.js (see Section 3).
- [ ] Debug panel polish (new) — paired w/ above.
- [ ] Privacy-respecting analytics (new) — paired w/ mobile fix.
- [ ] Flow-state-aware autonomous pacing (new) — significant.
- [ ] Zen Mode / format-preserving text / PDF+OCR extraction (new/extended).
- [ ] Phase 13 (distance/recal) — likely not needed.
- [ ] PWA packaging — direction decided, not built.
- [ ] Phase 14 (security review) — not started.
- [ ] Phase 15 (shipping+paywall) — last, ethical flag stands.
- [ ] QoL changes — unscoped.
- [ ] True PDF-page rendering (new) — deferred, own future session.

## 5. Current status

Files: `index.html` + `main.js` + `gate-init.js` + `assets/intro/` (8 JPEGs,
7 mp3s) + **`js/` (10 files — see module map, Section 3):**
`readingState.js`, `cadence.js`, `storage.js`, `lighting.js`,
`warningBox.js`, `voice.js`, `tone.js`, `tour.js`, `feedback.js`,
`panels.js`. **Entries 45-56 all deployed to Vercel, confirmed live. Entry
57: 3 bug fixes (calibration TTS gating, textarea/button clip on long
paste, feedback cooldown reload bypass) deployed+tested live by student,
all pass. 2 items parked (calibration-guide box placement → 3d #4; ambient
border/warning-box distraction → 3d #4/#5), not forgotten, see Section 3.**

**Next:** resume 3d build order at #2 (mobile highlighter fix). main.js
modularization is closed out — speech/mouth-tracking/calibration
deliberately stay unmodularized (see Section 3); revisit only if a future
session has a concrete reason to, not by default.

**New standing process (E57, see Section 2):** ask for specific module
files at session start; strict modularization on new code; log updates
show module connectivity; call out student testing mistakes directly
instead of adapting around them; step-by-step testing always; small-ship
reminder after major changes; flag long conversations for token
conservation; watch for dead code.

## 6. Session index

E1-14 (Jul 6-11): Phases 0-7 built+deployed. Edge TTS freeze fixed.
E15-21 (Jul 11-19): Phase 8a. Speed calib v1 (replaced E46). Trouble-shading.
E22-24 (Jul 19-24): Mobile testing, split Phase 9→9a/b/c, fixed 9b.
E25-29 (Jul 24-25): Phase 10 (text/redesign/PDF) shipped.
E30-38 (Jul 25-28): 12a/12c shipped. Phase 13.5 ruled out.
E39-44 (Jul 28-30): 9a/12b closed+deployed. Head-pose-removal decided.
E45 (Jul 31): Head-pose removed. ON/OFF switch + warning box shipped.
E46 (Jul 31): Speed calib rebuilt (slider+anchors).
E47 (Jul 31): Anchor tuning closed.
E48 (Aug 1): Mobile highlighter bug diagnosed+built. Desktop-tested only.
E49 (Aug 2): Sticky-word root cause = ambient light (see Section 3). Priority
  order agreed: light warning→ship→feedback→decide→security→ship→QoL.
E50 (Aug 3): Low-light fix shipped. Tour system + layout restructure built.
E51 (Aug 7): Feedback widget shipped. 10-reader review analyzed (see Section
  3). Intro sequence designed, assets locked.
E52 (Aug 8): Intro sequence built+deployed (see Section 3 for the 3
  presentation revisions + 2 bugs fixed).
E53 (Aug 9): Camera-access gating + trust messaging built (see Section 3).
E54 (Aug 12): UI cleanup + on-camera calibration redesign built (see Section
  3). Deploy-blocking bug fixed. Deployed by student before E55.
E55 (Aug 13): 14-item scoping session, no build. All verdicts + new build
  order → Section 3d. This file compressed for length (student request,
  Claude's own call on aggressiveness) — Section 6 cut from narrative to
  index; Section 3 tightened further; nothing decision-relevant or
  mechanism-identifying removed.
E56 (Aug 15): main.js modularization, 10/14 pieces (module map → Section
  3). Speech/mouth-tracking/calibration mapped in detail, found to be one
  genuinely inseparable unit — left in main.js by design, not left undone.
  main.js 4272→2723 lines. All 10 modules deployed+tested live by student,
  confirmed flawless.
E57 (Aug 15): New standing process rules adopted (Section 2/5). 5 bugs
  triaged; 3 fixed this session (calibration TTS gating in `onWordClick`,
  textarea/Load-button clip on long paste, feedback cooldown reload
  bypass), 2 parked into existing future phases (calibration-guide box
  placement, ambient-border/warning-box distraction) — see Section 3 for
  full mechanism on each. All 3 fixes deployed+tested live by student, all
  pass.
