import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runTraceFile } from '../src/mcp/readers.js';
import { wallClockAttribution } from '../src/mcp/traceTiming.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const T0 = Date.parse('2026-10-29T10:00:00Z');
const at = (s: number) => T0 + s * 1000;

it('splits a run into startup, spent time per tier and role, tool work, idle gaps and finalisation', () => {
  const events = [
    { id: 'plan', kind: 'llm', ts: at(400), durationMs: 200_000, role: 'plan', actor: { tier: 3 } },
    { id: 'review', kind: 'llm', ts: at(430), durationMs: 30_000, role: 'validate-plan', actor: { tier: 3 } },
    // 170 s with nothing in flight
    { id: 'exec', kind: 'llm', ts: at(700), durationMs: 100_000, role: 'execute', actor: { tier: 1 } },
    { id: 'tool', kind: 'tool', ts: at(690), durationMs: 50_000 },
  ];
  const timing = wallClockAttribution('2026-10-29T10:00:00Z', '2026-10-29T10:12:00Z', events);
  expect(timing).toMatchObject({
    wallMs: 720_000,
    preFirstEventMs: 200_000,
    firstToolStartMs: 640_000,
    llmMsByTierRole: {
      'L3:plan': { calls: 1, ms: 200_000 },
      'L3:validate-plan': { calls: 1, ms: 30_000 },
      'L1:execute': { calls: 1, ms: 100_000 },
    },
    toolMs: { calls: 1, ms: 50_000 },
    idleGaps: [{ afterEventId: 'review', ms: 170_000 }],
    idleMs: 170_000,
    afterLastEventMs: 20_000,
  });
});

it('reports overlapping lanes as spent time without inventing idle, and unknown bounds as null', () => {
  const timing = wallClockAttribution(undefined, undefined, [
    { id: 'a', kind: 'llm', ts: at(100), durationMs: 100_000, role: 'execute', actor: { tier: 1 } },
    { id: 'b', kind: 'llm', ts: at(150), durationMs: 120_000, role: 'execute', actor: { tier: 1 } },
    { id: 'c', kind: 'llm', ts: 'bad', durationMs: 1 },
  ]);
  expect(timing).toMatchObject({
    wallMs: null, preFirstEventMs: null, firstToolStartMs: null, afterLastEventMs: null,
    llmMsByTierRole: { 'L1:execute': { calls: 2, ms: 220_000 } }, idleGaps: [], idleMs: 0,
  });
});

it('carries the attribution on the MCP trace summary over every event, not only the page', () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-trace-timing-'));
  roots.push(root);
  const path = join(root, 'trace.json');
  writeFileSync(path, JSON.stringify({
    id: 'r', startedAt: '2026-10-29T10:00:00Z', endedAt: '2026-10-29T10:05:00Z',
    events: [
      { id: 'p', kind: 'llm', ts: at(60), durationMs: 30_000, role: 'plan', actor: { tier: 3 } },
      { id: 't', kind: 'tool', ts: at(120), durationMs: 10_000, name: 'read_file' },
    ],
  }));
  expect(runTraceFile(path, { offset: 1, limit: 1 })).toMatchObject({
    events: [{ id: 't' }],
    wallClock: { wallMs: 300_000, preFirstEventMs: 30_000, firstToolStartMs: 110_000, toolMs: { calls: 1 } },
  });
});
