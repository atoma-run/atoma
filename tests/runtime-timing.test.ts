import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { timingUnionMs } from '../src/contracts/runtimeTiming.js';
import { timed, timingSidecar } from '../src/core/runtimeTiming.js';
import { TraceRecorder } from '../src/viz/trace.js';
import { RecordingLlmClient } from '../src/viz/recordingLlm.js';
import { readLatency } from '../src/cli/latency.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { makeCtx } from './helpers.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('unions overlapping tools and calls instead of summing parallel envelopes', () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-latency-')); roots.push(root);
  const path = join(root, 'trace.json');
  writeFileSync(path, JSON.stringify({ events: [
    { kind: 'llm', ts: 0, durationMs: 100, timings: [{ phase: 'profile-wait', startedAt: 0, durationMs: 10 }] },
    { kind: 'llm', ts: 50, durationMs: 100 },
    { kind: 'tool', ts: 20, durationMs: 30 },
    { kind: 'tool', ts: 40, durationMs: 30 },
  ] }));
  expect(readLatency(path)).toMatchObject({ llmEnvelopeUnionMs: 150, toolUnionMs: 50, llmEnvelopeOutsideToolsMs: 100,
    phases: { 'profile-wait': { recorded: true, unionMs: 10 }, 'first-token': { recorded: false, unionMs: null } } });
  expect(timingUnionMs([{ startedAt: 0, durationMs: 50 }, { startedAt: 10, durationMs: 5 }])).toBe(50);
});

it.each([false, true])('persists transport observations with failures and preserves the caller (failed=%s)', async failed => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-timing-record-')); roots.push(root);
  const recorder = new TraceRecorder(root);
  recorder.beginRun({ description: 'Timing fixture' });
  const observer = vi.fn(() => { throw new Error('observer failure'); });
  const client = new RecordingLlmClient({ complete: async req => {
    req.onTiming?.({ phase: 'profile-wait', startedAt: 1, durationMs: 2 });
    if (failed) throw new Error('provider failure');
    return { text: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
  } }, recorder);
  const request = { model: 'fixture', systemPrompt: 's', userContent: 'u', onTiming: observer };
  if (failed) await expect(client.complete(request)).rejects.toThrow('provider failure');
  else expect((await client.complete(request)).text).toBe('done');
  const event = recorder.currentRun!.events.find(event => event.kind === 'llm');
  expect(event).toMatchObject({ timings: [{ phase: 'profile-wait', startedAt: 1, durationMs: 2 }] });
  expect(observer).toHaveBeenCalledOnce();
  recorder.endRun();
});

it('keeps timing observation independent of success and forwards it through branches', async () => {
  const observation = vi.fn(() => { throw new Error('recorder'); });
  expect(forkBranch({ ...makeCtx(), recordTiming: observation }, 'child').recordTiming).toBe(observation);
  await expect(timed(observation, 'parent-tests', async () => { throw new Error('actual assertion failure'); }))
    .rejects.toThrow('actual assertion failure');
  expect(observation).toHaveBeenCalledWith(expect.objectContaining({ phase: 'parent-tests' }));
});

it('reads late handoff observations without modifying the completed trace and reports corrupt receipts', () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-late-timing-')); roots.push(root);
  const path = join(root, 'trace.json');
  const bytes = JSON.stringify({ events: [] });
  writeFileSync(path, bytes);
  timingSidecar(path)({ phase: 'handoff', startedAt: 10, durationMs: 30 });
  expect(readLatency(path).phases['handoff']).toMatchObject({ recorded: true, unionMs: 30 });
  writeFileSync(path + '.timings.jsonl', '{truncated\n');
  expect(readLatency(path)).toMatchObject({ omittedTimings: 1, phases: { handoff: { recorded: false } } });
});
