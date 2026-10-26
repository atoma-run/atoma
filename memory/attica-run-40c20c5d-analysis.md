---
name: attica-run-40c20c5d-analysis
description: "2026-10-25 Attica control-page repair run 40c20c5d — four Atoma defects fixed and deployed (6827f98e), Compute 0.4.128 installed; run still \"running\" until its finalization is retried from the UI"
metadata:
  node_type: memory
  type: project
  originSessionId: 2342e190-d6b4-42e5-8b19-eccf44b5d18f
  modified: 2026-10-25T12:18:13.414Z
---

Run 40c20c5d (Attica control page + idle-cancel repair, deep, Mac Compute device) ended 08:38 UTC 2026-10-25 as runner outcome `partial` ($9.76), refused at delivery by a contradictory cell-authored suite (start 202 then cancel 400). Its row stayed `running`: Chromium `Singleton*` links left by its tests at the workspace root made the device export throw, and the server swallowed the error.

Fixed on main (824543ed merge, pins 0e0b7d6c, record 6827f98e; all CI and deploys green; one CI rerun for a preview-terminal fixture timeout):
1. Typed `export-refused` reply, terminal finalization, byte-less entries (dangling links, sockets, FIFOs) omitted and never seeded.
2. Worker pids bound 2048 everywhere; validate_html browser released when idle or before a command; each validate_html call gets a fresh context, so storage never crosses calls.
3. Cell refusal bound withheld when a refusal cites typed `unsatisfiableSuites`; run stats `cellBoundsWithheld`/`cellBoundsApplied`.
4. Root gate accepts the integration suite on the plan's sink join.

Rollout: Compute images tag compute-images-20261025-export-threads (worker+workspace pinned, record in records/releases/compute-export-threads-2026-10-25/), desktop 0.4.128 installed on the Mac and prepared, production admission updated (backup atoma.env.bak-20261025T120426Z). COMPUTE_CLIENT_ARCHIVE not bumped.

Open: the classifier refused my executor `compute-finalize` call, so the owner must click "Reconcile and finish transfer" in the Attica project's Compute settings. Workspace volume backup: scratchpad run40c2-workspace-volume.tar. Then fix the Attica page through a new run (the server part of 40c20c5d was correct).

**Why:** explains the repeated refusals and the blocked organisation slot; see [[validation-runs-too-slow]], [[attica-run-delegation]].
**How to apply:** watch `cellBoundsWithheld` on the next runs to see whether reviewers emit `unsatisfiableSuites`; treat a residual contradictory suite assigned by the tissue as a known gap, not a regression.
