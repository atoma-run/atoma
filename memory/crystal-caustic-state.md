---
name: crystal-caustic-state
description: "2026-10-17 crystal shading/caustic work committed locally (50c15882, dfa4c921, not pushed); edge-strip strokes exist but are invisible; three options left to test"
metadata:
  node_type: memory
  type: project
  originSessionId: 4aaed655-d365-4a1d-9928-0f0b2c894f17
  modified: 2026-10-17T04:51:47.261Z
---

State on 2026-10-17. Two commits sit on local `main` and are NOT pushed:
- 50c15882: crystal faces are classified toward the eye (`facing`), not by `normal[2]`.
- dfa4c921: the caustic enters through lamp-facing faces. Rays are traced through the real shell (diamond walls with an air cavity, interface by interface). The 8 shader slots go to halves and edge strips, ranked by energy.

The earlier push, 25bcdace (projective shadows, nine-slice shadows, wireframe, scroll-pane `air`), IS deployed.

**Why the caustic now looks subtle:** a wall with parallel faces barely bends or disperses light. The median red-blue half-separation fell from 0.107 to 0.0008. The edge-strip strokes do land where they should (verified with an amplified diff), but they peak at only 5–15/255. Two causes:
1. A strip carries about 13% of a face's energy.
2. The caustic shader caps concentration at ×1.35 (`CAUSTIC_PRESS_MAX`, with REF 24000 and SOFT 3200, in `renderer/caustic-shader.ts`).

**How to apply.** Options the owner wants to test next, in the order I recommended:
1. Let concentration follow physics (irradiance = energy / footprint area) by raising or reshaping the press cap. This affects ALL bundles, so watch for hot spots on capture.
2. Apply an artistic gain to the edge strips only.
3. Keep it as it is: subtle, but physically coherent.

Other ideas still open:
- Derive the caustic blur from the lamp size (penumbra), not from a fixed area fraction.
- Unify the crystal lamp (`ATOMA_MARK_LAMP_Z`) with the UI shadow lamp (`LAMP_HEIGHT_PX` = 50).
- Wireframe `lines` mode: give dark lines a minimum brightness, and optionally show the back and cavity edges as hidden lines.
- The "negative shadow patch" is forbidden by src/viz/AGENTS.md; it needs an owner decision first.

How to verify:
- Copy `scripts/viz-mark-turn.mjs` to a temp file. Add per-degree shots, or `--pointer` with no clip (full frame).
- For a "before", run the copy from a scratch `git worktree --detach` at the old commit (symlink `node_modules`).
- Compare frame diffs, a slab metric (erode the diff with a 9 px min-filter), and amplified diff images.

Related: [[push-to-prod-authorized]], [[viz-frame-cost-measurement]].
