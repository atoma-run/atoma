import { AuthStore } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCheckpointStoreOutsideWorkspace, checkpointWorkspaceDigest, RunCheckpointStore } from '../src/run/checkpoint.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { OLLAMA_PINS } from './tier-pins.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { makeCtx } from './helpers.js';
import { parseRunnerArgs } from '../src/run/runner.js';
import { BudgetGateLlmClient, RunBudgetMeter } from '../src/core/runBudget.js';
import { InMemoryMetrics } from '../src/core/metrics.js';

const roots: string[] = [];
afterEach(() => { closeStoreHandles(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-')));
  roots.push(root);
  const db = join(root, 'store.db');
  const env = { ...process.env, ...OLLAMA_PINS, CHECKPOINT_TEST_ROOT: root,
    ATOMA_DB_PATH: db, ATOMA_LEDGER_DB: db, ATOMA_SKILLS_DIR: join(root, 'skills'),
    ATOMA_RUNS_DIR: join(root, 'runs'), ATOMA_BUILD_WORKSPACE: join(root, 'workspace'),
    ATOMA_BUILD_TIMEOUT_MS: '600000', ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0',
    ATOMA_PREFILTER_CACHE: '0', ATOMA_SKILL_LEARN: '0', ATOMA_SKILL_PROMOTE: '0', ATOMA_SKILL_DIRECT: '0', ATOMA_JEV: '0',
  };
  // Fixtures never inherit a tenant receipt, seed, fixed trace id or criteria.
  for (const key of ['ATOMA_TENANT_RUN', 'ATOMA_RUN_ID', 'ATOMA_SEED', 'ATOMA_ACCEPTANCE_SPEC', 'ATOMA_ARTIFACT_MANIFEST_PATH']) delete (env as NodeJS.ProcessEnv)[key];
  const run = (args: string[], crash = '', overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    ['--experimental-test-module-mocks', '--import', 'tsx', resolve('tests/fixtures/checkpoint-run-child.ts'), ...args],
    { env: { ...env, CHECKPOINT_TEST_CRASH: crash, ...overrides }, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  const report = () => JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) as {
    outcome: string; checkpointId: string; calls: string[];
  };
  const counters = () => {
    const handle = new Database(db, { readonly: true });
    try { return {
      atoms: handle.prepare('SELECT sum(successes) AS n FROM atom_types').get() as { n: number },
      skills: handle.prepare('SELECT sum(successes) AS n FROM skill_meta').get() as { n: number },
    }; } finally { handle.close(); }
  };
  return { root, db, run, report, counters };
}

describe('durable sequential run continuation', () => {
  it('restarts the real runner in another process, skips credited work and still accepts the delivery', () => {
    const f = fixture();
    const first = f.run(['--pause-after-phase', '1', 'Write two files in sequence']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const before = f.report();
    expect(before.outcome).toBe('partial');
    expect(before.calls.filter(c => c.endsWith(':run-root'))).toHaveLength(0);
    const credit = f.counters();
    expect(credit.skills.n).toBe(1);
    const stored = new RunCheckpointStore(f.db).read(before.checkpointId);
    expect(stored.completed).toHaveLength(1);
    expect(stored.consumed.tokens).toBeGreaterThan(0);
    expect(stored.remainingMs).toBeLessThan(600000);
    expect(stored.completed[0]).not.toHaveProperty('evidence');
    expect(stored.completed[0]).not.toHaveProperty('trace');
    const next = f.run(['--resume', before.checkpointId]);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    const after = f.report();
    expect(after.outcome).toBe('delivered');
    expect(after.calls.filter(c => c.startsWith('plan:3:'))).toHaveLength(0);
    expect(after.calls.filter(c => c.startsWith('draft-checklist:'))).toHaveLength(0);
    expect(after.calls.filter(c => c.endsWith(':run-root'))).toHaveLength(1);
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    expect(f.counters().skills.n).toBe(2);
    expect(f.counters().atoms.n).toBe(credit.atoms.n * 2);
    expect(() => new RunCheckpointStore(f.db).read(before.checkpointId)).toThrow('not at a resumable');
  }, 90000);

  it('continues a tenant in a fresh scoped run and workspace without modifying its predecessor', () => {
    const f = fixture();
    const auth = AuthStore.open(f.db);
    const viewer = auth.completeLogin({ provider: 'github', subject: 'checkpoint-owner', displayName: 'Owner',
      email: null, emailVerified: false }, null)!.viewer;
    const store = ProjectStore.open(f.db);
    const project = store.createProject({ orgId: viewer.orgId, principalId: viewer.principalId,
      project: { name: 'Resume', slug: 'resume', repositoryTarget: { installationId: '1', owner: 'owner', name: 'resume', visibility: 'private' } } });
    const reserve = (resumeOf?: string) => {
      const id = randomUUID();
      const workspace = join(f.root, id, 'workspace');
      const runs = join(f.root, id, 'traces');
      store.createProjectRun({ orgId: viewer.orgId, principalId: viewer.principalId, projectId: project.projectId,
        projectRunId: id, request: { goal: 'Write two files in sequence', idempotencyKey: id, ...(resumeOf ? { resumeOf } : {}) },
        hostPaths: { workspacePath: workspace, runsPath: runs, skillsPath: join(f.root, 'skills'), logPath: join(f.root, id, 'run.log') } });
      store.transitionProjectRun({ orgId: viewer.orgId, projectRunId: id, from: 'queued', to: 'running' });
      return { id, workspace, env: { ATOMA_TENANT_RUN: '1', CHECKPOINT_TEST_TENANT: '1', ATOMA_RUN_ID: id,
        ATOMA_BUILD_WORKSPACE: workspace, ATOMA_RUNS_DIR: runs } };
    };
    const first = reserve();
    const seed = join(f.root, 'seed');
    mkdirSync(seed);
    writeFileSync(join(seed, 'original.txt'), 'Preserve the original project');
    const paused = f.run(['--container', '--checkpoint', '--seed', seed, 'Write two files in sequence'], '', { ...first.env, CHECKPOINT_TEST_REQUEST_PAUSE: '1' });
    expect(paused.status, paused.stdout + paused.stderr).toBe(0);
    expect(f.report().checkpointId).toBe(first.id);
    const saved = new RunCheckpointStore(f.db).read(first.id);
    expect(saved.startingSnapshot?.files.map(file => file.path)).toContain('original.txt');
    const unauthorized = reserve();
    const denied = f.run(['--container', '--resume', first.id], '', unauthorized.env);
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain('not authorized');
    const digest = checkpointWorkspaceDigest(first.workspace);
    const second = reserve(first.id);
    const resumed = f.run(['--container', '--resume', first.id, 'Write two files in sequence'], '', second.env);
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(f.report().outcome).toBe('delivered');
    expect(f.report().checkpointId).toBe(second.id);
    const handle = new Database(f.db, { readonly: true });
    const persisted = handle.prepare('SELECT payload FROM run_checkpoints WHERE id = ?').get(second.id) as { payload: string };
    handle.close();
    expect(JSON.parse(persisted.payload).startingSnapshot).toEqual(saved.startingSnapshot);
    expect(checkpointWorkspaceDigest(first.workspace)).toBe(digest);
    expect(readFileSync(join(second.workspace, 'phase-two.txt'), 'utf8')).toBe('phase-two.txt');
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    expect(() => new RunCheckpointStore(f.db).read(first.id)).toThrow('not at a resumable');
  }, 90000);

  it('resumes after SIGKILL exactly at a committed boundary', () => {
    const f = fixture();
    const first = f.run(['--checkpoint', 'Write two files in sequence'], 'boundary');
    expect(first.signal, first.stdout + first.stderr).toBe('SIGKILL');
    const db = new Database(f.db, { readonly: true });
    const row = db.prepare('SELECT id FROM run_checkpoints').get() as { id: string };
    db.close();
    const next = f.run(['--resume', row.id]);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(f.report().outcome).toBe('delivered');
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    expect(f.counters().skills.n).toBe(2);
  }, 90000);

  it('still performs fresh final acceptance when every phase was completed before the pause', () => {
    const f = fixture();
    const first = f.run(['--pause-after-phase', '2', 'Write two files in sequence']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const before = f.report();
    const credit = f.counters();
    expect(before.calls.filter(c => c.endsWith(':run-root'))).toHaveLength(0);
    const next = f.run(['--resume', before.checkpointId]);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(f.report().outcome).toBe('delivered');
    expect(f.report().calls.filter(c => c.startsWith('execute:'))).toHaveLength(0);
    expect(f.report().calls.filter(c => c.endsWith(':run-root'))).toHaveLength(1);
    expect(f.counters()).toEqual(credit);
  }, 90000);

  it('refuses replay after SIGKILL inside a phase with an external effect', () => {
    const f = fixture();
    const first = f.run(['--checkpoint', 'Write two files in sequence'], 'phase');
    expect(first.signal, first.stdout + first.stderr).toBe('SIGKILL');
    const db = new Database(f.db, { readonly: true });
    const row = db.prepare('SELECT id FROM run_checkpoints').get() as { id: string };
    db.close();
    const next = f.run(['--resume', row.id]);
    expect(next.status).toBe(2);
    expect(next.stderr).toContain('not at a resumable');
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    expect(f.counters().skills.n).toBe(1);
  }, 90000);

  it('refuses a changed workspace without overwriting the user edit', () => {
    const f = fixture();
    const first = f.run(['--pause-after-phase', '1', 'Write two files in sequence']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const id = f.report().checkpointId;
    writeFileSync(join(f.root, 'workspace', 'phase-one.txt'), 'user edit');
    const next = f.run(['--resume', id]);
    expect(next.status).toBe(2);
    expect(next.stderr).toContain('Workspace changed');
    expect(readFileSync(join(f.root, 'workspace', 'phase-one.txt'), 'utf8')).toBe('user edit');
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\n');
  }, 90000);

  it('atomically admits only one claimant and refuses live sandbox processes', () => {
    const f = fixture();
    const first = f.run(['--pause-after-phase', '1', 'Write two files in sequence']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const store = new RunCheckpointStore(f.db);
    const id = f.report().checkpointId;
    const a = store.read(id);
    const b = store.read(id);
    const owner = store.claim(a, false);
    expect(() => store.claim(b, false)).toThrow('not at a resumable');
    store.write(a, owner, 'ready');
    expect(() => store.read(id)).toThrow('still owned');
    // Simulate an exited owner with a surviving process; the pid probe is real.
    const db = new Database(f.db);
    const deadPid = 2_000_000_000;
    a.processes = [{ pid: process.pid, group: false }];
    db.prepare('UPDATE run_checkpoints SET pid=?, payload=? WHERE id=?').run(deadPid, JSON.stringify(a), id);
    expect(() => store.read(id)).toThrow('sandbox processes');
    a.processes = null;
    db.prepare('UPDATE run_checkpoints SET payload=? WHERE id=?').run(JSON.stringify(a), id);
    expect(() => store.read(id)).toThrow('backend was not drained');
    db.close();
  }, 90000);

  it('enforces carried consumption without billing previous calls to the new trace', async () => {
    const metrics = new InMemoryMetrics();
    const meter = new RunBudgetMeter(metrics, { tokens: 100, costUsd: 10 }, () => {}, undefined,
      { tokens: 90, costUsd: 1 });
    expect(metrics.events).toHaveLength(0);
    meter.record({ model: 'unknown', inputTokens: 11, outputTokens: 0, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0, durationMs: 1, stopReason: 'end_turn' });
    expect(meter.exceeded()?.kind).toBe('tokens');
    expect(meter.consumed()).toEqual({ tokens: 101, costUsd: 1 });
    expect(metrics.events).toHaveLength(1);
    const ctx = makeCtx();
    const gate = new BudgetGateLlmClient(ctx.llm, meter);
    await expect(gate.complete({ model: 'x', systemPrompt: '', userContent: '' })).rejects.toThrow('token ceiling');
    expect(ctx.llm.calls).toHaveLength(0);
    const narrowed = new RunBudgetMeter(new InMemoryMetrics(), { tokens: null, costUsd: 0.5 }, () => {}, undefined,
      { tokens: 90, costUsd: 1 });
    expect(narrowed.exceeded()?.kind).toBe('cost');
  });

  it('seals directories and internal dependency links, refuses escaping links', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-files-'))); roots.push(root);
    const empty = checkpointWorkspaceDigest(root);
    mkdirSync(join(root, 'empty'));
    expect(checkpointWorkspaceDigest(root)).not.toBe(empty);
    writeFileSync(join(root, 'target'), 'first');
    symlinkSync('target', join(root, 'internal'));
    const linked = checkpointWorkspaceDigest(root);
    writeFileSync(join(root, 'target'), 'changed');
    expect(checkpointWorkspaceDigest(root)).not.toBe(linked);
    symlinkSync('/tmp', join(root, 'link'));
    expect(() => checkpointWorkspaceDigest(root)).toThrow('link or special');
  });

  it('cannot place its authority store inside the workspace through a parent symlink', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-containment-'))); roots.push(root);
    mkdirSync(join(root, 'workspace'));
    const store = join(root, 'workspace', '..store.db');
    writeFileSync(store, '');
    symlinkSync(join(root, 'workspace'), join(root, 'alias'));
    expect(() => assertCheckpointStoreOutsideWorkspace(store, join(root, 'alias'))).toThrow('outside');
    expect(() => assertCheckpointStoreOutsideWorkspace(store, join(root, 'new', 'workspace'))).not.toThrow();
  });

  it('keeps the checkpoint out of nested dispatch contexts', () => {
    const ctx = makeCtx();
    Object.assign(ctx, { rootCheckpoint: {} });
    expect(forkBranch(ctx, 'child').rootCheckpoint).toBeUndefined();
  });

  it('parses bounded pause/resume arguments', () => {
    expect(parseRunnerArgs(['--pause-after-phase', '2', 'goal'])).toMatchObject({ checkpoint: true, pauseAfterPhase: 2, goal: 'goal' });
    expect(() => parseRunnerArgs(['--pause-after-phase', '0', 'goal'])).toThrow('positive phase');
    expect(() => parseRunnerArgs(['--resume', '../elsewhere'])).toThrow('UUID');
  });
});
