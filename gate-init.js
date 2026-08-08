// Entry 52 (3rd revision): must run synchronously, before any app markup
// paints — this is what actually prevents the flash of the real app UI on
// a first visit, before main.js (a deferred module script at the end of
// <body>) gets a chance to run.
//
// This used to be an inline <script> tag directly in index.html, but the
// site's CSP (see vercel.json) sets script-src without 'unsafe-inline',
// which silently blocks inline scripts — exactly the same category of bug
// as Entry 51's Formspree connect-src issue, just a different directive.
// Deploying is how this surfaced: it worked perfectly in local testing
// (no CSP header from a plain local file server) and silently failed once
// live. Moved to this standalone file and referenced as a plain, non-
// module, non-deferred <script src="gate-init.js"> so it (a) satisfies
// script-src 'self' and (b) still executes synchronously in place, same
// timing as the inline version had.
//
// Kept deliberately tiny and dependency-free. Uses the same storage key
// convention as hasSeenTour()/markTourSeen() in main.js (TOUR_STORAGE_PREFIX
// + 'welcomeGate') so both stay in sync without sharing code.
try {
  if (localStorage.getItem('readingAppTourSeen_welcomeGate') !== '1') {
    document.body.classList.add('app-gated');
  }
} catch (err) {
  // Storage unavailable — fail open (show the app normally) rather than
  // risk permanently hiding it behind a gate that can never resolve.
}
