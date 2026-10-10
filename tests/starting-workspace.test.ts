import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Atom } from '../src/core/atom.js';
import type { Plan, Result, RunContext, Task, ToolExecutor, Verdict } from '../src/core/types.js';
import { acceptRootResult } from '../src/atoms/rootAcceptance.js';
import { ASSERTION_EVIDENCE_GUIDANCE } from '../src/atoms/prompts.js';
import { compareStartingWorkspace, renderStartingWorkspace } from '../src/contracts/startingWorkspace.js';
import { snapshotDeliveredWorkspace, snapshotStartingWorkspace } from '../src/run/workspace.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';

/**
 * Production run 902b2c21 (2026-09-27), a continuation asked to keep "the
 * existing configurator unchanged in behaviour", wrote a home page over the
 * 13394-byte configurator and a 2090-byte stand-in with invented prices, and
 * was approved: nothing the acceptor read said what had happened to the
 * files it started from. The host holds both sides.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function dir(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-starting-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
const compare = (seed: string, now: string) => {
  const start = snapshotStartingWorkspace(seed);
  return compareStartingWorkspace(start, snapshotDeliveredWorkspace(now, start));
};

const CONFIGURATOR = Array.from({ length: 40 }, (_, i) => `const step${i} = computeStep(${i});`).join('\n');

describe('the starting workspace', () => {
  it('reads deliverable files only, without links, installed trees, caches or .atoma paths in any case', () => {
    const root = dir({ 'index.html': '<p>hi</p>\n', 'docs/ERRORS.md': '# Errors\n', 'node_modules/x.js': 'x',
      '.atoma-scratch/probe.csv': 'a', '.atoma-probes.json': '{}', '.ATOMA/x': 'y', '.next/cache.js': 'z',
      '__pycache__/m.pyc': 'p', 'coverage/lcov.info': 'c' });
    const start = snapshotStartingWorkspace(root);
    expect(start.files.map((file) => file.path)).toEqual(['docs/ERRORS.md', 'index.html']);
    expect(start.truncated).toBe(false);
    expect(start.files[1]).toMatchObject({ bytes: 10, lineHashes: [expect.stringMatching(/^[0-9a-f]{16}$/)] });
  });

  it('names a replaced file rewritten, a removed one first, and code moved to another file as moved', () => {
    const seed = dir({ 'index.html': CONFIGURATOR, 'app.js': 'export const x = 1;\n', 'README.md': '# Configurator\n',
      'styles.css': 'body { margin: 0 }\n', 'about.html': CONFIGURATOR.replaceAll('step', 'part') });
    const now = dir({
      'index.html': '<h1>Home</h1>\n<a href="configurator.html">Configure</a>\n',
      'configurator.html': 'if (pkg === "business" && pages === 12) total += 290;\n',
      'README.md': '# Configurator\n',
      'styles.css': 'body { margin: 0 }\n.b { color: blue }\n',
      // about.html's script moved, whole, to about.js.
      'about.html': '<script src="about.js"></script>\n',
      'about.js': CONFIGURATOR.replaceAll('step', 'part'),
    });
    const comparison = compare(seed, now);
    expect(comparison.changes.map((change) => [change.path, change.status])).toEqual([
      ['app.js', 'removed'], ['index.html', 'rewritten'], ['about.html', 'moved'], ['styles.css', 'changed']]);
    expect(comparison.unchanged).toBe(1);
    expect(comparison.added).toEqual(['about.js', 'configurator.html']);
    const block = renderStartingWorkspace(comparison);
    expect(block).toContain(`- index.html: REWRITTEN ${CONFIGURATOR.length} → 56 bytes; 0% of its starting lines remain anywhere in the delivery`);
    expect(block).toContain('- about.html: moved');
    expect(block).toContain('0% of its starting lines here, 100% across the delivered files');
    expect(block).toContain('- app.js: REMOVED (20 bytes at the start); it started as "export const x = 1;\\n"');
    expect(block).toContain('remain anywhere in the delivery; it started as "const step0 = computeStep(0);');
    // A one-line file is only ever changed: one edited line is no rewrite.
    expect(block).toContain('- styles.css: changed 19 → 38 bytes');
    expect(renderStartingWorkspace(undefined)).toBe('');
  });

  it('never reports a starting file removed because new files filled a cap, and says when the start was capped', () => {
    const many = Object.fromEntries(Array.from({ length: 405 }, (_, i) => [`src/f${String(i).padStart(3, '0')}.js`, `x${i}\n`]));
    const seed = dir(many);
    const now = dir({ ...many, 'CHANGELOG.md': '# new\n', 'AAA.md': '# new\n' });
    const comparison = compare(seed, now);
    expect(comparison.changes).toEqual([]);
    expect(comparison.startTruncated).toBe(true);
    expect(renderStartingWorkspace(comparison)).toContain('The starting snapshot covers 400 files only');
  });
});

class Workspace implements ToolExecutor {
  constructor(readonly files: Record<string, string>) {}
  has(name: string) { return ['read_file', 'list_files'].includes(name); }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'list_files') return { entries: Object.keys(this.files).map((name) => ({ name, kind: 'file', size: this.files[name]!.length })) };
    const path = String(args['path']);
    if (!(path in this.files)) throw new Error('ENOENT');
    return { content: this.files[path] };
  }
}
class Actor extends Atom {
  readonly tier = 2 as const;
  readonly model = 'test';
  constructor() { super({ name: 'cell', ordinal: 1, systemPrompt: '', tools: makeTools(['write_file', 'read_file']), params: {} }); }
  async plan(): Promise<Plan> { return makePlan(); }
  async execute(): Promise<Result> { return { output: 'done', summary: 'done', trace: [], producedBy: { tier: 1, name: 'leaf', viaFallback: false } }; }
  async validatePlan(): Promise<Verdict> { return { approved: true, reasoning: 'ok' }; }
  async validateResult(): Promise<Verdict> { return { approved: true, reasoning: 'ok' }; }
}

describe('what the root acceptor reads', () => {
  const task: Task = { description: 'Add pages around the existing configurator, unchanged in behaviour' };
  const result: Result = { output: 'site written', summary: 'Wrote README.md and index.html', trace: [], producedBy: { tier: 1, name: 'leaf', viaFallback: false } };
  const origin = { source: 'user' as const, digest: 'a'.repeat(64) };

  it('shows the complete warehouse test body, not just the misleading passing title, to root acceptance', async () => {
    const tests = readFileSync(new URL('../benchmark/stock-reconcile-2026-10-05/published/stock-reconcile.test.js.txt', import.meta.url), 'utf8');
    const base = makeCtx();
    const ctx: RunContext = { ...base, tools: new Workspace({ 'test/stock-reconcile.test.js': tests }), attempt: 1 };
    for (let call = 0; call < 2; call++) base.llm.enqueueText(jsonText({ approved: false, reasoning: 'Conflicting duplicate assertions are not present.',
      scope: 'ephemeral', modifications: {}, criteria: [{ id: 'c1', met: false, reason: 'The cases array has no conflicting duplicate input.' }] }));
    const accepted = await acceptRootResult({ actor: new Actor(), task: { description: 'Verify conflicting duplicates preserve outputs.' },
      result: { ...result, summary: 'Seven tests pass, including conflicts.' }, ctx, floor: [], phaseCoverage: [],
      checklist: [{ id: 'c1', behaviour: 'test/stock-reconcile.test.js covers conflicting duplicates and preserves outputs.', check: { kind: 'review' } }],
      checklistOrigin: origin });
    const request = base.llm.calls[0]!;
    expect(request.userContent).toContain(JSON.stringify(tests));
    expect(request.userContent).toContain('concrete assertion or observation and evidence location');
    expect(request.systemPrompt).toContain(ASSERTION_EVIDENCE_GUIDANCE);
    expect(accepted.approved).toBe(false);
    expect(base.llm.calls).toHaveLength(2);
    expect(base.llm.calls[1]!.userContent).toContain(JSON.stringify(tests));
    // This tests the real reader/verdict plumbing, not model judgment. Live
    // baseline/candidate judgments are archived separately beside the fixture.
  });

  it('reads the starting workspace comparison and the files the criteria name, long ones past their head', async () => {
    const readme = `# Notes API\n${'Intro text. '.repeat(4200)}\n## Routes\ncurl -X POST http://localhost:<port>/api/notes\n`;
    const seed = dir({ 'index.html': CONFIGURATOR });
    const now = dir({ 'index.html': '<h1>Home</h1>\n' });
    const start = snapshotStartingWorkspace(seed);
    const base = makeCtx();
    const ctx: RunContext = { ...base, tools: new Workspace({ 'README.md': readme, 'index.html': '<h1>Home</h1>' }), attempt: 1,
      startingWorkspace: { start, now: () => snapshotDeliveredWorkspace(now, start) } };
    for (let call = 0; call < 2; call++) base.llm.enqueueText(jsonText({ approved: false, reasoning: 'the configurator was replaced',
      criteria: [{ id: 'c1', met: false, reason: 'original features removed' }, { id: 'c2', met: true, reason: 'curl examples present' }] }));
    const checklist = [
      { id: 'c1', behaviour: 'The configurator keeps every feature it had', check: { kind: 'review' as const } },
      { id: 'c2', behaviour: 'README documents every route with a curl example; the quote downloads as quote.txt', check: { kind: 'review' as const } },
    ];
    await acceptRootResult({ actor: new Actor(), task, result, ctx, floor: [], phaseCoverage: [], checklist, checklistOrigin: origin });
    const prompt = base.llm.calls[0]!.userContent;
    expect(prompt).toContain(`- index.html: REWRITTEN ${CONFIGURATOR.length} → 14 bytes`);
    // Read although the ground-truth block lists it: that block shows a 400-character head.
    expect(prompt).toContain('FILES THE CRITERIA NAME, read back by the host');
    expect(prompt).toContain(`- README.md (${readme.length} chars):`);
    // Root acceptance reads 48,000 characters (ROOT_CRITERIA_SOURCE_CHARS).
    expect(prompt).toContain(`…(cut at 47951 of ${readme.length} chars)`);
    expect(prompt).toContain(`later blocks naming the criteria's words (line: text): ["4: curl -X POST http://localhost:<port>/api/notes"]`);
    expect(prompt).toContain('never judge a criterion unmet on a part of the file you were not shown');
    // A named file that is no workspace file (a download) says nothing.
    expect(prompt).not.toContain('- quote.txt');
    expect(prompt).toContain('met only on what it SHOWS');
  });

  it('reads neither for an unseeded run, nor named files beside a drafted list the acceptor is not shown', async () => {
    const plain = makeCtx();
    const ctx: RunContext = { ...plain, tools: new Workspace({ 'README.md': '# x' }), attempt: 1 };
    plain.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    await acceptRootResult({ actor: new Actor(), task, result, ctx, floor: [], phaseCoverage: [],
      checklist: [{ id: 'c1', behaviour: 'README explains how to run it', check: { kind: 'review' as const } }],
      checklistOrigin: { source: 'drafted' } });
    const prompt = plain.llm.calls[0]!.userContent;
    expect(prompt).not.toContain('STARTING WORKSPACE');
    expect(prompt).not.toContain('FILES THE CRITERIA NAME');
  });
});

it('reports an oversized starting file as unverified, never removed', () => {
  const root = dir();
  writeFileSync(join(root, 'large.txt'), Buffer.alloc(6 * 1024 * 1024, 'a'));
  const start = snapshotStartingWorkspace(root);
  writeFileSync(join(root, 'large.txt'), Buffer.alloc(9 * 1024 * 1024, 'b'));
  const comparison = compareStartingWorkspace(start, snapshotDeliveredWorkspace(root, start));
  expect(comparison.changes[0]?.status).toBe('unreadable');
  expect(renderStartingWorkspace(comparison)).toContain('NOT COMPARED');
  expect(renderStartingWorkspace(comparison)).not.toContain('REMOVED');
});
