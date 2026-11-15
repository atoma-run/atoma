import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Atom } from '../src/core/atom.js';
import type { Plan, Result, RunContext, Task, ToolExecutor, Verdict } from '../src/core/types.js';
import { acceptRootResult } from '../src/atoms/rootAcceptance.js';
import { ASSERTION_EVIDENCE_GUIDANCE } from '../src/atoms/prompts.js';
import { compareStartingWorkspace, renderStartingWorkspace, startingSnapshotSchema } from '../src/contracts/startingWorkspace.js';
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
  it.each([[0o644, 0o755], [0o4755, 0o644]])('reports permission-only changes through real filesystem snapshots (%o → %o)', (before, after) => {
    const root = dir({ 'launch.sh': '#!/bin/sh\necho usable\n' });
    chmodSync(join(root, 'launch.sh'), before);
    const start = snapshotStartingWorkspace(root);
    expect(start.files[0]?.mode).toBe(before);
    chmodSync(join(root, 'launch.sh'), after);
    const comparison = compareStartingWorkspace(start, snapshotDeliveredWorkspace(root, start));
    expect(comparison).toMatchObject({ unchanged: 0, modeCompared: 1, modeUnknown: 0,
      changes: [{ path: 'launch.sh', status: 'changed', contentChanged: false, beforeMode: before, afterMode: after }] });
    expect(renderStartingWorkspace(comparison)).toContain(`permissions ${before.toString(8).padStart(4, '0')} → ${after.toString(8).padStart(4, '0')}; content unchanged`);
  });

  it.each(['start', 'delivered'])('keeps missing legacy %s permissions unknown', (side) => {
    const root = dir({ 'launch.sh': '#!/bin/sh\necho usable\n' });
    chmodSync(join(root, 'launch.sh'), 0o644);
    const start = snapshotStartingWorkspace(root);
    chmodSync(join(root, 'launch.sh'), 0o755);
    const now = snapshotDeliveredWorkspace(root, start);
    const legacyFiles = start.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }));
    const comparison = compareStartingWorkspace(side === 'start' ? startingSnapshotSchema.parse({ files: legacyFiles, truncated: false }) : start,
      side === 'delivered' ? { ...now, files: legacyFiles } : now);
    expect(comparison).toMatchObject({ unchanged: 1, changes: [], modeCompared: 0, modeUnknown: 1 });
    expect(renderStartingWorkspace(comparison)).toContain('unchanged bytes do not establish unchanged permissions');
  });

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

  it('never reports a starting file removed because new files filled a cap, and names only the files the run added', () => {
    const many = Object.fromEntries(Array.from({ length: 405 }, (_, i) => [`src/f${String(i).padStart(3, '0')}.js`, `x${i}\n`]));
    const seed = dir(many);
    const now = dir({ ...many, 'CHANGELOG.md': '# new\n', 'AAA.md': '# new\n' });
    const comparison = compare(seed, now);
    expect(comparison.changes).toEqual([]);
    expect(comparison).toMatchObject({ startTruncated: false, addedUnknown: false, unchanged: 405, startFiles: 405 });
    expect(comparison.added).toEqual(['AAA.md', 'CHANGELOG.md']);
  });

  // Production run ff1027b6 (2026-11-15): a read-only question over a 425-file
  // imported repository was refused because the 25 files past the 400-file
  // cap were listed as "New files".
  it('calls no starting file new when a run past the detailed cap changed nothing', () => {
    const many = Object.fromEntries(Array.from({ length: 425 }, (_, i) => [`test/f${String(i).padStart(3, '0')}.test.ts`, `it(${i});\n`]));
    const root = dir(many);
    const start = snapshotStartingWorkspace(root);
    expect(start.truncated).toBe(false);
    expect(start.files).toHaveLength(425);
    expect(start.files[399]?.lineHashes).toBeDefined();
    expect(start.files[400]).toEqual({ path: 'test/f400.test.ts', bytes: 9, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), mode: expect.any(Number) });
    expect(startingSnapshotSchema.parse(JSON.parse(JSON.stringify(start)))).toEqual(start);
    const comparison = compareStartingWorkspace(start, snapshotDeliveredWorkspace(root, start));
    expect(comparison).toMatchObject({ changes: [], added: [], unchanged: 425, startTruncated: false, addedUnknown: false });
    const block = renderStartingWorkspace(comparison);
    expect(block).toContain('- no compared starting file was removed or changed');
    expect(block).toContain('Unchanged starting files: 425.');
    expect(block).toContain('New regular files: none.');
    expect(block).not.toContain('not compared');
  });

  it('reports a file past the detailed cap changed, removed or re-moded, by digest', () => {
    const many = Object.fromEntries(Array.from({ length: 404 }, (_, i) => [`src/f${String(i).padStart(3, '0')}.js`, `x${i}\n`]));
    const root = dir(many);
    chmodSync(join(root, 'src/f403.js'), 0o644);
    const start = snapshotStartingWorkspace(root);
    writeFileSync(join(root, 'src/f401.js'), 'changed\n');
    rmSync(join(root, 'src/f402.js'));
    chmodSync(join(root, 'src/f403.js'), 0o755);
    writeFileSync(join(root, 'src/f999.js'), 'new\n');
    const comparison = compareStartingWorkspace(start, snapshotDeliveredWorkspace(root, start));
    expect(comparison.changes).toMatchObject([
      { path: 'src/f402.js', status: 'removed' },
      { path: 'src/f401.js', status: 'changed', contentChanged: true },
      { path: 'src/f403.js', status: 'changed', contentChanged: false, beforeMode: 0o644, afterMode: 0o755 },
    ]);
    expect(comparison).toMatchObject({ unchanged: 401, added: ['src/f999.js'] });
  });

  it('counts lines moved into a file past the detailed cap as kept, not rewritten away', () => {
    const many = Object.fromEntries(Array.from({ length: 410 }, (_, i) => [`m/f${String(i).padStart(3, '0')}.js`, `x${i}\n`]));
    const root = dir({ ...many, 'a/app.js': CONFIGURATOR, 'z/utils.js': 'export {};\n' });
    const start = snapshotStartingWorkspace(root);
    expect(start.files.at(-1)).toMatchObject({ path: 'z/utils.js' });
    expect(start.files.at(-1)?.lineHashes).toBeUndefined();
    writeFileSync(join(root, 'a/app.js'), 'import "../z/utils.js";\n');
    writeFileSync(join(root, 'z/utils.js'), `export {};\n${CONFIGURATOR}\n`);
    const comparison = compareStartingWorkspace(start, snapshotDeliveredWorkspace(root, start));
    expect(comparison.changes).toMatchObject([
      { path: 'a/app.js', status: 'moved', keptAnywhere: 1 },
      { path: 'z/utils.js', status: 'changed' },
    ]);
  });

  it('says what the unlisted changes are when more than twenty files changed', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`old/f${String(i).padStart(2, '0')}.js`, `x${i}\n`]));
    const root = dir({ ...many, 'keep.js': 'k\n' });
    const start = snapshotStartingWorkspace(root);
    rmSync(join(root, 'old'), { recursive: true });
    writeFileSync(join(root, 'keep.js'), 'changed\n');
    const block = renderStartingWorkspace(compareStartingWorkspace(start, snapshotDeliveredWorkspace(root, start)));
    expect(block).toContain('- …and 11 more: 10 removed, 1 changed or moved');
  });

  it('claims no absence of links or of files in directories it does not walk', () => {
    const root = dir({ 'a.txt': 'a\n' });
    const start = snapshotStartingWorkspace(root);
    mkdirSync(join(root, 'coverage'));
    writeFileSync(join(root, 'coverage/x.html'), '<p>\n');
    const block = renderStartingWorkspace(compareStartingWorkspace(start, snapshotDeliveredWorkspace(root, start)));
    expect(block).toContain('New regular files: none. Links, and dependency, cache and coverage directories, are not walked.');
  });

  it('leaves a start past its digest cap truncated, and then calls no file new', () => {
    const many = Object.fromEntries(Array.from({ length: 5_405 }, (_, i) => [`d${Math.floor(i / 500)}/f${String(i).padStart(4, '0')}.js`, `x${i}\n`]));
    const root = dir(many);
    const start = snapshotStartingWorkspace(root);
    expect(start.truncated).toBe(true);
    expect(start.files).toHaveLength(5_400);
    const comparison = compareStartingWorkspace(start, snapshotDeliveredWorkspace(root, start));
    expect(comparison).toMatchObject({ changes: [], added: [], addedUnknown: true, unchanged: 5_400 });
    expect(renderStartingWorkspace(comparison)).toContain('New files: not established.');
  }, 30_000);

  it('says new files are not established for a start that left files unrecorded, whatever the delivered side lists', () => {
    const many = Object.fromEntries(Array.from({ length: 405 }, (_, i) => [`src/f${String(i).padStart(3, '0')}.js`, `x${i}\n`]));
    const root = dir(many);
    // What a build before 2026-11-15 recorded: the first 400 files, cut.
    const legacy = startingSnapshotSchema.parse({ files: snapshotStartingWorkspace(root).files.slice(0, 400), truncated: true });
    const now = snapshotDeliveredWorkspace(root, legacy);
    expect(now.added.map((file) => file.path)).toHaveLength(5);
    const comparison = compareStartingWorkspace(legacy, now);
    expect(comparison).toMatchObject({ changes: [], added: [], addedUnknown: true, startTruncated: true, unchanged: 400 });
    const block = renderStartingWorkspace(comparison);
    expect(block).toContain('The starting snapshot covers 400 files only');
    expect(block).toContain('New files: not established.');
    expect(block).not.toContain('f404');
  });

  it('records a file too large for the detailed read by digest: compared, never new', () => {
    const root = dir({ 'a.txt': 'a\n' });
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(8 * 1024 * 1024 + 1));
    const start = snapshotStartingWorkspace(root);
    expect(start.truncated).toBe(false);
    expect(start.files.map((file) => file.path)).toEqual(['a.txt', 'big.bin']);
    expect(compareStartingWorkspace(start, snapshotDeliveredWorkspace(root, start))).toMatchObject({ changes: [], added: [], unchanged: 2 });
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(8 * 1024 * 1024 + 1, 1));
    expect(compareStartingWorkspace(start, snapshotDeliveredWorkspace(root, start)).changes).toMatchObject([{ path: 'big.bin', status: 'changed', contentChanged: true }]);
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
    const readme = `# Notes API\n${'Intro text. '.repeat(8400)}\n## Routes\ncurl -X POST http://localhost:<port>/api/notes\n`;
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
    // Root acceptance reads 96,000 characters (ROOT_CRITERIA_SOURCE_CHARS).
    expect(prompt).toContain(`…(cut at 95951 of ${readme.length} chars)`);
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

it('reports a starting file that outgrew the detailed read as changed by digest, never removed', () => {
  const root = dir();
  writeFileSync(join(root, 'large.txt'), Buffer.alloc(6 * 1024 * 1024, 'a'));
  const start = snapshotStartingWorkspace(root);
  writeFileSync(join(root, 'large.txt'), Buffer.alloc(9 * 1024 * 1024, 'b'));
  const comparison = compareStartingWorkspace(start, snapshotDeliveredWorkspace(root, start));
  expect(comparison.changes).toMatchObject([{ path: 'large.txt', status: 'changed', contentChanged: true, before: 6 * 1024 * 1024, after: 9 * 1024 * 1024 }]);
  expect(renderStartingWorkspace(comparison)).toContain('- large.txt: changed 6291456 → 9437184 bytes');
  expect(renderStartingWorkspace(comparison)).not.toContain('REMOVED');
});

it('reports a starting file replaced by a directory as not compared, never removed', () => {
  const root = dir({ 'notes.txt': 'kept\n' });
  const start = snapshotStartingWorkspace(root);
  rmSync(join(root, 'notes.txt'));
  mkdirSync(join(root, 'notes.txt'));
  const comparison = compareStartingWorkspace(start, snapshotDeliveredWorkspace(root, start));
  expect(comparison.changes[0]?.status).toBe('unreadable');
  expect(renderStartingWorkspace(comparison)).toContain('NOT COMPARED');
  expect(renderStartingWorkspace(comparison)).not.toContain('REMOVED');
});
