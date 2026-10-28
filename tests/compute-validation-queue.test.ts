import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ComputeValidationQueue, assertComputeValidationClaim } from '../src/core/computeValidation.js';
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
  it('rolls back admission when the ledger cannot persist its audit', () => {
    observation(); queue.discover();
    db.exec(`CREATE TRIGGER deny_validation BEFORE INSERT ON lifecycle_events WHEN NEW.kind='compute-validation'
      BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`);
    expect(() => queue.claim(queue.pending()!)).toThrow('audit unavailable');
    expect(queue.pending()?.status).toBe('queued');
  });
});
