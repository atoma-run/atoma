import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { withRecoveryEffects } from '../src/core/recoveryEffects.js';
import { RunCheckpointStore, SequentialCheckpoint } from '../src/run/checkpoint.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';

const roots: string[] = [];
afterEach(() => { closeStoreHandles(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-prune-'))); roots.push(root);
  const f = projectRetrievalFixture(root);
  const checkpoints = new RunCheckpointStore(f.dbPath);
  const raw = new Database(f.dbPath);
  const journal = (id: string, state: string, released = 0) => {
    raw.prepare("INSERT INTO run_checkpoints (id,state,owner,pid,host,released,payload) VALUES (?,?,?,?,?,?,'{}')")
      .run(id, state, randomUUID(), 1, 'host', released);
    for (let i = 0; i < 260; i++) {
      raw.prepare("INSERT INTO run_checkpoint_actions (id,phase,kind,name,state,request_digest,result) VALUES (?,0,'tool','write_file','done','d',?)")
        .run(id, 'x'.repeat(1000));
    }
    raw.prepare("INSERT INTO run_checkpoint_recovery VALUES (?,0,NULL,'{}',0)").run(id);
    raw.prepare('INSERT INTO run_checkpoint_pauses (id) VALUES (?)').run(id);
  };
  const left = (id: string) => ({
    actions: raw.prepare('SELECT COUNT(*) FROM run_checkpoint_actions WHERE id=?').pluck().get(id),
    recovery: raw.prepare('SELECT COUNT(*) FROM run_checkpoint_recovery WHERE id=?').pluck().get(id),
    pauses: raw.prepare('SELECT COUNT(*) FROM run_checkpoint_pauses WHERE id=?').pluck().get(id),
    checkpoint: raw.prepare('SELECT state FROM run_checkpoints WHERE id=?').pluck().get(id),
  });
  return { ...f, root, checkpoints, raw, journal, left };
}

it('drops the journal of finished checkpoints and keeps live, paused and in-flight continuation sources', () => {
  const f = fixture();
  try {
    const finished = f.makeRun().run.projectRunId;
    const source = f.makeRun().run.projectRunId;
    const paused = randomUUID();
    const crashed = randomUUID();
    f.journal(finished, 'finished');
    f.journal(source, 'finished');
    f.journal(paused, 'ready', 1);
    f.journal(crashed, 'running');
    // The successor claimed `source` (state finished) and is still queued:
    // it may yet hand the source back with the journal it is judged on.
    const successor = f.projects.createProjectRun({ orgId: f.viewer.orgId, projectId: f.project.projectId, principalId: f.viewer.principalId,
      request: { goal: f.projects.getProjectRun(f.viewer.orgId, source)!.goal, idempotencyKey: randomUUID(), resumeOf: source },
      hostPaths: { workspacePath: join(f.root, 'next', 'workspace'), runsPath: join(f.root, 'next', 'runs'), logPath: join(f.root, 'next', 'run.log') } })!.run;
    expect(successor.status).toBe('queued');

    expect(f.checkpoints.pruneFinished()).toBe(1);
    expect(f.left(finished)).toEqual({ actions: 0, recovery: 0, pauses: 0, checkpoint: 'finished' });
    for (const kept of [source, paused, crashed]) expect(f.left(kept)).toMatchObject({ actions: 260, recovery: 1, pauses: 1 });

    // Once the successor has ended, nothing can hand the source back.
    f.projects.transitionProjectRun({ orgId: f.viewer.orgId, projectRunId: successor.projectRunId, from: 'queued', to: 'failed', error: 'stopped' });
    expect(f.checkpoints.pruneFinished()).toBe(1);
    expect(f.left(source)).toMatchObject({ actions: 0, recovery: 0, pauses: 0 });
    expect(f.checkpoints.pruneFinished()).toBe(0);
  } finally { f.raw.close(); }
});

it('prunes at finalization, its own journal included, without failing the run', async () => {
  const f = fixture();
  try {
    const older = randomUUID();
    f.journal(older, 'finished');
    const workspace = join(f.root, 'ws');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'index.html'), '<p>work</p>');
    const id = randomUUID();
    const data = { version: 1, id, goal: 'Build the app', workspace, policy: '{}', actor: null, checklist: [], root: null, completed: [],
      workspaceDigest: null, processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600_000, lastRunId: null };
    const warnings: string[] = [];
    await withRecoveryEffects(async () => {
      const cp = new SequentialCheckpoint(data as never, f.checkpoints, { fresh: true, account: () => ({ tokens: 0, costUsd: 0 }),
        deadlineAt: Date.now() + 600_000, settle: async () => {}, processes: () => [], warn: (m) => warnings.push(m) });
      const phase = { description: 'phase 1', child: 'Cell' };
      cp.planned({ description: 'Build the app' }, { subtasks: [phase], aggregation: { mode: 'sequential' } } as never, {}, 1);
      await cp.beforePhase(0, phase);
      await cp.tools({ has: () => true, execute: async () => ({ ok: true }) }).execute('write_file', { path: 'a' });
      expect(f.left(id).actions).toBe(1);
      cp.finalizing();
    });
    expect(f.left(id)).toMatchObject({ actions: 0, checkpoint: 'finished' });
    expect(f.left(older)).toMatchObject({ actions: 0, recovery: 0, pauses: 0 });
    expect(warnings).toEqual([]);
  } finally { f.raw.close(); }
});
