import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthStore } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { openLedgerHandle, appendLedgerStrict } from '../src/core/ledger.js';
import { RunInitialStateStore } from '../src/run/initialState.js';
import { RunCheckpointStore } from '../src/run/checkpoint.js';
import { validateComputeNext } from '../src/supervisor/computeValidation.js';
import { OLLAMA_PINS } from './tier-pins.js';
import { cleanupCheckpointFixtures, fixture } from './helpers/checkpointFixture.js';

// Every start is a new process: real runner, store, supervision and workspace;
// only provider replies and the container tool adapter are replaced in the existing fixture.
afterEach(cleanupCheckpointFixtures);
describe('Compute initial state through cold runner continuation and verification', () => {
  it.each([false, true])('retains the prepared seed and continuation prefix without touching source rows (client answer=%s)', async answered => {
    // The ordinary pause uses a new workspace service for every segment.
    const f = fixture(!answered); const db = openLedgerHandle(f.db);
    const viewer = AuthStore.open(f.db).completeLogin({ provider: 'github', subject: 'initial-owner', displayName: 'Owner', email: null, emailVerified: false }, null)!.viewer;
    const projects = ProjectStore.open(f.db);
    const project = projects.createProject({ orgId: viewer.orgId, principalId: viewer.principalId,
      project: { name: 'Initial', slug: 'initial', repositoryTarget: { installationId: '1', owner: 'owner', name: 'initial', visibility: 'private' } } });
    db.prepare('UPDATE projects SET execution_target_json=? WHERE project_id=?').run(JSON.stringify({ kind: 'customer-device', deviceId: randomUUID() }), project.projectId);
    const reserve = (resumeOf?: string) => {
      const id = randomUUID(), workspace = join(f.root, id, 'workspace'), runs = join(f.root, id, 'traces');
      projects.createProjectRun({ orgId: viewer.orgId, principalId: viewer.principalId, projectId: project.projectId, projectRunId: id,
        request: { goal: 'Write two files in sequence', idempotencyKey: id, ...(resumeOf ? { resumeOf } : {}) },
        hostPaths: { workspacePath: workspace, runsPath: runs, skillsPath: join(f.root, 'skills'), logPath: join(f.root, id, 'run.log') } });
      projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: id, from: 'queued', to: 'running' });
      return { id, workspace, env: { ATOMA_TENANT_RUN: '1', CHECKPOINT_TEST_TENANT: '1', CHECKPOINT_TEST_CAPTURE_COMPUTE: '1', ATOMA_RUN_ID: id,
        ATOMA_BUILD_WORKSPACE: workspace, ATOMA_RUNS_DIR: runs } };
    };
    const first = reserve(); const seed = join(f.root, 'seed'); mkdirSync(seed);
    writeFileSync(join(seed, '.atoma-probes.json'), '{"version":1,"entries":[{"cmd":"node verify.cjs","exitCode":0}]}');
    writeFileSync(join(seed, '.env.local'), 'private fixture seed');
    writeFileSync(join(seed, 'original.txt'), 'original bytes');
    const paused = f.run(['--container', '--checkpoint', '--seed', seed, 'Write two files in sequence'], '', { ...first.env, CHECKPOINT_TEST_REQUEST_PAUSE: answered ? '0' : '1', CHECKPOINT_TEST_QUESTION_PHASE: answered ? '1' : undefined });
    expect(paused.status, paused.stdout + paused.stderr).toBe(0);
    const states = new RunInitialStateStore(db);
    const initial = states.read({ sourceRunId: first.id, orgId: viewer.orgId, projectId: project.projectId });
    expect(initial).not.toBeNull();
    expect(initial?.continuation).toBeUndefined();
    if (answered) {
      const checkpoints = new RunCheckpointStore(f.db);
      const question = checkpoints.clientQuestion(viewer.orgId, first.id)!;
      expect(question).not.toBeNull();
      checkpoints.answerClientQuestion(viewer.orgId, first.id, viewer.principalId,
        { questionId: question.questionId, idempotencyKey: randomUUID(), answer: { optionId: 'keep_both' } });
    }
    const next = reserve(first.id);
    const resumed = f.run(['--container', '--resume', first.id], '', { ...next.env, CHECKPOINT_TEST_QUESTION_PHASE: answered ? '1' : undefined, CHECKPOINT_TEST_EXPECT_ANSWER: answered ? '1' : '0' });
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    const source = states.read({ sourceRunId: next.id, orgId: viewer.orgId, projectId: project.projectId })!;
    expect(source.continuation?.completed).toHaveLength(1);
    expect(source.continuation?.replanAfterAnswer).toBe(answered);
    const frozen = join(f.root, 'frozen'); states.materialize(source, frozen);
    expect(readFileSync(join(frozen, 'phase-one.txt'), 'utf8')).toBeTruthy();
    expect(() => readFileSync(join(frozen, 'phase-two.txt'))).toThrow();
    expect(readFileSync(join(frozen, '.env.local'), 'utf8')).toBe('private fixture seed');
    expect(readFileSync(join(frozen, '.atoma-probes.json'), 'utf8')).toContain('entries');
    // Destroy the old seed: validation must use the sealed launch state, not current files or publication inventories.
    rmSync(seed, { recursive: true }); writeFileSync(join(next.workspace, 'original.txt'), 'source output changed');
    projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: next.id, from: 'running', to: 'failed', error: 'fixture complete' });
    const sourcePayload = db.prepare('SELECT payload FROM run_checkpoints WHERE id=?').get(next.id);
    appendLedgerStrict({ kind: 'type-credit-withheld', entity: 'Water', scope: { runId: next.id, orgId: viewer.orgId, projectId: project.projectId },
      detail: { automaticValidation: true } }, db);
    const outcome = await validateComputeNext({ repoRoot: process.cwd(), dbPath: f.db, store: projects, skillsDir: join(f.root, 'skills'),
      runsDir: join(f.root, 'operator-runs'), supervisorDir: join(f.root, 'supervisor'), leasePath: join(f.root, 'lease.db'), allowed: () => true,
      hostEnv: { ...OLLAMA_PINS, ATOMA_REQUIRE_ISOLATION: '0', ATOMA_SKILL_LEARN: '0', ATOMA_SKILL_PROMOTE: '0', ATOMA_SKILL_DIRECT: '0', ATOMA_JEV: '0' },
      launch: async input => {
        const child = f.run(['--container', '--depth', 'deep', input.goal], '', { ...input.env, CHECKPOINT_TEST_TENANT: '1', CHECKPOINT_TEST_QUESTION_PHASE: answered ? '1' : undefined, CHECKPOINT_TEST_EXPECT_ANSWER: answered ? '1' : '0' });
        expect(child.status, child.stdout + child.stderr).toBe(0);
        return child.stdout;
      } });
    expect(outcome?.outcome, JSON.stringify(db.prepare("SELECT detail FROM lifecycle_events WHERE kind='compute-validation' ORDER BY seq DESC LIMIT 1").get())).toBe('compute-validated');
    const writes = readFileSync(join(f.root, 'effects.log'), 'utf8').trim().split('\n');
    expect(writes.filter(path => path === 'phase-one.txt')).toHaveLength(1);
    expect(writes.filter(path => path === 'phase-two.txt')).toHaveLength(2);
    expect(db.prepare('SELECT payload FROM run_checkpoints WHERE id=?').get(next.id)).toEqual(sourcePayload);
    expect(projects.getProjectRun(viewer.orgId, next.id)?.status).toBe('failed');
    new RunCheckpointStore(f.db).pruneSnapshots();
    expect(states.read({ sourceRunId: next.id, orgId: viewer.orgId, projectId: project.projectId })).not.toBeNull();
  }, 90000);
});
