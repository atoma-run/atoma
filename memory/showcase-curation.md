---
name: showcase-curation
description: Public showcase is opt-in since 2026-10-10 (new projects default hidden); which campaign projects I hid and why
metadata:
  node_type: memory
  type: project
  originSessionId: 57bf42e4-89cd-4dcd-aed3-1bcd2d8d2e37
  modified: 2026-10-10T17:29:55.711Z
---

2026-10-10, at owner request: test runs must not reach the public showcase by default. `createProjectInputSchema.showcase` now defaults to `hidden` (pass `showcase: 'listed'` to publish). NULL rows (pre-2026-10-06) still read listed. Curation is PER PROJECT only: a listed project shows every delivered run as an episode, including flawed v1s and "continue from partial run…" repair goals — continuing a listed project still publishes.

Hidden on 2026-10-10 via atoma_project_showcase (reversible, journaled): Foldsmith, Shadow atlas zine, Last Cabinet EPUB, Signal Orchard, Moss kit (documented broken v1 deliverables, repairs partial/failed), Transit explorer and Typing studio (opening builds partial, every shown episode is a repair/proof note; transit 779d854c had a false F5 "reload" proof).
Kept: Touchmarks, Lantern archipelago, Shuttle Bloom (repairs delivered, v1 still shown), duplicate finder, Canopy Accord, markdown auditor, Pantry Ledger, Tidewatch, NDJSON redactor. Owner's call left open: Six Moving Lanterns (thin, small doc contradictions), Recipe scaling (f6ec6a20 changed index.js despite "do not change behaviour", validator said unchanged).

**Why:** campaigns of 2026-10-09/10 put everything on the page. **How to apply:** create test projects without showcase; list only after reviewing deliveries. Related: [[production-runs-2026-09-26]].
