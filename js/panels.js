// panels.js — settings and debug corner-widget panel toggles.
// Extracted from main.js (Entry 55 modularization, Section 3d #1).
// Fully self-contained: no external state, no exports — just wires up its
// own buttons on import. Same "corner widget" pattern as the feedback
// widget (js/feedback.js).

const settingsToggleBtn = document.getElementById('settingsToggleBtn');
const settingsPanelEl = document.getElementById('settingsPanel');
const settingsCloseBtn = document.getElementById('settingsCloseBtn');

function openSettingsPanel() {
  settingsPanelEl.hidden = false;
  settingsToggleBtn.setAttribute('aria-expanded', 'true');
}
function closeSettingsPanel() {
  settingsPanelEl.hidden = true;
  settingsToggleBtn.setAttribute('aria-expanded', 'false');
}
settingsToggleBtn.addEventListener('click', () => {
  if (settingsPanelEl.hidden) openSettingsPanel(); else closeSettingsPanel();
});
settingsCloseBtn.addEventListener('click', closeSettingsPanel);

const debugToggleBtn = document.getElementById('debugToggleBtn');
const debugPanelEl = document.getElementById('debugPanel');
const debugCloseBtn = document.getElementById('debugCloseBtn');

function openDebugPanel() {
  debugPanelEl.hidden = false;
  debugToggleBtn.setAttribute('aria-expanded', 'true');
}
function closeDebugPanel() {
  debugPanelEl.hidden = true;
  debugToggleBtn.setAttribute('aria-expanded', 'false');
}
debugToggleBtn.addEventListener('click', () => {
  if (debugPanelEl.hidden) openDebugPanel(); else closeDebugPanel();
});
debugCloseBtn.addEventListener('click', closeDebugPanel);
