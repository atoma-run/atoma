import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { abortedForLanding, FINALIZATION_GRACE_MS } from '../src/atoms/cost.js';
import { dispatchWithAggregation, synthesizeOrKeep } from '../src/atoms/dispatch.js';
import { AuthStore } from '../src/auth/store.js';
import { DEFAULT_HARD_KILL_MARGIN_MS } from '../src/cli/burnin.js';
import {
  assertPlatformSettingValue,
  ceilingConflicts,
  DEFAULT_PLATFORM_LIMITS,
  narrowedRunTimeoutCeilingMs,
  PLATFORM_SETTINGS,
  PlatformSettingError,
  resolvePlatformLimits,
} from '../src/contracts/platformSettings.js';
import { BudgetGateLlmClient, RunBudgetExceededError, RunBudgetMeter } from '../src/core/runBudget.js';
import { closeStoreHandles } from '../src/core/stores.js';
import type { LlmCallMetrics, MetricsRecorder } from '../src/core/metrics.js';
import type { LlmClient, Plan, Result, RunContext } from '../src/core/types.js';
import { acquireRunLease } from '../src/mcp/runLock.js';
import { PlatformSettingsStore } from '../src/platform/settings.js';
import { ProjectRunConfigurationError, ProjectRunCoordinator } from '../src/projects/coordinator.js';
import { ProjectStore } from '../src/projects/store.js';
import { makeCtx } from './helpers.js';

/**
 * THE 2026-09-30 ADVERSARIAL REVIEW OF THE PORTED RUN LIMITS, one regression
 * per finding that the other suites do not already cross (the runner's three
 * are in `runner-handle.test.ts`, the no-row call timeouts in
 * `platform-settings.test.ts`).
 */

const roots: string[] = [];
afterEach(() => {
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `atoma-limits-review-${label}-`));
  roots.push(root);
  return root;
}

const budgetError = () => new RunBudgetExceededError('tokens', 1_200, 1_000);

function ctxAbortedBy(reason: Error): RunContext {
  const controller = new AbortController();
  controller.abort(reason);
  return { ...makeCtx(), signal: controller.signal, deadlineAt: Date.now() + 30 * 60_000 };
}

function result(summary: string): Result {
  return { output: summary, summary, trace: [], producedBy: { tier: 1, name: 'Methane', viaFallback: false } };
}

function plan(descriptions: string[]): Plan {
  return {
    reasoning: 'r',
    subtasks: descriptions.map((description) => ({ description })),
    aggregation: { mode: 'sequential' },
    expectedOutput: 'anything',
  };
}

describe('a platform ceiling lands the run instead of discarding it (owner decision 2026-09-30)', () => {
  it('is a landing reason like the deadline, and only beside a run deadline', () => {
    expect(abortedForLanding(ctxAbortedBy(budgetError()))).toBe(true);
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(abortedForLanding(ctxAbortedBy(timeout))).toBe(true);
    // A cancellation is not a landing, and neither is a ceiling without a run deadline.
    expect(abortedForLanding(ctxAbortedBy(new Error('cancelled')))).toBe(false);
    const { deadlineAt: _dropped, ...library } = ctxAbortedBy(budgetError());
    expect(abortedForLanding(library)).toBe(false);
  });

  it('keeps the phases a ceiling cut short, so the next run continues from them', async () => {
    const ctx = ctxAbortedBy(budgetError());
    const subtasks = ['implement', 're-audit', 'README', 'package'];
    const outcome = await dispatchWithAggregation(plan(subtasks).subtasks, plan(subtasks), ctx, async (_subtask, idx) => {
      if (idx === 2) throw budgetError();
      return result(`phase ${idx + 1}`);
    });
    expect(outcome.results).toHaveLength(2);
    expect(outcome.unfinished.map((subtask) => subtask.description)).toEqual(['README', 'package']);
  });

  it('keeps the sub-results rather than paying for a synthesis once the gate refuses', async () => {
    const ctx = ctxAbortedBy(budgetError());
    const kept = await synthesizeOrKeep(ctx, true, () => Promise.reject(budgetError()));
    expect(kept).toMatchObject({ keptBecause: expect.stringContaining('run token ceiling exceeded') });
  });

  it('refuses every call after the ceiling fired, without reaching the transport', async () => {
    const records: LlmCallMetrics[] = [];
    const recorder: MetricsRecorder = { record: (call) => { records.push(call); } };
    let fired = 0;
    const meter = new RunBudgetMeter(recorder, { tokens: 1_000, costUsd: null }, () => { fired += 1; });
    let reached = 0;
    const inner: LlmClient = { complete: async () => { reached += 1; return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } } as never; } };
    const gated = new BudgetGateLlmClient(inner, meter);
    await gated.complete({ model: 'm', messages: [] } as never);
    expect(reached).toBe(1);
    meter.record({ model: 'claude-haiku-4-5', inputTokens: 900, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } as LlmCallMetrics);
    expect(fired).toBe(1);
    await expect(gated.complete({ model: 'm', messages: [] } as never)).rejects.toBeInstanceOf(RunBudgetExceededError);
    expect(reached).toBe(1);
    // Once: a later call over the line fires nothing new.
    meter.record({ model: 'claude-haiku-4-5', inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } as LlmCallMetrics);
    expect(fired).toBe(1);
    expect(records).toHaveLength(2);
  });
});

describe('the catalog bounds the deadlines it does not own', () => {
  it('keeps the watchdog grace above the finalization window and below the harness hard-kill', () => {
    const spec = PLATFORM_SETTINGS['run.watchdogGraceMs'];
    // A grace inside the 45s landing window would kill a run while it lands.
    expect(spec.min).toBeGreaterThanOrEqual(FINALIZATION_GRACE_MS + 15_000);
    // A grace past the hard-kill margin would never close the trace.
    expect(spec.max).toBeLessThan(DEFAULT_HARD_KILL_MARGIN_MS);
    expect(() => assertPlatformSettingValue('run.watchdogGraceMs', 5_000)).toThrow(PlatformSettingError);
    expect(() => assertPlatformSettingValue('run.watchdogGraceMs', 900_000)).toThrow(PlatformSettingError);
  });

  it('takes 0 as "no ceiling" for a call timeout, and no stated ceiling below 30s', () => {
    expect(assertPlatformSettingValue('llm.callTimeoutMs', 0)).toBe(0);
    expect(() => assertPlatformSettingValue('llm.callTimeoutMs', 10_000)).toThrow(PlatformSettingError);
  });

  it('binds a runner-level launch only to a NARROWED wall-clock ceiling', () => {
    expect(narrowedRunTimeoutCeilingMs(DEFAULT_PLATFORM_LIMITS)).toBeNull();
    expect(narrowedRunTimeoutCeilingMs(resolvePlatformLimits({ 'run.timeoutMaxMs': 1_800_000 }))).toBe(1_800_000);
  });
});

describe('a ceiling below an exported request', () => {
  it('is named as a conflict, and a disabled or absent ceiling is none', () => {
    const limits = resolvePlatformLimits({ 'run.timeoutMaxMs': 3_600_000, 'llm.callTimeoutMs': 60_000 });
    expect(ceilingConflicts(limits, { ATOMA_PROJECT_TIMEOUT_MS: '5400000', ATOMA_CLI_CALL_TIMEOUT_MS: '900000' })).toEqual([
      expect.stringContaining('ATOMA_PROJECT_TIMEOUT_MS=5400000 is exported and exceeds run.timeoutMaxMs=3600000'),
      expect.stringContaining('ATOMA_CLI_CALL_TIMEOUT_MS=900000 is exported and exceeds llm.callTimeoutMs=60000'),
    ]);
    expect(ceilingConflicts(limits, { ATOMA_PROJECT_TIMEOUT_MS: '3600000' })).toEqual([]);
    expect(ceilingConflicts(DEFAULT_PLATFORM_LIMITS, { ATOMA_CLI_CALL_TIMEOUT_MS: '900000' })).toEqual([]);
  });

  it('is judged on the proposed rows before anything is written', () => {
    const store = PlatformSettingsStore.open(join(tempRoot('proposed'), 'atoma.db'));
    store.set({ 'run.timeoutMaxMs': 3_600_000 }, null);
    const proposed = store.proposed({ 'llm.callTimeoutMs': 60_000 }, ['run.timeoutMaxMs']);
    expect(proposed.stated).toEqual({ 'llm.callTimeoutMs': 60_000 });
    expect(proposed.limits['run.timeoutMaxMs']).toBe(PLATFORM_SETTINGS['run.timeoutMaxMs'].fallback);
    expect(store.overrides()).toEqual({ 'run.timeoutMaxMs': 3_600_000 });
  });

  it('never keeps the server from booting: the run is refused alone, before it is reserved', async () => {
    const root = tempRoot('coordinator');
    const dbPath = join(root, 'store.db');
    const auth = AuthStore.open(dbPath);
    const login = auth.completeLogin({ provider: 'github', subject: 'owner', displayName: 'Owner', email: null, emailVerified: false }, null)!;
    const store = ProjectStore.open(dbPath);
    const project = store.createProject({
      orgId: login.viewer.orgId, principalId: login.viewer.principalId,
      project: { name: 'Board', slug: 'board', repositoryTarget: { installationId: '123', owner: 'owner', name: 'board', visibility: 'private' } },
    });
    // What production had: the host exports 90 minutes, an admin saved a one-hour ceiling.
    const saved = resolvePlatformLimits({ 'run.timeoutMaxMs': 3_600_000 });
    let launches = 0;
    const construct = () => new ProjectRunCoordinator({
      store, dbPath, projectsRoot: root,
      hostEnv: { ATOMA_PROJECT_TIMEOUT_MS: '5400000' },
      acquireLease: (id) => acquireRunLease(id, join(root, 'lease.db')),
      driver: () => { launches += 1; return Promise.resolve('--- run failed ---\n'); },
      platformLimits: () => saved,
    });
    expect(construct).not.toThrow();
    const coordinator = construct();
    await expect(coordinator.start({
      orgId: login.viewer.orgId, principalId: login.viewer.principalId, projectId: project.projectId,
      request: { goal: 'Build a board.', idempotencyKey: 'k' },
    })).rejects.toBeInstanceOf(ProjectRunConfigurationError);
    expect(store.listProjectRuns(login.viewer.orgId, project.projectId)).toEqual([]);
    expect(launches).toBe(0);
    // The MCP task TTL still reads a number.
    expect(Number.isFinite(coordinator.runTaskBudgetMs())).toBe(true);
  });
});
