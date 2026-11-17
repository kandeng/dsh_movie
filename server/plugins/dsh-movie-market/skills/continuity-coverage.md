---
name: Continuity and Coverage
description: Plan shot-list coverage that cuts cleanly — the 180-degree line, eyeline match, match-on-action, and screen direction — to keep a shot plan edit-ready.
target: shot-plan
version: 1.0.0
license: MIT
provider: dsh_movie
---

# Continuity and Coverage

Coverage is the set of shots that lets a scene be edited. This skill ensures a
shot plan cuts cleanly by respecting continuity rules, so the assembled scene has
no jarring jumps or broken geography.

## The continuity rules that matter

- **180-degree line (the axis)** — keep the camera on one side of the action
  line so screen direction and eyelines stay consistent. Crossing it flips
  left/right relationships; only cross deliberately (a neutral shot or a move
  across the line).
- **Eyeline match** — a character looking off-frame must have a reverse whose
  height and direction match what they seem to see.
- **Match-on-action** — cut in the middle of a movement so the action bridges the
  two shots and hides the edit.
- **Screen direction** — a subject travelling left-to-right should keep travelling
  left-to-right across cuts unless a turn is shown.
- **180 → 30-degree rule** — when cutting same-subject angles, change the angle by
  at least ~30 degrees to avoid a jump cut (unless the jump is intentional).

## Coverage pattern for a dialogue scene

1. **Master / two-shot** — establish geography and blocking.
2. **Singles (OTS and clean)** — each speaker from over the other's shoulder, plus
   a clean single for emphasis.
3. **Inserts / cutaways** — hands, props, reactions to relieve the cut and hide
   continuity gaps.
4. **Reactions** — often more important than the speaker; plan them explicitly.

## Working steps

1. Draw the action line on the shot plan and mark each camera side.
2. Verify every reverse has a matching eyeline.
3. Ensure at least one match-on-action opportunity per transition.
4. List the inserts needed to compress time or cover a jump.

## Output

A coverage map per scene: the shots, their side of the line, eyeline partners,
and the intended match-on-action cut points.
