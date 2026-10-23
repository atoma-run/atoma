# Compute interruption diagnosis and repair — 2026-10-21

Owner request: fix misleading cancellation label, stuck LIVE status, add Compute
disconnect logs, test and push. Explicitly DO NOT start or relaunch any run.

Isolated managed worktree:
/Users/mgtf/.codex/worktrees/compute-disconnect-diagnostics/atoma
Branch codex/compute-disconnect-diagnostics; pushed main commit
60d56ff7d8f810c317291c94a3f8bee758d596a6 (rebased on 5fc0395a).
Shared checkout and its dirty peer work were not staged or reset.

Implementation: neutral runner shutdown text; exact legacy host-message display
projection without rewriting historical traces; selected executor polls and
settles stopped interrupted Compute receipts only with persisted exact-generation
stop proof, no active local/foreign lease, never an incomplete finalization
transfer. Cancellation still needs a saved cancellation request. Preserve log
spend, trace id and normal run-finished notification. Frontend readers do not write.
No paid naming or new execution is used for this reconciliation.

Diagnostics: closed reason vocabulary for TLS/socket failures, handshake and
per-channel RPC timeouts, expired lease, schema/JSON/protocol rejection,
gateway shutdown/idle cutover and dispatch finish/interruption. Log safe
connection/device/session/run/generation metadata, pending ids/methods/ages,
heartbeat/receive ages, buffered bytes, close code and reason length, allowlisted
transport codes. Never frames, credentials, args, remote close text or exception
messages. ComputeMachine supplies private rotating connection.log/.1 under
~/.atoma/compute, so the desktop utility's ignored stderr no longer erases it.
Client logging requires an updated Compute binary; server changes deploy normally.

Verification before push: npm ci; final rebased release:check:static PASSED;
492 targeted tests passed, 4 existing image-gated skips; full real viz:smoke
PASSED (WebGPU and WebGL); desktop build and Electron smoke in CI software mode
PASSED. First hardware-rendered Electron smoke timed out; software mode passed
all unchanged assertions. Complete initial release check had 7799 test passes,
36 skips, ONE failure in existing container-isolation depth transition.
Independent direct backend probe proved Docker Desktop's stale bind after host
rename: second write_file replied ok for fresh.txt, host workspace=[],
archive=[first.txt,fresh.txt], worker still saw first.txt. No tool/launcher bind
code changed; no Docker restart, test weakening or shared image rebuild performed.
Linux CI fresh-worker job must prove the isolation test before completion.

CI 39603916779, Compute desktop39603916729, CodeQL39603916711 pending at this note.
Before deployment native MCP confirmed b9a12828 still running/finalizing with
null endedAt/stats; production deploy should reconcile its persisted gen22 stop.
Need follow ALL workflows including desktop packages/publication and deployment,
then read native MCP again. Do not claim deployment or all checks green yet.

13:05UTC progress: CI Fresh worker image job119235124184 SUCCESS, all96tests
passed including the exact depth transition/replaced bind test (1390ms) which
fails on local Docker Desktop. Static release119235124239 and credential
isolation119235123547 SUCCESS. CodeQL39603916711 SUCCESS. Desktop ARM package
job119235508126 SUCCESS; other packages/general test suite still pending.
The hardware Electron smoke orphan PID75133 and its exact children (75155/6/8/9)
were identified by this worktree/profile and killed; the actual user's Compute
process17776 in the separate atoma-compute checkout was untouched.

FINAL13:08UTC: CI39603916779 SUCCESS (7786passed,52existing skips;547filespassed),
Fresh worker job96/96 passed, CodeQL39603916711 SUCCESS. Compute desktop
39603916729 SUCCESS: all3native packages (Windowsx64,macARM64,macIntel) and release
119239114681 publication succeeded. Deploy39605211729 SUCCESS; log pins exact
REVISION60d56ff7, compatible executors at13:07:31Z, activated13:08:01Z.
Native MCP after activation: b9a12828 statusFAILED, endedAt13:07:59.653Z, error
'Compute execution interrupted; workload stop confirmed. No cancellation was requested. Resume only from an eligible confirmed checkpoint, or start a new run.'
Stats preserved: cost1.5888, subscription1.5888,86LLMcalls; no artifact manifest.
This was automatic coordinator reconciliation, no SQL repair, no replay/new run,
no acceptance/publication of Attica. Original trace bytes remain immutable;
UI maps only the exact legacy misleading host message to the neutral shutdown text.
No user Compute app restart/update was attempted; local connection.log logging
begins when its newly published Compute version is installed.
