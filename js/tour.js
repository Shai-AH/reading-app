// tour.js — coach-mark tour engine, main-app tour + calibration-intro
// content, 8-panel intro sequence, and first-visit welcome gate.
// Extracted from main.js (Entry 55 modularization, Section 3d #1).
//
// Fully self-contained except for one coupling point: showing the
// calibration-intro tour before calibration itself starts. That's wired
// via wireCalibrateIntro(calibrateBtn, startCalibrationFn), called once
// from main.js, rather than importing main.js's startCalibration
// directly — keeps this module ignorant of calibration's internals,
// just holding a reference to its one entry point.
//
// Per PROGRESS.md Section 3d #4: this whole tour system is slated to be
// REPLACED by contextual just-in-time hints tied to the accordion steps
// (after flow-state pacing lands) — extracted as-is for the current
// modularization pass, not redesigned ahead of that planned work.

const TOUR_STORAGE_PREFIX = 'readingAppTourSeen_';

let activeTour = null; // { tourId, steps, index }

const tourOverlayEl = document.getElementById('tourOverlay');
const tourHighlightEl = document.getElementById('tourHighlight');
const tourTooltipEl = document.getElementById('tourTooltip');
const tourStepCounterEl = document.getElementById('tourStepCounter');
const tourTitleEl = document.getElementById('tourTitle');
const tourBodyEl = document.getElementById('tourBody');
const tourBackBtn = document.getElementById('tourBackBtn');
const tourNextBtn = document.getElementById('tourNextBtn');
const tourSkipBtn = document.getElementById('tourSkipBtn');
const helpTourBtn = document.getElementById('helpTourBtn');

function hasSeenTour(tourId) {
  try {
    return localStorage.getItem(TOUR_STORAGE_PREFIX + tourId) === '1';
  } catch (err) {
    return false; // storage unavailable — treat as "not seen" rather than crash
  }
}

function markTourSeen(tourId) {
  try {
    localStorage.setItem(TOUR_STORAGE_PREFIX + tourId, '1');
  } catch (err) {
    // Non-fatal — worst case the tour just auto-shows again next visit.
  }
}

function startTour(tourId, steps) {
  if (!steps || steps.length === 0) return;
  activeTour = { tourId, steps, index: 0 };
  tourOverlayEl.style.display = 'block';
  window.addEventListener('resize', repositionActiveTourStep);
  window.addEventListener('scroll', repositionActiveTourStep, true);
  renderTourStep();
}

// Returns the id of the tour that just ended, so the caller (see
// tourNextBtn/tourSkipBtn below) can decide what happens next — e.g. the
// calibration intro always hands off into the real wizard.
function endTour() {
  if (!activeTour) return null;
  const finishedTourId = activeTour.tourId;
  markTourSeen(finishedTourId);
  tourOverlayEl.style.display = 'none';
  tourOverlayEl.classList.remove('tour-centered');
  tourHighlightEl.style.display = 'none';
  window.removeEventListener('resize', repositionActiveTourStep);
  window.removeEventListener('scroll', repositionActiveTourStep, true);
  activeTour = null;
  return finishedTourId;
}

function renderTourStep() {
  if (!activeTour) return;
  const step = activeTour.steps[activeTour.index];
  tourStepCounterEl.textContent = `${activeTour.index + 1} of ${activeTour.steps.length}`;
  tourTitleEl.textContent = step.title;
  tourBodyEl.textContent = step.body;
  tourBackBtn.style.display = activeTour.index === 0 ? 'none' : 'inline-block';
  tourNextBtn.textContent = activeTour.index === activeTour.steps.length - 1 ? 'Done' : 'Next';

  const target = step.targetId ? document.getElementById(step.targetId) : null;
  if (target) {
    tourOverlayEl.classList.remove('tour-centered');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Give the smooth scroll a moment to settle before measuring —
    // getBoundingClientRect() called immediately after scrollIntoView can
    // still reflect the pre-scroll position on some browsers.
    setTimeout(() => positionTourStep(target), 260);
  } else {
    // No targetId, or the referenced element genuinely isn't in the DOM
    // right now (defensive — shouldn't happen with the fixed step lists
    // below, but a silently-missing highlight is worse than a graceful
    // fallback to a centered slide).
    tourOverlayEl.classList.add('tour-centered');
    tourHighlightEl.style.display = 'none';
    positionTooltipCentered();
  }
}

function positionTourStep(target) {
  if (!activeTour) return;
  const rect = target.getBoundingClientRect();
  const pad = 6;
  tourHighlightEl.style.display = 'block';
  tourHighlightEl.style.left = `${rect.left - pad}px`;
  tourHighlightEl.style.top = `${rect.top - pad}px`;
  tourHighlightEl.style.width = `${rect.width + pad * 2}px`;
  tourHighlightEl.style.height = `${rect.height + pad * 2}px`;

  const spaceBelow = window.innerHeight - rect.bottom;
  const tooltipGoesBelow = spaceBelow > 180 || rect.top < 180;
  if (tooltipGoesBelow) {
    tourTooltipEl.style.top = `${rect.bottom + pad + 12}px`;
    tourTooltipEl.style.transform = 'none';
  } else {
    tourTooltipEl.style.top = `${rect.top - pad - 12}px`;
    tourTooltipEl.style.transform = 'translateY(-100%)';
  }
  const maxLeft = Math.max(window.innerWidth - 300, 12);
  const left = Math.min(Math.max(rect.left, 12), maxLeft);
  tourTooltipEl.style.left = `${left}px`;
}

function positionTooltipCentered() {
  tourTooltipEl.style.top = '50%';
  tourTooltipEl.style.left = '50%';
  tourTooltipEl.style.transform = 'translate(-50%, -50%)';
}

function repositionActiveTourStep() {
  if (!activeTour) return;
  const step = activeTour.steps[activeTour.index];
  const target = step.targetId ? document.getElementById(step.targetId) : null;
  if (target) positionTourStep(target);
}

// What happens after a tour ends (finished OR skipped — skipping means
// "I get it, move on," not "cancel the flow"). Only the calibration intro
// currently needs a hand-off; the main app tour just ends.
// startCalibrationRef is set by wireCalibrateIntro() (called once from
// main.js) — this module doesn't import calibration's function directly,
// just holds a reference to whatever entry point main.js hands it.
let startCalibrationRef = null;

function onTourFinished(tourId) {
  if (tourId === 'calibrationIntro' && startCalibrationRef) {
    startCalibrationRef();
  }
}

tourNextBtn.addEventListener('click', () => {
  if (!activeTour) return;
  if (activeTour.index >= activeTour.steps.length - 1) {
    onTourFinished(endTour());
  } else {
    activeTour.index += 1;
    renderTourStep();
  }
});
tourBackBtn.addEventListener('click', () => {
  if (!activeTour || activeTour.index === 0) return;
  activeTour.index -= 1;
  renderTourStep();
});
tourSkipBtn.addEventListener('click', () => {
  onTourFinished(endTour());
});

// --- Main app tour content -------------------------------------------
// Walks the controls actually present in index.html today. Ordered so the
// mobile heads-up lands early (step 3) — seen before anyone invests real
// time in the rest of the walkthrough, per the student's explicit request.
const MAIN_APP_TOUR_STEPS = [
  {
    title: 'Welcome to Mumblew 👋',
    body: 'A quick, one-minute tour of the basics.'
  },
  {
    // Entry 53: targets the always-visible wrapper (#cameraTrustBlock),
    // not #privacyNote directly — that element is display:none until
    // camera access is granted, which would leave the tour highlighting
    // a hidden, zero-size element if run before then.
    targetId: 'cameraTrustBlock',
    title: 'Your camera stays private',
    body: "Video is processed on your device only — it's never uploaded or saved."
  },
  {
    title: 'Best on a laptop or desktop',
    body: 'Mobile support is still being finished — for now, use a computer.'
  },
  {
    targetId: 'textInputPanel',
    title: 'Add something to read',
    body: 'Paste text, or upload a .txt or .pdf.'
  },
  {
    targetId: 'calibrateBtn',
    title: 'Calibrate (one-time)',
    body: 'A quick ~15-second setup, tuned to how you move your mouth.'
  },
  {
    targetId: 'startBtn',
    title: 'Start Reading',
    body: 'Reads aloud while your mouth moves, pauses when it stops.'
  },
  {
    targetId: 'speechSwitchBtn',
    title: 'Pause / resume anytime',
    body: 'Click, or press Spacebar — no mouth movement needed.'
  },
  {
    targetId: 'readingControls',
    title: 'Heads-up messages',
    body: "A plain-English note shows up here if something's off, like low light."
  },
  {
    targetId: 'readingText',
    title: 'Jump to any word',
    body: 'Tap a word to jump the narration straight to it.'
  }
];

// --- Calibration intro content ----------------------------------------
// Shown before the existing 3-step wizard (CALIBRATION_STEPS above) the
// first time someone clicks Calibrate — see onCalibrateClick(). Deliberately
// short: this is a preview, not a replacement for the wizard's own
// per-step instructions.
const CALIBRATION_INTRO_STEPS = [
  {
    title: "Let's set up calibration",
    body: 'Tunes Mumblew to your mouth movement and pace — about 15 seconds, once per device.'
  },
  {
    targetId: 'container',
    title: "You'll see yourself here",
    body: 'A camera preview, shown only during calibration, to help you frame your face.'
  },
  {
    title: 'Three quick steps',
    body: 'Relax your mouth → silently mouth a sentence → pick your pace. Ready when you are.'
  }
];

// Calibrate button now shows the intro tour first time only, then always
// proceeds into the real wizard either way (see onTourFinished above) —
// skipping the intro is "I already know this," not "cancel calibration."
//
export function wireCalibrateIntro(calibrateBtn, startCalibrationFn) {
  startCalibrationRef = startCalibrationFn;
  function onCalibrateClick() {
    if (!hasSeenTour('calibrationIntro')) {
      startTour('calibrationIntro', CALIBRATION_INTRO_STEPS);
    } else {
      startCalibrationFn();
    }
  }
  calibrateBtn.removeEventListener('click', startCalibrationFn);
  calibrateBtn.addEventListener('click', onCalibrateClick);
}

if (helpTourBtn) {
  helpTourBtn.addEventListener('click', () => startTour('mainApp', MAIN_APP_TOUR_STEPS));
}

// Student-flagged gap: the calibration intro previously had NO way back —
// it only ever showed automatically, the very first time Calibrate was
// clicked (hasSeenTour('calibrationIntro') === false), with no button to
// replay it afterward. This is that button, visible at the top of the
// calibration panel on every run. Bypasses hasSeenTour() deliberately —
// this is an explicit "show it to me again" request, not the automatic
// first-time trigger. Note: since onTourFinished('calibrationIntro') always
// hands off into startCalibration() (see above), clicking this mid-wizard
// restarts calibration from step 1 once the intro finishes/is skipped —
// acceptable given the whole flow is ~15 seconds either way.
const calibrationIntroReplayBtn = document.getElementById('calibrationIntroReplayBtn');
if (calibrationIntroReplayBtn) {
  calibrationIntroReplayBtn.addEventListener('click', () => {
    startTour('calibrationIntro', CALIBRATION_INTRO_STEPS);
  });
}


// Entry 52 (2nd revision): first-visit sequencing is now gate-driven, not
// an unconditional page-load timer. See the "Welcome gate" block at the
// end of this file for the actual trigger — on first visit, NOTHING (not
// the app, not the guide, not the intro) shows until the user resolves the
// full-screen welcome gate by picking Watch or Skip. A returning visitor
// (gate already resolved) skips straight past the gate with no delay.

// --- Intro sequence (Entry 52, revised) ----------------------------------
// 8-panel illustrated problem/solution story. NEVER auto-plays and NEVER
// autoplays audio — only ever starts from an explicit click, either the
// first-visit invite card (introInviteCard, below) or the "▶ Replay Intro"
// button in the main controls. This is a deliberate reversal from the
// first version of this feature: an unrequested full-screen takeover with
// sound right at page load broke the app's own hands-free/no-forced-action
// premise, and did so on the very first thing a new visitor experiences —
// a bad note to open on for an app that exists partly to serve people who
// may not be able to click reliably (see PROGRESS.md Section 1, ALS/
// paralysis audience). Starting only from a real click has a useful side
// effect too: it sidesteps browser autoplay-audio blocking entirely, since
// playback always follows a genuine user gesture.
//
// Deliberately its own small player rather than a reuse of
// startTour()/renderTourStep() above — that engine is built around
// highlighting a DOM control with a text tooltip, and has no notion of a
// full-bleed image or an attached audio track. Follows the same
// conventions as the tour engine (hasSeenTour/markTourSeen storage keys,
// dark overlay + teal accent, always-visible Skip) for consistency.
//
// Panel 8 is deliberately silent (no narration-8.mp3 — the story's payoff
// beat is visual, not spoken) and is the one panel that does NOT
// auto-advance: it holds on the image, fades in the logo + tagline, and
// waits for an explicit "Get Started" click — same reasoning as above,
// applied to how the sequence ends as well as how it begins.
const INTRO_PANEL_COUNT = 8;
const INTRO_ASSET_BASE = 'assets/intro/';
// Panel 8 has no entry here — it's handled as the silent final beat below.
const INTRO_PANELS = [
  { image: `${INTRO_ASSET_BASE}panel-1.jpg`, audio: `${INTRO_ASSET_BASE}narration-1.mp3`,
    caption: 'This is John. Looks like he is trying to read something interesting, but... why does he look so desperate?' },
  { image: `${INTRO_ASSET_BASE}panel-2.jpg`, audio: `${INTRO_ASSET_BASE}narration-2.mp3`,
    caption: "But his mind keeps drifting. A sentence in, and he's already somewhere else." },
  { image: `${INTRO_ASSET_BASE}panel-3.jpg`, audio: `${INTRO_ASSET_BASE}narration-3.mp3`,
    caption: "He tries to mumble a little louder, but unluckily, that's enough to disturb the people around him." },
  { image: `${INTRO_ASSET_BASE}panel-4.jpg`, audio: `${INTRO_ASSET_BASE}narration-4.mp3`,
    caption: 'His sister notices — she has seen this before.' },
  { image: `${INTRO_ASSET_BASE}panel-5.jpg`, audio: `${INTRO_ASSET_BASE}narration-5.mp3`,
    caption: "Try this. You don't tap anything — you just read like you normally would, quietly, and it keeps pace with you." },
  { image: `${INTRO_ASSET_BASE}panel-6.jpg`, audio: `${INTRO_ASSET_BASE}narration-6.mp3`,
    caption: "Reading life changes for John. For the first time in a while, reading doesn't feel like a fight." },
  { image: `${INTRO_ASSET_BASE}panel-7.jpg`, audio: `${INTRO_ASSET_BASE}narration-7.mp3`,
    caption: 'Just your lips. Your device and a pair of headphones. That\u2019s all you need...' },
];
const INTRO_FINAL_PANEL_IMAGE = `${INTRO_ASSET_BASE}panel-8.jpg`;

const introOverlayEl = document.getElementById('introOverlay');
const introImgEl = document.getElementById('introImg');
const introCaptionEl = document.getElementById('introCaption');
const introProgressDotsEl = document.getElementById('introProgressDots');
const introSkipBtn = document.getElementById('introSkipBtn');
const introReplayBtn = document.getElementById('introReplayBtn');
const introLogoOverlayEl = document.getElementById('introLogoOverlay');
const introGetStartedBtn = document.getElementById('introGetStartedBtn');

let introState = null; // { index, audioEl, onComplete, advanceTimerId }

function buildIntroProgressDots() {
  introProgressDotsEl.textContent = '';
  const totalDots = INTRO_PANEL_COUNT;
  for (let i = 0; i < totalDots; i++) {
    const dot = document.createElement('div');
    dot.className = 'intro-dot';
    introProgressDotsEl.appendChild(dot);
  }
}

function setIntroActiveDot(index) {
  const dots = introProgressDotsEl.querySelectorAll('.intro-dot');
  dots.forEach((dot, i) => dot.classList.toggle('intro-dot-active', i === index));
}

// Preload every panel image up front (they're small post-compression —
// ~150-250KB each, ~1.6MB total) so later panels don't pop in with a
// blank/half-loaded frame while the story is mid-flow.
function preloadIntroImages() {
  INTRO_PANELS.forEach((panel) => { new Image().src = panel.image; });
  new Image().src = INTRO_FINAL_PANEL_IMAGE;
}

function startIntroSequence(onComplete) {
  introState = { index: 0, audioEl: null, onComplete, advanceTimerId: null };
  buildIntroProgressDots();
  preloadIntroImages();
  introOverlayEl.classList.add('intro-visible');
  introSkipBtn.style.display = 'block';
  introLogoOverlayEl.classList.remove('intro-logo-visible');
  playIntroPanel(0);
}

function stopIntroAudio() {
  if (introState && introState.audioEl) {
    introState.audioEl.pause();
    introState.audioEl.onended = null;
    introState.audioEl = null;
  }
  if (introState && introState.advanceTimerId) {
    clearTimeout(introState.advanceTimerId);
    introState.advanceTimerId = null;
  }
}

function playIntroPanel(index) {
  if (!introState) return;
  introState.index = index;
  setIntroActiveDot(index);

  if (index >= INTRO_PANEL_COUNT - 1) {
    // Final panel (8): silent landing beat — image only, no audio, no
    // auto-advance. Hold briefly, then fade in the logo + Get Started.
    introImgEl.classList.remove('intro-img-visible');
    introImgEl.src = INTRO_FINAL_PANEL_IMAGE;
    introCaptionEl.textContent = '';
    introImgEl.onload = () => introImgEl.classList.add('intro-img-visible');
    introState.advanceTimerId = setTimeout(() => {
      introLogoOverlayEl.classList.add('intro-logo-visible');
    }, 1600);
    return;
  }

  const panel = INTRO_PANELS[index];
  introImgEl.classList.remove('intro-img-visible');
  introImgEl.src = panel.image;
  introCaptionEl.textContent = panel.caption;
  introImgEl.onload = () => introImgEl.classList.add('intro-img-visible');

  const audio = new Audio(panel.audio);
  introState.audioEl = audio;
  audio.onended = () => {
    if (!introState) return; // sequence was skipped/ended mid-playback
    playIntroPanel(index + 1);
  };
  // If audio fails to load/play (blocked autoplay policy, missing file,
  // etc.) don't strand the user on a silent panel forever — fall back to a
  // fixed hold so the sequence still progresses.
  audio.onerror = () => {
    if (!introState) return;
    introState.advanceTimerId = setTimeout(() => playIntroPanel(index + 1), 4000);
  };
  const playPromise = audio.play();
  if (playPromise && playPromise.catch) {
    playPromise.catch(() => {
      if (!introState) return;
      introState.advanceTimerId = setTimeout(() => playIntroPanel(index + 1), 4000);
    });
  }
}

function endIntroSequence() {
  if (!introState) return;
  const onComplete = introState.onComplete;
  stopIntroAudio();
  markTourSeen('introSequence');
  introOverlayEl.classList.remove('intro-visible');
  introLogoOverlayEl.classList.remove('intro-logo-visible');
  introSkipBtn.style.display = 'none';
  introState = null;
  if (onComplete) onComplete();
}

introSkipBtn.addEventListener('click', endIntroSequence);
introGetStartedBtn.addEventListener('click', endIntroSequence);

// "▶ Replay Intro" — explicit re-watch request, always available regardless
// of hasSeenTour('introSequence'). No onComplete chain here: replaying
// doesn't need to also re-trigger the main app tour afterward.
if (introReplayBtn) {
  introReplayBtn.addEventListener('click', () => {
    startIntroSequence(null);
  });
}

// --- Intro invite card (Entry 52 revision) -------------------------------
// Replaces the old auto-play trigger entirely. A small, dismissible,
// non-blocking card — same "honest heads-up, never forced" spirit as the
// mobile-viewport banner. Shown once per unseen state near the top of the
// page; clicking it plays the intro (a real user gesture, so audio always
// works), dismissing it just hides it for this pageview without marking
// the sequence "seen" — the student can still find it later via "▶ Replay
// Intro" in the main controls either way.
// --- Welcome gate (Entry 52, 2nd revision) --------------------------------
// Full-screen first-visit gate — replaces the earlier inline invite card.
// While ungated visitors are viewing the app normally, a genuine first-time
// visitor sees ONLY this (see body.app-gated in the CSS, which hides
// #appLayout/#feedbackWidget/#mobileNoticeBanner entirely) until they pick
// one of the two options below. Either path ends the same way: the gate
// closes, the app becomes visible, and the coach-mark guide fires exactly
// as it always has — the only thing that changed is WHEN that first
// reveal happens, and whether the intro story played first.
const welcomeGateEl = document.getElementById('welcomeGate');
const welcomeGateWatchBtn = document.getElementById('welcomeGateWatchBtn');
const welcomeGateSkipBtn = document.getElementById('welcomeGateSkipBtn');

// Resolves the gate visually (app becomes visible, gate marked seen) but
// does NOT decide when/whether the guide tour fires — callers do that
// explicitly, since the two paths need different timing (see below).
function resolveWelcomeGate() {
  document.body.classList.remove('app-gated');
  markTourSeen('welcomeGate');
}

function maybeStartMainTour() {
  if (!hasSeenTour('mainApp')) {
    setTimeout(() => startTour('mainApp', MAIN_APP_TOUR_STEPS), 400);
  }
}

if (welcomeGateWatchBtn) {
  welcomeGateWatchBtn.addEventListener('click', () => {
    // Reveal the app first (so it's not hidden behind two stacked
    // full-screen overlays), then immediately hand off into the intro
    // sequence, which draws its own overlay on top — same visual result
    // as before (full-screen story), just via one gate instead of two.
    // The guide tour is intentionally NOT scheduled here — it would fire
    // ~400ms later, while the ~45s intro story is still playing underneath
    // it. Instead it's passed as the intro's onComplete callback, so it
    // only appears once the story has actually finished (or been skipped
    // via the intro's own Skip button).
    resolveWelcomeGate();
    startIntroSequence(maybeStartMainTour);
  });
}
if (welcomeGateSkipBtn) {
  welcomeGateSkipBtn.addEventListener('click', () => {
    resolveWelcomeGate();
    maybeStartMainTour();
  });
}

// Note: the gate's INITIAL hidden state is applied synchronously by the
// inline <script> at the top of <body> in index.html — not here. This
// module script is deferred by the browser (type="module"), so by the
// time this file runs, the page has already painted; relying on this code
// to apply the class would flash the real app UI first on every visit,
// defeating the point of the gate. This block only ever REMOVES the class
// (via resolveWelcomeGate(), wired to the two buttons above).
