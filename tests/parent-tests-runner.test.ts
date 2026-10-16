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
import { makePlan } from './helpers/factories.js';
import { summarizeParentTests } from '../src/contracts/parentTestRecord.js';
import { MCP_PARENT_TEST_LIMITS } from '../src/projects/runProgress.js';
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
 * D3 of the 2026-10-16 review: a run without root acceptance (a registered
 * comparison arm, the runner's non-depth path) has no judge for the tissue's
 * own integration suite. Until then only the observation's `refusal` made such
 * a run partial; parent tests no longer write it, so the runner does, through
 * the real fixed runner on the real workspace.
 */
describe('a run without root acceptance and a host-run integration suite', () => {
  it.each([
    ['failed', "import { test, expect } from 'vitest';\ntest('joined', () => {\n  expect(1).toBe(2);\n});", 'partial'],
    ['passed', "import { test, expect } from 'vitest';\ntest('joined', () => {\n  expect(1).toBe(1);\n});", 'delivered'],
  ] as const)('is %s at the runner boundary', async (status, source, outcome) => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-parent-runner-'));
    const runs = join(root, 'runs');
    for (const [key, value] of Object.entries({ ...OLLAMA_PINS,
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'), ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: runs,
      ATOMA_BUILD_WORKSPACE: join(root, 'workspace'), ATOMA_BUILD_TIMEOUT_MS: '120000',
      ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0', ATOMA_PREFILTER_CACHE: '0',
      ATOMA_SKILL_LEARN: '0', ATOMA_SKILL_PROMOTE: '0', ATOMA_DEFER_LEARNING: '1',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const integration = { requirement: 'the server module loads', cwd: '.', source };
    const calls: LlmCompletionRequest[] = [];
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async (req) => {
      calls.push(req);
      let reply: unknown;
      if (req.role === 'prefilter' && req.systemPrompt === SKILL_PREFILTER_SYSTEM_PROMPT) reply = { kind: 'none', reasoning: 'No recipe' };
      else if (req.role === 'prefilter') reply = { kind: 'escalate', reasoning: 'Plan it' };
      else if (req.role === 'validate-plan') reply = { approved: true, reasoning: 'Plan approved', ...mockOtherProofReview(req) };
      else if (req.role === 'validate-result') reply = { approved: true, reasoning: 'Phase approved' };
      else if (req.role === 'plan' && req.actor?.tier === 3) reply = [
        { strategy: 'create', description: 'file builder', reasoning: 'One phase' },
        makePlan({ subtasks: [{ description: 'Write server.js', outputs: ['server.js'] }], aggregation: { mode: 'sequential' }, acceptanceTests: integration }),
      ];
      else if (req.role === 'plan' && req.actor?.tier === 2) reply = [
        { strategy: 'create', description: 'file writer', reasoning: 'One file' },
        makePlan({ subtasks: [{ description: 'Write server.js', outputs: ['server.js'] }] }),
      ];
      else if (req.role === 'plan') reply = { reasoning: 'Write the server', proposedAction: 'Write server.js', expectedOutput: 'Server on disk' };
      else if (req.role === 'execute') {
        const args = { path: 'server.js', content: 'export const ready = true;\n' };
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
      handle = await startTask(['--comparison', '--clean-workspace', 'Write server.js exporting ready']);
      expect(await handle.settled).toEqual({ outcome });
      const file = readdirSync(runs).find((name) => name.endsWith('.json') && name !== 'index.json')!;
      const trace = JSON.parse(readFileSync(join(runs, file), 'utf8')) as VizRun;
      expect(trace.events.some((event) => event.kind === 'acceptance')).toBe(false);
      expect(trace.result?.parentTests).toMatchObject([{ status, requirement: integration.requirement }]);
      expect(JSON.stringify(trace.result?.parentTests)).not.toContain('expect(1)');
      // G6: the shared reader reads what the real runner persisted.
      const summary = summarizeParentTests(trace.result, MCP_PARENT_TEST_LIMITS);
      expect(summary.state).toBe('recorded');
      expect(summary.records.invalid).toBe(0);
      expect(summary.observations).toHaveLength(1);
      expect(summary.observations[0]).toMatchObject({ status, cause: 'ran', requirement: integration.requirement });
      expect(summary.suites[status]).toBe(1);
      if (status === 'failed') {
        expect(trace.result?.summary).toMatch(/^REFUSED AT DELIVERY — no root acceptance ran and the host-run parent-owned suite failed: /);
        expect(trace.result?.refusal).toContain('joined');
      } else {
        expect(trace.result?.refusal).toBeUndefined();
        expect(trace.result?.summary).not.toContain('PARENT ACCEPTANCE TESTS');
      }
    } finally {
      await handle?.shutdown();
      closeStoreHandles();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
