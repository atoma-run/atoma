# Compute one-click updates — 2026-10-21

Owner approved implementing automatic update detection and one-click installation
once current work has finished. Work is isolated in
`/tmp/atoma-compute-updates-20261021`, branch
`codex/compute-one-click-updates`, pushed commit
`9c53bb5f67bfe92460ec0b6473f9d2f1aa8ed98f` (base `243caee7`).

Signed-only checks run on startup, every four hours and wake. The banner downloads
on click, drains new assignments and waits for allocations/transfers. The new
utility-process `disconnect-idle` command rereads live inventory and awaits shared
lifecycle cleanup before installation. Narrow update IPC, progress, postponement,
manual-preview copy and ordered CI patch versions are included. Approve each
native installer version in `ATOMA_COMPUTE_APP_VERSIONS` before signed rollout;
no admission check was bypassed.

64 focused tests passed, one platform-specific credential test skipped. Both TS
configs, full lint, docs check, full product build and desktop bundle passed.
Full release outside sandbox was rejected by session policy; Electron smoke
exited without a usable result inside sandbox. Full CI and native smoke/packaging
on macOS arm64/x64 and Windows remain required. Real signed installation remains
unverified and requires publisher credentials/notarization.

PR NOT CREATED, NO MERGE. First GitHub create was rejected by automatic review
(publication authorization); read-only get_repo proved the repo is public and
admin-accessible. Retrying was allowed but returned HTTP403 Resource not
accessible by integration. GitKraken PR create then returned user rejected MCP
tool call. Do not repeat that rejected action without renewed authorization.
Branch and origin branch have identical HEAD; the worktree was clean.

## Direct main publication requested

The owner explicitly requested commit on main and push, and prohibited GitKraken.
Do not use GitKraken again. A separate real Git clone now lives at
`/tmp/atoma-compute-main-push-20261021`. GitHub read API established remote main
as `b70258d2b276275db4166b7bca2845f3f0902c45`; this object was already available
locally. The Compute commit was cherry-picked onto it, producing
`97bbb34a9839c78e643bc3100053ab20beafd60e`, on that clone's `main`. Only the
18 Compute paths are in this commit. The original shared checkout and its index
were preserved. The clone's tracking origin/main was aligned to the observed
remote main for an honest ahead-one status.

Publication DID NOT SUCCEED: ordinary `git push origin main` cannot resolve
`github.com` inside this command sandbox. GitHub create_tree likewise returned
403 Resource not accessible by integration. No GitKraken fallback was used.
To retry from an unrestricted terminal:
`git -C /tmp/atoma-compute-main-push-20261021 push origin main`.
A non-fast-forward refusal requires fetching and integrating the new remote
main in the isolated clone, never forcing or rebasing the shared checkout.

## Initial push confirmed; native layout correction pending push

Owner reported the push done. GitHub confirms main contains 97bbb34a, followed
by translation-only 9f4739f3. CI39559396352 passed (full release static, tests,
worker isolation); deploy39560244291 succeeded for revision97bbb34a. Native
workflow39559396379 failed all three platforms at Resources default-window fit:
the always-expanded update settings added too much height. Unit tests/typecheck
were green on all three platforms; packaging/release were skipped.

The isolated clone was concurrently advanced to9f4739f3 and contained peer-owned
uncommitted workflow/content-check changes. Preserved them. Own correction is
commit38eb3216 on main in `/tmp/atoma-compute-main-push-20261021`: only renderer,
CSS and Electron smoke changed. Update settings now use a collapsed accessible
details/summary, with extra smoke assertions for opening and the manual-download
button; the original fit assertion is preserved. Typecheck, affected lint and
desktop bundling passed. Local native smoke again exited without a result.
Push of38eb3216 failed DNS `Could not resolve host: github.com`; owner terminal
must run the same `git -C /tmp/atoma-compute-main-push-20261021 push origin main`.
Native CI must pass on this correction before claiming desktop publication.
