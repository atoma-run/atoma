# Compute content-based releases — 2026-10-21

Owner requested that unrelated main pushes must not publish Compute updates.
Implementation pushed directly to main as
`85a31ec1da40107d8d47f4a56348349ecf6ac2bf` from the dedicated clone
`/tmp/atoma-compute-content-only-20261021` (do not reuse another chat's clone).

Four paths: `.github/workflows/compute-desktop.yml`,
`scripts/compute-desktop-content.mjs`, `tests/compute-desktop-content.test.ts`,
`docs/compute-desktop.md`. The gate hashes actual bundled files (normalizing only
the CI version suffix), evaluated installer configuration, and the locked native
runtime/packager dependency tree. Unrelated dependencies are excluded. Last
published channel receipt is the baseline, not the previous push. Legacy channels
rebuild their recorded source revision rather than force an unnecessary update.
Native bundles must match the receipt. Publication is serialized, deduplicated
and checks Git ancestry for stable/current feeds; later unrelated main commits
do not invalidate installers. Manual validation still runs; publication needs a
content change.

Clean npm ci and full static release checks passed, actionlint passed, ten new
behavior tests passed (real bundler + separate CLI + real Git ancestry), 316 viz
view tests passed after rebasing over the concurrent typography commit. Real
Electron smoke passed locally. Full suite twice: 7,786 passed, 36 skipped, one
Docker depth-transition failure (fresh.txt absent after workspace rename). The
same failure was reproduced on clean main without this correction; no worker
image was rebuilt or tests weakened.

CI run 39562826155, Compute desktop 39562826035, CodeQL39562826489: pending/in
progress at this note's creation. The prior Compute run for38eb3216 failed on
Mac ARM + Windows at the existing Resources-fit smoke; Intel passed. This is
independent of the new content gate. Follow the exact pushed revision's jobs to
completion, including production deployment; do not claim they passed yet.

The earlier clone `/tmp/atoma-compute-main-push-20261021` was being reused by
another session (38eb3216 landed during checks). All four of my changes were
copied out, then removed from that clone, leaving it clean. The shared project
checkout and its staged/unstaged peer files were preserved.


Follow-up `5398d558800828a75521f0728d7a8a265f6cfe64` narrows feed
normalization to the arm64/x64 suffix; a real channel rename remains visible.
Final CI39563144339, Compute39563144203, CodeQL39563143218. The content job and
legacy bootstrap passed. Both final Mac ARM and Windows jobs passed all content
tests and the Linux/native fingerprint equality; both then failed on the SAME
pre-existing Resources-fit assertion. Intel and main CI still pending/in progress
at this update. No new publisher issue has been found in the content gate.


Final verification: CI 39563144339 SUCCESS (full suite, static release checks,
fresh worker/isolation and mender isolation); CodeQL 39563143218 SUCCESS.
Deploy 39564772222 SUCCESS for exact revision
5398d558800828a75521f0728d7a8a265f6cfe64 (verified by display title, not headSha).
Compute 39563144203 completed FAILURE: content/legacy bootstrap SUCCESS,
all three platforms' ten regression tests and native fingerprint equality
SUCCESS, Intel native smoke+packaging SUCCESS. Mac ARM and Windows both fail
only the baseline Resources-fit smoke. Release was skipped; no Compute version
was published. The filter fix itself is complete and active on main. The
pre-existing Resources layout/smoke remains a separate issue, unchanged here.
