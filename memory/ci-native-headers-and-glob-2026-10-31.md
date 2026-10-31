# CI blockers after the Attica connection repair

Owner authorized correcting both CI failures, verifying/deploying, then proving
Attica usable with all data preserved and other agents' work untouched.

- Baseline main: 4fd83276; production transport fix remains 95f283c4 until the
  successful deployment of this repair. CI41150747534 preserved both ENOSPC
  attempts and the minimatch audit failure. Do not hide or discard those logs.
- Fix: minimatch11.0.3, asar4.3.1, universal3.0.6, asar glob14.0.3. Private
  callback adapter for only rimraf's old glob uses upstream14.0.3 through the
  glob-modern alias. Its npm archive is integrity-locked and checked against
  exact reviewed sources; ordinary npm ci must work from clean checkout.
  Initial blind override broke glob7; the compatibility test caught it.
- Mender image reuses /usr/local Node headers through the documented node-gyp
  option. Keep 512MiB tmpfs/4GiB/no-swap and all isolation. Regression recompiles
  and loads SQLite without network in a new container, after clean installation.
- Full incident: records/incidents/ci-native-headers-and-glob-2026-10-31.md.
  Raw local verification receipts: /tmp/atoma-ci-repair-20261031; preserve them
  with the final CI/deployment and Attica before/after data receipts.
- Attica baseline captured in /tmp/attica-before-ci-repair-20261031.json: ready
  deployment2d03ae1e, app5b5c7210, accepted run78208e3f,1059 rows. Compare all
  six data/checkpoint/export hashes and full modes after deployment. No run,
  collection, schedule mutation, new acceptance or publication is required.
- Our worktree only; main checkout stays at other agent's unpublished f4c95a67.
  Do not touch intentional untracked attica-retry-evidence-followup-2026-10-30.md.
  Never read production process environments or restart Docker without consent.

Local full release check passed:599 files/8702 tests, existing45 skipped.
Real Mac ARM packaging passed. Canonical root npm devDependency and $ override
are required for the private archive; raw relative file overrides yielded
invalid npm ls metadata despite installing. New compatibility test runs on
all three native CI targets. Backup HOME fixture now covers absent/present
archives without touching the real home. Keyboard assertion retains diagnostics;
its one intermittent failure and unchanged successful reruns are preserved.
