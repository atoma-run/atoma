import { mockOtherProofReview } from './helpers/delegationReview.js';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTierClients } from '../src/run/providers.js';
import { startTask, resetHostLifecycleSnapshotForTests } from '../src/run/runner.js';
import { SKILL_PREFILTER_SYSTEM_PROMPT } from '../src/atoms/cost.js';
import { closeStoreHandles } from '../src/core/stores.js';
import type { LlmCompletionRequest } from '../src/core/types.js';
import type { VizRun } from '../src/viz/trace.js';
import { parentTestSuiteDigest, type ParentTestSuite } from '../src/contracts/parentTests.js';
import { parseRunStatsEpilogue } from '../src/contracts/runStats.js';
import { readSuiteDisputeEntries } from '../src/contracts/suiteDisputeRecord.js';
import { makePlan } from './helpers/factories.js';
import { OLLAMA_PINS } from './tier-pins.js';

vi.mock('../src/run/providers.js', async (original) => ({
  ...await original<typeof import('../src/run/providers.js')>(), buildTierClients: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetHostLifecycleSnapshotForTests();
});

/**
 * The record of a suite dispute at the runner boundary (2026-10-17): the real
 * fixed Vitest runner on the real workspace, a molecule that rewrites a data
 * file on every attempt (a new subject digest each time) under a suite that
 * fails the same way until the branch retry writes the file it asserts. The
 * trace under runs/ must hold the counted entry and the later passing
 * verification, and the epilogue's count must equal the counted entries.
 */
describe('a suite dispute through the runner', () => {
  it('reaches the trace under runs/ and matches the epilogue count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-suite-dispute-runner-'));
    const runs = join(root, 'runs');
    for (const [key, value] of Object.entries({ ...OLLAMA_PINS,
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'), ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: runs,
      ATOMA_BUILD_WORKSPACE: join(root, 'workspace'), ATOMA_BUILD_TIMEOUT_MS: '180000',
      ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0', ATOMA_PREFILTER_CACHE: '0',
      ATOMA_SKILL_LEARN: '0', ATOMA_SKILL_PROMOTE: '0', ATOMA_DEFER_LEARNING: '1',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    const printed: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { printed.push(parts.map(String).join(' ')); });
    }
    const suite: ParentTestSuite = {
      requirement: 'the flag file exists',
      cwd: '.',
      source: "import { test, expect } from 'vitest';\nimport { existsSync } from 'node:fs';\ntest('flag', () => {\n  expect(existsSync('flag.txt')).toBe(true);\n});",
    };
    const calls: LlmCompletionRequest[] = [];
    let executions = 0;
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async (req) => {
      calls.push(req);
      let reply: unknown;
      if (req.role === 'prefilter' && req.systemPrompt === SKILL_PREFILTER_SYSTEM_PROMPT) reply = { kind: 'none', reasoning: 'No recipe' };
      else if (req.role === 'prefilter') reply = { kind: 'escalate', reasoning: 'Plan it' };
      else if (req.role === 'validate-plan') reply = { approved: true, reasoning: 'Plan approved', ...mockOtherProofReview(req) };
      else if (req.role === 'validate-result') reply = { approved: true, reasoning: 'Phase approved' };
      else if (req.role === 'plan' && req.actor?.tier === 3) reply = [
        { strategy: 'create', description: 'data builder', reasoning: 'One phase' },
        makePlan({ subtasks: [{ description: 'Write data.json', outputs: ['data.json'] }], aggregation: { mode: 'sequential' } }),
      ];
      else if (req.role === 'plan' && req.actor?.tier === 2) reply = [
        { strategy: 'create', description: 'data writer', reasoning: 'One file' },
        makePlan({ subtasks: [{ description: 'Write data.json', outputs: ['data.json'], acceptanceTests: suite }] }),
      ];
      else if (req.role === 'plan') reply = { reasoning: 'Write the data', proposedAction: 'Write data.json', expectedOutput: 'Data on disk' };
      else if (req.role === 'execute') {
        executions += 1;
        // Another version of the workspace every time; the flag only from the fourth.
        const writes = [{ path: 'data.json', content: `${JSON.stringify({ attempt: executions })}\n` },
          ...(executions >= 4 ? [{ path: 'flag.txt', content: 'set\n' }] : [])];
        for (const args of writes) {
          const startedAt = Date.now();
          const value = await req.executor!.execute('write_file', args);
          req.onToolInvocation?.({ name: 'write_file', args, result: value, startedAt, durationMs: Date.now() - startedAt });
        }
        reply = { output: { files: writes.map((write) => write.path) }, summary: 'Data written' };
      } else if (req.actor?.name === 'prompt-consolidation') reply = { amendment: null, reason: 'Nothing new.', evidenceIds: [] };
      else throw new Error(`Unexpected request: ${req.role} ${req.actor?.name ?? ''}`);
      return { text: JSON.stringify(reply), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    } } });
    let handle: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      handle = await startTask(['--comparison', '--clean-workspace', 'Write data.json and its flag']);
      expect(await handle.settled).toEqual({ outcome: 'delivered' });
      const file = readdirSync(runs).find((name) => name.endsWith('.json') && name !== 'index.json')!;
      const trace = JSON.parse(readFileSync(join(runs, file), 'utf8')) as VizRun;
      const { entries, malformed } = readSuiteDisputeEntries(trace.suiteDisputes);
      expect(malformed).toBe(0);
      const counted = entries.filter((entry) => entry.type === 'counted');
      const later = entries.filter((entry) => entry.type === 'later');
      expect(counted).toHaveLength(1);
      const entry = counted[0]!;
      if (entry.type !== 'counted') throw new Error('expected a counted entry');
      expect(entry.suiteDigest).toBe(parentTestSuiteDigest(suite));
      expect(entry.suite).toEqual(suite);
      expect(entry.counts).toEqual({ observations: 3, subjects: 3 });
      expect(entry.owner.tier).toBe(2);
      // Three real runs of the suite on three versions of the workspace, one failing set.
      expect(entry.observations.map((observation) => [observation.status, observation.sameSet])).toEqual([['failed', true], ['failed', true], ['failed', true]]);
      expect(new Set(entry.observations.map((observation) => observation.subjectDigest)).size).toBe(3);
      expect(entry.observations.every((observation) => /^[0-9a-f]{64}$/.test(observation.subjectDigest ?? ''))).toBe(true);
      // The branch retry wrote the flag: the same suite passed after the count.
      expect(later.map((item) => item.type === 'later' ? [item.countId, item.observation.status, item.observation.sameSet] : null))
        .toEqual([[entry.id, 'passed', false]]);
      // The epilogue counts what the trace records.
      const stats = parseRunStatsEpilogue(printed.join('\n'));
      expect(stats?.suiteDisputes).toBe(counted.length);
      // Never an event: the analyst's events file is model input.
      expect(JSON.stringify(trace.events)).not.toContain(entry.id);
      expect(calls.some((req) => `${req.systemPrompt}\n${req.userContent}`.includes(entry.id))).toBe(false);
    } finally {
      await handle?.shutdown();
      closeStoreHandles();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
