import type Database from 'better-sqlite3';
import { openStoreHandle } from '../core/stores.js';
import { z } from 'zod';
import { hostedDeploymentSchema, type HostedDeployment } from '../contracts/projectHosting.js';
import { ProjectStateConflict } from './store.js';

export const HOSTING_DDL = `CREATE TABLE IF NOT EXISTS project_hosted_deployments (
 deployment_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('starting','ready','failed','stopped')),
 record TEXT NOT NULL CHECK(json_valid(record)), created_at TEXT NOT NULL,
 FOREIGN KEY(project_id, org_id) REFERENCES projects(project_id, org_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS hosted_one_start ON project_hosted_deployments(project_id) WHERE state='starting';`;
/**
 * A row whose runtime may still write the project's data: a ready Node
 * application, or one whose state is unknown. Replacing any of them needs a
 * stop first, so two versions never write the same data.
 */
export function holdsApplicationData(row: HostedDeployment): boolean {
  return (row.state === 'ready' && row.kind === 'node') || row.error === 'runtime-unavailable' || row.error === 'cleanup-failed';
}
/**
 * Rows are READ tolerantly: a field a later release added is dropped instead
 * of failing every listing, which is what a release before 17fef5ac does with
 * rows carrying `previousRunId`, `readyAt` or `replacedRunId` (a rollback past
 * it needs all three removed: docs/project-hosting.md). Writes stay strict.
 */
const storedDeploymentSchema = z.object(hostedDeploymentSchema.shape);
export class HostingStore {
  constructor(private readonly db: Database.Database) { db.exec(HOSTING_DDL); }
  static open(file: string): HostingStore { return new HostingStore(openStoreHandle(file, HOSTING_DDL)); }
  list(orgId?: string, projectId?: string): HostedDeployment[] {
    const rows = orgId && projectId
      ? this.db.prepare('SELECT record FROM project_hosted_deployments WHERE org_id=? AND project_id=? ORDER BY created_at DESC, rowid DESC').all(orgId, projectId)
      : this.db.prepare("SELECT record FROM project_hosted_deployments WHERE (state IN ('starting','ready') OR (state='failed' AND json_extract(record,'$.error') IN ('runtime-unavailable','cleanup-failed'))) ORDER BY created_at DESC, rowid DESC").all();
    return (rows as { record: string }[]).map(r => storedDeploymentSchema.parse(JSON.parse(r.record)));
  }
  reserve(row: HostedDeployment, expected: string | null, max: number): void {
    hostedDeploymentSchema.parse(row);
    this.db.transaction(() => {
      const rows = this.list(row.orgId, row.projectId);
      if ((rows[0]?.deploymentId ?? null) !== expected || rows.some(r => r.state === 'starting')) throw new ProjectStateConflict('Deployment changed; refresh before continuing');
      if (rows.some(holdsApplicationData)) throw new ProjectStateConflict('Stop the running application before updating its persistent data');
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM project_hosted_deployments WHERE (state IN ('starting','ready') OR (state='failed' AND json_extract(record,'$.error') IN ('runtime-unavailable','cleanup-failed')))").get() as { n: number };
      if (count.n >= max) throw new ProjectStateConflict('Hosting capacity is full');
      this.db.prepare('INSERT INTO project_hosted_deployments VALUES (?,?,?,?,?,?)').run(row.deploymentId, row.orgId, row.projectId, row.state, JSON.stringify(row), row.createdAt);
    }).immediate();
  }
  /**
   * A version that never reached `starting`: an update stopped its predecessor
   * and then could not reserve it. Failed rows hold no data and no capacity,
   * so none of `reserve`'s refusals apply. The caller holds the project's lock.
   */
  recordFailed(row: HostedDeployment): void {
    hostedDeploymentSchema.parse(row);
    if (row.state !== 'failed') throw new ProjectStateConflict('Only a failed version is recorded this way');
    this.db.prepare('INSERT INTO project_hosted_deployments VALUES (?,?,?,?,?,?)').run(row.deploymentId, row.orgId, row.projectId, row.state, JSON.stringify(row), row.createdAt);
  }
  update(row: HostedDeployment, from: HostedDeployment['state']): void {
    hostedDeploymentSchema.parse(row);
    if (this.db.prepare('UPDATE project_hosted_deployments SET state=?, record=? WHERE deployment_id=? AND org_id=? AND project_id=? AND state=?')
      .run(row.state, JSON.stringify(row), row.deploymentId, row.orgId, row.projectId, from).changes !== 1) throw new ProjectStateConflict('Deployment changed');
  }
}
