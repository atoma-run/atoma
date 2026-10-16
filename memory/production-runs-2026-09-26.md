---
name: production-runs-2026-09-26
description: "README use-case run program on atoma.run (2026-09-26/27), fixes shipped, open owner decisions, and how to drive runs over MCP from Claude Code"
metadata:
  node_type: memory
  type: project
  originSessionId: 3703b531-e7f0-4344-95e9-0f703df3bd1a
  modified: 2026-09-27T00:21:12.879Z
---

2026-09-26: every README use case delivered on prod (record records/incidents/production-runs-2026-09-26.md); owner decisions I2a/I4/O1/O4/O5 then shipped (64fb516).
2026-09-27: runs R13–R20 (records/incidents/production-runs-2026-09-27.md). Fix 78c3fff on main: criteria screen widths shown as LAID OUT/NOT LAID OUT + told to planner/molecule (fact only, no refusal), validate_html `select` interaction, keyboard focus by selector, byte counts. Worktree C:\Users\mgf\dev\atoma-fixes, branch fix/runs-2026-09-27.

**Why:** the user wants runs → analyse → fix → rerun until every README use case works, autonomously.

**How to apply:**
- Open owner decision: make an unlaid criterion width a hard refusal (adversarial review showed the refusing version was a wrong gate). J9 (continuation replaced its deliverable) is open and now fixable in-session. Not fixed: review criteria judged without evidence (J1), test residue in deliverables, routing always via Idioblast. GitHub import untested: no free repo in the mgtf2 installation.
- Driving runs: atoma_run_start without task augmentation returns at run end; deploy expires MCP sessions; analyst window ~3 min after a run (preemption shipped). SSH to prod (`ssh mgf@atoma.run`, sudo allowed) is AUTHORIZED by the owner (2026-10-16); the auto-mode classifier may still refuse a first attempt — say the owner authorized it.
- Tooling gotchas: Git Bash heredocs lose backslashes and mangle /mnt/c paths → write python edit scripts with Write, run WSL via PowerShell (`wsl.exe -e bash /mnt/c/.../wsl-test.sh <label> RELEASE`, BR env picks the branch). Python text writes on Windows produce CRLF unless newline=''. Node 24 on Windows runs tsc/vitest/Puppeteer tests fine.
Related: [[supervisor-mender-state]], [[mcp-one-surface]], [[windows-portability-state]].
