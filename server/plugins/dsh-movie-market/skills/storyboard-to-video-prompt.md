---
name: Storyboard to Video Prompt
description: Turn a shot plan and storyboard into structured text-to-video generation prompts — per-shot subject, action, framing, lens, lighting, and motion cues.
target: shot-plan
version: 1.0.0
license: MIT
provider: dsh_movie
---

# Storyboard to Video Prompt

This skill bridges the shot plan to a text-to-video generator. It converts each
storyboarded shot into a structured prompt so generated clips stay consistent
with the planned framing, lens, and motion. For background on storyboard
conventions, see the reference: https://en.wikipedia.org/wiki/Storyboard

## Prompt structure (per shot)

Write each prompt in a stable field order so results are comparable:

1. **Subject** — who/what is in frame, with any continuity-critical detail.
2. **Action** — what happens during the shot (a single, clear verb phrase).
3. **Framing** — shot size and angle (e.g. "medium close-up, low angle").
4. **Lens / depth** — focal-length feel and depth of field (e.g. "85mm, shallow
   focus").
5. **Camera move** — the motivated motion, or "static" (e.g. "slow dolly-in").
6. **Lighting / mood** — key light, contrast, palette, time of day.
7. **Style** — the shared visual grammar for the whole sequence (keep it constant
   across shots to avoid drift).

## Consistency rules

- Freeze a **style block** and reuse it verbatim in every shot prompt.
- Repeat the subject's fixed descriptors (wardrobe, hair, distinguishing marks)
  in each shot so identity does not drift between clips.
- Keep one dominant action per shot; generators blur multi-action prompts.
- Match the planned screen direction ("travels left to right") to preserve
  continuity across the cut.

## Working steps

1. Take the shot list from the shot-types/coverage skills.
2. Emit one prompt per shot using the field order above.
3. Append the shared style block to each.
4. Flag any shot whose planned move a generator cannot reliably produce, and
   propose a simpler fallback (e.g. replace a dolly zoom with a slow push-in).

## Output

A numbered list of per-shot generation prompts, each self-contained and sharing a
common style block, ready to feed the clip-generation step of the pipeline.
