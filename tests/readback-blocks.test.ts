import { describe, expect, it } from 'vitest';
import { criteriaFilesBlock } from '../src/atoms/fileEvidence.js';
import type { AcceptanceChecklist } from '../src/contracts/acceptanceChecklist.js';
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
