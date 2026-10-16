import { mockOtherProofReview } from './helpers/delegationReview.js';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTierClients } from '../src/run/providers.js';
import { startTask, resetHostLifecycleSnapshotForTests } from '../src/run/runner.js';
import { SKILL_PREFILTER_SYSTEM_PROMPT } from '../src/atoms/cost.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { PHASE_BUDGET_SPENT_PREFIX } from '../src/core/phaseBudget.js';
import type { LlmCompletionRequest, Result } from '../src/core/types.js';
import type { VizRun } from '../src/viz/trace.js';
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
 * Group G3 (review 2026-10-16) across the runner boundary: a depth run, so a
 * root acceptance judges it (`rootAcceptance`). Its one root phase's cell
 * plans `[CHANGELOG, add.js]` with no dependency; add.js ends in the cell's
 * own fallback and the tissue refuses the phase. The phase goes up once,
 * stamped in memory (`spentLadder`), and the root N=1 pass-through carries the
 * stamp to the run result — which the runner never persists.
 */
describe('a depth run whose root phase spent its ladder on one of two independent subtasks', () => {
  it('hands the whole phase up once, and the persisted result carries the prefix but never the stamp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-spent-ladder-'));
    const runs = join(root, 'runs');
    for (const [key, value] of Object.entries({ ...OLLAMA_PINS,
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'), ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: runs,
      ATOMA_BUILD_WORKSPACE: join(root, 'workspace'), ATOMA_BUILD_TIMEOUT_MS: '120000',
      ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0', ATOMA_PREFILTER_CACHE: '0',
      ATOMA_SKILL_LEARN: '0', ATOMA_SKILL_PROMOTE: '0', ATOMA_DEFER_LEARNING: '1',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    for (const method of ['debug', 'info', 'log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const handle = vi.spyOn(L3Atom.prototype, 'handle');
    const phase = 'Build the adder package files';
    const taskA = 'Write add.js';
    const taskC = 'Write CHANGELOG.md';
    const calls: LlmCompletionRequest[] = [];
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async (req) => {
      calls.push(req);
      let reply: unknown;
      if (req.actor?.name === 'run-router') reply = { action: 'reuse', name: 'Meristem', reasoning: 'Build fixture' };
      else if (req.role === 'prefilter' && req.systemPrompt === SKILL_PREFILTER_SYSTEM_PROMPT) reply = { kind: 'none', reasoning: 'No recipe' };
      else if (req.role === 'prefilter') reply = { kind: 'escalate', reasoning: 'Plan it' };
      else if (req.role === 'validate-plan') reply = { approved: true, reasoning: 'Plan approved', ...mockOtherProofReview(req) };
      else if (req.role === 'validate-result' && req.actor?.name === 'run-root') reply = { approved: true, reasoning: 'Delivery reviewed and accepted' };
      else if (req.role === 'validate-result' && req.actor?.tier === 3) {
        reply = { approved: false, reasoning: 'The adder is not proven', scope: 'ephemeral', modifications: { additionalContext: 'prove it' } };
      } else if (req.role === 'validate-result') {
        const approved = !req.userContent.includes(taskA);
        reply = approved
          ? { approved: true, reasoning: 'Changelog written' }
          : { approved: false, reasoning: `add.js still wrong after ${calls.length} calls`, scope: 'ephemeral', modifications: { additionalContext: 'fix it' } };
      } else if (req.role === 'plan' && req.actor?.tier === 3) reply = [
        { strategy: 'create', description: 'package builder', reasoning: 'One phase' },
        makePlan({ subtasks: [{ description: phase, outputs: ['add.js', 'CHANGELOG.md'] }] }),
      ];
      else if (req.role === 'plan' && req.actor?.tier === 2) reply = [
        { strategy: 'create', description: 'file writer', reasoning: 'Two independent files' },
        makePlan({
          subtasks: [{ description: taskC, outputs: ['CHANGELOG.md'] }, { description: taskA, outputs: ['add.js'] }],
          aggregation: { mode: 'concat' },
        }),
      ];
      else if (req.role === 'plan' || req.role === 'fallback-plan') reply = { reasoning: 'Write it', proposedAction: 'Write the file', expectedOutput: 'File on disk' };
      else if (req.role === 'execute' || req.role === 'fallback-execute') {
        const path = req.userContent.includes(taskA) ? 'add.js' : 'CHANGELOG.md';
        const args = { path, content: `${path} by ${req.role}\n` };
        const startedAt = Date.now();
        const value = await req.executor!.execute('write_file', args);
        req.onToolInvocation?.({ name: 'write_file', args, result: value, startedAt, durationMs: Date.now() - startedAt });
        reply = { output: { files: [path] }, summary: `${path} written by ${req.role}` };
      } else if (req.actor?.name === 'prompt-consolidation') reply = { amendment: null, reason: 'Nothing new.', evidenceIds: [] };
      else throw new Error(`Unexpected request: ${req.role} ${req.actor?.name ?? ''}`);
      return { text: JSON.stringify(reply), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    } } });
    let run: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      run = await startTask(['--depth', 'deep', '--clean-workspace', '--no-learn-skills', '--no-direct-skills', 'Build a small adder package']);

      expect(await run.settled).toEqual({ outcome: 'delivered' });
      // One ladder: the cell planned once, fell back once, and the tissue judged once.
      expect(calls.filter((req) => req.role === 'plan' && req.actor?.tier === 2)).toHaveLength(1);
      expect(calls.filter((req) => req.role === 'fallback-plan' && req.actor?.tier === 2)).toHaveLength(1);
      expect(calls.filter((req) => req.role === 'validate-result' && req.actor?.tier === 3 && req.actor.name !== 'run-root')).toHaveLength(1);
      // In memory, the stamp reached the run result through the root pass-through.
      const inMemory = await (handle.mock.results[0]!.value as Promise<Result>);
      expect(inMemory.phaseBudgetSpent).toBe(true);
      expect(inMemory.spentLadder?.on).toEqual([taskA]);
      // Persisted: the prefix a reader explains the run from, never the runtime stamp.
      const file = readdirSync(runs).find((name) => name.endsWith('.json') && name !== 'index.json')!;
      const trace = JSON.parse(readFileSync(join(runs, file), 'utf8')) as VizRun;
      expect(trace.result?.summary).toContain(PHASE_BUDGET_SPENT_PREFIX);
      expect(trace.result?.summary).toContain(`ladder ended in its last-resort fallback on "${taskA}"`);
      expect(trace.result).not.toHaveProperty('spentLadder');
    } finally {
      await run?.shutdown();
      closeStoreHandles();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
