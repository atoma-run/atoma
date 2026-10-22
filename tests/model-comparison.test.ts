import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { compareModels, readComparisonCorpus, scoreComparison } from '../src/cli/compareModels.js';
import { localToolBackend } from '../src/run/toolBackend.js';
import { makeCtx } from './helpers.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const corpusPath = resolve('benchmark/attica-challenge-v1/corpus.json');

it.each(['false', 'true'])('the real held-out scorer rejects a constant %s implementation', async value => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-model-score-')); roots.push(root);
  writeFileSync(join(root, 'challenge.ts'), `export const detectChallenge = () => ${value};`);
  const { corpus } = readComparisonCorpus(corpusPath);
  const score = await scoreComparison(root, corpus.suite,
    async options => localToolBackend({ ...options, logger: makeCtx().logger }));
  expect(score.status).toBe('failed');
  expect(score.failed).toBeGreaterThan(0);
  expect(score.skipped).toBe(0);
  expect(score.passed + score.failed).toBe(8);
}, 30000);

it('holds the corpus outside both fresh model workspaces and refuses to overwrite results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-model-comparison-')); roots.push(root);
  const { corpus } = readComparisonCorpus(corpusPath);
  const run = vi.fn(async (options: Parameters<typeof import('../src/cli/burnin.js').spawnRun>[0]) => {
    const workspace = options.extraEnv!['ATOMA_BUILD_WORKSPACE']!;
    mkdirSync(workspace, { recursive: true });
    expect(options.extraArgs).toContain('--baseline');
    expect(options.extraEnv!['ATOMA_WORKER_IMAGE']).toBe('sha256:fixture');
    expect(options.goal).not.toContain('holdout-');
    expect(options.extraEnv!['ATOMA_MODEL_L1']).toBe(options.extraEnv!['ATOMA_BASELINE_MODEL']);
    return '✓ build finished';
  });
  const score = vi.fn(async (_root: string, suite: typeof corpus.suite) => {
    expect(suite).toEqual(corpus.suite);
    return { suiteDigest: 'a'.repeat(64), workspaceDigest: '', status: 'passed' as const, passed: 7, failed: 0, skipped: 1, details: 'One omitted check' };
  });
  const options = { corpusPath, models: ['api:ollama:qwen3:8b', 'api:ollama:qwen3:32b'], out: join(root, 'result') };
  const result = await compareModels(options, { run, score, workerImage: 'sha256:fixture' });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[0]![0].extraEnv!['ATOMA_BUILD_WORKSPACE']).not.toBe(run.mock.calls[1]![0].extraEnv!['ATOMA_BUILD_WORKSPACE']);
  expect(result.rows.every(row => !row.correct)).toBe(true);
  expect(JSON.parse(readFileSync(join(options.out, 'protocol.json'), 'utf8'))).toMatchObject({ corpus: corpus.id, corpusDigest: expect.any(String) });
  await expect(compareModels(options, { run, score })).rejects.toThrow('already exists');
  expect(run).toHaveBeenCalledTimes(2);
});

it('retains a failed arm and still scores the other model without turning a banner into correctness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-failed-arm-')); roots.push(root);
  const run = vi.fn().mockRejectedValueOnce(new Error('transport unavailable')).mockResolvedValueOnce('✓ build finished');
  const score = vi.fn().mockRejectedValue(new Error('scorer refused workspace'));
  const result = await compareModels({ corpusPath, models: ['api:ollama:a', 'api:ollama:b'], out: join(root, 'result') }, { run, score });
  expect(run).toHaveBeenCalledTimes(2);
  expect(result.rows).toHaveLength(2);
  expect(result.rows.every(row => row.error && !row.correct)).toBe(true);
  expect(result.rows[0]!.error).toContain('transport unavailable');
  expect(result.rows[1]!.error).toContain('scorer refused workspace');
});

it('the same real scorer accepts the complete positive and negative structural corpus', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-valid-score-')); roots.push(root);
  writeFileSync(join(root, 'challenge.ts'), `
export function detectChallenge(html: string): boolean {
  const visible = html.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, '')
    .replace(/<div\\b[^>]*\\bhidden[^>]*>[\\s\\S]*?<\\/div>/gi, '');
  return /<form\\b[^>]*action=["']\\/challenge["'][^>]*>[\\s\\S]*?<input\\b[^>]*name=["']captcha-response["'][^>]*>[\\s\\S]*?<button\\b[^>]*>(?:Verify|Continue)<\\/button>/i.test(visible);
}`);
  const { corpus } = readComparisonCorpus(corpusPath);
  const score = await scoreComparison(root, corpus.suite,
    async options => localToolBackend({ ...options, logger: makeCtx().logger }));
  expect(score).toMatchObject({ status: 'passed', passed: 8, failed: 0, skipped: 0 });
}, 30000);
