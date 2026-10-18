import { AuthStore } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, mkdirSync, symlinkSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCheckpointStoreOutsideWorkspace, checkpointWorkspaceDigest, RunCheckpointStore, SequentialCheckpoint, savedRootActor } from '../src/run/checkpoint.js';
import { readCheckpointWorkspace, saveCheckpointWorkspace } from '../src/run/checkpointWorkspace.js';
import { encodeReadRunsIndex, READ_RUNS_ENV, readRunCopyPath } from '../src/contracts/readRuns.js';
import { buildWorkspaceArtifactManifest } from '../src/projects/artifacts.js';
import { openDb } from '../src/registry/db.js';
import { seedTissueCatalog } from '../src/run/tissues.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { OLLAMA_PINS } from './tier-pins.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { makeCtx } from './helpers.js';
import { parseRunnerArgs, shortRootHandle } from '../src/run/runner.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { PlanParseError } from '../src/core/errors.js';
import type { Result } from '../src/core/types.js';
import { BudgetGateLlmClient, RunBudgetMeter } from '../src/core/runBudget.js';
import { InMemoryMetrics } from '../src/core/metrics.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { withRecoveryEffects, setRecoveryEffectHandler } from '../src/core/recoveryEffects.js';

const roots: string[] = [];
afterEach(() => { closeStoreHandles(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(workspaceProcess = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-')));
  roots.push(root);
  const db = join(root, 'store.db');
  const env = { ...process.env, ...OLLAMA_PINS, CHECKPOINT_TEST_ROOT: root,
    CHECKPOINT_TEST_WORKSPACE_PROCESS: workspaceProcess ? '1' : '0',
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
    outcome: string; checkpointId: string; calls: string[]; rootReviews: number;
  };
  /** The calls of a run that exited 2 before writing its report. */
  const errorReport = () => JSON.parse(readFileSync(join(root, 'error-report.json'), 'utf8')) as { calls: string[]; rootReviews: number };
  /** Edit the saved checkpoint payload as an older binary or a tamperer would leave it. */
  const editPayload = (id: string, sql: string) => {
    const handle = new Database(db);
    try { handle.prepare(`UPDATE run_checkpoints SET payload=${sql} WHERE id=?`).run(id); } finally { handle.close(); }
  };
  const counters = () => {
    const handle = new Database(db, { readonly: true });
    try { return {
      atoms: handle.prepare('SELECT sum(successes) AS n FROM atom_types').get() as { n: number },
      skills: handle.prepare('SELECT sum(successes) AS n FROM skill_meta').get() as { n: number },
    }; } finally { handle.close(); }
  };
  return { root, db, run, report, errorReport, editPayload, counters };
}

describe('durable sequential run continuation', () => {
  it('commits and rolls back a registry recovery barrier on the mutation connection', () => {
    const f = fixture();
    expect(f.run(['--pause-after-phase', '1', 'Write two files in sequence']).status).toBe(0);
    const store = new RunCheckpointStore(f.db);
    const data = store.read(f.report().checkpointId);
    const owner = store.claim(data, false);
    store.beginSegment(data, Date.now() + 300000);
    const db = new Database(f.db);
    const registry = new AtomRegistry(db);
    const name = registry.listByTier(1)[0]!.name;
    const initial = registry.getByName(name)!.successes;
    withRecoveryEffects(() => {
      setRecoveryEffectHandler(connection => store.blockMutation(data.id, owner, connection));
      const namespace = (db.prepare('SELECT namespace FROM skill_meta LIMIT 1').get() as { namespace: string }).namespace;
      expect(new SkillRegistry(join(f.root, 'skills'), { db }).loadFor(namespace).length).toBeGreaterThan(0);
      expect(db.prepare('SELECT blocked FROM run_checkpoint_recovery WHERE id=?').get(data.id)).toEqual({ blocked: null });
      expect(() => db.transaction(() => {
        registry.recordSuccess(name);
        throw new Error('roll back');
      })()).toThrow('roll back');
      expect(registry.getByName(name)!.successes).toBe(initial);
      expect(db.prepare('SELECT blocked FROM run_checkpoint_recovery WHERE id=?').get(data.id)).toEqual({ blocked: null });
      registry.recordSuccess(name);
      expect(db.prepare('SELECT blocked FROM run_checkpoint_recovery WHERE id=?').get(data.id)).toEqual({ blocked: 'host_mutation' });
    });
    db.close();
  }, 90000);

  it('does not invent zero spend for a model interrupted before its final usage', () => {
    const f = fixture();
    const env = { CHECKPOINT_TEST_NO_SKILL: '1' };
    const first = f.run(['--checkpoint', 'Write two files in sequence'], 'phase', env);
    expect(first.signal).toBe('SIGKILL');
    const db = new Database(f.db, { readonly: true });
    const row = db.prepare('SELECT id FROM run_checkpoints').get() as { id: string };
    db.close();
    expect(() => new RunCheckpointStore(f.db).read(row.id)).toThrow('model_pending');
    expect(f.run(['--resume', row.id], '', env).status).toBe(2);
  }, 90000);

  it.each([false, true])('recovers a SIGKILL inside a phase by restoring sealed bytes, preserving spend and not crediting the prefix twice (workspace process=%s)', remote => {
    const f = fixture(remote);
    const env = { CHECKPOINT_TEST_NO_SKILL: '1' };
    const first = f.run(['--checkpoint', 'Write two files in sequence'], 'safe', env);
    expect(first.signal, first.stdout + first.stderr).toBe('SIGKILL');
    const db = new Database(f.db, { readonly: true });
    const row = db.prepare('SELECT id,payload FROM run_checkpoints').get() as { id: string; payload: string };
    const boundary = JSON.parse(row.payload) as { consumed: { tokens: number } };
    const actions = db.prepare('SELECT kind,name,state,result FROM run_checkpoint_actions WHERE id=?').all(row.id) as { kind: string; name: string; state: string; result: string }[];
    expect(actions.some(a => a.kind === 'tool' && a.name === 'write_file' && a.state === 'done' && a.result)).toBe(true);
    db.close();
    const saved = new RunCheckpointStore(f.db).read(row.id);
    expect(saved.interrupted).toBe(true);
    expect(saved.snapshotId).toBeTruthy();
    expect(saved.completed).toHaveLength(1);
    expect(saved.consumed.tokens).toBeGreaterThanOrEqual(boundary.consumed.tokens);
    const credits = f.counters();
    const workspaceMode = statSync(join(f.root, 'workspace')).mode & 0o777;
    const next = f.run(['--resume', row.id], '', env);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(f.report().outcome).toBe('delivered');
    expect(statSync(join(f.root, 'workspace')).mode & 0o777).toBe(workspaceMode);
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\nphase-two.txt\n');
    expect(f.counters().atoms.n).toBe(credits.atoms.n * 2);
    const archive = readdirSync(f.root).find(n => n.startsWith('workspace.interrupted-'))!;
    expect(readFileSync(join(f.root, archive, 'phase-two.txt'), 'utf8')).toBe('phase-two.txt');
    expect(f.report().calls.filter(c => c.endsWith(':run-root'))).toHaveLength(1);
    expect(next.stdout).toContain(`"tokens":${saved.consumed.tokens}`);
  }, 90000);

  it.each(['external', 'credit'] as const)('refuses replay after a completed %s effect in the interrupted phase', kind => {
    const f = fixture();
    const env = { CHECKPOINT_TEST_NO_SKILL: '1' };
    const first = f.run(['--checkpoint', 'Write two files in sequence'], kind, env);
    expect(first.signal, first.stdout + first.stderr).toBe('SIGKILL');
    const db = new Database(f.db, { readonly: true });
    const row = db.prepare('SELECT id FROM run_checkpoints').get() as { id: string };
    db.close();
    const credits = f.counters();
    const next = f.run(['--resume', row.id], '', env);
    expect(next.status).toBe(2);
    expect(next.stderr).toContain(kind === 'credit' ? 'host_mutation' : 'external_effect');
    expect(f.counters()).toEqual(credits);
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
  }, 90000);

  it('does not replace interrupted evidence if a stored snapshot is corrupt', () => {
    const f = fixture();
    const first = f.run(['--checkpoint', 'Write two files in sequence'], 'safe', { CHECKPOINT_TEST_NO_SKILL: '1' });
    expect(first.signal).toBe('SIGKILL');
    const db = new Database(f.db);
    const row = db.prepare('SELECT id FROM run_checkpoints').get() as { id: string };
    db.prepare("UPDATE run_checkpoint_files SET content=? WHERE path='phase-one.txt'").run(Buffer.from('corrupt'));
    db.close();
    const next = f.run(['--resume', row.id], '', { CHECKPOINT_TEST_NO_SKILL: '1' });
    expect(next.status).toBe(2);
    expect(next.stderr).toContain('snapshot digest mismatch');
    expect(readFileSync(join(f.root, 'workspace', 'phase-two.txt'), 'utf8')).toBe('phase-two.txt');
  }, 90000);
  it.each([false, true])('restarts the real runner in another process, skips credited work and still accepts the delivery (workspace process=%s)', remote => {
    const f = fixture(remote);
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
    // The approval rides the checkpoint: one review before the pause, none after.
    expect(before.rootReviews).toBe(1);
    expect(stored.root?.approval?.from).toBe(0);
    expect(stored.root?.approval?.review.subtasks.map(s => s.index)).toEqual([0, 1]);
    const next = f.run(['--resume', before.checkpointId]);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    const after = f.report();
    expect(after.outcome).toBe('delivered');
    expect(after.rootReviews).toBe(0);
    expect(after.calls.filter(c => c.startsWith('plan:3:'))).toHaveLength(0);
    expect(after.calls.filter(c => c.startsWith('draft-checklist:'))).toHaveLength(0);
    expect(after.calls.filter(c => c.endsWith(':run-root'))).toHaveLength(1);
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    expect(f.counters().skills.n).toBe(2);
    expect(f.counters().atoms.n).toBe(credit.atoms.n * 2);
    expect(() => new RunCheckpointStore(f.db).read(before.checkpointId)).toThrow('not at a resumable');
  }, 90000);

  it.each(['pause', 'crash'] as const)('continues a tenant after %s in a fresh scoped run and workspace without modifying its predecessor', mode => {
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
    const paused = f.run(['--container', '--checkpoint', '--seed', seed, 'Write two files in sequence'], mode === 'crash' ? 'safe' : '',
      { ...first.env, CHECKPOINT_TEST_REQUEST_PAUSE: mode === 'pause' ? '1' : '0', CHECKPOINT_TEST_NO_SKILL: mode === 'crash' ? '1' : '0' });
    if (mode === 'crash') expect(paused.signal, paused.stdout + paused.stderr).toBe('SIGKILL');
    else { expect(paused.status, paused.stdout + paused.stderr).toBe(0); expect(f.report().checkpointId).toBe(first.id); }
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
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe(mode === 'crash' ? 'phase-one.txt\nphase-two.txt\nphase-two.txt\n' : 'phase-one.txt\nphase-two.txt\n');
    expect(() => new RunCheckpointStore(f.db).read(first.id)).toThrow('not at a resumable');
  }, 90000);

  // Read runs (docs/decisions/read-runs-2026-10-17.md): a continuation restores
  // the copies its source sealed, exactly as they were, and copies nothing
  // again. A workspace a version before 2026-10-17 sealed holds them at
  // .atoma-runs/<runId>, where nothing reads them: refused before any model
  // call, the source handed back.
  it.each(['nested', 'legacy'] as const)('continues a tenant that reads another run from the copies its source sealed (%s layout)', layout => {
    const f = fixture();
    const viewer = AuthStore.open(f.db).completeLogin({ provider: 'github', subject: 'read-runs-owner', displayName: 'Owner', email: null, emailVerified: false }, null)!.viewer;
    const store = ProjectStore.open(f.db);
    const project = store.createProject({ orgId: viewer.orgId, principalId: viewer.principalId,
      project: { name: 'Read runs', slug: 'read-runs', repositoryTarget: { installationId: '1', owner: 'owner', name: 'read-runs', visibility: 'private' } } });
    const reserve = (resumeOf?: string) => {
      const id = randomUUID();
      const workspace = join(f.root, id, 'workspace');
      const runs = join(f.root, id, 'traces');
      store.createProjectRun({ orgId: viewer.orgId, principalId: viewer.principalId, projectId: project.projectId, projectRunId: id,
        request: { goal: 'Write two files in sequence', idempotencyKey: id, ...(resumeOf ? { resumeOf } : {}) },
        hostPaths: { workspacePath: workspace, runsPath: runs, skillsPath: join(f.root, 'skills'), logPath: join(f.root, id, 'run.log') } });
      store.transitionProjectRun({ orgId: viewer.orgId, projectRunId: id, from: 'queued', to: 'running' });
      return { id, workspace, env: { ATOMA_TENANT_RUN: '1', CHECKPOINT_TEST_TENANT: '1', ATOMA_RUN_ID: id,
        ATOMA_BUILD_WORKSPACE: workspace, ATOMA_RUNS_DIR: runs } };
    };
    // The run both segments read, and the index the coordinator writes for each.
    const read = join(f.root, 'read-run');
    mkdirSync(join(read, 'browser'), { recursive: true });
    writeFileSync(join(read, 'browser', 'collect.js'), 'the bytes of the read run');
    const { manifest, hash } = buildWorkspaceArtifactManifest({ workspaceRoot: read });
    const readRunId = randomUUID();
    const indexFor = (runId: string) => {
      const path = join(f.root, `${runId}.read-runs.json`);
      writeFileSync(path, encodeReadRunsIndex({ version: 1, orgId: viewer.orgId, projectId: project.projectId, runId,
        readRuns: [{ runId: readRunId, status: 'delivered', endedAt: new Date().toISOString(), workspacePath: read, manifestHash: hash, manifest }] }),
      { mode: 0o600 });
      return { [READ_RUNS_ENV]: path };
    };
    const first = reserve();
    const paused = f.run(['--container', '--checkpoint', 'Write two files in sequence'], '',
      { ...first.env, ...indexFor(first.id), CHECKPOINT_TEST_REQUEST_PAUSE: '1' });
    expect(paused.status, paused.stdout + paused.stderr).toBe(0);
    expect(f.report().checkpointId).toBe(first.id);
    const copied = join(first.workspace, readRunCopyPath(readRunId), 'browser', 'collect.js');
    expect(readFileSync(copied, 'utf8')).toBe('the bytes of the read run');
    if (layout === 'legacy') {
      // What an older version left: the copy straight below .atoma-runs, sealed so.
      renameSync(join(first.workspace, readRunCopyPath(readRunId)), join(first.workspace, '.atoma-runs', readRunId));
      rmdirSync(join(first.workspace, '.atoma-runs', 'node_modules'));
      const db = new Database(f.db);
      try {
        const sealed = db.transaction(() => saveCheckpointWorkspace(db, first.workspace, readCheckpointWorkspace(first.workspace)))();
        db.prepare("UPDATE run_checkpoints SET payload=json_set(payload,'$.snapshotId',?,'$.workspaceDigest',?) WHERE id=?")
          .run(sealed.id, sealed.digest, first.id);
      } finally { db.close(); }
    } else {
      // The read run's own file changes meanwhile: the continuation reads what its source sealed.
      writeFileSync(join(read, 'browser', 'collect.js'), 'changed after the pause');
    }
    const second = reserve(first.id);
    const resumed = f.run(['--container', '--resume', first.id, 'Write two files in sequence'], '', { ...second.env, ...indexFor(second.id) });
    const checkpoints = new RunCheckpointStore(f.db);
    if (layout === 'legacy') {
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(2);
      expect(resumed.stderr).toContain(`read run ${readRunId}: the saved workspace holds its copy at .atoma-runs/${readRunId}, ` +
        `where runs before 2026-10-17 put it, not at .atoma-runs/node_modules/${readRunId}`);
      expect(f.errorReport().calls).toEqual([]);
      // Handed back untouched, as for a changed root actor: the source can still be continued.
      expect(checkpoints.projectStatus(first.id, viewer.orgId)?.state).toBe('paused');
      expect(checkpoints.projectStatus(second.id, viewer.orgId)?.state).toBe('unavailable');
      expect(() => checkpoints.read(first.id)).not.toThrow();
    } else {
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
      expect(f.report()).toMatchObject({ outcome: 'delivered', checkpointId: second.id });
      // The sealed copy, restored where the run reads it: nothing copied it again.
      expect(readFileSync(join(second.workspace, readRunCopyPath(readRunId), 'browser', 'collect.js'), 'utf8')).toBe('the bytes of the read run');
      expect(readFileSync(copied, 'utf8')).toBe('the bytes of the read run');
      expect(resumed.stdout).not.toContain('read runs copied');
      expect(readFileSync(join(second.workspace, 'phase-two.txt'), 'utf8')).toBe('phase-two.txt');
    }
  }, 90000);

  it.each([[0, false], [1, false], [0, true], [1, true]] as const)('replans after a client answer at boundary %i, surviving a post-plan crash: %s', (phase, crashAfterPlan) => {
    const f = fixture();
    const viewer = AuthStore.open(f.db).completeLogin({ provider: 'github', subject: 'question-owner', displayName: 'Owner', email: null, emailVerified: false }, null)!.viewer;
    const store = ProjectStore.open(f.db);
    const project = store.createProject({ orgId: viewer.orgId, principalId: viewer.principalId,
      project: { name: 'Question', slug: 'question', repositoryTarget: { installationId: '1', owner: 'owner', name: 'question', visibility: 'private' } } });
    const reserve = (resumeOf?: string) => {
      const id = randomUUID(), workspace = join(f.root, id, 'workspace'), runs = join(f.root, id, 'traces');
      store.createProjectRun({ orgId: viewer.orgId, principalId: viewer.principalId, projectId: project.projectId, projectRunId: id,
        request: { goal: 'Write two files in sequence', idempotencyKey: id, ...(resumeOf ? { resumeOf } : {}) },
        hostPaths: { workspacePath: workspace, runsPath: runs, skillsPath: join(f.root, 'skills'), logPath: join(f.root, id, 'run.log') } });
      store.transitionProjectRun({ orgId: viewer.orgId, projectRunId: id, from: 'queued', to: 'running' });
      return { id, workspace, env: { ATOMA_TENANT_RUN: '1', CHECKPOINT_TEST_TENANT: '1', ATOMA_RUN_ID: id,
        ATOMA_BUILD_WORKSPACE: workspace, ATOMA_RUNS_DIR: runs, CHECKPOINT_TEST_QUESTION_PHASE: String(phase),
        CHECKPOINT_TEST_NO_SKILL: crashAfterPlan ? '1' : '0' } };
    };
    const first = reserve();
    const paused = f.run(['--container', '--checkpoint', 'Write two files in sequence'], '', first.env);
    expect(paused.status, paused.stdout + paused.stderr).toBe(0);
    expect(f.report().outcome).toBe('partial');
    const checkpoints = new RunCheckpointStore(f.db);
    const question = checkpoints.clientQuestion(viewer.orgId, first.id)!;
    expect(question).toMatchObject({ phase, answer: null });
    expect(checkpoints.projectStatus(first.id, viewer.orgId)).toMatchObject({ state: 'paused', completed: phase });
    expect(() => checkpoints.read(first.id)).toThrow(/client answer/);
    const request = { questionId: question.questionId, idempotencyKey: randomUUID(), answer: { optionId: 'keep_both' } };
    expect(checkpoints.answerClientQuestion(viewer.orgId, first.id, viewer.principalId, request).created).toBe(true);
    expect(checkpoints.answerClientQuestion(viewer.orgId, first.id, viewer.principalId, request).created).toBe(false);
    const saved = checkpoints.read(first.id);
    const db = new Database(f.db);
    db.prepare('UPDATE run_checkpoint_recovery SET deadline=0 WHERE id=?').run(first.id);
    db.close();
    expect(checkpoints.read(first.id).remainingMs).toBe(saved.remainingMs); // Waiting uses no execution budget.
    const credit = f.counters();
    const digest = checkpointWorkspaceDigest(first.workspace);
    const second = reserve(first.id);
    let source = first.id;
    let continuation = second;
    if (crashAfterPlan) {
      const crashed = f.run(['--container', '--resume', source], 'replanned', { ...second.env, CHECKPOINT_TEST_EXPECT_ANSWER: '1' });
      expect(crashed.signal, crashed.stdout + crashed.stderr).toBe('SIGKILL');
      expect(checkpoints.read(second.id).root?.reconciledQuestionId).toBe(question.questionId);
      expect(f.counters()).toEqual(credit);
      source = second.id;
      continuation = reserve(source);
    }
    const resumed = f.run(['--container', '--resume', source], '', { ...continuation.env, CHECKPOINT_TEST_EXPECT_ANSWER: '1' });
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(f.report().outcome).toBe('delivered');
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    expect(readFileSync(join(f.root, 'answer-prompt.txt'), 'utf8')).toContain('Keep both login methods');
    expect(f.report().calls.filter(c => c.startsWith('plan:3:'))).toHaveLength(crashAfterPlan ? 0 : 1);
    // The crashed successor reviewed and recorded its replan; its own successor does not judge it again.
    expect(f.report().rootReviews).toBe(crashAfterPlan ? 0 : 1);
    expect(f.report().calls.filter(c => c.endsWith(':run-root'))).toHaveLength(1);
    expect(checkpointWorkspaceDigest(first.workspace)).toBe(digest);
    if (!crashAfterPlan) expect(f.counters().skills.n).toBe(2);
    if (phase === 1) expect(f.counters().atoms.n).toBe(credit.atoms.n * 2);
    expect(checkpoints.clientQuestion(viewer.orgId, first.id)?.answer?.principalId).toBe(viewer.principalId);
    expect(checkpoints.clientQuestion(viewer.orgId, second.id)).toBeNull();
    expect(() => checkpoints.read(first.id)).toThrow(/not at a resumable/);
  }, 90000);

  // Group D, review 2026-10-16: a resumed root used to re-judge its plan,
  // and a refusal ended the run with "Saved delegation plan requires a new run".
  describe('the recorded root delegation approval', () => {
    const paused = () => {
      const f = fixture();
      const first = f.run(['--pause-after-phase', '1', 'Write two files in sequence']);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      return { f, id: f.report().checkpointId };
    };

    it('reviews a legacy checkpoint without an approval record once, then delivers', () => {
      const { f, id } = paused();
      f.editPayload(id, "json_remove(payload, '$.root.approval')");
      const next = f.run(['--resume', id]);
      expect(next.status, next.stdout + next.stderr).toBe(0);
      expect(f.report().outcome).toBe('delivered');
      expect(f.report().rootReviews).toBe(1);
      expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    }, 90000);

    it.each([
      ['a saved subtask description', "json_set(payload, '$.root.plan.subtasks[1].description', 'Write phase-two.txt with care')"],
      ['the saved inputs', "json_set(payload, '$.root.inputs', json('{\"note\":\"changed\"}'))"],
    ])('reviews again when %s changed after the approval', (_, sql) => {
      const { f, id } = paused();
      f.editPayload(id, sql);
      const next = f.run(['--resume', id]);
      expect(next.status, next.stdout + next.stderr).toBe(0);
      expect(f.report().outcome).toBe('delivered');
      expect(f.report().rootReviews).toBe(1);
    }, 90000);

    // Group G4, 2026-10-16: a new suite is held to 12,000 characters by the
    // plan parser only; a plan saved with a longer one must still restore in
    // the real runner, in another process, through the stored schema bound.
    it('restores a saved plan whose suite is longer than the authored bound', () => {
      const { f, id } = paused();
      const source = `import { test, expect } from 'vitest';\n// ${'x'.repeat(20_000 - 42)}`;
      expect(source).toHaveLength(20_000);
      const suite = JSON.stringify({ requirement: 'phase one wrote its file', cwd: '.', source });
      const quoted = suite.replaceAll("'", "''");
      f.editPayload(id, `json_set(payload, '$.root.plan.subtasks[0].acceptanceTests', json('${quoted}'))`);
      const next = f.run(['--resume', id]);
      expect(next.status, next.stdout + next.stderr).toBe(0);
      expect(f.report().outcome).toBe('delivered');
      // The edit changed the approved plan, so its remaining work is reviewed once and nothing is replanned.
      expect(f.report().rootReviews).toBe(1);
      expect(f.report().calls.filter(c => c.startsWith('plan:3:'))).toHaveLength(0);
      expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    }, 90000);

    it('records the plan before executing a recorded approval, so the phase count is checked', () => {
      const { f, id } = paused();
      const next = f.run(['--resume', id, '--pause-after-phase', '3']);
      expect(next.status).not.toBe(0);
      expect(next.stdout + next.stderr).toContain('--pause-after-phase exceeds the number of root phases');
      const failed = existsSync(join(f.root, 'error-report.json')) ? f.errorReport() : f.report();
      expect(failed.rootReviews).toBe(0);
      expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\n');
    }, 90000);

    it('replans only the remaining work when a legacy plan is refused on resume', () => {
      const { f, id } = paused();
      f.editPayload(id, "json_remove(payload, '$.root.approval')");
      const next = f.run(['--resume', id], '', { CHECKPOINT_TEST_REFUSE_ROOT_REVIEW: 'first' });
      expect(next.status, next.stdout + next.stderr).toBe(0);
      expect(f.report().outcome).toBe('delivered');
      expect(f.report().rootReviews).toBe(2);
      expect(f.report().calls.filter(c => c.startsWith('plan:3:'))).toHaveLength(1);
      expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    }, 90000);

    it('ends a resumed run whose remaining plan is refused three times', () => {
      const { f, id } = paused();
      f.editPayload(id, "json_remove(payload, '$.root.approval')");
      const next = f.run(['--resume', id], '', { CHECKPOINT_TEST_REFUSE_ROOT_REVIEW: 'always' });
      expect(next.status).not.toBe(0);
      expect(next.stdout + next.stderr).toContain('Saved delegation plan requires a new run');
      expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\n');
    }, 90000);

    it('ends a resumed run at once when its remaining work must fan out', () => {
      const { f, id } = paused();
      f.editPayload(id, "json_remove(payload, '$.root.approval')");
      const next = f.run(['--resume', id], '', { CHECKPOINT_TEST_ROOT_FAN_OUT: '1' });
      expect(next.status).not.toBe(0);
      expect(next.stdout + next.stderr).toContain('remaining work must fan out');
      const failed = existsSync(join(f.root, 'error-report.json')) ? f.errorReport() : f.report();
      expect(failed.rootReviews).toBe(1);
      expect(failed.calls.filter(c => c.startsWith('plan:3:'))).toHaveLength(0);
      expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\n');
    }, 90000);
  });

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

  // Code review 2026-10-09, 1.1: the boundary was sealed while the phase's
  // server ran; the pause's drain sent SIGTERM, the server persisted its state,
  // and release() failed the run as 'Workspace changed during shutdown'.
  it('pauses a phase whose server writes on SIGTERM, and resumes it', () => {
    const f = fixture();
    const first = f.run(['--pause-after-phase', '1', 'Write two files in sequence'], '', { CHECKPOINT_TEST_SERVER: '1' });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(f.report()).toMatchObject({ outcome: 'partial', paused: true });
    expect(readFileSync(join(f.root, 'workspace', 'notes.json'), 'utf8')).toBe('[]');
    const next = f.run(['--resume', f.report().checkpointId]);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(f.report().outcome).toBe('delivered');
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
  }, 90000);

  it('keeps a client question answerable when the phase before it left a server that writes on SIGTERM', () => {
    const f = fixture();
    const viewer = AuthStore.open(f.db).completeLogin({ provider: 'github', subject: 'drain-owner', displayName: 'Owner', email: null, emailVerified: false }, null)!.viewer;
    const store = ProjectStore.open(f.db);
    const project = store.createProject({ orgId: viewer.orgId, principalId: viewer.principalId,
      project: { name: 'Drain', slug: 'drain', repositoryTarget: { installationId: '1', owner: 'owner', name: 'drain', visibility: 'private' } } });
    const reserve = (resumeOf?: string) => {
      const id = randomUUID(), workspace = join(f.root, id, 'workspace'), runs = join(f.root, id, 'traces');
      store.createProjectRun({ orgId: viewer.orgId, principalId: viewer.principalId, projectId: project.projectId, projectRunId: id,
        request: { goal: 'Write two files in sequence', idempotencyKey: id, ...(resumeOf ? { resumeOf } : {}) },
        hostPaths: { workspacePath: workspace, runsPath: runs, skillsPath: join(f.root, 'skills'), logPath: join(f.root, id, 'run.log') } });
      store.transitionProjectRun({ orgId: viewer.orgId, projectRunId: id, from: 'queued', to: 'running' });
      return { id, workspace, env: { ATOMA_TENANT_RUN: '1', CHECKPOINT_TEST_TENANT: '1', ATOMA_RUN_ID: id,
        ATOMA_BUILD_WORKSPACE: workspace, ATOMA_RUNS_DIR: runs, CHECKPOINT_TEST_QUESTION_PHASE: '1' } };
    };
    const first = reserve();
    const paused = f.run(['--container', '--checkpoint', 'Write two files in sequence'], '', { ...first.env, CHECKPOINT_TEST_SERVER: '1' });
    expect(paused.status, paused.stdout + paused.stderr).toBe(0);
    expect(f.report().outcome).toBe('partial');
    expect(readFileSync(join(first.workspace, 'notes.json'), 'utf8')).toBe('[]');
    const checkpoints = new RunCheckpointStore(f.db);
    expect(checkpoints.projectStatus(first.id, viewer.orgId)).toMatchObject({ state: 'paused', completed: 1 });
    const question = checkpoints.clientQuestion(viewer.orgId, first.id)!;
    expect(checkpoints.answerClientQuestion(viewer.orgId, first.id, viewer.principalId,
      { questionId: question.questionId, idempotencyKey: randomUUID(), answer: { optionId: 'keep_both' } }).created).toBe(true);
    const second = reserve(first.id);
    const resumed = f.run(['--container', '--resume', first.id], '', { ...second.env, CHECKPOINT_TEST_EXPECT_ANSWER: '1' });
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(f.report().outcome).toBe('delivered');
    expect(readFileSync(join(second.workspace, 'notes.json'), 'utf8')).toBe('[]');
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
    expect(() => store.claim(b, false)).toThrow('still owned');
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
    expect(() => store.read(id)).toThrow('backend_unknown');
    a.processes = [];
    db.prepare('UPDATE run_checkpoints SET payload=? WHERE id=?').run(JSON.stringify(a), id);
    store.beginAction(a, owner, 'tool', 'write_file', { path: 'uncertain.txt', content: 'intent' });
    expect(() => store.read(id)).toThrow('tool_pending');
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

  // Code review 2026-10-09, 1.6: the client-question boundary sealed without
  // afterPhase's degradation, so a seed the snapshot refuses (here an 11 MiB
  // file) failed the whole run when a question was due before phase 1.
  it('degrades a client-question boundary over an unsupported workspace like afterPhase: no question, run goes on', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-question-'))); roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'dataset.bin'), Buffer.alloc(11 * 1024 * 1024));
    const store = new RunCheckpointStore(join(root, 'atoma.db'));
    const id = randomUUID();
    const data = {
      version: 1, id, scope: { orgId: 'o', projectId: 'p', principalId: 'u', runId: id }, goal: 'g', workspace,
      policy: '{}', actor: { name: 'Meristem', atomId: 'a', version: 1 }, checklist: [], root: null, completed: [],
      workspaceDigest: null, processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600_000, lastRunId: null,
    };
    const warnings: string[] = [];
    let drained = 0;
    await withRecoveryEffects(async () => {
      const cp = new SequentialCheckpoint(data as never, store, {
        fresh: true, automatic: true, account: () => ({ tokens: 1, costUsd: 0.1 }), deadlineAt: Date.now() + 600_000,
        settle: async () => {}, processes: () => [], warn: (m: string) => warnings.push(m),
        drain: () => { drained++; return Promise.resolve(); },
        assessClientQuestion: () => Promise.resolve({ question: 'Which database?', options: [
          { id: 'a', label: 'SQLite', consequence: 'file' }, { id: 'b', label: 'Postgres', consequence: 'server' }] }),
      } as never);
      cp.planned({ description: 'g' }, { subtasks: [{}, {}], aggregation: { mode: 'sequential' } } as never, {}, 2);
      await cp.beforePhase(0, {} as never);
      expect(cp.paused).toBe(false);
      expect(cp.completed).toEqual([]);
    });
    expect(warnings).toEqual([expect.stringContaining('Durable continuation unavailable')]);
    // The live backend was never stopped for a tree that cannot be sealed.
    expect(drained).toBe(0);
    expect(store.clientQuestion('o', id)).toBeNull();
  });

  // Code review 2026-10-09, 2.4: only the count (32) was checked before a
  // question was asked, not the 24000-character budget. A few long answers
  // filled the history, the question was asked, and no answer could then be
  // recorded, a plain option included: the run could only be cancelled.
  it('does not ask a client question the answer history has no characters left to record', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-history-'))); roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'index.html'), '<p>hi</p>');
    const store = new RunCheckpointStore(join(root, 'atoma.db'));
    const id = randomUUID();
    const data = {
      version: 1, id, scope: { orgId: 'o', projectId: 'p', principalId: 'u', runId: id }, goal: 'g', workspace,
      policy: '{}', actor: { name: 'Meristem', atomId: 'a', version: 1 }, checklist: [], root: null, completed: [],
      workspaceDigest: null, processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600_000, lastRunId: null,
    };
    // Eight answers, far below the 32-entry count, about 22000 encoded characters.
    const clientAnswers = Array.from({ length: 8 }, () => ({
      questionId: randomUUID(), question: 'q'.repeat(600), selectedOption: null, text: 't'.repeat(2000),
      principalId: randomUUID(), at: new Date().toISOString(),
    }));
    expect(JSON.stringify(clientAnswers).length).toBeLessThan(24_000);
    let asked = 0;
    await withRecoveryEffects(async () => {
      const cp = new SequentialCheckpoint(data as never, store, {
        fresh: true, automatic: true, account: () => ({ tokens: 1, costUsd: 0.1 }), deadlineAt: Date.now() + 600_000,
        settle: async () => {}, processes: () => [], warn: () => {}, drain: () => Promise.resolve(),
        assessClientQuestion: () => { asked++; return Promise.resolve({ question: 'Which database should the app use?', whyClient: 'w', missingDecision: 'm', options: [
          { id: 'a', label: 'SQLite', consequence: 'file' }, { id: 'b', label: 'Postgres', consequence: 'server' }] }); },
      });
      cp.planned({ description: 'g', inputs: { clientAnswers } }, { subtasks: [{}, {}], aggregation: { mode: 'sequential' } } as never, {}, 2);
      await expect(cp.beforePhase(0, {} as never)).rejects.toThrow('Client answer history is full; start a new scoped run');
    });
    expect(asked).toBe(1);
    expect(store.clientQuestion('o', id)).toBeNull();
  });

  // Code review 2026-10-09, 1.4: the saved root actor is checked after the
  // successor claimed the continuation, and the successor's own catalog
  // seeding can move Meristem's version. The refusal consumed the source for
  // good and left the successor `running`, blocked by its own seeding.
  it('hands a project continuation back when its saved root actor has changed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-actor-'))); roots.push(root);
    const dbPath = join(root, 'atoma.db');
    const registry = new AtomRegistry(openDb(dbPath));
    const schema = { type: 'object', properties: {} };
    const base = [{ name: 'read_file', description: 'Read a file', inputSchema: schema }];
    const docs = { name: 'search_project_docs', description: 'Search the project documents', inputSchema: schema };
    const seed = (toolDecls: typeof base) => seedTissueCatalog({ registry, toolDecls, log: () => {} });
    const paused = seed([...base, docs]);
    const workspace = join(root, 'ws-source');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'index.html'), '<p>phase 1 validated</p>');
    const store = new RunCheckpointStore(dbPath);
    const sourceId = randomUUID();
    const scope = { orgId: 'org', projectId: 'proj', principalId: 'alice', runId: sourceId };
    const data = { version: 1, id: sourceId, scope, goal: 'Build the app', workspace, policy: '{}',
      actor: { name: paused.name, atomId: paused.atomId, version: paused.version }, checklist: [], root: null, completed: [],
      workspaceDigest: null, processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600_000, lastRunId: null };
    const phase = (n: number) => ({ description: `phase ${n}`, child: 'Cell' });
    await withRecoveryEffects(async () => {
      const cp = new SequentialCheckpoint(data as never, store, { fresh: true, automatic: true, pauseAfter: 1,
        account: () => ({ tokens: 1000, costUsd: 0.42 }), deadlineAt: Date.now() + 600_000, settle: async () => {}, processes: () => [] });
      cp.planned({ description: 'Build the app' }, { subtasks: [phase(1), phase(2)], aggregation: { mode: 'sequential' } } as never, {}, 2);
      await cp.beforePhase(0, phase(1));
      await expect(cp.afterPhase(0, { output: { ok: true }, summary: 'phase 1 done', producedBy: { name: 'Cell', tier: 2, viaFallback: false },
        trace: [{ kind: 'verdict-result', payload: { approved: true } }] } as never)).rejects.toThrow();
      await cp.release();
    });
    expect(store.projectStatus(sourceId, 'org')?.state).toBe('paused');
    // Another run of the commons has no retrieval corpus: Meristem moves on.
    seed(base);
    const saved = store.read(sourceId);
    const nextId = randomUUID();
    const nextWorkspace = join(root, 'ws-next');
    await withRecoveryEffects(async () => {
      const successor = new SequentialCheckpoint({ ...saved, id: nextId, workspace: nextWorkspace, scope: { ...scope, runId: nextId } }, store, {
        fresh: false, source: saved, automatic: true, account: () => saved.consumed, deadlineAt: Date.now() + 600_000,
        settle: async () => {}, processes: () => [], restoreWorkspace: () => store.materialize(saved, nextWorkspace, false) });
      // The runner's order: the successor seeds its catalog, then selects the saved actor.
      seed([...base, docs]);
      expect(() => savedRootActor(registry, saved.actor!, successor)).toThrow('Saved root actor has changed; resume refused');
    });
    expect(store.projectStatus(sourceId, 'org')?.state).toBe('paused');
    expect(store.projectStatus(nextId, 'org')?.state).toBe('unavailable');
    expect(store.read(sourceId)).toEqual(saved);
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

  // Review 2026-10-16 (D5): an approved phase whose parent-owned suite did not
  // run proved nothing, like an uncovered obligation; parent tests no longer
  // write `refusal`, so `isLanded` alone would have saved it as a resume prefix.
  it('does not seed a resume with an approved phase whose parent-owned suite did not run', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-parent-tests-'))); roots.push(root);
    const workspace = join(root, 'ws');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'add.ts'), 'export const add = (a: number, b: number) => a + b;');
    const store = new RunCheckpointStore(join(root, 'atoma.db'));
    const id = randomUUID();
    const data = { version: 1, id, scope: { orgId: 'o', projectId: 'p', principalId: 'u', runId: id }, goal: 'g', workspace,
      policy: '{}', actor: { name: 'Meristem', atomId: 'a', version: 1 }, checklist: [], root: null, completed: [],
      workspaceDigest: null, processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600_000, lastRunId: null };
    const warnings: string[] = [];
    await withRecoveryEffects(async () => {
      const cp = new SequentialCheckpoint(data as never, store, { fresh: true, automatic: true,
        account: () => ({ tokens: 1, costUsd: 0.1 }), deadlineAt: Date.now() + 600_000, settle: async () => {},
        processes: () => [], warn: (line: string) => warnings.push(line) });
      cp.planned({ description: 'g' }, { subtasks: [{ description: 'phase 1' }, { description: 'phase 2' }], aggregation: { mode: 'sequential' } } as never, {}, 2);
      await cp.beforePhase(0, { description: 'phase 1' });
      await cp.afterPhase(0, { output: { ok: true }, summary: 'phase 1 done', producedBy: { name: 'Cell', tier: 2, viaFallback: false },
        trace: [{ kind: 'verdict-result', ts: '0', atom: 'Meristem', payload: { approved: true, reasoning: 'reviewed' } }],
        parentTests: [{ suiteDigest: 'd', workspaceDigest: 'w', status: 'unavailable', cause: 'runner-error', passed: 0, failed: 0, skipped: 0,
          details: 'crashed', judged: true }] });
      await cp.release();
    });
    expect(warnings).toContain('Durable continuation disabled: this phase did not close with a complete approved result');
    expect(data.completed).toEqual([]);
  });

  it('keeps the checkpoint out of nested dispatch contexts', () => {
    const ctx = makeCtx();
    Object.assign(ctx, { rootCheckpoint: {} });
    expect(forkBranch(ctx, 'child').rootCheckpoint).toBeUndefined();
  });

  // Group D, review 2026-10-16: the SHORT root called cell.plan once, so one
  // unparseable reply ended the run.
  describe('the SHORT root plan', () => {
    const plan = { reasoning: 'r', subtasks: [{ description: 'Write a.txt', outputs: ['a.txt'] }], aggregation: { mode: 'sequential' }, expectedOutput: 'a.txt' };
    const good = JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'r' }, plan]);
    const bad = good.replace('"reasoning":"r"', '"reasoning":"say "hi""');
    const cell = () => {
      const db = openDb(':memory:');
      const registry = new AtomRegistry(db);
      const type = registry.create(2, { description: 'cell', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' });
      const atom = L2Atom.fromType(type, registry);
      const delivered: Result = { output: 'done', summary: 'done', trace: [], producedBy: { tier: 2, name: atom.name, viaFallback: false } };
      atom.execute = async () => delivered;
      return { atom, delivered, close: () => db.close() };
    };

    it('asks the entry cell again after an unparseable reply, with the parser message', async () => {
      const { atom, delivered, close } = cell();
      const ctx = makeCtx();
      ctx.llm.enqueueText(bad);
      ctx.llm.enqueueText(good);
      await expect(shortRootHandle(atom)({ description: 'Write a.txt' }, ctx)).resolves.toBe(delivered);
      close();
      expect(ctx.llm.calls).toHaveLength(2);
      expect(ctx.llm.calls[1]?.userContent).toContain('plan reply unparseable');
      // On the planner channel (group G4): never merged into the task's constraints.
      expect(ctx.llm.calls[1]?.userContent).toContain('PREVIOUS PLAN ATTEMPT:');
      expect(ctx.llm.calls[1]?.userContent).not.toContain('Constraints:');
    });

    it('gives up after three unparseable replies', async () => {
      const { atom, close } = cell();
      const ctx = makeCtx();
      for (let i = 0; i < 3; i++) ctx.llm.enqueueText(bad);
      await expect(shortRootHandle(atom)({ description: 'Write a.txt' }, ctx)).rejects.toBeInstanceOf(PlanParseError);
      close();
      expect(ctx.llm.calls).toHaveLength(3);
    });
  });

  it('parses bounded pause/resume arguments', () => {
    expect(parseRunnerArgs(['--pause-after-phase', '2', 'goal'])).toMatchObject({ checkpoint: true, pauseAfterPhase: 2, goal: 'goal' });
    expect(() => parseRunnerArgs(['--pause-after-phase', '0', 'goal'])).toThrow('positive phase');
    expect(() => parseRunnerArgs(['--resume', '../elsewhere'])).toThrow('UUID');
  });
});
