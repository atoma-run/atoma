import type Database from 'better-sqlite3';
import { COMPUTE_VALIDATION, type ComputeValidationLaunch, type ComputeValidationStatus } from '../contracts/computeValidation.js';
import { appendLedgerStrict, ensureLedgerSchema } from './ledger.js';

const DDL = `CREATE TABLE IF NOT EXISTS compute_validation_jobs (
  source_run_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);`;

export interface ComputeValidationJob extends ComputeValidationLaunch {
  readonly status: ComputeValidationStatus;
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

  pending(): ComputeValidationJob | null {
    return this.db.prepare(`SELECT source_run_id AS sourceRunId, org_id AS orgId, project_id AS projectId, status
      FROM compute_validation_jobs WHERE status IN ('queued','budget-wait') ORDER BY created_at LIMIT 1`)
      .get() as ComputeValidationJob | undefined ?? null;
  }

  /** Call only while holding the exclusive background lease: no old child can still be executing. */
  interruptAbandoned(): void {
    const rows = this.db.prepare(`SELECT source_run_id AS sourceRunId, org_id AS orgId, project_id AS projectId
      FROM compute_validation_jobs WHERE status='running'`).all() as ComputeValidationLaunch[];
    for (const job of rows) this.finish(job, 'interrupted', { reason: 'restart', costUsd: null });
  }

  claim(job: ComputeValidationJob, now = new Date()): boolean {
    return this.db.transaction(() => {
      const used = this.db.prepare(`SELECT count(*) AS n FROM compute_validation_jobs WHERE started_at >= ?`)
        .get(new Date(now.getTime() - 86_400_000).toISOString()) as { n: number };
      if (used.n >= COMPUTE_VALIDATION.attemptsPerDay) {
        if (this.db.prepare(`UPDATE compute_validation_jobs SET status='budget-wait' WHERE source_run_id=? AND status='queued'`)
          .run(job.sourceRunId).changes) this.event(job, 'budget-wait');
        return false;
      }
      if (!this.db.prepare(`UPDATE compute_validation_jobs SET status='running',started_at=?
        WHERE source_run_id=? AND status IN ('queued','budget-wait') AND started_at IS NULL`)
        .run(now.toISOString(), job.sourceRunId).changes) return false;
      this.event(job, 'running');
      return true;
    }).immediate();
  }

  finish(job: ComputeValidationLaunch, status: Exclude<ComputeValidationStatus, 'queued' | 'running' | 'budget-wait'>,
    detail: Record<string, unknown>): void {
    this.db.transaction(() => {
      if (!this.db.prepare(`UPDATE compute_validation_jobs SET status=?,ended_at=?,detail=?
        WHERE source_run_id=? AND status IN ('queued','budget-wait','running')`)
        .run(status, new Date().toISOString(), JSON.stringify(detail), job.sourceRunId).changes) return;
      this.event(job, status, detail);
    }).immediate();
  }
}

/** Receipt labels cannot turn an ordinary tenant launch into an assayer run. */
export function assertComputeValidationClaim(db: Database.Database, job: ComputeValidationLaunch): void {
  const row = db.prepare(`SELECT 1 FROM compute_validation_jobs WHERE source_run_id=? AND org_id=?
    AND project_id=? AND status='running' AND started_at IS NOT NULL`)
    .get(job.sourceRunId, job.orgId, job.projectId);
  if (!row) throw new Error('Compute validation has no active host claim');
}
