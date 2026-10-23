# Attica verification — 2026-10-19

## Completed state — 13:00 UTC

Work is complete. This section supersedes every in-flight note below.

- Broad verification d543fe1d failed planning; all 664 summary events read.
  Source-context fix was exercised; no full Attica installation/check/build
  or application acceptance was established.
- Scoped verification e107d0a7 DELIVERED. All 91 summary events read. Actual
  probe30f49b67 exits0: real server rejects maxPages0 with HTTP400 and stays
  idle/activefalse/rows0, offline without browser. Saved manifests: all175
  application files unchanged. No Attica acceptance, publication or deployment.
- Fixed and deployed source-context readback b646d9a0, nl allowlist d09e7f62,
  schema-derived bounded retrieval diagnostics dbbcbbbe, and explicit desktop
  component refresh a9e96865. Test fixture fix73d1e471 retains native Windows
  filesystem semantics; production security checks were never weakened.
- Current main/production exact73d1e47171859579b13deb958cfed54df92de409.
  CI39253560947 SUCCESS; native39253560848 SUCCESS on Mac ARM, Mac Intel and
  Windows; deploy39255972552 SUCCESS. Server current symlink and active
  service verified. Earlier source-fix CI39252996795/deploy39254413457 green too.
- Images from dbbcbbbe published/tested on both architectures in39251440402;
  eight public manifest/config/revision/architecture identities verified.
  Receipts tracked in records/releases/compute-images-2026-10-19.
- Actual Mac now uses all four new ARM receipt pins. Packaged nl regression
  FAILS old7af8 worker and PASSES new7f2c worker. Actual production device row
  advertises7f2c, valid lease, acceptingtrue, appVersion0.4.0. CUA real UI Ready,
  connected, no workload, including after deployment. No third paid run.
- New desktop preview installers/checksums published at
  https://github.com/atoma-run/atoma/releases/tag/compute-desktop-preview-73d1e4717185
  Source73d1e471 and all six public assets verified. Local app was updated
  reversibly from native packaged build; previous bundle preserved alongside.
- Known LOCAL limitation preserved: Docker Desktop host bind-mount rename
  transition fails fresh.txt ENOENT against both old and new workers; full
  local release tests7648pass/34skip/1failure. Static checks, native GUI smoke,
  typechecks/lint/docs and focused tests pass; required fresh-worker Linux CI
  and full clean CI pass. Compute uses named volumes. No Docker or manual
  production-service restart, test weakening, historical-data deletion or
  source workaround was used.
- Isolated worktree clean and HEAD==origin/main before cleanup. Archive confirmed
  through app (archived_worktree attachment); no ignored build needed (actual app is in atoma-compute worktree,
  public installers/receipts retained). Primary peer changes left untouched.

## Historical progress notes

The owner explicitly requested a new Attica run to verify the fixes and to fix
demonstrated problems. The initial MCP authentication failure was resolved by
the owner's reconnection and `codex mcp login atoma`; production MCP reads work.

Active run: `d543fe1d-c89e-493f-958e-43d0080ae10a`, project
`07864f7c-d8f2-4023-9fca-afd8a7a51e52`, started 11:46:09 UTC.
Idempotency key: `attica-verify-review-source-nl-20261019-v1`.
The pending start call is functions cell 87; never issue a different start
because the call is still waiting. Exact args are in functions store
`atticaVerifyRestartArgs`: same goal and five criteria as b04565ec, explicit
base `cafd0d69-267e-4caf-a94c-60a6e2f1ec25`, deep, account model defaults.

Trace confirms revision `d09e7f6222cc6f247d986b0aca9382a9b37dada3` (both
context-readback and nl fixes), Node 24.20.0, customer-device execution.
Read all summary events 0–25; next offset 26. First root plan approved;
two discovery branches are working. No error yet. Continue paging trace to
end, inspect actual review and execution evidence, fix demonstrated Atoma
defects with production-path regression tests. No live xe.gr/Spitogatos
traffic, personal data, Attica publication or deployment is authorized by
this verification. Owner authorization to push verified Atoma fixes persists.

Prior fixes: b646d9a0 (96k existing root source budget for suite-module review)
and d09e7f62 (nl allowlist); both CI and production deploys succeeded. Prior
investigation: records/incidents/attica-run-review-2026-10-19.md on origin/main.
PR #26 is a separate mender proposal for the generic superviseLoop; the five
observed root replans run in L3Atom.reviewedRootPlan, already bounded at five.
It was not merged as a fix for this incident.

11:58 UTC follow-up: summary read through offset 553. Config/documentation
inspection approved at root; server-interface discovery repeatedly refused for
missing exact signatures/response shapes (read c826444c and 6494d500 to end;
refusals match the assigned task, no false refusal established). No app
installation/check/build evidence yet; no terminal error or client question.

New defect established: six search_project_docs calls used limit20 (max10) and
maxExcerptBytes5000–12000 (max4096), receiving only invalid_request and retrying
wrong filters. Fixed in isolated restored worktree
/Users/mgtf/.codex/worktrees/attica-review-source/atoma: schema-derived bounded
optional failure message, no relaxed limits, no query echo, strips controls.
Observed-bounds regression fails before; 87 retrieval/compute-relay tests pass,
five environment-gated skips; typecheck, lint and docs pass. Pushed after rebase
as dbbcbbbee2614dca7aace5ae5a6ccd97325e3cb5 (original local6443fd7d was rewritten).
CI39248121475 pending behind peer CI. This run remains on d09e7f62; a production
deploy waits for live execution to finish and does not update its runtime.
Worktree clean and HEAD equals origin/main as last checked. Do not archive it
until CI/deploy and this run's investigation are finished.

Final broad verification: FAILED at 12:10 UTC, $3.4591 equivalent, 60 calls,
664 events all paged to end. Result null. Final review b7132574 read in full,
plus final plan5f65c6c4: RootHair suite has no collector invocation, pacing,
CAPTCHA verify/resume or active-concurrency journey. Refusal is justified.
Earlier final-reviewdbea1692 showed the full control-server.ts and store.ts
with NO cut markers: prior source-readback fix is actually exercised.
No application installation/check/build was proved. No acceptance/publication.

Search diagnostic fix dbbcbbbe CI39248121475 and production deploy39250283541
both SUCCESS. Restored worktree clean; HEAD equals origin/main. No source change
has reached the finished broad run retroactively.

User delegation permits scoped follow-up verification. New SHORT run
`e107d0a7-70c7-4cf8-9722-25c4ee81f57c` started12:16:04UTC with key
`attica-invalid-start-proof-20261019-v1`, same basecafd0d69. Pending startcall
functions cell137; exact args functions storeatticaNarrowArgs. NEVER start a
second copy. One criterion: real server rejects maxPages0 with HTTP400 and
stays idle, offline without browser. Goal also asks direct numbered source
reading with nl; sources frozen, no broad audit/migration/acceptance/publication.
Follow this run to completion and inspect actual proof, not just its banner.
No trace read yet; start offset0. Prior calls87/118 timed out at300s; neither
cancelled the broad run, which has now ended failed. No pending broad start.


12:30 UTC update: scoped run e107d0a7 DELIVERED. All 91 summary events read.
Actual record_probe 30f49b67 exit0 proves real createServer /api/start maxPages0
returns400 (positive integer error), before/after idle, activefalse, rows0,
fixture loopback only. First attempt failed its temporary harness; corrected
second attempt passed. No application sources changed or accepted/published.

New confirmed Compute mismatch: this Mac uses worker digest7af8dc09 (OCI source
revisiona5b7bde7), so direct nl still refused despite hostdbbcbbbe; bash wrapper
worked. This is an immutable old component, not regression of the nl sourcefix.
Image release compute-images-20261019-1 atdbbcbbbe is building/publishing in
Actions39251440402. Both architecture isolation/transfer/retrieval/preview
suites passed; publication receipts pending. Do not use unchecked digests.

Isolated worktree now has uncommitted desktop preparation fix: refresh four
bundled image pins only on explicit Prepare, hold inventory lock and refuse
unconfirmed workload teardown; preserve pairing/budget/credentials and keep
headless pull/diagnostics unchanged.16 focused tests passed,typecheck passed.
Full release check running shell72762, log/tmp/attica-compute-refresh-release.log.
After receipts: updatecomputeImages pins, test/package nativeapp, admit verified
new reference worker digests inprod /home/atoma/config/atoma.env (oldretain),
push verifiedAtoma commit to main and waitCI+deploy. No manualservice/Docker
restart authorized. Local app was disconnected AFTER both MCP delivered and
all localinventory rowsstopped; app/UI Nonconnecté. Quitshortcut sent but
process87405 stillrunning. UseCUA propermenuquit then replacewithbackedup
builtbundle; no workloadkill. Existing apppath in atoma-compute worktreedist.


12:35 UTC: image release39251440402 SUCCESS for both architectures; all8 public
manifest/config hashes, architectures and source revisions anonymously verified.
Receipts tracked in records/releases/compute-images-2026-10-19. ARMworkernew
7f2cda61..., AMDworker0c260b34... (use receipt reference digest, not configID).
Production env narrowly backed up at atoma.env.before-attica-images-20261019,
new2 reference digests added to old2; no service restart. Normal next deploy
will activate allowlist. Images downloading locally (shell9584 worker,
shell7471 workspace/preview/retrieval, logs /tmp/attica-worker-pull.log and
/tmp/attica-components-pull.log). Workspace/preview pulled; worker/retrievalpending.

Code + pins + receipts + incidentrecord committed and rebased over peer
scrollbarcommitd5ce9cb1. Pushed exact a9e9686542cf25e9d0f383dfc8bbde11fa76ad87.
CI39252996795 pendingbehindpeerCI39252306392; native39252996805 running.
Both tsconfigs/lint/docs/16focusedtests pass. Native ARMpackage + ElectronGUI
smoke pass. Fullrelease static passes; tests7648passed/34skipped/1FAIL:
containerdepth SIGTERM rename transition fresh.txt ENOENT onMacbindmount.
Isolatedrepeatfailsidentically, alreadyknownphysicalDockerDesktopissue;
LinuximageCI passed and requiredCI must be green. No tests weakened.
New packaged nl regression fails against old7af8 image as expected; run it
against new7f2c oncepull completes, then compiledacceptance fullsuite.

Idlelocalapp disconnected+quit throughCUA, bundle replaced from verifiedlocal
build; backup alongside it: Atoma Compute.attica-20261019.previous.app.
Path /Users/mgtf/.codex/worktrees/atoma-compute/atoma/dist/compute-installers/mac-arm64/Atoma Compute.app
codesign deepstrict passes(ad-hocpreview). Updatedapp reopened withpairing,
Nonconnecté and Preparebutton33 shown. Do not launch paidthirdrun; after normal
proddeploy andimagepulls, CUA Prepare reconnect, verify all4actualpins/newworker
OCIrevisiondbbc and Ready. Docker untouched. Active run was ended/stopped first.


12:42 UTC: newworker pulled, OCIarm64/revisiondbbc verified. Packaged nl
regression PASS against new7f2c; same test FAIL against old7af8. DockerDesktop
bindrename regression failsagainstbothimages; no weakening/retryloop. Full
freshworker CI job39252996795 PASS (Linux), staticrelease PASS, menderPASS,
fulltests stillrunning. MainCI firstpeer succeeded+deployed d5ce9cb1 in
39253480492, so actualproductionPID environmentnowadmitsbothnewdigests (read
/proc with onlytargetkey, verified). AppPrepareexecuted viaCUA, actual4pins
matchnewARMreceipts, same device andexistingbudget(noexplicitbudgetstored).
App is nowdownloadingretrieval(lastlargecomponent), secondarypulljoinsnormal
Dockerprocess. UIbackgroundrenderwasstale; clickingConnexion showedcurrent
2/4searchprogress, not a stoppedruntime. No sourcefixneededforAXcache.

NativeCIa9 firstWindowsjob failed: fixture hardcoded process.platformdarwin
onNTFS, so newrealinventoryownershipcheck correctlyrefusedPOSIXmode. Fixed
fixturepreservingwin32 onnativeWindows (samepatternascomputeApplicationtest),
productionsecurityunchanged. Committed/pushed73d1e47171859579b13deb958cfed54df92de409.
Native39253560848 Windows tests nowPASS, packaginginprogress; ARMjobPASS;
Inteljobrunning. NewmainCI39253560947 queuedaftera9CI39252996795. Do not claim
allpipelinegreenuntilthosefinish. Local16focusedtests/typechecklintpassed;
no productionchangesaftera9, onlytestfixturefix73. SourceworktreecleanexactHEADorigin.
Pendingnativepublicationautomaticallypublishespreview/currentchannelwhenmainCIgreen.


12:45 UTC: ALL4 actual ARMimagespulled, allOCIidentitiesverified dbbcbbbe.
UpdatedGUI explicitPrepare completeddoctor andWSS handshake: CUAactualUI
Prêt / Ton ordinateur est prêt / connecté / Aucune charge de travail active.
No newpaidrun. nlpackagedregressionpassedactualnewworker. SourcefixCI39252996795
SUCCESS. Native73Windows+ARM+Intelalltests/packagingPASS, Intelartifactupload
pending, releasewaits73mainCI39253560947. Need finishmain73CI+normaldeploy+
nativepublication beforefinal. Current source73d1e471, cleanexactoriginlastcheck.
No morechangesneeded. MacDockerbindrenameissueexplicitlypreserved; LinuxCIgreen.
