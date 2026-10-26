import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launchWorkspacePreparation, packageRootsOf, PACKAGE_ROOT_MAX_DEPTH, PACKAGE_ROOT_MAX_DIRECTORIES } from '../src/run/workspace.js';
import { MAX_PACKAGE_ROOTS, workspacePreparationSchema, type WorkspacePreparation } from '../src/contracts/workspacePreparation.js';
import { delegatedTaskContext, packageRootInstallCommand, taskContextLines, workspacePreparationGuidance } from '../src/atoms/taskContext.js';
import { undeclaredToolMentions } from '../src/atoms/verdict.js';
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
const BROWSER_INSTALL = '(test -d browser/node_modules || npm ci --include=dev --prefix browser)';

describe('rendering the receipt', () => {
  it('composes one guarded install, root first, that never reinstalls a present tree', () => {
    expect(packageRootInstallCommand(receipt.packageRoots!)).toBe(
      `(test -d node_modules || npm ci --include=dev) && ${BROWSER_INSTALL} && `
      + '(test -d tests/fixtures/app/node_modules || npm install --no-save --prefix tests/fixtures/app)');
    expect(packageRootInstallCommand([{ dir: "my app", lockfile: 'package-lock.json' }]))
      .toBe("(test -d 'my app/node_modules' || npm ci --include=dev --prefix 'my app')");
    expect(packageRootInstallCommand([{ dir: 'web', lockfile: 'pnpm-lock.yaml' }])).toBeNull();
  });

  it('gives the fact to everyone and the instruction only to a declared shell, naming no other tool', () => {
    const fact = workspacePreparationGuidance(receipt, false);
    expect(fact).toContain('not a plan requirement');
    expect(fact).toContain('browser (package-lock.json)');
    expect(fact).toContain('tests/fixtures/app (no lockfile)');
    expect(fact).not.toMatch(/npm ci|test -d|run_shell|install every/);
    // The mechanical undeclared-tool pre-check stays silent even at one mention.
    expect(undeclaredToolMentions(fact, ['read_file', 'write_file', 'validate_html'], { minNonNegated: 1 })).toEqual([]);
    const instruction = workspacePreparationGuidance(receipt, true);
    expect(instruction.startsWith(fact)).toBe(true);
    expect(instruction).toContain(BROWSER_INSTALL);
    expect(instruction).toContain('ONE run_shell command');
    expect(instruction).toContain('npm ci deletes the tree');
    expect(instruction).toContain('web (pnpm-lock.yaml) uses another package manager');
    expect(instruction).toContain('never an unpinned npx or npm exec download');
    expect(instruction).toContain('never recorded as a probe');
    expect(undeclaredToolMentions(instruction, ['run_shell'], { minNonNegated: 1 })).toEqual([]);
    expect(workspacePreparationGuidance({ ...receipt, packageRootsComplete: false }, true)).toContain('other roots may exist deeper');
  });

  it('falls back to the generic preparation for a shell when no root was listed', () => {
    const generic = workspacePreparationGuidance({ dependencies: 'unverified' }, true);
    expect(generic).toContain('Inspect the relevant package roots and lockfiles once');
    expect(generic).not.toContain('test -d');
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
    expect(planner).not.toContain('test -d');
    expect(taskContextLines(leaf, { executor: true }).join('\n')).not.toContain('test -d');
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
      expect(prompt).not.toContain('test -d');
      expect(prompt).not.toContain('npm ci');
    }
  });

  it('tells a molecule that declares run_shell the guarded install naming browser', async () => {
    const { plan, execute } = await prompts(['read_file', 'edit_file', 'run_shell']);
    expect(plan).toContain(BROWSER_INSTALL);
    expect(execute).toContain(BROWSER_INSTALL);
  });
});
