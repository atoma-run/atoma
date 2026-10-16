import { mockOtherProofReview } from './helpers/delegationReview.js';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTierClients } from '../src/run/providers.js';
import { startTask, resetHostLifecycleSnapshotForTests } from '../src/run/runner.js';
import { parseRunLog } from '../src/cli/burnin.js';
import { SKILL_PREFILTER_SYSTEM_PROMPT } from '../src/atoms/cost.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { isLanded } from '../src/contracts/runLanding.js';
import type { LlmCompletionRequest } from '../src/core/types.js';
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
 * Review 2026-10-16, group B, across the runner boundary: a root phase whose
 * parent-owned suite fails (the real fixed runner, on the real workspace) used
 * to throw out of the dependency it fed and record the run `failed`, seeding
 * nothing. It now ends `partial`: the trace persists which phase never
 * started and why, and the epilogue the coordinator hands the next run says so.
 */
describe('a run whose first phase failed its parent-owned suite and whose second depends on it', () => {
  it('records partial, persists the phase that never started, and explains it in the epilogue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-dependency-landing-'));
    const runs = join(root, 'runs');
    for (const [key, value] of Object.entries({ ...OLLAMA_PINS,
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'), ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: runs,
      ATOMA_BUILD_WORKSPACE: join(root, 'workspace'), ATOMA_BUILD_TIMEOUT_MS: '120000',
      ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0', ATOMA_PREFILTER_CACHE: '0',
      ATOMA_SKILL_LEARN: '0', ATOMA_SKILL_PROMOTE: '0', ATOMA_DEFER_LEARNING: '1',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => logs.push(parts.map(String).join(' ')));
    }
    const suite = {
      requirement: 'the server module reports ready',
      cwd: '.',
      source: "import { test, expect } from 'vitest';\nimport { ready } from './server.js';\ntest('ready', () => {\n  expect(ready).toBe('yes');\n});",
    };
    const calls: LlmCompletionRequest[] = [];
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async (req) => {
      calls.push(req);
      let reply: unknown;
      if (req.role === 'prefilter' && req.systemPrompt === SKILL_PREFILTER_SYSTEM_PROMPT) reply = { kind: 'none', reasoning: 'No recipe' };
      else if (req.role === 'prefilter') reply = { kind: 'escalate', reasoning: 'Plan it' };
      else if (req.role === 'validate-plan') reply = { approved: true, reasoning: 'Plan approved', ...mockOtherProofReview(req) };
      else if (req.role === 'validate-result') reply = { approved: true, reasoning: 'Phase approved' };
      else if (req.role === 'plan' && req.actor?.tier === 3) reply = [
        { strategy: 'create', description: 'file builder', reasoning: 'Two phases' },
        makePlan({
          subtasks: [
            { description: 'Write server.js', outputs: ['server.js'], acceptanceTests: suite },
            { description: 'Write client.js on the server', outputs: ['client.js'], dependsOn: [0] },
          ],
          aggregation: { mode: 'concat' },
        }),
      ];
      else if (req.role === 'plan' && req.actor?.tier === 2) reply = [
        { strategy: 'create', description: 'file writer', reasoning: 'One file' },
        makePlan({ subtasks: [{ description: 'Write server.js', outputs: ['server.js'] }] }),
      ];
      else if (req.role === 'plan' || req.role === 'fallback-plan') reply = { reasoning: 'Write the server', proposedAction: 'Write server.js', expectedOutput: 'Server on disk' };
      else if (req.role === 'execute' || req.role === 'fallback-execute') {
        if (req.userContent.includes('Write client.js')) throw new Error('the dependent phase must never start');
        const args = { path: 'server.js', content: "export const ready = 'no';\n" };
        const startedAt = Date.now();
        const value = await req.executor!.execute('write_file', args);
        req.onToolInvocation?.({ name: 'write_file', args, result: value, startedAt, durationMs: Date.now() - startedAt });
        reply = { output: { files: ['server.js'] }, summary: 'Server written' };
      } else if (req.actor?.name === 'prompt-consolidation') reply = { amendment: null, reason: 'Nothing new.', evidenceIds: [] };
      else throw new Error(`Unexpected request: ${req.role} ${req.actor?.name ?? ''}`);
      return { text: JSON.stringify(reply), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    } } });
    let handle: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      handle = await startTask(['--comparison', '--clean-workspace', 'Write server.js and a client on it']);

      expect(await handle.settled).toEqual({ outcome: 'partial' });
      const file = readdirSync(runs).find((name) => name.endsWith('.json') && name !== 'index.json')!;
      const trace = JSON.parse(readFileSync(join(runs, file), 'utf8')) as VizRun;
      const entry = 'Write client.js on the server (not started: its prerequisite "Write server.js" failed its parent-owned acceptance suite)';
      expect(trace.result?.blockedPhases).toEqual([entry]);
      expect(trace.result?.unfinishedPhases).toEqual([entry]);
      expect(trace.result).not.toHaveProperty('ownFallbackBlockedBy');
      expect(isLanded(trace.result)).toBe(true);
      expect(calls.some((req) => req.userContent.includes('Write client.js on the server') && req.role === 'execute')).toBe(false);
      const stats = parseRunLog(logs.join('\n'));
      expect(stats.outcome).toBe('partial');
      expect(stats.landingReasons).toContain(`did not start 1 phase(s) behind a phase that failed its typed checks: ${entry}`);
    } finally {
      await handle?.shutdown();
      closeStoreHandles();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
