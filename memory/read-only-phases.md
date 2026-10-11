---
name: read-only-phases
description: "Root-plan phases without outputs are photographed and restored by the host (user chose restore over refusal, 2026-09-30); refined after 2 reviews; limits; repair run plan"
metadata:
  node_type: memory
  type: project
  originSessionId: e82e9669-4aba-430d-ba86-145d0c444324
  modified: 2026-09-30T18:09:19.029Z
---

On 2026-09-30 the user chose "Restaurer en fin de phase" over refusing writes. Shipped as 527b3b55 on main (pushed 2026-09-30 ~20:00 after 3 adversarial reviews + 4877-test Linux suite).

**Which phases.** A phase is `Task.readOnly` when it declares no `outputs` and belongs to a
SEQUENTIAL root plan the planner wrote with 2+ phases. The count is taken before routing splits a
phase (L3 `pendingPlannedPhases`). Root plans are the L3's plan, or a root L2 cell's own plan
(`ctx.currentBranchId` undefined, not `viaPrefilter`).

**What the host does.** It photographs the workspace at the start of every execution and restores it
at the end (src/run/readOnlyPhase.ts):
- Linux operations go through `/proc/self/fd` and names are read as bytes.
- Restore runs in two passes.
- SQLite files are LEFT as they are and reported, which does not make a restoration matter.
- The manifest is restored only when something else was.

**What happens when a restoration matters.** The result gets the `[READ-ONLY PHASE RESTORED` prefix
and `Result.readOnlyRestoration`. Its attestations are stale for root acceptance, and credit is
withheld.

**How validators treat read-only work.** They see `READ_ONLY_TASK_LINE`. The banner becomes the
`read-only-validation-failed` review gate, and root acceptance reviews every attempt that had a
read-only phase.

**Why:**
- 04ea696f's verification phase replaced the page, and it shipped (commit f73c0b0c).
- f793b338 (2026-09-27) overwrote a home page 23 times.
- The refusal design looped, and its fallback bypassed it.
- Review 2 (restore v1) broke: the evidence, live SQLite, silent partial photographs, the budget,
  routing splits, gate loops and credit. All of these were fixed.

**How to apply:**
- Never re-propose refusing writes, or telling molecules "change nothing": obeyed, it loops the gate.
- DAMAGE = the phase owned a restored path (`executionOwns`: element writes, server entry, shell/probe command naming it, compiled script); only damage makes evidence stale / restores manifest / withholds credit. Servers started by a restored execution are always stopped.
- Open: reset-then-probe of a data file counts as damage (cautious); servers from EARLIER phases keep in-memory state.
- Known limit: below a tissue's phase, only a molecule's attested ELEMENT writes withhold its credit (shell-only writes don't).
- Done: repair run cdc34023 met all 11 criteria (the light theme it introduced was kept at the
  user's choice). Rerun 0399bd82 showed the mechanism in prod: its READ-ONLY PHASES block said
  "changed nothing", and the page kept 99% of its lines.

Related: [[production-runs-2026-09-26]], [[jev-decisions-state]].
