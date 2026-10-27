import { readArchivedToolEvidence } from '../src/core/evidenceArchive.js';
import { createAttestationLog } from '../src/core/attestation.js';
import { AuthStore } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { checkpointWorkspaceDigest, RunCheckpointStore } from '../src/run/checkpoint.js';
import { readCheckpointWorkspace, saveCheckpointWorkspace } from '../src/run/checkpointWorkspace.js';
import { encodeReadRunsIndex, READ_RUNS_ENV, readRunCopyPath } from '../src/contracts/readRuns.js';
import { buildWorkspaceArtifactManifest } from '../src/projects/artifacts.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { withRecoveryEffects, setRecoveryEffectHandler } from '../src/core/recoveryEffects.js';
import { cleanupCheckpointFixtures, fixture } from './helpers/checkpointFixture.js';

afterEach(cleanupCheckpointFixtures);

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

  it('preserves complete archives across a cold continuation, readable without crediting historical execution', () => {
    const f = fixture();
    const first = f.run(['--pause-after-phase', '1', 'Write two files in sequence'], '', { CHECKPOINT_TEST_LARGE_EVIDENCE: '1' });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const before = f.report();
    const store = new RunCheckpointStore(f.db);
    const checkpoint = store.read(before.checkpointId);
    const archives = store.historicalEvidence(checkpoint);
    expect(archives.length).toBeGreaterThan(0);
    expect(readArchivedToolEvidence(archives[0]!.fullEvidence!)).toContain('CHECKPOINT_FULL_PROOF');
    expect(archives[0]!.fullEvidence!.bytes).toBeGreaterThan(200000);
    const log = createAttestationLog(undefined, archives);
    expect(log.size).toBe(0);
    expect(log.forAttempt(1)).toEqual([]);
    expect(log.forBranch(archives[0]!.branchId)).toEqual([]);
    expect(log.get(archives[0]!.eventId)?.historical).toBe(true);
    const credit = f.counters();
    const next = f.run(['--resume', before.checkpointId], '', { CHECKPOINT_TEST_READ_HISTORY: '1' });
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(f.report()).toMatchObject({ outcome: 'delivered', historicalRead: true });
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    expect(f.counters().atoms.n).toBe(credit.atoms.n * 2);
  }, 90000);

  it('keeps work partial without implementation replay when root evidence reading is invalid', () => {
    const f = fixture();
    const result = f.run(['Write two files in sequence'], '', { CHECKPOINT_TEST_ROOT_BAD_READ: '1' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.report().outcome).toBe('partial');
    expect(readFileSync(join(f.root, 'effects.log'), 'utf8')).toBe('phase-one.txt\nphase-two.txt\n');
    expect(result.stderr).toContain('acceptance review incomplete');
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
});
