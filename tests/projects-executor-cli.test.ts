import { spawn, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { projectRunHostLayout } from '../src/projects/coordinator.js';
import { serveExecutor } from '../src/projects/executorTransport.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';

const CLI_TIMEOUT_MS = 10_000;

// Five sequential cold CLI processes each get their own deadline, plus one
// allowance for fixture setup/cleanup. A slow child cannot consume this whole
// scenario budget; spawn kills it at CLI_TIMEOUT_MS and its assertions fail.
it('delegates CLI admission, waits for its own queued run and reattaches after completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pcli-'));
  chmodSync(root, 0o700);
  const f = projectRetrievalFixture(root);
  const other = projectRetrievalFixture(root, { subject: 'other', slug: 'other' });
  other.projects.createProjectRun({ orgId: other.viewer.orgId, projectId: other.project.projectId,
    principalId: other.viewer.principalId, request: { goal: 'Unrelated queued work', idempotencyKey: 'other' },
    projectRunId: randomUUID(), hostPaths: { workspacePath: join(root, 'other-work'), runsPath: join(root, 'other-runs'), logPath: join(root, 'other.log') } });
  const socket = join(root, 'executor.sock');
  const calls: string[] = [];
  let runId: string | undefined;
  const server = await serveExecutor(socket, async command => {
    if (command.method !== 'start') throw new Error('Unexpected command');
    const input = command.input;
    calls.push(input.request.idempotencyKey);
    const existing = f.projects.findProjectRunForRequest(input.orgId, input.projectId, input.principalId, input.request);
    if (existing) return { run: existing, created: false, admissionJournaled: true };
    runId = randomUUID();
    const layout = projectRunHostLayout(root, input.orgId, input.projectId, runId);
    const created = f.projects.createProjectRun({ ...input, principalId: input.principalId,
      projectRunId: runId, hostPaths: { workspacePath: layout.workspacePath, runsPath: layout.runsPath, logPath: layout.logPath } })!;
    return { ...created, admissionJournaled: true };
  });
  const children: ChildProcess[] = [];
  function cli(key = 'cli-retry-key') {
    const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'),
      resolve('src/cli/projects.ts'), 'run', '--project', f.project.projectId, '--as', f.viewer.principalId,
      '--idempotency-key', key, 'Quota-free CLI boundary'], {
      cwd: root, env: { PATH: process.env['PATH'], HOME: root, ATOMA_DB_PATH: f.dbPath,
        ATOMA_EXECUTOR_SOCKET: socket, ATOMA_MCP_RUN_LOCK: join(root, 'lease.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    children.push(child);
    let output = '';
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    return { child, output: () => output, ended: once(child, 'exit') };
  }
  try {
    const first = cli();
    await vi.waitFor(() => {
      if (first.child.exitCode !== null || first.child.signalCode !== null) {
        throw new Error(`CLI exited before admission (${first.child.exitCode ?? first.child.signalCode}): ${first.output()}`);
      }
      expect(runId).toBeDefined();
    }, { timeout: CLI_TIMEOUT_MS });
    expect(first.child.exitCode).toBeNull();
    first.child.kill('SIGTERM');
    await first.ended;
    expect(f.projects.getProjectRun(f.viewer.orgId, runId!)?.status).toBe('queued');
    const resumed = cli();
    await vi.waitFor(() => {
      if (resumed.child.exitCode !== null || resumed.child.signalCode !== null) {
        throw new Error(`CLI exited before reattachment (${resumed.child.exitCode ?? resumed.child.signalCode}): ${resumed.output()}`);
      }
      expect(calls).toHaveLength(2);
    }, { timeout: CLI_TIMEOUT_MS });
    expect(resumed.child.exitCode).toBeNull();
    f.projects.transitionProjectRun({ orgId: f.viewer.orgId, projectRunId: runId!, from: 'queued', to: 'running' });
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(resumed.child.exitCode).toBeNull();
    f.projects.transitionProjectRun({ orgId: f.viewer.orgId, projectRunId: runId!, from: 'running', to: 'failed', error: 'Quota-free test completion' });
    expect((await resumed.ended)[0], resumed.output()).toBe(1);
    expect(resumed.output()).toContain(`run ${runId!} failed`);
    const completedRetry = cli();
    expect((await completedRetry.ended)[0], completedRetry.output()).toBe(1);
    expect(completedRetry.output()).toContain(`run ${runId!} failed`);
    expect(calls).toEqual(['cli-retry-key', 'cli-retry-key', 'cli-retry-key']);
    expect(f.projects.listProjectRuns(f.viewer.orgId, f.project.projectId)).toHaveLength(1);
    const journal = new Database(f.dbPath, { readonly: true });
    try {
      expect(journal.prepare("SELECT COUNT(*) AS n FROM platform_events WHERE kind='run.started'").get()).toEqual({ n: 0 });
    } finally { journal.close(); }
    const malformed = cli('invalid key');
    expect((await malformed.ended)[0], malformed.output()).toBe(1);
    expect(malformed.output()).toContain('invalid --idempotency-key');
    await new Promise<void>(resolve => server.close(() => resolve()));
    const unavailable = cli();
    expect((await unavailable.ended)[0], unavailable.output()).toBe(1);
    expect(unavailable.output()).toContain('Run executor unavailable');
    expect(calls).toHaveLength(3);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, 'exit')));
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeStoreHandles();
    rmSync(root, { recursive: true, force: true });
  }
}, 6 * CLI_TIMEOUT_MS);
