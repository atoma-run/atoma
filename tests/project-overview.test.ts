import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCostBreakdown } from '../src/contracts/runCostBreakdown.js';
import { summarizeTraceFile, summarizeTraceFileWithCost } from '../src/viz/runIndex.js';
import { projectOverview } from '../src/viz/client-gl/project-overview.js';
import { wedgeContains } from '../src/viz/client-gl/renderer/tooltip.js';
import { modelShade } from '../src/viz/client-gl/renderer/views/project-overview.js';
import type { VizProjectRun } from '../src/viz/client/types.js';

const usage = (inputTokens: number, outputTokens: number) =>
  ({ inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });

function trace(events: unknown[], tierModels: Record<string, string> | undefined = {
  l1: 'api:anthropic:claude-haiku-5', l2: 'api:anthropic:claude-sonnet-5', l3: 'api:anthropic:claude-opus-5',
}) {
  return { id: 'run-1', label: 'run', startedAt: '2026-10-10T00:00:00.000Z', ...(tierModels ? { tierModels } : {}), events };
}

describe('runCostBreakdown', () => {
  it('attributes each call to the pin that served it, and Jev on its own', () => {
    const breakdown = runCostBreakdown(trace([
      { kind: 'llm', role: 'execute', model: 'claude-haiku-5', actor: { name: 'm', tier: 1 }, usage: usage(100, 10), costUsd: 0.01 },
      // run-root speaks for L3 but ran on the L2 pin: the bill is L2's.
      { kind: 'llm', role: 'validate-result', model: 'claude-sonnet-5', actor: { name: 'run-root', tier: 3 }, usage: usage(200, 20), costUsd: 0.2 },
      { kind: 'llm', role: 'plan', model: 'api:anthropic:claude-opus-5', actor: { name: 't', tier: 3 }, usage: usage(300, 30), costUsd: 1 },
      { kind: 'llm-start', role: 'plan', model: 'claude-opus-5' },
      { kind: 'jev', role: 'prefilter', evaluator: 'jev-1', usage: { inputTokens: 5, outputTokens: 1 }, costUsd: 0.001, requestCount: 2 },
      { kind: 'jev', role: 'validate-plan', evaluator: 'jev-1', usage: { inputTokens: 5, outputTokens: 1 }, costUsd: 0.002, requestCount: 1 },
    ]));
    expect(breakdown.l1).toMatchObject({ calls: 1, costUsd: 0.01, inputTokens: 100, outputTokens: 10 });
    expect(breakdown.l2).toMatchObject({ calls: 1, costUsd: 0.2, roles: [{ role: 'validate-result', calls: 1, costUsd: 0.2 }] });
    expect(breakdown.l3).toMatchObject({ calls: 1, costUsd: 1 });
    expect(breakdown.jev).toMatchObject({ calls: 2, requests: 3, models: [{ model: 'jev-1', calls: 2 }] });
    expect(breakdown.jev.costUsd).toBeCloseTo(0.003);
    expect(breakdown.other.calls).toBe(0);
  });

  it('breaks a shared pin by the caller rank and falls back to it for unknown models', () => {
    const breakdown = runCostBreakdown(trace([
      { kind: 'llm', role: 'execute', model: 'm', actor: { tier: 1 }, usage: usage(1, 1), costUsd: 1 },
      { kind: 'llm', role: 'plan', model: 'm', actor: { tier: 2 }, usage: usage(1, 1), costUsd: 2 },
      // run-root on a shared pin: its own rank (3) is not one of the sharing tiers, so the lowest wins.
      { kind: 'llm', role: 'validate-result', model: 'm', actor: { name: 'run-root', tier: 3 }, usage: usage(1, 1), costUsd: 4 },
      { kind: 'llm', role: 'execute', model: 'fallback-model', actor: { tier: 3 }, usage: usage(1, 1), costUsd: 8 },
      { kind: 'llm', role: 'unknown', model: 'mystery', usage: usage(1, 1), costUsd: 16 },
    ], { l1: 'api:openai:m', l2: 'api:openai:m', l3: 'api:openai:big' }));
    expect(breakdown.l1.costUsd).toBe(5);
    expect(breakdown.l2.costUsd).toBe(2);
    expect(breakdown.l3.costUsd).toBe(8);
    expect(breakdown.other.costUsd).toBe(16);
  });

  it('is computed from the same bounded read as the run row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-cost-'));
    const file = join(dir, 'run.json');
    writeFileSync(file, JSON.stringify({ ...trace([
      { kind: 'llm', role: 'execute', model: 'claude-haiku-5', actor: { tier: 1 }, usage: usage(1, 1), costUsd: 0.5 },
    ]), totals: { calls: 1, costUsd: 0.5, inputTokens: 1, outputTokens: 1 } }));
    const summary = summarizeTraceFileWithCost(file);
    expect(summary?.entry).toEqual(summarizeTraceFile(file));
    expect(summary?.costBreakdown.l1.costUsd).toBe(0.5);
    expect(summarizeTraceFileWithCost(join(dir, 'missing.json'))).toBeNull();
  });
});

function run(overrides: Partial<VizProjectRun>): VizProjectRun {
  return {
    projectRunId: 'r', projectId: 'p', goal: 'g', status: 'delivered', traceId: 't', costUsd: 1, durationS: 60,
    error: null, createdAt: '2026-10-01T00:00:00.000Z', endedAt: null, publication: null, ...overrides,
  };
}

describe('projectOverview', () => {
  it('aggregates runs, launchers and the breakdown, and says what the pie covers', () => {
    const breakdown = runCostBreakdown(trace([
      { kind: 'llm', role: 'execute', model: 'claude-haiku-5', actor: { tier: 1 }, usage: usage(10, 1), costUsd: 1 },
      { kind: 'llm', role: 'plan', model: 'claude-opus-5', actor: { tier: 3 }, usage: usage(10, 1), costUsd: 3 },
      { kind: 'jev', role: 'prefilter', evaluator: 'jev', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, requestCount: 1 },
    ]));
    const models = {
      l1: { selection: 'sub:anthropic:haiku', provider: 'claude-cli', payer: 'host-subscription', source: 'account' },
      l2: { selection: 'api:anthropic:claude-sonnet-5', provider: 'anthropic-api', payer: 'org-key', source: 'org' },
      l3: { selection: 'api:anthropic:claude-opus-5', provider: 'anthropic-api', payer: 'org-key', source: 'org' },
    };
    const overview = projectOverview([
      run({ projectRunId: 'a', requestedByPrincipalId: 'u1', requestedByName: 'Ada', costBreakdown: breakdown, models,
        createdAt: '2026-10-03T00:00:00.000Z', costUsd: 4, durationS: 30, tokens: 22, llmCalls: 2, jevCalls: 1 }),
      run({ projectRunId: 'b', requestedByPrincipalId: 'u1', requestedByName: 'Ada', costBreakdown: breakdown, status: 'failed',
        createdAt: '2026-10-02T00:00:00.000Z', costUsd: 4, durationS: 90 }),
      run({ projectRunId: 'c', requestedByPrincipalId: 'u2', requestedByName: null, costBreakdown: null, status: 'partial',
        rerunOf: 'a', costUsd: null, durationS: null, jevCallsLowerBound: true }),
    ], 'Unknown');
    expect(overview.runCount).toBe(3);
    expect(overview.statusCounts).toMatchObject({ delivered: 1, failed: 1, partial: 1 });
    expect(overview.reruns).toBe(1);
    expect(overview.firstRunAt).toBe('2026-10-01T00:00:00.000Z');
    expect(overview.lastRunAt).toBe('2026-10-03T00:00:00.000Z');
    expect(overview.totalDurationS).toBe(120);
    expect(overview.medianDurationS).toBe(60);
    expect(overview.llmCostUsd).toBe(8);
    expect(overview.jevCallsLowerBound).toBe(true);
    expect(overview.requesters.map(r => [r.name, r.runs, r.costUsd])).toEqual([['Ada', 2, 8], ['Unknown', 1, 0]]);
    expect(overview.breakdownRuns).toBe(2);
    expect(overview.breakdownTotalUsd).toBe(8);
    // Jev made a call at no cost: it is listed, with no share of the pie.
    expect(overview.slices.map(s => [s.key, s.costUsd, s.share])).toEqual([['l1', 2, 0.25], ['l3', 6, 0.75], ['jev', 0, 0]]);
    expect(overview.slices[0]!.payers).toEqual([{ payer: 'host-subscription', runs: 1 }]);
    expect(overview.slices[0]!.pins).toEqual([{ selection: 'sub:anthropic:haiku', runs: 1 }]);
    expect(overview.subscriptionPriced).toBe(true);
  });

  it('keeps every model a tier was pinned to, in order of first use', () => {
    const on = (model: string, costUsd: number) => runCostBreakdown(trace([
      { kind: 'llm', role: 'execute', model, actor: { tier: 1 }, usage: usage(1, 1), costUsd },
    ], { l1: `api:openai:${model}`, l2: 'api:openai:mid', l3: 'api:openai:big' }));
    // Newest first, as the API lists them: haiku served L1 first, luna after the re-pin.
    const overview = projectOverview([
      run({ projectRunId: 'c', createdAt: '2026-10-03T00:00:00.000Z', costBreakdown: on('luna', 3) }),
      run({ projectRunId: 'b', createdAt: '2026-10-02T00:00:00.000Z', costBreakdown: on('luna', 3) }),
      run({ projectRunId: 'a', createdAt: '2026-10-01T00:00:00.000Z', costBreakdown: on('haiku', 1) }),
    ], 'Unknown');
    const l1 = overview.slices.find(slice => slice.key === 'l1')!;
    expect(l1.costUsd).toBe(7);
    expect(l1.models.map(model => model.model)).toEqual(['luna', 'haiku']);
    expect(l1.modelsByFirstUse.map(model => [model.model, model.runs, model.firstRunAt])).toEqual([
      ['haiku', 1, '2026-10-01T00:00:00.000Z'], ['luna', 2, '2026-10-02T00:00:00.000Z'],
    ]);
  });

  it('is empty, not wrong, for a project with no run', () => {
    const overview = projectOverview([], 'Unknown');
    expect(overview).toMatchObject({ runCount: 0, llmCostUsd: null, medianDurationS: null, slices: [], breakdownTotalUsd: 0 });
  });
});

describe('wedgeContains', () => {
  const quarter = { cx: 0, cy: 0, inner: 5, outer: 10, start: -Math.PI / 2, end: 0 };
  it('answers inside the ring and the angle span only', () => {
    expect(wedgeContains(quarter, 5, -5)).toBe(true);
    expect(wedgeContains(quarter, 1, -1)).toBe(false);
    expect(wedgeContains(quarter, 20, -20)).toBe(false);
    expect(wedgeContains(quarter, -5, 5)).toBe(false);
    expect(wedgeContains({ ...quarter, start: Math.PI, end: Math.PI * 2.5 }, 0, 7)).toBe(true);
  });
});

describe('modelShade', () => {
  it('starts on the tier colour and steps through distinct shades of it', () => {
    const base = 0x2dd4bf;
    expect(modelShade(base, 0)).toBe(base);
    const shades = Array.from({ length: 6 }, (_, index) => modelShade(base, index));
    expect(new Set(shades).size).toBe(6);
    // A darker step keeps the hue: every channel scales toward black together.
    const darker = modelShade(base, 1);
    expect(darker >> 16).toBeLessThan(base >> 16);
    expect((darker >> 8) & 0xff).toBeLessThan((base >> 8) & 0xff);
  });
});
