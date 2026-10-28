import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { COMPUTE_VALIDATION, type ComputeValidationLaunch, type ComputeValidationStatus, computeValidationRetryReceiptSchema, type ComputeValidationRetryReceipt } from '../contracts/computeValidation.js';
import { appendLedgerStrict, ensureLedgerSchema } from './ledger.js';

const DDL = `CREATE TABLE IF NOT EXISTS compute_validation_jobs (
  source_run_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS compute_validation_retries (
  attempt_id TEXT PRIMARY KEY, source_run_id TEXT NOT NULL, org_id TEXT NOT NULL, project_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, request_key TEXT NOT NULL, receipt TEXT NOT NULL, previous_job TEXT NOT NULL,
  UNIQUE(source_run_id, org_id, project_id, principal_id, request_key)
);`;

export interface ComputeValidationJob extends ComputeValidationLaunch {
  readonly status: ComputeValidationStatus;
}

export class ComputeValidationRetryConflict extends Error {}

/** An explicit attempt fences stale workers without changing legacy automatic jobs. */
function attempt(detail: string): string | undefined {
  return (JSON.parse(detail) as { attemptId?: string }).attemptId;
}

/** Durable scheduling, not another result/trust store. Claims and their audit are atomic. */
export class ComputeValidationQueue {
  constructor(readonly db: Database.Database) {
    ensureLedgerSchema(db);
    db.exec(DDL);
  }

  private event(job: ComputeValidationLaunch, status: ComputeValidationStatus, detail: Record<string, unknown> = {}): void {
    appendLedgerStrict({ kind: 'compute-validation', entity: job.sourceRunId,
      scope: { runId: job.sourceRunId, orgId: job.orgId, projectId: job.projectId, actorType: 'system', actorId: 'assayer' },
      detail: { status, ...detail, budget: COMPUTE_VALIDATION } }, this.db);
  }

  /** Only new, explicitly eligible receipts; historical withholding is never backfilled. */
  discover(): void {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_runs'").get()) return;
    const rows = this.db.prepare(`SELECT r.project_run_id AS sourceRunId, r.org_id AS orgId, r.project_id AS projectId
      FROM project_runs r WHERE r.status NOT IN ('queued','running') AND EXISTS (
        SELECT 1 FROM lifecycle_events e WHERE e.run_id=r.project_run_id AND e.org_id=r.org_id
        AND e.project_id=r.project_id AND e.kind IN ('skill-credit-withheld','type-credit-withheld')
        AND json_valid(e.detail) AND json_extract(e.detail,'$.automaticValidation')=1)
      AND NOT EXISTS (SELECT 1 FROM compute_validation_jobs j WHERE j.source_run_id=r.project_run_id)
      ORDER BY r.ended_at LIMIT 100`).all() as ComputeValidationLaunch[];
    for (const job of rows) this.db.transaction(() => {
      if (!this.db.prepare(`INSERT OR IGNORE INTO compute_validation_jobs
        (source_run_id,org_id,project_id,status,created_at) VALUES (?,?,?,'queued',?)`)
        .run(job.sourceRunId, job.orgId, job.projectId, new Date().toISOString()).changes) return;
      this.event(job, 'queued');
    }).immediate();
  }

  /** Existing keys return their own durable receipt, even after another retry has finished. */
  retry(job: ComputeValidationLaunch, principalId: string, key: string,
    preflight: () => ComputeValidationRetryReceipt['initialSnapshot']): ComputeValidationRetryReceipt {
    return this.db.transaction(() => {
      const prior = this.db.prepare(`SELECT receipt FROM compute_validation_retries WHERE source_run_id=?
        AND org_id=? AND project_id=? AND principal_id=? AND request_key=?`)
        .get(job.sourceRunId, job.orgId, job.projectId, principalId, key) as { receipt: string } | undefined;
      if (prior) return computeValidationRetryReceiptSchema.parse(JSON.parse(prior.receipt));
      const current = this.db.prepare(`SELECT * FROM compute_validation_jobs WHERE source_run_id=? AND org_id=? AND project_id=?`)
        .get(job.sourceRunId, job.orgId, job.projectId) as { status: ComputeValidationStatus } | undefined;
      if (!current) throw new ComputeValidationRetryConflict('No automatic Compute validation exists for this source');
      if (['queued', 'budget-wait', 'running'].includes(current.status)) {
        throw new ComputeValidationRetryConflict('Compute validation is already queued or running; reuse its original idempotency key');
      }
      const initialSnapshot = preflight();
      const receipt: ComputeValidationRetryReceipt = { sourceRunId: job.sourceRunId, projectId: job.projectId,
        attemptId: randomUUID(), status: 'queued', createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
        initialSnapshot, result: {} };
      this.db.prepare(`INSERT INTO compute_validation_retries VALUES (?,?,?,?,?,?,?,?)`)
        .run(receipt.attemptId, job.sourceRunId, job.orgId, job.projectId, principalId, key,
          JSON.stringify(receipt), JSON.stringify(current));
      this.db.prepare(`UPDATE compute_validation_jobs SET status='queued',created_at=?,started_at=NULL,ended_at=NULL,detail=?
        WHERE source_run_id=? AND org_id=? AND project_id=?`)
        .run(receipt.createdAt, JSON.stringify({ attemptId: receipt.attemptId }), job.sourceRunId, job.orgId, job.projectId);
      appendLedgerStrict({ kind: 'compute-validation', entity: job.sourceRunId,
        scope: { runId: job.sourceRunId, orgId: job.orgId, projectId: job.projectId, actorType: 'principal', actorId: principalId },
        detail: { status: 'queued', reason: 'explicit-retry', attemptId: receipt.attemptId, initialSnapshot, budget: COMPUTE_VALIDATION } }, this.db);
      return receipt;
    }).immediate();
  }

  private updateReceipt(job: ComputeValidationLaunch, status: ComputeValidationStatus, now: string, detail: Record<string, unknown> = {}): void {
    if (!job.attemptId) return;
    const row = this.db.prepare('SELECT receipt FROM compute_validation_retries WHERE attempt_id=?').get(job.attemptId) as { receipt: string };
    const receipt = computeValidationRetryReceiptSchema.parse(JSON.parse(row.receipt));
    receipt.status = status;
    if (status === 'running') receipt.startedAt = now;
    else {
      receipt.endedAt = now;
      receipt.result = computeValidationRetryReceiptSchema.shape.result.parse(Object.fromEntries(
        ['validationRunId', 'costUsd', 'countersChanged', 'recipesChanged'].filter(key => key in detail).map(key => [key, detail[key]])));
    }
    this.db.prepare('UPDATE compute_validation_retries SET receipt=? WHERE attempt_id=?').run(JSON.stringify(receipt), job.attemptId);
  }

  pending(): ComputeValidationJob | null {
    // budget-wait is a legacy persisted state; removing the daily ceiling releases it normally.
    const row = this.db.prepare(`SELECT source_run_id AS sourceRunId, org_id AS orgId, project_id AS projectId, status, detail
      FROM compute_validation_jobs WHERE status IN ('queued','budget-wait') AND started_at IS NULL
      ORDER BY created_at LIMIT 1`).get() as (ComputeValidationJob & { detail: string }) | undefined;
    if (!row) return null;
    const { detail, ...job } = row;
    const attemptId = attempt(detail);
    return { ...job, ...(attemptId ? { attemptId } : {}) };
  }

  /** Call only while holding the exclusive background lease: no old child can still be executing. */
  interruptAbandoned(): void {
    const rows = this.db.prepare(`SELECT source_run_id AS sourceRunId, org_id AS orgId, project_id AS projectId, detail
      FROM compute_validation_jobs WHERE status='running'`).all() as (ComputeValidationLaunch & { detail: string })[];
    for (const { detail, ...job } of rows) this.finish({ ...job, ...(attempt(detail) ? { attemptId: attempt(detail) } : {}) },
      'interrupted', { reason: 'restart', costUsd: null });
  }

  claim(job: ComputeValidationJob, now = new Date()): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT detail FROM compute_validation_jobs WHERE source_run_id=? AND org_id=?
        AND project_id=? AND status IN ('queued','budget-wait') AND started_at IS NULL`)
        .get(job.sourceRunId, job.orgId, job.projectId) as { detail: string } | undefined;
      if (!row || attempt(row.detail) !== job.attemptId) return false;
      if (!this.db.prepare(`UPDATE compute_validation_jobs SET status='running',started_at=?,detail=?
        WHERE source_run_id=? AND org_id=? AND project_id=? AND status IN ('queued','budget-wait') AND started_at IS NULL`)
        .run(now.toISOString(), row.detail,
          job.sourceRunId, job.orgId, job.projectId).changes) return false;
      this.updateReceipt(job, 'running', now.toISOString());
      this.event(job, 'running', job.attemptId ? { attemptId: job.attemptId } : {});
      return true;
    }).immediate();
  }

  finish(job: ComputeValidationLaunch, status: Exclude<ComputeValidationStatus, 'queued' | 'running' | 'budget-wait'>,
    detail: Record<string, unknown>): void {
    this.db.transaction(() => {
      const current = this.db.prepare(`SELECT detail FROM compute_validation_jobs WHERE source_run_id=? AND org_id=?
        AND project_id=? AND status IN ('queued','budget-wait','running')`)
        .get(job.sourceRunId, job.orgId, job.projectId) as { detail: string } | undefined;
      if (!current || attempt(current.detail) !== job.attemptId) return;
      const now = new Date().toISOString();
      const result = { ...detail, ...(job.attemptId ? { attemptId: job.attemptId } : {}) };
      this.db.prepare(`UPDATE compute_validation_jobs SET status=?,ended_at=?,detail=? WHERE source_run_id=?`)
        .run(status, now, JSON.stringify(result), job.sourceRunId);
      this.updateReceipt(job, status, now, detail);
      this.event(job, status, result);
    }).immediate();
  }
}

/** Receipt labels cannot turn an ordinary tenant launch into an assayer run. */
export function assertComputeValidationClaim(db: Database.Database, job: ComputeValidationLaunch): void {
  const row = db.prepare(`SELECT detail FROM compute_validation_jobs WHERE source_run_id=? AND org_id=?
    AND project_id=? AND status='running' AND started_at IS NOT NULL`)
    .get(job.sourceRunId, job.orgId, job.projectId) as { detail: string } | undefined;
  if (!row || attempt(row.detail) !== job.attemptId) throw new Error('Compute validation has no active host claim');
}
