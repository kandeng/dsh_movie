---
name: Story Substance and Value Charge
description: Diagnose whether a literary script's scenes actually turn on value change — the McKee test of story substance, gap, and progressive complications.
target: script
version: 1.0.0
license: MIT
provider: dsh_movie
---

# Story Substance and Value Charge

A scene only earns its place if a **value** shifts charge across it — hope to
dread, trust to betrayal, freedom to captivity. This skill audits a literary
script for story substance by checking that every scene turns, and that the
turns compound into progressive complications rather than repeating.

## Core ideas

- **Story values** are the universal human experiences that swing positive and
  negative: life/death, love/hate, truth/lie, order/chaos.
- A **beat** is the smallest unit of behaviour change (action/reaction). A
  **scene** turns when its value charge differs at the end than at the start.
- The **gap** is the space between what a character expects and what the world
  delivers; that gap is where drama lives.

## Audit steps

1. List the story values each scene puts at stake.
2. For every scene, write its opening and closing charge (`+`/`-`). If they are
   the same, the scene does not turn — cut it or force a reversal.
3. Order the turns so stakes escalate; a scene that repeats a prior charge is a
   progressive-complication failure.
4. Locate the gap in each turning point: what did the character expect, and what
   did the world hand back instead?
5. Confirm the climax carries the largest, most irreversible value change.

## Anti-patterns to flag

- Scenes that inform but do not turn ("exposition dumps").
- Value changes resolved by coincidence instead of a character's choice under
  pressure.
- A flat middle where charges oscillate without escalating.

## Output

A value-charge table (`scene | value | from → to | gap`) plus a ranked list of
non-turning scenes to rewrite or cut.
