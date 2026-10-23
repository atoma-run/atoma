import { AuthStore } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { checkpointWorkspaceDigest, RunCheckpointStore } from '../src/run/checkpoint.js';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupCheckpointFixtures, fixture } from './helpers/checkpointFixture.js';

afterEach(cleanupCheckpointFixtures);

describe('durable sequential run continuation', () => {
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
});
