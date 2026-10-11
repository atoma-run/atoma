---
name: viz-frame-cost-measurement
description: "How to measure GPU client frame cost on mgf's laptop (probe, thermal drift, vsync traps, what dominates), state of the 2026-09-06 and 2026-09-30 fps work"
metadata:
  node_type: memory
  type: project
  originSessionId: 2544630d-3a60-44f9-8aba-02fd5c9ddea3
  modified: 2026-09-30T20:09:21.762Z
---

Two fps sessions on the Ryzen 5 5500U / Radeon Vega 7 laptop (1920×1080 panel, 100 % scaling → owner geometry 1920×970 CSS, DPR 1). Findings live in the repo: `docs/incidents/gpu-frame-cost-2026-09-06.md` and `docs/incidents/gpu-fps-2026-09-30.md`; the tool is `npm run viz:frame-probe` (needs `npm run build`, writes `.atoma-frame-probe/`). Scratch scenario scripts from 2026-09-30 (live run, sustained sweep, subtree attribution, carrier A/B) were in that session's scratchpad, not the repo.

What the repo docs cannot tell a future session:
- The owner's own Chrome tab cannot be driven: no browser-control tool, and Chrome runs without a debugging port. Reproduce with Puppeteer's Chrome, or the installed Chrome via `PUPPETEER_EXECUTABLE_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"` (same numbers). Production traces are small (7–21 LLM calls ≈ 16–200 events), so the 80-event fixture is realistic.
- At vsync every fixture scenario holds 60 fps; the owner's "slow" was stutter, not steady cost. The biggest one was a LIVE run: each poll rebuilt the scene (fixed 020464d8 by deferring live refreshes while the pointer moves). Test with a growing trace, not the static fixture.
- GPU timestamps (`--gpu-time`) under vsync are clock-governor noise (6.5 vs 15.6 ms for identical arms); use `--unlock` for cost. The 09-06 claim "MSAA irrelevant at 1920×1080" was wrong for the same reason: unlocked, MSAA doubles the frame here (owner decision still open).
- Thermal drift: identical builds 2–5 → 6–14 ms/frame within ~40 min. Run arms back to back, interleaved, and trust structural counters.
- The `viz:smoke` scroll budget (`SCROLL_REBUILD_P95_MAX = 12`) is Metal-calibrated and fails here on HEAD too (33.8 ms before, 23.4 ms after on 2026-09-30); every behavioural assertion passes. Compare against HEAD via `git stash -u` + rebuild, not by the budget.
- Win32-only red suites when running tests/viz-*: EPERM temp cleanup in viz-auth-gate and viz-burnin-api, symlink EPERM in viz-run-index and viz-benchmark-runs.
- Another session may commit in this same checkout while you work (it did on 2026-09-30): check `git log` before stashing and stage only your paths.

**Why:** hours were lost to thermal noise and vsync-hidden costs; the real stutter only showed with a live trace and a moving pointer.

**How to apply:** for any viz perf claim on this host, measure unlocked or with a stutter scenario, quote large effects and structural counters, and name the machine state. See [[windows-portability-state]] for why the full `npm run check` is red on the Windows host.
