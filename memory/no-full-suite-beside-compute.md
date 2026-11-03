---
name: no-full-suite-beside-compute
description: "2026-10-30: my full npm test on the Mac filled its disk while Atoma Compute ran Attica run 3a81397b there; a tool failed, the run stopped unconfirmed"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 9ef50ec7-717c-4469-bb1b-edf9e3022fc5
  modified: 2026-10-30T10:50:11.076Z
---

On 2026-10-30 the Mac's data volume had ~3 GB free. I ran the full `npm test` twice (10:34–10:42 UTC) to verify a preview fix. It hit ENOSPC, the Docker VM went read-only, and the Atoma Compute app on the same Mac lost Attica run 3a81397b: `tool-failed` at 10:40:15, socket closed, `stop-unconfirmed`. The device then refused previews ("Reconnect Atoma Compute"). A failed `preview-egress` test also left `atoma-preview-*-48624` containers running.

**Why:** the Mac is the Attica Compute device, so a heavy local suite competes with a live paid run for disk, Docker and CPU. That is the burn-in rule ("a batch needs the machine to itself") applied to Compute.

**How to apply:**
- Before running a full suite, container tests or builds on the Mac, check for a running Compute run (`atoma_project_runs` status=running with executionTarget customer-device) and check `df -h /System/Volumes/Data`.
- While a run is live, or with less than ~15 GB free, run only the targeted test files and let CI's clean runners carry the full suite.
- Related: [[validation-runs-too-slow]], [[test-suite-speed]], [[atoma-compute-state]].
