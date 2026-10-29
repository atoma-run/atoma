import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ComputeValidationQueue, assertComputeValidationClaim, computeValidationSourceForTrace, readComputeValidation } from '../src/core/computeValidation.js';
import { appendLedgerStrict, readLedger } from '../src/core/ledger.js';
import { type ComputeValidationLaunch } from '../src/contracts/computeValidation.js';
import { withheldComputeKnowledge } from '../src/contracts/executionTarget.js';

describe('durable Compute validation admission', () => {
  let db: Database.Database;
  let queue: ComputeValidationQueue;
  let job: ComputeValidationLaunch;
  beforeEach(() => {
    db = new Database(':memory:');
    queue = new ComputeValidationQueue(db);
    db.exec(`CREATE TABLE project_runs(project_run_id TEXT PRIMARY KEY,org_id TEXT,project_id TEXT,status TEXT,ended_at TEXT)`);
    job = source();
  });
  afterEach(() => db.close());
  function source(status = 'delivered'): ComputeValidationLaunch {
    const value = { sourceRunId: randomUUID(), orgId: randomUUID(), projectId: randomUUID() };
    db.prepare('INSERT INTO project_runs VALUES (?,?,?,?,?)').run(value.sourceRunId,value.orgId,value.projectId,status,new Date().toISOString());
    return value;
  }
  function observation(value = job, automatic = true): void {
    const detail = withheldComputeKnowledge('success','Cell');
    if (!automatic) delete detail.automaticValidation;
    appendLedgerStrict({ kind: 'skill-credit-withheld', entity: 'molecule/recipe', detail,
      scope: { orgId: value.orgId, projectId: value.projectId, runId: value.sourceRunId } }, db);
  }
  it('coalesces all observations from a source, atomically and across restarts', () => {
    observation(); observation(); queue.discover(); queue.discover();
    expect(queue.pending()).toEqual({ ...job, status: 'queued' });
    expect(queue.claim(queue.pending()!)).toBe(true);
    expect(new ComputeValidationQueue(db).claim({ ...job, status: 'queued' })).toBe(false);
    expect(() => assertComputeValidationClaim(db, job)).not.toThrow();
    expect(readLedger(db).filter(e => e.kind === 'compute-validation').map(e => e.detail?.status)).toEqual(['queued','running']);
  });
  it('does not spend on old records, an active source, or a forged scope', () => {
    observation(job,false); observation(source('running'));
    observation({ ...job, orgId: randomUUID() });
    queue.discover(); expect(queue.pending()).toBeNull();
    expect(() => assertComputeValidationClaim(db,job)).toThrow();
  });
  it('reads status and trace provenance without granting another organisation access or migrating an older store', () => {
    const legacy = new Database(':memory:');
    try {
      expect(readComputeValidation(legacy, job.sourceRunId, job.orgId)).toBeNull();
      expect(computeValidationSourceForTrace(legacy, randomUUID(), job.orgId)).toBeNull();
      expect(legacy.prepare('SELECT name FROM sqlite_master').all()).toEqual([]);
    } finally { legacy.close(); }
    observation(); queue.discover(); queue.claim(queue.pending()!);
    const validationRunId = randomUUID();
    queue.finish(job, 'inconclusive', { validationRunId, costUsd: 0.1, reason: 'root refused', countersChanged: false });
    expect(readComputeValidation(db, job.sourceRunId, job.orgId)).toMatchObject({ sourceRunId: job.sourceRunId,
      projectId: job.projectId, status: 'inconclusive', result: { validationRunId, costUsd: 0.1, countersChanged: false } });
    expect(computeValidationSourceForTrace(db, validationRunId, job.orgId)).toEqual(job);
    expect(computeValidationSourceForTrace(db, validationRunId, randomUUID())).toBeNull();
    expect(readComputeValidation(db, job.sourceRunId, randomUUID())).toBeNull();
    const bad = JSON.stringify({ validationRunId, attemptId: '../../escape' });
    db.prepare('UPDATE compute_validation_jobs SET detail=?').run(bad);
    expect(computeValidationSourceForTrace(db, validationRunId, job.orgId)).toBeNull();
    expect(readComputeValidation(db, job.sourceRunId, job.orgId)).toBeNull();
  });
  it('keeps interrupted spend reserved and never retries an uncertain attempt', () => {
    observation(); queue.discover(); queue.claim(queue.pending()!);
    queue.interruptAbandoned(); queue.discover();
    expect(queue.pending()).toBeNull();
    expect(() => assertComputeValidationClaim(db,job)).toThrow();
    expect(readLedger(db).at(-1)?.detail).toMatchObject({ status: 'interrupted', costUsd: null });
  });
  it('admits more than four sources in one day, including after inconclusive outcomes', () => {
    const now = new Date();
    for (let i = 0; i < 8; i++) {
      const next = source(); observation(next); queue.discover();
      expect(queue.claim(queue.pending()!, now)).toBe(true);
      queue.finish(next, 'inconclusive', { costUsd: null });
    }
    expect(queue.pending()).toBeNull();
    expect(readLedger(db).filter(e => e.kind === 'compute-validation' && e.detail?.status === 'running')).toHaveLength(8);
  });
  it('releases legacy budget-wait jobs without an extra authorization and preserves their audit', () => {
    observation(); queue.discover();
    const oldDetail = JSON.stringify({ extraAttempt: { authorizedBy: randomUUID(), reason: 'Historical approval' } });
    db.prepare("UPDATE compute_validation_jobs SET status='budget-wait', detail=? WHERE source_run_id=?").run(oldDetail, job.sourceRunId);
    const restarted = new ComputeValidationQueue(db);
    expect(restarted.pending()).toEqual({ ...job, status: 'budget-wait' });
    expect(restarted.claim({ ...job, orgId: randomUUID(), status: 'budget-wait' })).toBe(false);
    expect(restarted.claim(restarted.pending()!)).toBe(true);
    expect(db.prepare('SELECT detail FROM compute_validation_jobs WHERE source_run_id=?').get(job.sourceRunId)).toEqual({ detail: oldDetail });
    expect(readLedger(db).at(-1)?.detail).toMatchObject({ status: 'running' });
    expect(readLedger(db).at(-1)?.detail).not.toHaveProperty('additionalAttempt');
    expect(restarted.claim({ ...job, status: 'budget-wait' })).toBe(false);
  });
  it('retains retry receipts across restarts, later attempts and stale workers', () => {
    observation(); queue.discover(); const original = queue.pending()!;
    queue.claim(original); queue.finish(original, 'inconclusive', { costUsd: 0.01, validationRunId: randomUUID() });
    const snapshot = { id: randomUUID(), digest: 'a'.repeat(64) };
    const retry = () => queue.retry(job, 'owner', 'one', () => snapshot);
    const first = retry();
    expect(first).toMatchObject({ status: 'queued', initialSnapshot: snapshot });
    expect(retry()).toEqual(first);
    expect(() => queue.retry(job, 'owner', 'two', () => snapshot)).toThrow('already queued');
    expect(() => queue.retry({ ...job, orgId: randomUUID() }, 'owner', 'one', () => snapshot)).toThrow('No automatic');
    expect(queue.claim(original)).toBe(false);
    queue.finish(original, 'blocked', { costUsd: 0 });
    expect(queue.pending()?.attemptId).toBe(first.attemptId);
    const firstJob = queue.pending()!;
    expect(queue.claim(firstJob)).toBe(true);
    expect(() => assertComputeValidationClaim(db, job)).toThrow('no active host claim');
    expect(() => assertComputeValidationClaim(db, firstJob)).not.toThrow();
    queue.finish({ ...firstJob, orgId: randomUUID() }, 'blocked', { costUsd: 0 });
    expect(retry().status).toBe('running');
    queue.finish(firstJob, 'completed', { validationRunId: first.attemptId, costUsd: 0.02, countersChanged: true });
    const finished = retry();
    expect(finished).toMatchObject({ status: 'completed', startedAt: expect.any(String), endedAt: expect.any(String),
      result: { validationRunId: first.attemptId, costUsd: 0.02, countersChanged: true } });
    const restarted = new ComputeValidationQueue(db);
    const second = restarted.retry(job, 'owner', 'two', () => snapshot);
    expect(second.attemptId).not.toBe(first.attemptId);
    queue.finish(firstJob, 'interrupted', { costUsd: null });
    expect(restarted.pending()?.attemptId).toBe(second.attemptId);
    restarted.claim(restarted.pending()!); restarted.interruptAbandoned();
    expect(restarted.retry(job, 'owner', 'two', () => snapshot).status).toBe('interrupted');
    expect(retry()).toEqual(finished);
    expect(db.prepare('SELECT count(*) AS n FROM compute_validation_retries').get()).toEqual({ n: 2 });
    const previous = db.prepare('SELECT previous_job FROM compute_validation_retries WHERE attempt_id=?').pluck().get(first.attemptId) as string;
    expect(JSON.parse(previous)).toMatchObject({ status: 'inconclusive', started_at: expect.any(String) });
    expect(readLedger(db).find(event => event.detail?.reason === 'explicit-retry')).toMatchObject({ scope: { actorType: 'principal', actorId: 'owner' } });
  });
  it('rolls back a retry and its idempotency receipt when audit fails', () => {
    observation(); queue.discover(); queue.finish(job, 'blocked', { costUsd: 0 });
    db.exec(`CREATE TRIGGER deny_retry BEFORE INSERT ON lifecycle_events WHEN NEW.kind='compute-validation'
      BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`);
    expect(() => queue.retry(job, 'owner', 'one', () => ({ id: randomUUID(), digest: 'a'.repeat(64) }))).toThrow('audit unavailable');
    expect(queue.pending()).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM compute_validation_retries').get()).toEqual({ n: 0 });
  });
  it('rolls back admission when the ledger cannot persist its audit', () => {
    observation(); queue.discover();
    db.exec(`CREATE TRIGGER deny_validation BEFORE INSERT ON lifecycle_events WHEN NEW.kind='compute-validation'
      BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`);
    expect(() => queue.claim(queue.pending()!)).toThrow('audit unavailable');
    expect(queue.pending()?.status).toBe('queued');
  });
});
