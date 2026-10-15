import { describe, expect, it } from 'vitest';
import { commandTestScripts, criteriaFilesBlock, ROOT_CRITERIA_SOURCE_CHARS } from '../src/atoms/fileEvidence.js';
import type { AcceptanceChecklist } from '../src/contracts/acceptanceChecklist.js';
import { parseExecutionObservation, type AttestationRecord } from '../src/contracts/attestation.js';
import { makeCtx } from './helpers.js';

/**
 * What the acceptor reads of a long file past its head
 * (docs/incidents/first-refusals-2026-10-10.md, E3): a test's title line
 * names the behaviour, its assertions are the lines below it, and four first
 * refusals said "only the title is visible". Run cb53b09d's diamond test named
 * fixture files the acceptor was never shown.
 */
function workspace(files: Record<string, string>) {
  const reads: string[] = [];
  const ctx = { ...makeCtx(), tools: {
    has: (name: string) => name === 'read_file',
    execute: async (_name: string, args: Record<string, unknown>) => {
      const path = String(args['path']);
      reads.push(path);
      if (!(path in files)) throw new Error('ENOENT');
      return { content: files[path] };
    },
  } };
  return { ctx, reads };
}

const criterion = (behaviour: string): AcceptanceChecklist => [{ id: 'c1', behaviour, check: { kind: 'review' } }];

describe('read-back past a long file head', () => {
  it('keeps the block a criterion word opens: the assertions under a test title', async () => {
    const tests = [
      "import assert from 'node:assert/strict';",
      `// ${'filler '.repeat(4000)}`,
      "test('statusCode=599 stays 599', async () => {",
      '  const res = await app.inject({ url: "/599" });',
      '',
      '  assert.equal(res.statusCode, 599);',
      '});',
      "test('unrelated', () => {",
      '  assert.ok(true);',
      '});',
    ].join('\n');
    const { ctx } = workspace({ 'test/errors.test.js': tests });
    const block = await criteriaFilesBlock(ctx, criterion('test/errors.test.js asserts a statusCode of 599'), [], '');
    expect(block).toContain('later blocks naming the criteria\'s words (line: text)');
    expect(block).toContain(JSON.stringify([
      "3: test('statusCode=599 stays 599', async () => {\n  const res = await app.inject({ url: \"/599\" });\n\n  assert.equal(res.statusCode, 599);\n});",
    ]));
    expect(block).not.toContain('unrelated');
  });

  it('a file no criterion word reaches past its head keeps its whole allowance as head', async () => {
    const long = 'x'.repeat(30_000);
    const { ctx } = workspace({ 'data.txt': long });
    const block = await criteriaFilesBlock(ctx, [], ['data.txt'], '');
    expect(block).toContain(`…(cut at 24000 of 30000 chars)`);
    expect(block).toContain(JSON.stringify('x'.repeat(24_000)));
  });

  it('reads the small fixtures a read-back test loads, beside it or from the root, and stays silent on the rest', async () => {
    const test = [
      "const input = JSON.parse(readFileSync('fixtures/diamond.json', 'utf8'));",
      "const lock = new URL('./diamond.lock.json', import.meta.url);",
      "const missing = 'fixtures/absent.json';",
      "const huge = 'fixtures/huge.json';",
      "const leaves = '../../outside.json';",
      "const internal = '.atoma-probes.json';",
    ].join('\n');
    const { ctx, reads } = workspace({
      'test/resolver.test.js': test,
      'fixtures/diamond.json': '{"root":["A","B"]}',
      'test/diamond.lock.json': '{"A":"1.0.0"}',
      'fixtures/huge.json': 'h'.repeat(5_000),
      '.atoma-probes.json': '{}',
    });
    const block = await criteriaFilesBlock(ctx, criterion('test/resolver.test.js proves the diamond case'), [], '');
    expect(block).toContain('- fixtures/diamond.json (18 chars, referenced by a string literal in test/resolver.test.js): "{\\"root\\":[\\"A\\",\\"B\\"]}"');
    expect(block).toContain('- test/diamond.lock.json (13 chars, referenced by a string literal in test/resolver.test.js)');
    expect(block).not.toContain('fixtures/huge.json (');
    expect(block).not.toContain('absent.json (');
    expect(reads).not.toContain('.atoma-probes.json');
    expect(reads.some((path) => path.includes('outside'))).toBe(false);
    expect(block).not.toContain('further file reads omitted');
  });

  it('stays inside the sixteen-read cap and still counts omitted primary files honestly', async () => {
    const files: Record<string, string> = {};
    const paths = Array.from({ length: 18 }, (_, i) => `t${i}.test.js`);
    for (const path of paths) files[path] = `load('${path}.json')`;
    const { ctx, reads } = workspace(files);
    const block = await criteriaFilesBlock(ctx, [], paths, '');
    expect(reads).toHaveLength(16);
    expect(block).toContain('2 further file reads omitted');
  });
});

describe('read-back blocks stay inside the allowance', () => {
  it('completes test bodies while retaining at least half of every other fair share', async () => {
    const files = { 'first.test.js': 'a'.repeat(9000), 'second.test.js': 'b'.repeat(10000),
      'requirements.md': 'c'.repeat(40000), 'config.json': 'd'.repeat(1000) };
    const { ctx } = workspace(files);
    const block = await criteriaFilesBlock(ctx, [], Object.keys(files), '');
    expect(block).toContain(JSON.stringify(files['first.test.js']));
    expect(block).toContain(JSON.stringify(files['second.test.js']));
    expect(block).toContain(JSON.stringify('c'.repeat(4000)));
    expect(block).toContain(JSON.stringify(files['config.json']));
    const shown = [...block.matchAll(/"([abcd]+)"/g)].reduce((sum, match) => sum + match[1]!.length, 0);
    expect(shown).toBe(24000);
  });

  it('does not sacrifice other files or test heads when a full suite cannot fit', async () => {
    const files = { 'large.test.js': 'a'.repeat(50000), 'source.js': 'b'.repeat(40000), 'requirements.md': 'c'.repeat(40000) };
    const { ctx } = workspace(files);
    const block = await criteriaFilesBlock(ctx, [], Object.keys(files), '');
    for (const char of ['a', 'b', 'c']) expect(block).toContain(JSON.stringify(char.repeat(8000)));
  });

  it('keeps every donor visible when many small tests compete with implementation and input bytes', async () => {
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`suite${i}.test.js`, String(i).repeat(3000)]));
    Object.assign(files, { 'implementation.js': 'a'.repeat(50000), 'capture.html': 'b'.repeat(50000) });
    const { ctx } = workspace(files);
    const block = await criteriaFilesBlock(ctx, [], Object.keys(files), '');
    // Twelve fair shares of 2k: at most half each non-test head can move.
    expect(block).toContain(JSON.stringify('a'.repeat(1000)));
    expect(block).toContain(JSON.stringify('b'.repeat(1000)));
    const shown = [...block.matchAll(/"([0-9ab]+)"/g)].reduce((sum, match) => sum + match[1]!.length, 0);
    expect(shown).toBe(24000);
  });

  const longTests = (eol: string) => Array.from({ length: 400 }, (_, i) =>
    [`describe('case ${i} boundary', () => {`, `  it('holds ${i}', () => {`, `    assert.equal(run(${i}), ${i});`, '  });', '});'].join(eol)).join(eol);

  it.each(['\n', '\r\n'])('never exceeds the allowance, prefixes included (eol=%j)', async (eol) => {
    const content = longTests(eol);
    const { ctx } = workspace({ 'spec.js': content });
    const block = await criteriaFilesBlock(ctx, criterion('spec.js covers every boundary case'), [], '');
    const head = JSON.parse(/: ("(?:[^"\\]|\\.)*") …\(cut at/.exec(block)![1]!) as string;
    const blocks = JSON.parse(/\(line: text\): (\[.*\])$/m.exec(block)![1]!) as string[];
    expect(head.length + blocks.reduce((n, entry) => n + entry.length, 0)).toBeLessThanOrEqual(24_000);
    // One wide match takes at most a quarter of the block budget: several blocks survive.
    expect(blocks.length).toBeGreaterThan(3);
    // The first block starts on the line the head cut through or after it, never before.
    const firstLine = Number(blocks[0]!.slice(0, blocks[0]!.indexOf(':')));
    const headLines = head.split(/\r?\n/).length;
    expect(firstLine).toBeGreaterThanOrEqual(headLines);
    expect(firstLine).toBeLessThanOrEqual(headLines + 5);
  });
});

describe('root acceptance reads four times the phase budget', () => {
  it('a 40,000-character page is whole for the root and cut for a phase judge', async () => {
    const page = `<main>${'<p>row</p>'.repeat(4_000)}</main>`;
    const { ctx } = workspace({ 'index.html': page });
    const phase = await criteriaFilesBlock(ctx, [], ['index.html'], '');
    const root = await criteriaFilesBlock(ctx, [], ['index.html'], '', ROOT_CRITERIA_SOURCE_CHARS);
    expect(phase).toContain('…(cut at 24000 of');
    expect(root).toContain(JSON.stringify(page));
  });
});

describe('test scripts a shell command names (Attica runs 85cc4e83, f74c140a)', () => {
  let id = 0;
  const record = (tool: string, args: Record<string, unknown>): AttestationRecord =>
    ({ eventId: `e${id++}`, attempt: 1, tool, observation: parseExecutionObservation(tool, args, { exitCode: 0, stdout: 'ok' })! });

  it('reads command lines only, newest first, never a note, a glob, a non-test script or an absolute path', () => {
    const records = [
      record('record_probe', { cmd: 'node --test tests/a.test.js ./tests/b.test.js', note: 'also see tests/note-only.test.js' }),
      record('run_shell', { command: 'node', args: ['--test', 'test/c.spec.mjs'] }),
      record('run_shell', { cmd: 'node --test tests/*.test.js browser/control-server.js /workspace/tests/abs.test.js' }),
      record('read_file', { path: 'tests/read.test.js' }),
      record('record_probe', { cmd: 'node --test tests/a.test.js' }),
    ];
    expect(commandTestScripts(records)).toEqual(['tests/a.test.js', 'test/c.spec.mjs', 'tests/b.test.js']);
  });

  it('keeps the command half of a request cut by its excerpt bound and drops the note', () => {
    const records = [record('record_probe', { cmd: `node --test tests/kept.test.js ${'x'.repeat(900)}`, note: 'tests/dropped.test.js' })];
    expect(records[0]!.observation.kind === 'execution' && records[0]!.observation.request).toContain('[truncated]');
    expect(commandTestScripts(records)).toEqual(['tests/kept.test.js']);
  });

  it('lets command-named tests take at most half of the sixteen reads', async () => {
    const files: Record<string, string> = {};
    const named = Array.from({ length: 12 }, (_, i) => `tests/n${i}.test.js`);
    const refreshed = Array.from({ length: 6 }, (_, i) => `src/s${i}.js`);
    for (const path of [...named, ...refreshed]) files[path] = path;
    const { ctx, reads } = workspace(files);
    await criteriaFilesBlock(ctx, [], refreshed, '', ROOT_CRITERIA_SOURCE_CHARS, named);
    expect(reads.filter((path) => path.startsWith('tests/'))).toEqual(named.slice(0, 8));
    expect(reads.filter((path) => path.startsWith('src/'))).toEqual(refreshed);
  });

  it('reads refreshed test scripts before other refreshed files when the cap bites', async () => {
    const files: Record<string, string> = {};
    const docs = Array.from({ length: 16 }, (_, i) => `docs/d${i}.md`);
    for (const path of [...docs, 'tests/late.test.js']) files[path] = path;
    const { ctx, reads } = workspace(files);
    const block = await criteriaFilesBlock(ctx, [], [...docs, 'tests/late.test.js'], '');
    expect(reads[0]).toBe('tests/late.test.js');
    expect(block).toContain('1 further file reads omitted');
    expect(block).not.toContain('named by a shell command');
  });
});
