# Mumblew — Small-Scale Ship Guide

Goal (per PROGRESS.md Section 3d #3): desktop/laptop only, honest about scope,
10–20 outside readers, gather real feedback before deciding what to build next.

---

## Phase 1 — Pre-Launch Check (do this before sending to anyone, ~15 min)

Do this yourself first, then — important — hand your laptop to one friend or
family member and watch them use it **without any guidance from you**. That's
your last chance to catch a confusing moment before a stranger hits it.

- [ ] Open the live `mumblew.vercel.app` link in a fresh Incognito window
- [ ] Confirm the onboarding tour appears on first visit and makes sense
- [ ] Run through calibration once, start-to-finish
- [ ] Load or paste in a short piece of text and actually read a paragraph
      out loud (quietly) — confirm speech follows your mouth movement
- [ ] Trigger the low-light warning on purpose (dim the room or cover the
      camera partially) — does the message make sense to someone who's
      never seen the code?
- [ ] Open the feedback widget, submit a real test entry, confirm it lands
      in your Formspree inbox (not spam)
- [ ] Resize the window narrow / check on your phone — does the mobile
      notice show up and make sense?
- [ ] Check the browser Console (F12) for any red errors during all of the above
- [ ] Have your one outside tester do the whole flow cold — note anywhere
      they hesitate or ask "wait, what do I do here?"

Don't move to Phase 2 until this list is clean.

---

## Phase 2 — Decide Your Honest Framing

Your PROGRESS.md is explicit about this: don't small-ship while known issues
would just make testers rediscover bugs you already know about. So the
pitch has to *say* what's still rough, not hide it. That's not weakness —
it's what makes the feedback you get back actually new information instead
of "yeah I know."

Say clearly, every time, in the message and ideally in-app (the tour
already does this for mobile):
- **Desktop/laptop only** — mobile is in progress
- **Needs a webcam + decent lighting** — dark rooms may not track well yet
- **This is an early beta** — rough edges expected, that's the point

---

## Phase 3 — Where to Find 10–20 Testers

Mix a few sources so you're not just hearing from one type of person:

**People you already know (aim for 4–6 here — do these first as a "soft open")**
- Classmates, CS club/Discord, friends who read a lot or use ebooks/apps to read

**Relevant online communities (check each sub's self-promo rules before posting)**
- r/SideProject, r/somebodymakethis, r/InternetIsBeautiful — general project shares
- r/assistivetechnology, r/accessibility — your ALS/paralysis use case is genuinely
  relevant here, be upfront about what stage it's at
- r/ADHD, r/neurodivergent — if you want to specifically test the active-engagement angle
- University-specific Discord/Slack or CS club channels

**"Build in public" channels**
- X/Twitter, LinkedIn, or a dev Discord if you're in one — even a short post works

Aim for the soft-open group first (catches embarrassing bugs before a wider
audience sees them), then open it up over the following few days rather
than blasting everywhere at once.

---

## Phase 4 — Message Template

Something like this, adjusted to your voice:

> Hey — I built a small reading app called **Mumblew**. It reads text out
> loud to you, but instead of tapping play/pause, it watches your mouth
> move (quiet mumbling, no sound needed) to control the pacing — built
> partly for people who want to read in bed without a light, and partly
> for people who have trouble vocalizing but can still move their mouth.
>
> It's an early beta — **works on laptop/desktop only right now, needs a
> webcam, works best in decent lighting.** Mobile's coming later.
>
> Would love it if you tried it for a few minutes: [your link]
> There's a feedback button in the corner — genuinely want the honest
> version, good or bad.

Keep it short. People skim.

---

## Phase 5 — While Feedback Comes In

- Check your Formspree dashboard every day or two, not obsessively
- Look for **patterns across multiple people**, not single anecdotes —
  one person confused by calibration is a data point, three people
  confused by the same step is a signal
- Glance for anything odd in submitted text (this is standard hygiene for
  any public form, nothing specific to expect — just don't act on any
  single weird submission without corroboration)
- Don't start building fixes mid-collection unless something is clearly
  broken for everyone — let the full round finish first so you're deciding
  from a complete picture, per PROGRESS.md Section 3d #4

---

## Phase 6 — Wrap-Up

Once you've got responses from ~10–20 people (or it's been about a week,
whichever comes first):
- Come back and we'll go through the responses together
- We'll update PROGRESS.md with what came in
- Then decide the next priority per Section 3d #4 — finishing the mobile
  fix, building the fuller adaptive light system, or whatever the
  feedback actually points to
