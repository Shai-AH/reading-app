// readingState.js — shared mutable state for the mouth-tracking/speech/
// calibration/warning-box core.
//
// This file is deliberately NOT a "core" or "engine" module — it owns no
// logic, only the handful of fields that get read across domain boundaries
// (mouth-tracking, speech, calibration, the warning box) even though each
// is written primarily by one of them. See PROGRESS.md Section 2: shared
// state needs a deliberate export design, not a mechanical split — this is
// that design, introduced as its own step BEFORE physically relocating the
// mouth-tracking/speech/calibration functions into their own files. Once
// every cross-domain touch of these fields goes through the get/set
// functions below instead of a raw shared `let`, splitting the functions
// themselves into separate files becomes mechanical (each file just imports
// the getters/setters it needs), rather than a redesign done under pressure
// mid-split.
//
// Ownership (who's expected to call the setter — nothing here enforces it,
// this is a convention, same trust model as the rest of the codebase):
//   mouthState, isFaceVisible, noFaceSince  — mouth-tracking's frame loop
//   readingActive, isSpeakingChunk,
//   lastWordBoundaryTime,
//   currentSpokenWordExpectedMs             — speech's start/stop and
//                                              word-boundary handling
//   calibrationActive                       — calibration's lifecycle
//     (mirrors calibration.active from main.js's richer calibration object
//     — that object stays where calibration's OTHER fields live, stepIndex/
//     phase/samples/etc. aren't read outside calibration, only .active is,
//     so only .active gets a seam here rather than duplicating the whole
//     object's shape.)
// Everything else in this file is a reader, not a writer, of these fields.

let mouthState = 'closed'; // 'open' | 'closed'
export function getMouthState() { return mouthState; }
export function setMouthState(value) { mouthState = value; }

let isFaceVisible = true;
export function getIsFaceVisible() { return isFaceVisible; }
export function setIsFaceVisible(value) { isFaceVisible = value; }

// performance.now() timestamp of when landmarks last went missing, or null
// while a face is being seen.
let noFaceSince = null;
export function getNoFaceSince() { return noFaceSince; }
export function setNoFaceSince(value) { noFaceSince = value; }

// true from Start Reading click until the whole text finishes.
let readingActive = false;
export function getReadingActive() { return readingActive; }
export function setReadingActive(value) { readingActive = value; }

// true while a (possibly multi-word) utterance is actively speaking.
let isSpeakingChunk = false;
export function getIsSpeakingChunk() { return isSpeakingChunk; }
export function setIsSpeakingChunk(value) { isSpeakingChunk = value; }

// Mirrors main.js's calibration.active — see ownership note above.
let calibrationActive = false;
export function getCalibrationActive() { return calibrationActive; }
export function setCalibrationActive(value) { calibrationActive = value; }

// performance.now() timestamp of the most recent onboundary event (or a
// manual resync) — written from speech's word-boundary handling
// (highlightWordAt/speakFrom), read by trouble-shading/warning-box to
// measure how long the current word has been open.
let lastWordBoundaryTime = 0;
export function getLastWordBoundaryTime() { return lastWordBoundaryTime; }
export function setLastWordBoundaryTime(value) { lastWordBoundaryTime = value; }

// Expected duration (ms) for the word currently being spoken — written
// alongside lastWordBoundaryTime from the same speech call sites.
let currentSpokenWordExpectedMs = 0;
export function getCurrentSpokenWordExpectedMs() { return currentSpokenWordExpectedMs; }
export function setCurrentSpokenWordExpectedMs(value) { currentSpokenWordExpectedMs = value; }

// Manual ON/OFF reading switch (Space bar / click) — written from speech's
// switch-toggle handling, read by mouth-tracking's gating and the warning
// box's priority check. Named ...Flag (not setManualSpeechEnabled) because
// main.js has a richer setManualSpeechEnabled() with side effects (UI
// update) that calls this raw setter internally — same two-tier pattern as
// e.g. tour.js's wireCalibrateIntro wrapping a plain state change.
let manualSpeechEnabled = true;
export function getManualSpeechEnabled() { return manualSpeechEnabled; }
export function setManualSpeechEnabledFlag(value) { manualSpeechEnabled = value; }

// true right before an intentional cancel() (mouth closing, calibration
// starting, a fresh session resetting, word-click resync) — written from
// calibration and main.js's session-reset code as well as speech itself,
// read by speech's stop-handling to distinguish "we asked for this" from
// an unexpected stop.
let manualCancel = false;
export function getManualCancel() { return manualCancel; }
export function setManualCancel(value) { manualCancel = value; }

// performance.now() when cancel() was requested — diagnostic pairing with
// manualCancel, same writers/reader.
let cancelRequestedTime = null;
export function getCancelRequestedTime() { return cancelRequestedTime; }
export function setCancelRequestedTime(value) { cancelRequestedTime = value; }
