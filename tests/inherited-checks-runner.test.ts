import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTierClients } from '../src/run/providers.js';
import { startTask, resetHostLifecycleSnapshotForTests } from '../src/run/runner.js';
import { buildProfile } from '../src/run/profiles/build.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { makePlan } from './helpers/factories.js';
import { OLLAMA_PINS } from './tier-pins.js';

/**
 * The host's replay of the browser checks earlier runs recorded, through the
 * real runner: a seeded static page, the local tool backend, python's static
 * server and Chrome (docs/inherited-checks-replay-2026-10-01.md). Where the
 * machine has neither, the replay stops at its server and the order of the
 * gate is still what is asserted.
 */

vi.mock('../src/run/providers.js', async (original) => ({
  ...await original<typeof import('../src/run/providers.js')>(), buildTierClients: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetHostLifecycleSnapshotForTests(); });

const PAGE = (line: string) => `<!doctype html><html><head><title>Focus Timer</title></head><body>
<button id="long-break">Long break</button><p id="mode">Mode: Pomodoro</p>
<script>document.getElementById('long-break').addEventListener('click', () => { document.getElementById('mode').textContent = ${JSON.stringify(line)}; });</script>
</body></html>`;

describe('a seeded static-page run', () => {
  it('replays the inherited checks before any molecule touches the page, and shows the acceptor the one the delivery broke', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-inherited-runner-'));
    const workspace = join(root, 'workspace');
    const seedDir = join(root, 'seed');
    mkdirSync(seedDir);
    writeFileSync(join(seedDir, 'index.html'), PAGE('Long break'));
    writeFileSync(join(seedDir, '.atoma-probes.json'), JSON.stringify({ version: 1, entries: [{
      probe: 'web', file: 'index.html', interactions: [{ type: 'click', selector: '#long-break' }],
      smoke: "(() => ({ ok: document.getElementById('mode').textContent === 'Long break', mode: document.getElementById('mode').textContent }))()",
      expected: '{"ok":true}',
    }] }));
    for (const [key, value] of Object.entries({ ...OLLAMA_PINS,
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: join(root, 'runs'),
      // Room for the acceptance replay before the deadline's verdict reserve.
      ATOMA_BUILD_WORKSPACE: workspace, ATOMA_BUILD_TIMEOUT_MS: '600000', ATOMA_CONTAINER: '0',
      ATOMA_REQUIRE_ISOLATION: '0', ATOMA_PREFILTER_CACHE: '0',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => logs.push(parts.map(String).join(' ')));
    }
    let baselineDoneAtFirstToolCall: boolean | undefined;
    // Set right after the first write returns.
    let rootPrompt = '';
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async (req) => {
      let reply: unknown;
      const role = req.role;
      if (role === 'prefilter') reply = { outcome: 'escalate', reasoning: 'Exercise decomposition' };
      else if (role === 'validate-plan') reply = { approved: true, reasoning: 'Plan approved' };
      else if (role === 'validate-result') {
        if (req.actor?.name === 'run-root') rootPrompt = req.userContent;
        reply = { approved: true, reasoning: 'Fixture approves' };
      } else if (role === 'plan' && req.actor?.tier !== 1) reply = [
        { strategy: 'create', reasoning: 'One phase' },
        makePlan({ subtasks: [{ description: 'Write index.html', outputs: ['index.html'] }], aggregation: { mode: 'sequential' } }),
      ];
      else if (role === 'plan' || role === 'fallback-plan') reply = { reasoning: 'Write the page', proposedAction: 'Write index.html and report it', expectedOutput: 'Page on disk' };
      else if (role === 'execute' || role === 'fallback-execute') {
        // The gate holds TOOL calls, not model calls: this read is the
        // molecule's first tool call, and it may only reach the page once the
        // run-start replay has logged. Then the delivery drops the line an
        // earlier run asked for.
        await req.executor!.execute('read_file', { path: 'index.html' });
        baselineDoneAtFirstToolCall ??= logs.some((line) => line.startsWith('inherited checks: '));
        await req.executor!.execute('write_file', { path: 'index.html', content: PAGE('Mode: Long Break') });
        reply = { output: { files: ['index.html'] }, summary: 'Page written' };
      } else throw new Error(`Unexpected mock request: ${role}`);
      return { text: JSON.stringify(reply), stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 }, servedModel: 'claude-haiku-4-5-20251001' };
    } } });
    let handle: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      handle = await startTask(buildProfile, ['--seed', seedDir, '--no-learn-skills', '--no-direct-skills', 'Change the long-break line']);
      await handle.settled;
      expect(baselineDoneAtFirstToolCall).toBe(true);
      const baseline = logs.find((line) => line.startsWith('inherited checks: '))!;
      // Where python can serve the page, nothing but the full catch passes:
      // a broken host server start must not hide behind the fallback.
      if (spawnSync('python3', ['--version']).status === 0) {
        expect(baseline).toMatch(/^inherited checks: 1 of 1 passed twice/);
        expect(rootPrompt).toContain('INHERITED BROWSER CHECKS (host replay, mechanical)');
        expect(rootPrompt).toContain('Mode: Long Break');
      } else {
        expect(baseline).toContain('(stopped: server)');
      }
    } finally {
      await handle?.shutdown();
      closeStoreHandles();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
