import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexCliLlmClient, cleanupCodexJails } from '../src/core/llmCodexCli.js';
import type { LlmCompletionRequest } from '../src/core/types.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanupCodexJails();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const request: LlmCompletionRequest = {
  model: 'gpt-5.6-luna', systemPrompt: 'Review the recorded proof.', userContent: 'Synthetic offline proof.',
};

/** Real subprocesses exercise JSONL, child reap and usage folding, without a provider. */
function fixture(outcomes: readonly (number | 'success' | 'hang')[]) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const root = mkdtempSync(path.join(tmpdir(), 'codex-text-recovery-'));
  roots.push(root);
  const script = path.join(root, 'provider.cjs');
  const counter = path.join(root, 'calls.json');
  writeFileSync(counter, '[]');
  writeFileSync(script, `
    const fs = require('node:fs');
    const calls = JSON.parse(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
    let input = '';
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      const args = process.argv.slice(2);
      const outcome = ${JSON.stringify(outcomes)}[calls.length] ?? 429;
      calls.push({ model: args[args.indexOf('-m') + 1], input });
      fs.writeFileSync(${JSON.stringify(counter)}, JSON.stringify(calls));
      console.log(JSON.stringify({ type: 'turn.completed', usage: {
        input_tokens: 20, cached_input_tokens: 3, cache_write_input_tokens: 2,
        output_tokens: 4, reasoning_output_tokens: 1
      } }));
      if (outcome === 'hang') { setInterval(() => {}, 1000); return; }
      console.log(JSON.stringify(outcome === 'success'
        ? { type: 'item.completed', item: { type: 'agent_message', text: '{"approved":true}' } }
        : { type: 'turn.failed', error: { message: 'HTTP ' + outcome + ' private-account@example.test secret-token' } }));
    });
  `);
  const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let usageEvents = 0;
  const client = new CodexCliLlmClient({ env: {}, spawnFn: (args, stdin, env, cwd) => {
    const child = spawn(process.execPath, [script, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('turn.completed')) usageEvents++; });
    child.stdin.end(stdin);
    return child;
  } });
  const calls = () => JSON.parse(readFileSync(counter, 'utf8')) as { model: string; input: string }[];
  const waiting = async (retry: number) => {
    await vi.waitFor(() => expect(log.mock.calls.some(([line]) => String(line).includes(`retry ${retry}/`))).toBe(true), { timeout: 5000 });
  };
  return { client, calls, waiting, log, usageEvents: () => usageEvents };
}

describe('Codex text throttle recovery across real subprocesses', () => {
  it('recovers beyond the former single retry on the same model and retains every token', async () => {
    const f = fixture([429, 429, 'success']);
    const result = f.client.complete(request);
    await f.waiting(1);
    await vi.advanceTimersByTimeAsync(9000);
    expect(f.calls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await f.waiting(2);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(result).resolves.toMatchObject({
      text: '{"approved":true}', servedModel: 'gpt-5.6-luna',
      usage: { inputTokens: 45, outputTokens: 15, cacheReadInputTokens: 9, cacheCreationInputTokens: 6 },
    });
    expect(f.calls()).toEqual(Array.from({ length: 3 }, () => ({ model: request.model, input: request.userContent })));
    expect(f.log.mock.calls.map(([line]) => String(line)).join('')).not.toMatch(/secret-token|private-account/);
  });

  it('stops after four progressively spaced retries and reports honest partial usage', async () => {
    const f = fixture([429, 429, 429, 429, 429]);
    const failed = f.client.complete(request).catch((error: unknown) => error);
    for (const [i, delay] of [10_000, 20_000, 40_000, 80_000].entries()) {
      await f.waiting(i + 1);
      await vi.advanceTimersByTimeAsync(delay);
    }
    const error: unknown = await failed;
    expect(error).toMatchObject({
      code: 'rate-limited', retryCount: 4, retried: true,
      message: 'codex call failed [rate-limited] after 4 retries',
      partialUsage: { inputTokens: 75, outputTokens: 25, cacheReadInputTokens: 15, cacheCreationInputTokens: 10 },
    });
    expect(String(error)).not.toMatch(/secret-token|private-account/);
    expect(f.calls()).toHaveLength(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the wait immediately without another subprocess and retains paid usage', async () => {
    const f = fixture([429, 'success']);
    const abort = new AbortController();
    const reason = new Error('run deadline');
    const failed = f.client.complete({ ...request, signal: abort.signal }).catch((error: unknown) => error);
    await f.waiting(1);
    abort.abort(reason);
    expect(await failed).toMatchObject({ message: 'run deadline', partialUsage: { inputTokens: 15, outputTokens: 5 } });
    expect(reason).not.toHaveProperty('partialUsage');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(f.calls()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops immediately when a retry returns an authentication error', async () => {
    const f = fixture([429, 401, 'success']);
    const failed = f.client.complete(request).catch((error: unknown) => error);
    await f.waiting(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await failed).toMatchObject({
      code: 'authentication-required', retryCount: 1,
      partialUsage: { inputTokens: 30, outputTokens: 10 },
    });
    expect(f.calls()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adds an interrupted retry’s usage to earlier attempts after reaping its real child', async () => {
    const f = fixture([429, 'hang']);
    const abort = new AbortController();
    const failed = f.client.complete({ ...request, signal: abort.signal }).catch((error: unknown) => error);
    await f.waiting(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(f.usageEvents()).toBe(2), { timeout: 5000 });
    abort.abort(new Error('run cancelled'));
    expect(await failed).toMatchObject({
      message: 'run cancelled',
      partialUsage: { inputTokens: 30, outputTokens: 10, cacheReadInputTokens: 6, cacheCreationInputTokens: 4 },
    });
    expect(f.calls()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
