import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { withProbeExecutionHistory } from '../src/atoms/probeExecutionHistory.js';
import { recordProbeTool } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';

it('L1 receives the real mutant assertion after restoration across serialized worker replies, without another pair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'probe-history-'));
  try {
    const tool = recordProbeTool({ sandbox: new ToolSandbox(root) });
    const cmd = 'node check.cjs';
    writeFileSync(join(root, 'check.cjs'), "require('node:assert/strict').equal(require('./built.cjs').value, 1, 'temporal boundary');");
    let calls = 0;
    const ctx = { ...makeCtx(), tools: {
      has: (name: string) => name === 'record_probe',
      execute: async (_name: string, args: Record<string, unknown>) => {
        calls++;
        // The executor boundary must not require shared worker objects/state.
        return JSON.parse(JSON.stringify(await tool.execute(JSON.parse(JSON.stringify(args)) as Record<string, unknown>))) as unknown;
      },
    } };
    ctx.llm.enqueue(async request => {
      writeFileSync(join(root, 'built.cjs'), 'exports.value = 2;');
      expect(await request.executor!.execute('record_probe', { cmd })).toMatchObject({ exitCode: 1 });
      writeFileSync(join(root, 'built.cjs'), 'exports.value = 1;');
      const restored = await request.executor!.execute('record_probe', { cmd, note: 'restored' });
      expect(restored).toMatchObject({ exitCode: 0, executionHistory: {
        previousObservedResults: [expect.objectContaining({ exitCode: 1, stderr: expect.stringContaining('temporal boundary') })],
      } });
      return { text: jsonText({ output: restored, summary: 'Mutant assertion failed; restored code passed.' }), stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    await new L1Atom({ name: 'Water', ordinal: 1, systemPrompt: 'verify', tools: [tool.declaration], params: {} })
      .execute({ description: 'Prove mutant failure and restored success.' }, makePlan(), ctx);
    expect(calls).toBe(2);
    const manifest = JSON.parse(readFileSync(join(root, '.atoma-probes.json'), 'utf8')) as { entries: unknown[] };
    expect(manifest.entries).toEqual([expect.objectContaining({ cmd, exitCode: 0, replacementHistory: [{ cmd, exitCode: 1 }] })]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('never skips a requested invocation or masks latest failure; isolates attempts and marks excerpts', async () => {
  let calls = 0;
  const base = { has: () => true, execute: async () => ({ recorded: true, exitCode: calls++ === 0 ? 0 : 1, stdout: 'x'.repeat(3000) }) };
  const executor = withProbeExecutionHistory(base);
  await executor.execute('record_probe', { cmd: 'check' });
  expect(await executor.execute('record_probe', { cmd: 'check' })).toMatchObject({ exitCode: 1,
    executionHistory: { previousObservedResults: [{ exitCode: 0, stdout: 'x'.repeat(2000), stdoutTruncated: true }] },
  });
  expect(await executor.execute('record_probe', { cmd: 'different-check' })).not.toHaveProperty('executionHistory');
  expect(await withProbeExecutionHistory(base).execute('record_probe', { cmd: 'check' })).not.toHaveProperty('executionHistory');
  expect(calls).toBe(4);
});

it('does not turn unrecorded or unknown outcomes into historical proof', async () => {
  const results = [{ recorded: false, exitCode: 1 }, { recorded: true }, { recorded: true, exitCode: 0 }];
  const executor = withProbeExecutionHistory({ has: () => true, execute: async () => results.shift() });
  for (let i = 0; i < 3; i++) expect(await executor.execute('record_probe', { cmd: 'check' })).not.toHaveProperty('executionHistory');
});
