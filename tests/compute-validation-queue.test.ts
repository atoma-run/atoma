import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ComputeValidationQueue, assertComputeValidationClaim } from '../src/core/computeValidation.js';
import { appendLedgerStrict, readLedger } from '../src/core/ledger.js';
import { COMPUTE_VALIDATION, type ComputeValidationLaunch } from '../src/contracts/computeValidation.js';
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
  it('reserves the rolling daily allowance before launching, including failures', () => {
    const now = new Date();
    for (let i=0;i<COMPUTE_VALIDATION.attemptsPerDay;i++) {
      const next = source(); observation(next); queue.discover();
      expect(queue.claim(queue.pending()!,now)).toBe(true);
      queue.finish(next,'inconclusive',{costUsd:null});
    }
    observation(); queue.discover();
    expect(queue.claim(queue.pending()!,now)).toBe(false);
    expect(queue.pending()?.status).toBe('budget-wait');
    expect(queue.claim(queue.pending()!,new Date(now.getTime()+86_400_001))).toBe(true);
  });
  it('rolls back admission when the ledger cannot persist its audit', () => {
    observation(); queue.discover();
    db.exec(`CREATE TRIGGER deny_validation BEFORE INSERT ON lifecycle_events WHEN NEW.kind='compute-validation'
      BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`);
    expect(() => queue.claim(queue.pending()!)).toThrow('audit unavailable');
    expect(queue.pending()?.status).toBe('queued');
  });
  function exhaustAllowance(): void {
    for (let i = 0; i < COMPUTE_VALIDATION.attemptsPerDay; i++) {
      const next = source(); observation(next); queue.discover();
      expect(queue.claim(queue.pending()!)).toBe(true);
      queue.finish(next, 'inconclusive', { costUsd: null });
    }
    observation(); queue.discover();
    expect(queue.claim(queue.pending()!)).toBe(false);
  }
  it('consumes one source-scoped authorization across restarts without raising other jobs limits', () => {
    exhaustAllowance();
    const principal = randomUUID();
    expect(queue.authorizeAdditionalAttempt({ ...job, orgId: randomUUID() }, principal, 'Owner approval')).toBe(false);
    expect(queue.authorizeAdditionalAttempt(job, principal, 'Owner approved one additional attempt')).toBe(true);
    expect(queue.authorizeAdditionalAttempt(job, principal, 'Repeated approval')).toBe(false);
    expect(new ComputeValidationQueue(db).claim(queue.pending()!)).toBe(true);
    expect(queue.claim({ ...job, status: 'queued' })).toBe(false);
    const audit = readLedger(db).filter(e => e.kind === 'compute-validation');
    expect(audit.at(-2)).toMatchObject({ scope: { actorType: 'principal', actorId: principal },
      detail: { operation: 'authorize-additional-attempt', extraAttempt: { authorizedBy: principal } } });
    expect(audit.at(-1)?.detail).toMatchObject({ status: 'running', additionalAttempt: true, authorization: { authorizedBy: principal } });
    queue.finish(job, 'inconclusive', { costUsd: 0.1 });
    expect(queue.authorizeAdditionalAttempt(job, principal, 'Not a retry grant')).toBe(false);
    const other = source(); observation(other); queue.discover();
    expect(queue.claim(queue.pending()!)).toBe(false);
  });
  it('rolls back grant and consumption independently when their audit cannot persist', () => {
    exhaustAllowance();
    const deny = `CREATE TRIGGER deny_extra BEFORE INSERT ON lifecycle_events WHEN NEW.kind='compute-validation'
      BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`;
    db.exec(deny);
    expect(() => queue.authorizeAdditionalAttempt(job, randomUUID(), 'Explicit owner approval')).toThrow('audit unavailable');
    const read = () => db.prepare('SELECT status,started_at,detail FROM compute_validation_jobs WHERE source_run_id=?').get(job.sourceRunId) as { status: string; started_at: string | null; detail: string };
    expect(JSON.parse(read().detail)).toEqual({});
    db.exec('DROP TRIGGER deny_extra');
    queue.authorizeAdditionalAttempt(job, randomUUID(), 'Explicit owner approval');
    db.exec(deny);
    expect(() => queue.claim(queue.pending()!)).toThrow('audit unavailable');
    expect(read()).toMatchObject({ status: 'budget-wait', started_at: null });
    expect(JSON.parse(read().detail)).not.toHaveProperty('extraAttemptUsed');
    db.exec('DROP TRIGGER deny_extra');
    expect(queue.claim(queue.pending()!)).toBe(true);
  });
  it('cannot transfer an authorization or reuse one after normal admission', () => {
    observation(); queue.discover();
    const principal = randomUUID();
    expect(() => queue.authorizeAdditionalAttempt(job, principal, ' ')).toThrow();
    queue.authorizeAdditionalAttempt(job, principal, 'Explicit owner approval');
    expect(queue.claim({ ...job, projectId: randomUUID(), status: 'queued' })).toBe(false);
    expect(queue.claim(queue.pending()!)).toBe(true);
    expect(readLedger(db).at(-1)?.detail).not.toHaveProperty('additionalAttempt');
    queue.finish(job, 'completed', { costUsd: 0.1 });
    expect(queue.authorizeAdditionalAttempt(job, principal, 'Repeated approval')).toBe(false);
    expect(queue.claim({ ...job, status: 'queued' })).toBe(false);
  });
  it('finds an authorized later job past an older job waiting for the ordinary allowance', () => {
    exhaustAllowance();
    const authorized = source(); observation(authorized); queue.discover();
    expect(queue.pending()?.sourceRunId).toBe(job.sourceRunId);
    queue.authorizeAdditionalAttempt(authorized, randomUUID(), 'One additional targeted attempt');
    expect(queue.pending()?.sourceRunId).toBe(authorized.sourceRunId);
    expect(queue.claim(queue.pending()!)).toBe(true);
    queue.finish(authorized, 'completed', { costUsd: 0.1 });
    expect(queue.pending()?.sourceRunId).toBe(job.sourceRunId);
    expect(queue.claim(queue.pending()!)).toBe(false);
  });
});
