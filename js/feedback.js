// feedback.js — small-ship user feedback widget (Formspree-backed).
// Extracted from main.js (Entry 55 modularization, Section 3d #1).
//
// Fully self-contained except for two pieces of context this module has no
// business knowing about directly (calibration storage key, the rate
// slider): initFeedbackWidget(getContext) takes a callback supplied by
// main.js instead, returning { hasCalibration, speedSetting } fresh at
// submit time — same injection pattern as tour.js's wireCalibrateIntro.

// --- Feedback widget (Entry 51) ----------------------------------------
// Small-ship user feedback, collected via Formspree (free tier, no backend
// of our own to write or secure — see PROGRESS.md Section 3 for the
// reasoning). Two kinds of data go up per submission:
//   1) What the tester explicitly gives us: star rating, quick tags,
//      optional free text.
//   2) What we capture automatically, at zero cost to the tester: browser/
//      viewport info, whether calibration is set up, and the current speed
//      setting — the context that turns "tracking felt off" into an
//      actionable bug report instead of a shrug.
// None of this touches the camera/lip-tracking pipeline; it's fully
// separate from the app's core privacy promise (video never leaves the
// device — this is just opt-in text the tester types themselves).
const FORMSPREE_ENDPOINT = 'https://formspree.io/f/xkoddvqj';

let feedbackRating = 0;
const feedbackSelectedTags = new Set();

// Soft client-side cooldown — NOT a real security boundary (anyone can
// bypass client-side JS), just stops accidental double-taps/rapid re-
// submits from one honest tester from cluttering the dashboard. Formspree's
// own spam filtering + the honeypot field below are the actual defenses.
const FEEDBACK_COOLDOWN_MS = 15000;
// Bug fix (session after E56): this used to be a plain in-memory variable,
// reset to 0 on every page reload — so the cooldown was a one-click bypass
// (reload, submit again immediately). Persisting to localStorage means the
// cooldown survives a reload; it's still not a hard security boundary
// (clearing storage or a different browser resets it too), but it closes
// the trivial bypass without standing up a backend. Wrapped defensively:
// a corrupted/missing value or a localStorage read failure (e.g. private
// browsing in older Safari) falls back to 0, same as the old default,
// rather than breaking the whole widget.
const FEEDBACK_LAST_SUBMIT_STORAGE_KEY = 'readingAppFeedbackLastSubmitAt';
function readFeedbackLastSubmitAt() {
  try {
    const stored = parseInt(localStorage.getItem(FEEDBACK_LAST_SUBMIT_STORAGE_KEY), 10);
    return Number.isFinite(stored) ? stored : 0;
  } catch {
    return 0;
  }
}
function writeFeedbackLastSubmitAt(value) {
  try {
    localStorage.setItem(FEEDBACK_LAST_SUBMIT_STORAGE_KEY, String(value));
  } catch {
    // Storage unavailable/full — cooldown just falls back to in-memory-only
    // behavior for this session, same as before the fix. Not worth
    // surfacing to the tester over a soft anti-spam nicety.
  }
}
let feedbackLastSubmitAt = readFeedbackLastSubmitAt();

// getContext: () => { hasCalibration: boolean, speedSetting: string } —
// supplied by main.js so this module doesn't need to import
// CALIBRATION_STORAGE_KEY or hold a reference to rateSliderEl itself.
export function initFeedbackWidget(getContext) {
  const feedbackToggleBtn = document.getElementById('feedbackToggleBtn');
  const feedbackPanelEl = document.getElementById('feedbackPanel');
  const feedbackCloseBtn = document.getElementById('feedbackCloseBtn');
  const feedbackFormViewEl = document.getElementById('feedbackFormView');
  const feedbackThanksViewEl = document.getElementById('feedbackThanksView');
  const feedbackStarsEl = document.getElementById('feedbackStars');
  const feedbackTagsEl = document.getElementById('feedbackTags');
  const feedbackTextAreaEl = document.getElementById('feedbackTextArea');
  const feedbackHoneypotEl = document.getElementById('feedbackHoneypot');
  const feedbackSubmitBtn = document.getElementById('feedbackSubmitBtn');
  const feedbackErrorMsgEl = document.getElementById('feedbackErrorMsg');

  function openFeedbackPanel() {
    feedbackPanelEl.hidden = false;
    feedbackToggleBtn.setAttribute('aria-expanded', 'true');
  }
  function closeFeedbackPanel() {
    feedbackPanelEl.hidden = true;
    feedbackToggleBtn.setAttribute('aria-expanded', 'false');
  }
  feedbackToggleBtn.addEventListener('click', () => {
    if (feedbackPanelEl.hidden) openFeedbackPanel(); else closeFeedbackPanel();
  });
  feedbackCloseBtn.addEventListener('click', closeFeedbackPanel);

  function renderFeedbackStars() {
    feedbackStarsEl.querySelectorAll('.feedback-star').forEach((btn) => {
      const val = parseInt(btn.dataset.value, 10);
      btn.classList.toggle('feedback-star-filled', val <= feedbackRating);
      btn.setAttribute('aria-pressed', val === feedbackRating ? 'true' : 'false');
    });
  }
  feedbackStarsEl.querySelectorAll('.feedback-star').forEach((btn) => {
    btn.addEventListener('click', () => {
      feedbackRating = parseInt(btn.dataset.value, 10);
      renderFeedbackStars();
    });
  });

  feedbackTagsEl.querySelectorAll('.feedback-tag').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      if (feedbackSelectedTags.has(tag)) {
        feedbackSelectedTags.delete(tag);
        btn.classList.remove('feedback-tag-selected');
      } else {
        feedbackSelectedTags.add(tag);
        btn.classList.add('feedback-tag-selected');
      }
    });
  });

  function resetFeedbackForm() {
    feedbackRating = 0;
    feedbackSelectedTags.clear();
    renderFeedbackStars();
    feedbackTagsEl.querySelectorAll('.feedback-tag').forEach((btn) => btn.classList.remove('feedback-tag-selected'));
    feedbackTextAreaEl.value = '';
    feedbackHoneypotEl.value = '';
    feedbackErrorMsgEl.textContent = '';
    feedbackFormViewEl.hidden = false;
    feedbackThanksViewEl.hidden = true;
  }

  async function submitFeedback() {
    feedbackErrorMsgEl.textContent = '';

    // Honeypot tripped: silently pretend success. Never tell a bot its
    // submission was rejected — that just teaches it to try again differently.
    if (feedbackHoneypotEl.value.trim() !== '') {
      feedbackFormViewEl.hidden = true;
      feedbackThanksViewEl.hidden = false;
      setTimeout(() => { closeFeedbackPanel(); resetFeedbackForm(); }, 2500);
      return;
    }

    const now = Date.now();
    if (now - feedbackLastSubmitAt < FEEDBACK_COOLDOWN_MS) {
      feedbackErrorMsgEl.textContent = 'Already sent — thanks! Give it a moment before sending more.';
      return;
    }
    if (feedbackRating === 0 && feedbackSelectedTags.size === 0 && feedbackTextAreaEl.value.trim() === '') {
      feedbackErrorMsgEl.textContent = 'Add a rating, a tag, or a note first.';
      return;
    }

    feedbackSubmitBtn.disabled = true;
    feedbackSubmitBtn.textContent = 'Sending…';

    const { hasCalibration, speedSetting } = getContext();

    const payload = {
      rating: feedbackRating || null,
      tags: Array.from(feedbackSelectedTags),
      message: feedbackTextAreaEl.value.trim(),
      // Auto-captured context (Section 3's "useful FOR US" requirement):
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      hasCalibration,
      speedSetting,
      pageUrl: window.location.href,
      submittedAt: new Date().toISOString(),
      _gotcha: '' // honeypot, confirmed empty above
    };

    try {
      const response = await fetch(FORMSPREE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error('Formspree responded with an error');

      feedbackLastSubmitAt = now;
      writeFeedbackLastSubmitAt(now);
      feedbackFormViewEl.hidden = true;
      feedbackThanksViewEl.hidden = false;
      setTimeout(() => { closeFeedbackPanel(); resetFeedbackForm(); }, 2500);
    } catch (err) {
      feedbackErrorMsgEl.textContent = "Couldn't send — check your connection and try again.";
    } finally {
      feedbackSubmitBtn.disabled = false;
      feedbackSubmitBtn.textContent = 'Send feedback';
    }
  }
  feedbackSubmitBtn.addEventListener('click', submitFeedback);
}
