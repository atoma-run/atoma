import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launchWorkspacePreparation, packageRootsOf, PACKAGE_ROOT_MAX_DEPTH, PACKAGE_ROOT_MAX_DIRECTORIES } from '../src/run/workspace.js';
import { MAX_PACKAGE_ROOT_DIR_LENGTH, MAX_PACKAGE_ROOTS, workspacePreparationSchema, type WorkspacePreparation } from '../src/contracts/workspacePreparation.js';
import { delegatedTaskContext, packageRootInstallCommand, taskContextLines, workspacePreparationGuidance } from '../src/atoms/taskContext.js';
import { undeclaredToolMentions } from '../src/atoms/verdict.js';
import { SHELL_TIMEOUT_MAX_MS } from '../src/contracts/commandTimeouts.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import type { Task } from '../src/core/types.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const seed = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-roots-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

describe('packageRootsOf: the package roots of a seed source', () => {
  it('lists roots root first, then by depth and sorted name, with the lockfile each install is frozen to', () => {
    const root = seed({
      'package.json': '{}', 'package-lock.json': '{}',
      'zeta/package.json': '{}', 'zeta/pnpm-lock.yaml': '',
      'alpha/package.json': '{}', 'alpha/yarn.lock': '',
      'alpha/deep/package.json': '{}', 'alpha/deep/bun.lockb': '',
      'both/package.json': '{}', 'both/package-lock.json': '{}', 'both/npm-shrinkwrap.json': '{}',
      'browser/package.json': '{}', 'browser/package-lock.json': '{}',
      'fixtures/app/package.json': '{}',
      'lonely/package-lock.json': '{}',
    });
    expect(packageRootsOf(root)).toEqual({ complete: true, roots: [
      { dir: '.', lockfile: 'package-lock.json' },
      { dir: 'alpha', lockfile: 'yarn.lock' },
      { dir: 'both', lockfile: 'npm-shrinkwrap.json' },
      { dir: 'browser', lockfile: 'package-lock.json' },
      { dir: 'zeta', lockfile: 'pnpm-lock.yaml' },
      { dir: 'alpha/deep', lockfile: 'bun.lockb' },
      { dir: 'fixtures/app', lockfile: null },
    ] });
  });

  it('skips installed trees, every dot-directory, omitted build trees and links', () => {
    const root = seed({
      'package.json': '{}', 'package-lock.json': '{}',
      'node_modules/x/package.json': '{}', 'node_modules/x/package-lock.json': '{}',
      'browser/node_modules/playwright/package.json': '{}',
      '.atoma-runs/node_modules/0f0e0d0c-0b0a-4908-8706-050403020100/package.json': '{}',
      '.atoma-runs/node_modules/0f0e0d0c-0b0a-4908-8706-050403020100/package-lock.json': '{}',
      '.atoma-scratch/package.json': '{}', '.git/package.json': '{}', '.atoma-skeleton/package.json': '{}',
      'dist/package.json': '{}', 'vendor/lib/package.json': '{}', 'build/package.json': '{}',
      'outside/package.json': '{}', 'outside/package-lock.json': '{}',
    });
    symlinkSync(join(root, 'outside'), join(root, 'linked'));
    symlinkSync(join(root, 'package.json'), join(root, 'outside', 'manifest-link.json'));
    mkdirSync(join(root, 'manifest-only-link'));
    symlinkSync(join(root, 'package.json'), join(root, 'manifest-only-link', 'package.json'));
    expect(packageRootsOf(root)).toEqual({ complete: true, roots: [
      { dir: '.', lockfile: 'package-lock.json' }, { dir: 'outside', lockfile: 'package-lock.json' },
    ] });
  });

  it('leaves out a workspace member of a lockfile root, and keeps a member with its own lockfile', () => {
    const root = seed({
      'package.json': JSON.stringify({ workspaces: ['packages/*', './tools/**'] }), 'package-lock.json': '{}',
      'packages/a/package.json': '{}', 'packages/b/package.json': '{}', 'packages/b/package-lock.json': '{}',
      'tools/x/y/package.json': '{}', 'tests/fixtures/app/package.json': '{}',
      'other/package.json': JSON.stringify({ workspaces: { packages: ['libs/*'] } }), 'other/yarn.lock': '',
      'other/libs/one/package.json': '{}',
    });
    expect(packageRootsOf(root).roots).toEqual([
      { dir: '.', lockfile: 'package-lock.json' },
      { dir: 'other', lockfile: 'yarn.lock' },
      { dir: 'packages/b', lockfile: 'package-lock.json' },
      { dir: 'tests/fixtures/app', lockfile: null },
    ]);
  });

  it('is incomplete when the depth bound cut it, and never lists past it', () => {
    const atBound = Array.from({ length: PACKAGE_ROOT_MAX_DEPTH }, (_, i) => `d${i}`).join('/');
    const root = seed({ [`${atBound}/package.json`]: '{}', [`${atBound}/deeper/package.json`]: '{}' });
    expect(packageRootsOf(root)).toEqual({ complete: false, roots: [{ dir: atBound, lockfile: null }] });
    expect(packageRootsOf(seed({ [`${atBound}/package.json`]: '{}' })).complete).toBe(true);
  });

  it('is incomplete when the directory bound or the root cap cut it', () => {
    const wide = seed({ 'package.json': '{}' });
    for (let i = 0; i < PACKAGE_ROOT_MAX_DIRECTORIES; i++) mkdirSync(join(wide, `d${String(i).padStart(4, '0')}`));
    writeFileSync(join(wide, 'd0000', 'package.json'), '{}');
    expect(packageRootsOf(wide)).toEqual({ complete: false, roots: [{ dir: '.', lockfile: null }, { dir: 'd0000', lockfile: null }] });
    const many = seed(Object.fromEntries(Array.from({ length: MAX_PACKAGE_ROOTS + 1 }, (_, i) => [`p${String(i).padStart(2, '0')}/package.json`, '{}'])));
    const result = packageRootsOf(many);
    expect(result.complete).toBe(false);
    expect(result.roots).toHaveLength(MAX_PACKAGE_ROOTS);
    expect(() => workspacePreparationSchema.parse({ dependencies: 'excluded-from-seed', packageRoots: result.roots, packageRootsComplete: false })).not.toThrow();
  });

  it('reports an unreadable seed as incomplete, never as a seed without roots', () => {
    expect(packageRootsOf(join(tmpdir(), 'atoma-no-such-seed-0f0e0d0c'))).toEqual({ complete: false, roots: [] });
  });

  // A pnpm member installed standalone with npm fails on `workspace:*`, and a
  // member of a lockfile-less npm workspace installed with --prefix never sees
  // its sibling packages (review 2026-10-26).
  it('leaves the members of a pnpm workspace to the pnpm root, which leaves npm nothing to install', () => {
    const root = seed({
      'package.json': '{"name":"mono"}', 'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': "# workspace\npackages:\n  - 'packages/*'   # libraries\n  - \"apps/**\"\n  - '!**/test/**'\ncatalog:\n  react: ^18\n",
      'packages/a/package.json': '{"dependencies":{"@x/shared":"workspace:*"}}',
      'apps/web/site/package.json': '{}', 'tools/cli/package.json': '{}',
    });
    const { roots: found } = packageRootsOf(root);
    expect(found).toEqual([{ dir: '.', lockfile: 'pnpm-lock.yaml' }, { dir: 'tools/cli', lockfile: null }]);
    expect(packageRootInstallCommand(found.filter(entry => entry.dir === '.'))).toBeNull();
  });

  it('reads a flow or unindented pnpm list', () => {
    const flow = seed({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': "packages: ['libs/*']\n",
      'libs/one/package.json': '{}', 'other/package.json': '{}' });
    expect(packageRootsOf(flow).roots.map(entry => entry.dir)).toEqual(['.', 'other']);
    const flat = seed({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': 'packages:\n- libs/*\n',
      'libs/one/package.json': '{}', 'other/package.json': '{}' });
    expect(packageRootsOf(flat).roots.map(entry => entry.dir)).toEqual(['.', 'other']);
    const multiline = seed({ 'package.json': '{}', 'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': "packages: [\n  'apps/*',   # apps\n  \"libs/**\",\n]\nonlyBuiltDependencies: [esbuild]\n",
      'apps/a/package.json': '{}', 'libs/x/y/package.json': '{}', 'tools/t/package.json': '{}' });
    expect(packageRootsOf(multiline).roots).toEqual([{ dir: '.', lockfile: 'pnpm-lock.yaml' }, { dir: 'tools/t', lockfile: null }]);
  });

  // pnpm 10 keeps its settings in pnpm-workspace.yaml even for one package:
  // without `packages` it installs the root alone (pnpm 8 and 9 refuse the
  // file), so a nested package.json is no member and stays listed.
  it('reads a pnpm-workspace.yaml without packages as a root-only workspace', () => {
    const settingsOnly = seed({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': 'onlyBuiltDependencies:\n  - esbuild\n',
      'libs/one/package.json': '{}', 'other/deep/package.json': '{}', 'own/package.json': '{}', 'own/package-lock.json': '{}' });
    expect(packageRootsOf(settingsOnly).roots).toEqual([{ dir: '.', lockfile: 'pnpm-lock.yaml' }, { dir: 'own', lockfile: 'package-lock.json' },
      { dir: 'libs/one', lockfile: null }, { dir: 'other/deep', lockfile: null }]);
  });

  it('takes the whole subtree only when the file or its packages value cannot be read', () => {
    const unreadable = seed({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': `# ${'x'.repeat(1024 * 1024)}\n`,
      'libs/one/package.json': '{}' });
    expect(packageRootsOf(unreadable).roots).toEqual([{ dir: '.', lockfile: 'pnpm-lock.yaml' }]);
    // A scalar, which pnpm refuses ("packages field is not an array"), and a flow list never closed.
    for (const workspace of ['packages: libs/*\n', "packages: [ 'apps/*',\n", "packages:\n  [ 'apps/*',\n"]) {
      const unread = seed({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': workspace, 'libs/one/package.json': '{}' });
      expect(packageRootsOf(unread).roots, workspace).toEqual([{ dir: '.', lockfile: 'pnpm-lock.yaml' }]);
    }
  });

  // Measured with pnpm 10.18.0 (`pnpm ls -r`, 2026-10-26): `packages: []`, a
  // `packages:` with no value before the next key or the end, `~`, `null` and
  // negations only install the root alone; a flow list on the line after the
  // key installs what it lists. None of them is a file that cannot be read.
  it('reads an empty, bare or negations-only packages value as root-only, as pnpm 10 installs it', () => {
    for (const workspace of ['packages: []\n', 'packages:\nonlyBuiltDependencies:\n  - esbuild\n', 'packages:\n', 'packages: ~\n',
      'packages: null\n', "packages:\n  - '!test/**'\n"]) {
      const rootOnly = seed({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': workspace,
        'apps/a/package.json': '{}', 'tools/t/package.json': '{}' });
      expect(packageRootsOf(rootOnly), workspace).toEqual({ complete: true, roots: [{ dir: '.', lockfile: 'pnpm-lock.yaml' },
        { dir: 'apps/a', lockfile: null }, { dir: 'tools/t', lockfile: null }] });
    }
  });

  it('reads a flow list that starts on the line after the packages key', () => {
    for (const workspace of ["packages:\n  [ 'apps/*' ]\n", "packages:\n  [ 'apps/*',   # apps\n    'libs/*' ]\ncatalog:\n  react: ^18\n"]) {
      const nextLine = seed({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': workspace,
        'apps/a/package.json': '{}', 'libs/l/package.json': '{}', 'tools/t/package.json': '{}' });
      expect(packageRootsOf(nextLine).roots.map(entry => entry.dir), workspace)
        .toEqual(workspace.includes('libs') ? ['.', 'tools/t'] : ['.', 'libs/l', 'tools/t']);
    }
  });

  // npm ci ignores pnpm-workspace.yaml: a root npm installs owns no member through it.
  it('reads pnpm-workspace.yaml only when pnpm owns the root', () => {
    const npmRoot = seed({ 'package.json': '{}', 'package-lock.json': '{}', 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'apps/a/package.json': '{}' });
    expect(packageRootsOf(npmRoot).roots).toEqual([{ dir: '.', lockfile: 'package-lock.json' }, { dir: 'apps/a', lockfile: null }]);
    const lockfileLess = seed({ 'package.json': '{}', 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n", 'apps/a/package.json': '{}' });
    expect(packageRootsOf(lockfileLess).roots).toEqual([{ dir: '.', lockfile: null, workspace: 'pnpm' }]);
  });

  // The worker image has no pnpm: a root npm can install stays npm's (final review, 2026-10-26).
  it('marks a lockfile-less root pnpm\'s only when npm cannot stand in for pnpm', () => {
    const settingsOnly = seed({ 'package.json': '{"scripts":{"test":"vitest run"},"devDependencies":{"vitest":"^3.2.0"}}',
      'pnpm-workspace.yaml': 'onlyBuiltDependencies:\n  - esbuild\n' });
    const plain = packageRootsOf(settingsOnly).roots;
    expect(plain).toEqual([{ dir: '.', lockfile: null }]);
    expect(packageRootInstallCommand(plain)).toBe('(test -f node_modules/.package-lock.json || npm install --no-save)');
    for (const manifest of ['{"devDependencies":{"typescript":"catalog:"}}', '{"dependencies":{"@x/lib":"workspace:*"}}']) {
      const protocol = seed({ 'package.json': manifest, 'pnpm-workspace.yaml': 'onlyBuiltDependencies:\n  - esbuild\n' });
      expect(packageRootsOf(protocol).roots, manifest).toEqual([{ dir: '.', lockfile: null, workspace: 'pnpm' }]);
    }
  });

  it('leaves the members of a lockfile-less npm workspace to its root install', () => {
    const root = seed({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/a/package.json': '{"dependencies":{"b":"1.0.0"}}', 'packages/b/package.json': '{"name":"b","version":"1.0.0"}',
    });
    const { roots: found } = packageRootsOf(root);
    expect(found).toEqual([{ dir: '.', lockfile: null }]);
    expect(packageRootInstallCommand(found)).toBe('(test -f node_modules/.package-lock.json || npm install --no-save)');
  });

  it('drops a directory whose path a receipt cannot hold and marks the scan incomplete, and the launch receipt still parses', () => {
    const long = Array.from({ length: 4 }, (_, i) => `${String(i)}${'n'.repeat(149)}`).join('/');
    expect(long.length).toBeGreaterThan(MAX_PACKAGE_ROOT_DIR_LENGTH);
    const root = seed({ 'package.json': '{}', 'package-lock.json': '{}', [`${long}/package.json`]: '{}' });
    expect(packageRootsOf(root)).toEqual({ complete: false, roots: [{ dir: '.', lockfile: 'package-lock.json' }] });
    expect(launchWorkspacePreparation({ resume: false, seedRoot: root })).toEqual({ dependencies: 'excluded-from-seed',
      packageRoots: [{ dir: '.', lockfile: 'package-lock.json' }], packageRootsComplete: false });
  });
});

describe('launchWorkspacePreparation: the launch receipt', () => {
  it('lists the seed roots at launch, and a resume merges into the saved receipt instead of replacing it', () => {
    const root = seed({ 'package.json': '{}', 'package-lock.json': '{}', 'browser/package.json': '{}', 'browser/package-lock.json': '{}' });
    const launched = launchWorkspacePreparation({ resume: false, seedRoot: root });
    expect(launched).toEqual({ dependencies: 'excluded-from-seed', packageRootsComplete: true,
      packageRoots: [{ dir: '.', lockfile: 'package-lock.json' }, { dir: 'browser', lockfile: 'package-lock.json' }] });
    // The checkpoint stores the root inputs as JSON; the resume never re-reads a seed.
    const saved: unknown = JSON.parse(JSON.stringify(launched));
    expect(launchWorkspacePreparation({ resume: true, saved, seedRoot: root }))
      .toEqual({ ...launched, dependencies: 'preserved-unverified' });
    rmSync(root, { recursive: true, force: true });
    expect(launchWorkspacePreparation({ resume: true, saved })).toEqual({ ...launched, dependencies: 'preserved-unverified' });
  });

  it('keeps a legacy or unreadable saved receipt to its dependencies, and an unseeded run unverified', () => {
    expect(launchWorkspacePreparation({ resume: true, saved: { dependencies: 'excluded-from-seed' } })).toEqual({ dependencies: 'preserved-unverified' });
    expect(launchWorkspacePreparation({ resume: true, saved: { dependencies: 'installed', packageRoots: 'x' } })).toEqual({ dependencies: 'preserved-unverified' });
    expect(launchWorkspacePreparation({ resume: true })).toEqual({ dependencies: 'preserved-unverified' });
    expect(launchWorkspacePreparation({ resume: false })).toEqual({ dependencies: 'unverified' });
  });
});

const receipt: WorkspacePreparation = { dependencies: 'excluded-from-seed', packageRootsComplete: true, packageRoots: [
  { dir: '.', lockfile: 'package-lock.json' }, { dir: 'browser', lockfile: 'package-lock.json' },
  { dir: 'tests/fixtures/app', lockfile: null }, { dir: 'web', lockfile: 'pnpm-lock.yaml' },
] };
const BROWSER_INSTALL = '(test -f browser/node_modules/.package-lock.json || npm ci --include=dev --prefix browser)';

describe('rendering the receipt', () => {
  // npm writes node_modules/.package-lock.json only when an install finishes:
  // a tree killed at the run_shell timeout has none, and is reinstalled.
  it('composes one guarded install, root first, that reinstalls only a tree whose install did not complete', () => {
    expect(packageRootInstallCommand(receipt.packageRoots!)).toBe(
      `(test -f node_modules/.package-lock.json || npm ci --include=dev) && ${BROWSER_INSTALL}`);
    expect(packageRootInstallCommand([{ dir: "my app", lockfile: 'package-lock.json' }]))
      .toBe("(test -f 'my app/node_modules/.package-lock.json' || npm ci --include=dev --prefix 'my app')");
    expect(packageRootInstallCommand([{ dir: 'web', lockfile: 'pnpm-lock.yaml' }])).toBeNull();
    expect(packageRootInstallCommand([{ dir: '.', lockfile: null }])).toBe('(test -f node_modules/.package-lock.json || npm install --no-save)');
  });

  it('never chains a nested root without a lockfile, which would stop the real roots after it', () => {
    const command = packageRootInstallCommand([{ dir: '.', lockfile: 'package-lock.json' },
      { dir: 'examples/broken', lockfile: null }, { dir: 'web', lockfile: 'package-lock.json' }]);
    expect(command).toBe('(test -f node_modules/.package-lock.json || npm ci --include=dev) && '
      + '(test -f web/node_modules/.package-lock.json || npm ci --include=dev --prefix web)');
    expect(packageRootInstallCommand([{ dir: 'tests/fixtures/app', lockfile: null }])).toBeNull();
  });

  // A fixture's lockfile may be fake or stale on purpose: npm ci fails in
  // every executor, or installs packages the fixture's tests then resolve.
  it('keeps a nested root under a fixture directory out of the chain, lockfile or not, and names it for an install on demand', () => {
    const fixtureRoots = [{ dir: '.', lockfile: 'package-lock.json' }, { dir: 'tests/fixtures/app', lockfile: 'package-lock.json' },
      { dir: 'src/__fixtures__/a', lockfile: 'yarn.lock' }, { dir: 'testdata/b', lockfile: 'package-lock.json' },
      { dir: 'test/fixture/c', lockfile: 'npm-shrinkwrap.json' }, { dir: 'fixtures-tool', lockfile: 'package-lock.json' },
      { dir: 'web', lockfile: 'package-lock.json' }] as const;
    const command = packageRootInstallCommand(fixtureRoots);
    expect(command).toBe('(test -f node_modules/.package-lock.json || npm ci --include=dev) && '
      + '(test -f fixtures-tool/node_modules/.package-lock.json || npm ci --include=dev --prefix fixtures-tool) && '
      + '(test -f web/node_modules/.package-lock.json || npm ci --include=dev --prefix web)');
    expect(packageRootInstallCommand([{ dir: '.', lockfile: 'package-lock.json' }])).toBe('(test -f node_modules/.package-lock.json || npm ci --include=dev)');
    const instruction = workspacePreparationGuidance({ dependencies: 'excluded-from-seed', packageRootsComplete: true, packageRoots: fixtureRoots }, true);
    expect(instruction).toContain(`For the listed roots: ${command}`);
    expect(instruction).toContain('tests/fixtures/app (package-lock.json), src/__fixtures__/a (yarn.lock), testdata/b (package-lock.json), test/fixture/c (npm-shrinkwrap.json) sit under a fixture directory: install one, frozen to its lockfile');
    expect(instruction).not.toContain('uses another package manager');
    expect(workspacePreparationGuidance({ dependencies: 'excluded-from-seed', packageRootsComplete: true, packageRoots: fixtureRoots }, false))
      .toContain('tests/fixtures/app (package-lock.json)');
  });

  // pnpm, yarn and bun never write npm's marker: guarded by it, their tree
  // never reads as complete and every executor reinstalls it.
  it('scopes the guarded command and its marker to npm roots, and asks for no command it does not give', () => {
    const pnpmOnly = workspacePreparationGuidance({ dependencies: 'excluded-from-seed', packageRootsComplete: true,
      packageRoots: [{ dir: '.', lockfile: 'pnpm-lock.yaml' }, { dir: 'examples/x', lockfile: null }] }, true);
    expect(pnpmOnly).not.toContain('ONE run_shell command');
    expect(pnpmOnly).not.toContain('For the listed roots');
    expect(pnpmOnly).not.toContain('test -f');
    expect(pnpmOnly).toContain(`. (pnpm-lock.yaml) uses another package manager: install it once per execution, before the first command that resolves modules from it, with that manager's frozen-lockfile mode in a run_shell command with timeoutMs ${SHELL_TIMEOUT_MAX_MS}`);
    expect(pnpmOnly).toContain('That manager never writes <dir>/node_modules/.package-lock.json: never guard its install with that file.');
    expect(pnpmOnly).toContain('examples/x hold a package.json without a lockfile');
    const mixed = workspacePreparationGuidance({ dependencies: 'excluded-from-seed', packageRootsComplete: true,
      packageRoots: [{ dir: '.', lockfile: 'package-lock.json' }, { dir: 'browser', lockfile: 'package-lock.json' }, { dir: 'docs', lockfile: 'yarn.lock' }] }, true);
    expect(mixed).toContain('every listed npm root (package-lock.json or npm-shrinkwrap.json) outside a fixture directory');
    expect(mixed).toContain(BROWSER_INSTALL);
    expect(mixed).toContain('docs (yarn.lock) uses another package manager');
    expect(mixed).toContain('never guard its install with that file');
    expect(undeclaredToolMentions(mixed, ['run_shell'], { minNonNegated: 1 })).toEqual([]);
  });

  // npm ignores pnpm-workspace.yaml and refuses `catalog:` and `workspace:`
  // (EUNSUPPORTEDPROTOCOL, npm 11): a lockfile-less pnpm root in the npm chain
  // failed its first step, so `browser/` after it was never installed either.
  it('marks a lockfile-less pnpm workspace root as pnpm\'s, keeps it out of the npm chain and names pnpm for it', () => {
    const root = seed({
      'package.json': JSON.stringify({ name: 'mono', devDependencies: { typescript: 'catalog:', '@app/web': 'workspace:*' } }),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\ncatalog:\n  typescript: ^5.6.0\n",
      'apps/web/package.json': '{"name":"@app/web"}',
      'browser/package.json': '{}', 'browser/package-lock.json': '{}',
    });
    const preparation = launchWorkspacePreparation({ resume: false, seedRoot: root });
    expect(preparation).toEqual({ dependencies: 'excluded-from-seed', packageRootsComplete: true,
      packageRoots: [{ dir: '.', lockfile: null, workspace: 'pnpm' }, { dir: 'browser', lockfile: 'package-lock.json' }] });
    expect(packageRootInstallCommand(preparation.packageRoots!)).toBe(BROWSER_INSTALL);
    const instruction = workspacePreparationGuidance(preparation, true);
    expect(instruction).toContain("Package roots the seed held at launch, outside dot-directories and build or vendor trees ('.' is the repository root): . (pnpm workspace, no lockfile), browser (package-lock.json).");
    expect(instruction).toContain(`For the listed roots: ${BROWSER_INSTALL} `);
    expect(instruction).toContain('. (pnpm workspace, no lockfile) uses another package manager: install it once per execution');
    expect(instruction).toContain('env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --no-lockfile for a pnpm workspace without a lockfile');
    expect(instruction).toContain('never guard its install with that file');
    expect(instruction).not.toContain('npm install --no-save');
    expect(instruction).not.toContain('the repository root without');
    expect(instruction).not.toContain('apps/web');
    // An npm root without a lockfile is still installed by npm, and said so.
    const npmRoot = workspacePreparationGuidance({ dependencies: 'excluded-from-seed', packageRootsComplete: true,
      packageRoots: [{ dir: '.', lockfile: null }, { dir: 'browser', lockfile: 'package-lock.json' }] }, true);
    expect(npmRoot).toContain('and the repository root without a lockfile, whose install did not complete');
    expect(npmRoot).toContain('the repository root without one installs with npm install --no-save');
    expect(npmRoot).not.toContain('uses another package manager');
  });

  it('installs a nested pnpm workspace without a lockfile only on demand, through corepack, never with npm', () => {
    const guidance = workspacePreparationGuidance({ dependencies: 'excluded-from-seed', packageRootsComplete: true, packageRoots: [
      { dir: '.', lockfile: 'package-lock.json' }, { dir: 'tests/fixtures/mono', lockfile: null, workspace: 'pnpm' }] }, true);
    expect(guidance).toContain('tests/fixtures/mono (pnpm workspace, no lockfile) hold a package.json without a lockfile');
    expect(guidance).toContain('(a pnpm workspace: env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --no-lockfile --dir <dir>, never npm)');
    expect(guidance).not.toContain('uses another package manager');
    expect(packageRootInstallCommand([{ dir: '.', lockfile: 'package-lock.json' }, { dir: 'tests/fixtures/mono', lockfile: null, workspace: 'pnpm' }]))
      .toBe('(test -f node_modules/.package-lock.json || npm ci --include=dev)');
  });

  it('gives the fact to everyone and the instruction only to a declared shell, naming no other tool', () => {
    const fact = workspacePreparationGuidance(receipt, false);
    expect(fact).toContain('not a plan requirement');
    expect(fact).toContain('browser (package-lock.json)');
    expect(fact).toContain('tests/fixtures/app (no lockfile)');
    expect(fact).not.toMatch(/npm ci|test -f|run_shell|timeoutMs|install every/);
    // The mechanical undeclared-tool pre-check stays silent even at one mention.
    expect(undeclaredToolMentions(fact, ['read_file', 'write_file', 'validate_html'], { minNonNegated: 1 })).toEqual([]);
    const instruction = workspacePreparationGuidance(receipt, true);
    expect(instruction.startsWith(fact)).toBe(true);
    expect(instruction).toContain(BROWSER_INSTALL);
    expect(instruction).toContain('ONE run_shell command');
    expect(instruction).toContain('npm ci deletes the tree');
    expect(instruction).toContain(`with timeoutMs ${SHELL_TIMEOUT_MAX_MS}`);
    expect(instruction).toContain('An install that timed out or failed leaves a broken tree without that file: the same guarded command reinstalls it.');
    expect(instruction).toContain('tests/fixtures/app hold a package.json without a lockfile (possibly a fixture, template or example): install one only when a command you run resolves modules from it, with npm install --no-save --prefix <dir>.');
    // Scoped to the preparation installs: a task that changes a dependency changes its lockfile too.
    expect(instruction).toContain('These preparation installs never rewrite a lockfile');
    expect(instruction).toContain('When the task itself adds, removes or upgrades a dependency, change package.json and its lockfile together');
    expect(instruction).not.toContain('no install rewrites a lockfile');
    expect(instruction).toContain('web (pnpm-lock.yaml) uses another package manager');
    expect(instruction).toContain('never an unpinned npx or npm exec download');
    expect(instruction).toContain('never recorded as a probe');
    expect(undeclaredToolMentions(instruction, ['run_shell'], { minNonNegated: 1 })).toEqual([]);
    expect(workspacePreparationGuidance({ ...receipt, packageRootsComplete: false }, true)).toContain('other roots may exist deeper');
  });

  it('falls back to the generic preparation for a shell when no root was listed', () => {
    const generic = workspacePreparationGuidance({ dependencies: 'unverified' }, true);
    expect(generic).toContain('Inspect the relevant package roots and lockfiles once');
    expect(generic).not.toContain('test -f');
    expect(workspacePreparationGuidance({ dependencies: 'excluded-from-seed', packageRoots: [], packageRootsComplete: true }, false))
      .toContain('The seed held no package root at launch.');
  });

  it('keeps the host receipt across two delegations, a plan cannot forge it, and only a shell reads the instruction', () => {
    const root: Task = { description: 'Repair the browser suite', inputs: { workspacePreparation: receipt } };
    const phase: Task = { description: 'Repair', ...delegatedTaskContext(root, { description: 'Repair',
      inputs: { workspacePreparation: { dependencies: 'preserved-unverified', packageRoots: [] } } }) };
    const leaf: Task = { description: 'Run the browser suite', ...delegatedTaskContext(phase, { description: 'Run the browser suite' }) };
    expect(leaf.inputs?.['workspacePreparation']).toEqual(receipt);
    const shell = taskContextLines(leaf, { executor: true, hasShell: true }).join('\n');
    expect(shell).toContain(BROWSER_INSTALL);
    expect(shell.split('Package roots the seed held at launch').length - 1).toBe(1);
    const planner = taskContextLines(leaf).join('\n');
    expect(planner).toContain('browser (package-lock.json)');
    expect(planner).not.toContain('test -f');
    expect(taskContextLines(leaf, { executor: true }).join('\n')).not.toContain('test -f');
  });
});

describe('the molecule prompts', () => {
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
  const task: Task = { description: 'Repair the browser suite', inputs: { workspacePreparation: receipt } };
  const prompts = async (tools: string[]): Promise<{ plan: string; execute: string }> => {
    const child = new L1Atom({ name: 'Molecule', ordinal: 1, systemPrompt: 'Work.', params: {}, tools: tools.map(tool) });
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    await child.plan(task, ctx);
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'Done.' }));
    await child.execute(task, makePlan({ proposedAction: 'a' }), ctx);
    const [plan, execute] = ctx.llm.calls.map(call => call.userContent);
    return { plan: plan!, execute: execute! };
  };

  it('tells a molecule without run_shell the fact only, in its plan and its execution', async () => {
    const { plan, execute } = await prompts(['read_file', 'write_file', 'edit_file', 'validate_html', 'start_static_server']);
    for (const prompt of [plan, execute]) {
      expect(prompt).toContain('browser (package-lock.json)');
      expect(prompt).not.toContain('test -f');
      expect(prompt).not.toContain('npm ci');
    }
  });

  it('tells a molecule that declares run_shell the guarded install naming browser', async () => {
    const { plan, execute } = await prompts(['read_file', 'edit_file', 'run_shell']);
    expect(plan).toContain(BROWSER_INSTALL);
    expect(execute).toContain(BROWSER_INSTALL);
  });
});
