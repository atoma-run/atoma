# Two release checks blocked after the Attica transport repair

The source repair `95f283c4` passed release verification and was deployed.
The documentation-only follow-up `4fd83276` failed CI run `41150747534`:

- `npm audit` reported minimatch's globparts amplification advisory, including
  transitive copies in the installer toolchain. The failure was preserved.
- Both attempts of the fresh mender container test failed during `npm ci` with
  ENOSPC while copying downloaded Node 24.20.0 headers from one temporary tree
  into another. The disposable `/tmp` mount is deliberately limited to 512 MiB.
  This was not a full production volume or an Attica data failure.

## Dependency correction

The lockfile pins minimatch 11.0.3. The upstream
[advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249) identifies 11.0.1
as the first patched version. A blind global override broke old consumers:
legacy asar and directory comparison expected a callable CommonJS default,
and glob 7 expected internal regexp metadata no longer provided by minimatch.
The new real-package compatibility test detected that failure before release.

Asar moves to 4.3.1 and universal to 3.0.6, removing the obsolete callable
minimatch consumers. Asar's traversal uses glob 14.0.3, which also addresses
[glob cancellation](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4).
The old rimraf dependency of Windows installer temp cleanup gets a private
callback adapter, limited by the `glob@<9` override. It delegates matching,
traversal and sync operations to upstream glob 14.0.3; it does not implement
another matcher. The `glob-modern` npm alias prevents the override from
recursively replacing its own upstream dependency. Native Windows path
separator behavior is retained. No advisory is ignored and the audit gate is
unchanged.

The adapter source lives in `scripts/compat/legacy-glob`. Its tiny npm archive
is tracked because ordinary `npm ci` and release installations need immutable,
integrity-locked bytes without a preparatory build or machine-local symlink.
For later changes, bump its private version and the root archive reference/test path
before regenerating it with:

```sh
npm pack ./scripts/compat/legacy-glob --ignore-scripts --pack-destination scripts/compat
npm install --ignore-scripts
npm ci
```

The archive is declared once as a root development dependency; the override
references `$@atoma/legacy-glob`. This keeps npm's installation and dependency
validation anchored to the same canonical file source. A direct relative file
override installed successfully but `npm ls` exposed inconsistent metadata.
Minimal cold fixtures proved the root reference valid for both full and
production-only installs. The archive is under repository `scripts/compat`,
already included in the release.
The compatibility test verifies that the archive contains exactly the reviewed
source and package manifest. It then uses actual builder ESM and Windows
CommonJS dependency paths to pack/read native-unpacked archives, exercises
legacy callback and synchronous matching, FileList filtering, wildcard cleanup
and literal-directory cleanup. The existing installer content fingerprint
includes the archive's npm integrity and its complete dependency closure.

## Container correction

The pinned official Node image already includes matching headers under
`/usr/local/include/node`. The mender image supplies node-gyp's existing
`npm_package_config_node_gyp_nodedir=/usr/local` option, and its build checks
that all required header/config inputs exist. The 4 GiB memory limit, 512 MiB
tmpfs, no extra swap, CPU limit, read-only root and isolation are unchanged.

The real production-path container regression installs the clean checkout,
then recompiles better-sqlite3 in a separate fresh network-disabled container,
loads the resulting native module and executes an in-memory query. Installation
cannot leave a warm tmpfs cache for that second container. The existing offline
type/browser/HOME checks still run. Only the image and regression change;
no Docker restart, pruning, application data mutation or Atoma run is needed.

## Hermetic backup regression

The first complete local suite passed 8,700 tests but exposed an unrelated
fixture assumption in `backup.test.ts`: it expected the actual account's
`~/.atoma/archive` to be absent. On this Mac it exists. The test now supplies
an isolated OS-account-home fixture and checks both absence and presence,
including the captured archive's exact source and contents. `HOME` is still
unset, so reverting to a relative environment-based path still fails. The
backup implementation and all real archives remain unchanged. The independent
container identity regression continues to test Node's real account fallback.

## Local verification

A complete release check passed with four local Vitest workers: 599 test files
and 8,702 tests, with the existing four skipped files and 45 skipped tests.
The real macOS ARM application packaged successfully with archive integrity,
native icon and content-closure checks. The native CI matrix now also runs the
new dependency compatibility test on Windows, Mac Intel and Mac ARM.
A separate full-suite keyboard observation failed once without diagnostics,
then passed targeted and full verification without changing its assertion.
The assertion now includes its saved observation on failure; the original
failure and successful reruns are retained.
