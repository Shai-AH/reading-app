# Mumblew Intro — Image Generation Prompts

Style reference: your uploaded storyboard image (grayscale pencil/ink,
loose expressive linework, soft cross-hatch shading, cinematic panel
framing, slightly rounded character proportions).

## Leonardo-specific setup (learned from Panel 1 test generation)

The first test came out photorealistic instead of sketchy, because it
used the **"Lucid Origin"** model — that model leans photorealistic by
design, and text alone won't fully override it. Two fixes, use both:

1. **Switch the model/preset to "Sketch (B&W)"** (or another
   illustration-leaning preset if that one isn't available on your
   plan) instead of Lucid Origin, for every panel.
2. **Use Image Guidance → "Line Art" mode** with your original reference
   storyboard image uploaded as the guide image. This steers the actual
   linework toward your reference far more reliably than style words in
   the prompt alone. Keep the guide image attached for all 8 panels.

Both fixes apply to every panel below, not just Panel 1.

**Workflow tip:** generate Panel 1 first with the fixes above. If your
tool supports feeding a generated image back in as a reference (on top
of the original Image Guidance), feed Panel 1 back in for every later
panel too — this matters more than any text description for keeping
John recognizable across all 8 shots.

**Copy the character blocks below EXACTLY THE SAME into every prompt that
uses them.** Don't reword them panel to panel — consistency depends on it.

---

### Reusable character blocks

**JOHN (paste verbatim into every John prompt):**
> a young man in his early 20s, short tousled brown hair, wearing a
> plain crewneck sweater, medium build, expressive soft facial features

**SISTER (paste verbatim into every Sister prompt):**
> a young woman, slightly younger than John, hair tied back in a loose
> ponytail, wearing a casual t-shirt, warm expressive face

**BASE STYLE TAG (append to every prompt):**
> black and white pencil storyboard illustration, loose expressive
> linework, soft cross-hatch shading, cinematic panel composition,
> hand-drawn sketch style, grayscale, no color

**AVOID (add as negative prompt / exclusion if your tool supports it):**
> photorealistic, digital painting, 3D render, visible brand logos,
> visible laptop manufacturer logos

---

### Panel 1 — Setup (0:00–0:08)

> Storyboard panel, black and white pencil illustration. Interior, cozy
> living room, evening lamp light. [JOHN block] is lying/reclining on a
> couch, laptop open on his lap, unbranded laptop with no visible logo,
> looking down at the screen, calm posture, hands resting rather than
> typing, just beginning to read. Wide shot, slightly high angle,
> establishing the room. [BASE STYLE TAG]

### Panel 2 — Distraction begins (0:08–0:16)

> Storyboard panel, black and white pencil illustration. Same living
> room, same couch. [JOHN block], now shown from a closer three-quarter
> angle, eyes on his laptop screen (unbranded, no visible logo) but his
> gaze slightly unfocused. Small abstract thought-fragment doodles
> (swirls, faint disconnected shapes, a wandering line) drawn floating
> above and around his head, illustrating a wandering mind. [BASE STYLE
> TAG]

### Panel 3 — Frustration escalates (0:16–0:26)

> Storyboard panel, black and white pencil illustration. Close-up on
> [JOHN block], now visibly frustrated — furrowed brow, tense shoulders,
> gripping the edges of his unbranded laptop tighter, leaning forward.
> More thought-fragment doodles crowding around his head than the
> previous panel, denser and more chaotic. Tight framing on his face and
> upper body. [BASE STYLE TAG]

### Panel 4 — The reveal (0:26–0:33)

> Storyboard panel, black and white pencil illustration. Camera pulls
> back to a wider shot of the same living room. Reveal [SISTER block]
> sitting nearby on the same couch or an adjacent chair, her own
> unbranded laptop open on her lap, glancing over at John with a look of
> concern/notice after seeing his frustration. John still visible in
> frame, tense, unaware she's looking. [BASE STYLE TAG]

### Panel 5 — She offers Mumblew (0:33–0:40)

> Storyboard panel, black and white pencil illustration. Medium shot,
> both characters visible. [SISTER block] is turning/rotating her open
> unbranded laptop toward John so he can see her screen. Her laptop
> screen shows simple visible lines of text (no logos, just plain
> readable text blocky lines to suggest a reading app interface). Her
> expression is warm, encouraging, gentle smile. John looking toward her
> laptop, curious. [BASE STYLE TAG]

### Panel 6 — He takes it in (0:40–0:46)

> Storyboard panel, black and white pencil illustration. Close-up on
> [JOHN block]'s face only, looking at the laptop screen (off-panel or
> just his sister's laptop edge visible), a thoughtful, quietly hopeful
> expression — brow relaxing, small shift from tense to open. [BASE
> STYLE TAG]

### Panel 7 — The turn / color bloom (0:46–0:58)

> Storyboard panel illustration, TRANSITIONING FROM BLACK AND WHITE TO
> SOFT WARM COLOR. Same living room. [JOHN block], now shown using his
> own unbranded laptop again, mouth slightly open mid-word (quiet
> subvocalizing, not shouting), relaxed posture, small content smile.
> The pencil linework stays visible but soft warm color washes in — warm
> lamp-light oranges and gentle yellows spreading from around him
> outward, as if color is blooming into the scene. The rest of the room
> can remain mostly grayscale with color concentrated around John, to
> emphasize the shift is about him specifically.

### Panel 8 — Landing (0:58–1:04, or adjust to your final runtime)

> Full soft warm color illustration (matching Panel 7's palette), same
> pencil-linework style but now fully colored. Simple, minimal — the
> living room fades to a soft warm gradient background. No text (logo
> and tagline will be added separately in code, not in the image).

---

### Notes

- If your tool lets you set a fixed seed, reuse the same seed across all
  8 prompts — this alone often does more for consistency than the text
  description does.
- If John or the sister drift in appearance between generations, try
  regenerating that one panel a few times rather than accepting a
  slightly-off version — better to burn extra free credits than ship a
  visibly-different character mid-sequence.
- Panel 7 is intentionally the hardest prompt (asking for a style
  transition) — expect to iterate on it the most. If your tool can't do
  a true black-and-white-to-color blend in one image, an acceptable
  fallback is: keep Panel 7 fully grayscale (matching 1–6) and let Panel
  8 be the first fully-colored frame — the "turn" then happens as a
  cut between two static images instead of within one, which is
  simpler to achieve and still reads clearly once we animate the
  transition in code.
- After each generation, do a quick 2-second check against this list:
  right style (sketchy, not photoreal)? No visible brand logos? Right
  posture/action for the beat? Catching a miss early is cheaper than
  catching it on panel 6.

