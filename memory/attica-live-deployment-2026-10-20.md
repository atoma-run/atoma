---
name: attica-live-deployment-2026-10-20
description: Real Attica run survives web redeployment and a different executor generation; live follow-up remains in progress
metadata:
  type: project
  modified: 2026-10-20
---

Owner request: advance Attica and update atoma.run while the run executes.
Production MCP was read first. Existing request
`1bf32e71-97c4-4061-96fd-d8b8dccade5f` (project
`07864f7c-d8f2-4023-9fca-afd8a7a51e52`) was queued since 11:01 UTC;
no duplicate paid run was started. Its six immutable criteria cover the true
offline collector/server/store path, IDs 101/102 through HTTP and after server
recreation, demonstrated diagnosis/regression and honest verification evidence.
No real property-site access, personal data or broad migration is authorized.

## Admission defect fixed and shipped

The post-configuration memory check counted its own lease twice, so the first
run required 4 GiB despite the first-run availability contract (about 2.9 GiB
was available). `ba76a1413d34db0508dd08a59dd4be0999a02809` excludes only
the candidate's exact run ID from competing growth reservations. Other hosts'
leases remain counted. Real multi-process regression failed before and passed
after; 99 focused tests passed. Complete local release static checks passed;
7,727 tests passed, 32 skipped and one known Docker Desktop stale bind-mount
inode failure remained. No test weakened or Docker restarted.

Full Linux CI `39414908902` passed: 7,708 tests, 52 intentional skips, static
release, fresh worker isolation and credential isolation green. Deploy
`39416150592` attempt 1 succeeded. The SAME queued Attica run started at
11:37:19.220 UTC. Trace starts 11:38:06.424 UTC and stamps ba76a141.

## Real deployment proof

First, redeployed ba76a141 during its LLM work: deploy `39416150592` attempt 2
succeeded at 11:38:47.654 UTC. Web PID changed 1315320 -> 1323482;
executor PID stayed 1314176, child PGID stayed 1317950, and the device session
and assignment generations stayed unchanged. New trace work followed restart.

Then committed Linux/admission evidence as
`68e334ff0f2f6e2b0f5296506a4f9bbc58da86d2`. Its complete CI `39416332753`
and Deploy `39417501670` succeeded. The activator logged compatible executors
at 11:48:01.771 UTC; web restarted at 11:48:26 and deployment succeeded at
11:48:28.564. At 11:48:58:

- current release and active executor socket select 68e334ff;
- new web PID 1334470; new executor PID 1334435;
- old ba76a141 executor still PID 1314176, ready, selected false, idle false;
- Attica's original lease still owns child PGID 1317950, acquired 11:37:18.634;
- Compute session `41d8bf39-c5fb-474d-855e-a3a28a6c384b`, connection generation
  37, execution generation 11, same active run assignment;
- post-cutover trace event `56662f70-c764-434c-a397-9b5ebb8e5324` starts at
  11:48:45.247 UTC, while its provenance remains ba76a141.

New executor health ready/selected/idle true; old health ready true, selected
false, idle false. No global drain, manual service or Docker restart, lease
mutation, device reconnection or run replay. Production update while the real
run executes is proven. This says nothing yet about the application result.

## Follow-up

Run is still running; no Attica acceptance, GitHub publication or deployment.
Summary events read through index 324 (next offset 325). Initial read-only
inspection approved. First implementation plan refused because its parent suite
exercised TS source instead of the compiled JS forwarder; replan in progress.
The proposed plan also lists broad TypeScript migration work: do not interpret
that model proposal as owner authorization or silently accept it against c6.
Review actual final changes, complete trace and executed proofs before acceptance.

Atoma source work was isolated in `/private/tmp/atoma-independent-executors`,
branch codex/independent-run-executors, clean HEAD == origin/main == 68e334ff
at the last check. The primary checkout's unrelated dirty peer work was preserved.
This note is intentionally a local project memory, not another production push.

## Status checked at 13:02 UTC

Owner asked for status. Production MCP confirms the same run ended PARTIAL at
12:34:51.116 UTC, after 57m32s (120 calls, subscription-equivalent $6.005).
All 1,035 summary events were paged to the end; complete result and final report
were read. No newer project run exists. No client acceptance or publication.

Final parent suites 26f865952b3f00a7 and 7f095e16e605a2c1 both failed with HTTP
400 where 404 was asserted; final acceptance event
29c3c645-40fb-4c75-99e6-03d29f1d0190 refused delivery. The generated report
claims its focused offline test passed after adjusting the negative assertion,
but that does not supersede these independent failed parent checks. It also
records npm check failing on existing Retry-After (400 vs 429) and resume after
cancellation (400 vs 403) tests. The original undefined/rows-expected cause
remains undetermined. Do not claim the application is validated or accept it.

The infrastructure experiment remains successful: the run continued on its
original ba76a141 revision through both web restarts and the 68e334ff cutover,
then ended on application acceptance failures rather than an interrupted host.
No new paid run or source edit was started merely to answer the status query.
