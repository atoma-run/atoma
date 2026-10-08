import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { encodeProjectContext, projectContextSchema, projectContextUpdateSchema,
  type ProjectContext, type ProjectContextUpdate } from '../contracts/projectContext.js';

/** Same product database and transaction as project admission; never a workspace file. */
export function initializeProjectContext(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS project_context_versions (
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES auth_organisations(org_id),
    version INTEGER NOT NULL CHECK(version > 0),
    principal_id TEXT NOT NULL REFERENCES auth_principals(principal_id),
    request_key TEXT NOT NULL, request_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    PRIMARY KEY(project_id, version), UNIQUE(project_id, request_key));
    CREATE TRIGGER IF NOT EXISTS project_context_immutable BEFORE UPDATE ON project_context_versions
    BEGIN SELECT RAISE(ABORT, 'project context revisions are immutable'); END;`);
}
export class ProjectContextConflict extends Error {}
export function readProjectContext(db: Database.Database, orgId: string, projectId: string, version?: number): ProjectContext | null {
  if (version === 0) return { projectId, version: 0, brief: null, decisions: [], change: null };
  const row = db.prepare(`SELECT snapshot_json FROM project_context_versions WHERE org_id = ? AND project_id = ?
    ${version === undefined ? 'ORDER BY version DESC LIMIT 1' : 'AND version = ?'}`)
    .get(...(version === undefined ? [orgId, projectId] : [orgId, projectId, version])) as { snapshot_json: string } | undefined;
  return row ? projectContextSchema.parse(JSON.parse(row.snapshot_json))
    : version === undefined ? readProjectContext(db, orgId, projectId, 0) : null;
}
export function projectContextHistory(db: Database.Database, orgId: string, projectId: string, before: number | undefined, limit: number) {
  const rows = db.prepare(`SELECT snapshot_json FROM project_context_versions WHERE org_id = ? AND project_id = ? AND version < ?
    ORDER BY version DESC LIMIT ?`).all(orgId, projectId, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as { snapshot_json: string }[];
  const history = rows.slice(0, limit).map(row => {
    const { version, change } = projectContextSchema.parse(JSON.parse(row.snapshot_json));
    // Replaced text is available by reading that revision; history stays compact.
    return { version, change: change ? { kind: change.kind, author: change.author, ...(change.decisionId ? { decisionId: change.decisionId } : {}) } : null };
  });
  return { history, nextBeforeVersion: rows.length > limit ? history.at(-1)!.version : null };
}
export function updateProjectContext(db: Database.Database, orgId: string, projectId: string, principalId: string, raw: ProjectContextUpdate) {
  const input = projectContextUpdateSchema.parse(raw);
  return db.transaction(() => {
    const project = db.prepare('SELECT status FROM projects WHERE org_id = ? AND project_id = ?').get(orgId, projectId) as { status: string } | undefined;
    if (!project) return null;
    const retry = db.prepare('SELECT principal_id, request_json, snapshot_json FROM project_context_versions WHERE org_id = ? AND project_id = ? AND request_key = ?')
      .get(orgId, projectId, input.idempotencyKey) as { principal_id: string; request_json: string; snapshot_json: string } | undefined;
    if (retry) {
      if (retry.principal_id !== principalId || retry.request_json !== JSON.stringify(input)) throw new ProjectContextConflict('Idempotency key already used for another context update');
      return { context: projectContextSchema.parse(JSON.parse(retry.snapshot_json)), created: false };
    }
    if (project.status !== 'active') throw new ProjectContextConflict('Cannot edit an archived project');
    const current = readProjectContext(db, orgId, projectId)!;
    if (current.version !== input.expectedVersion) throw new ProjectContextConflict('Project context changed; read it again before updating');
    const change = input.change;
    const source = 'source' in change ? change.source : change.kind === 'replace_decision' ? change.replacement?.source : undefined;
    if (source?.runId && !db.prepare('SELECT 1 FROM project_runs WHERE org_id = ? AND project_id = ? AND project_run_id = ?').get(orgId, projectId, source.runId)) {
      throw new ProjectContextConflict('Source run must belong to this project');
    }
    const author = { principalId, at: new Date().toISOString() };
    const next: ProjectContext = { ...current, version: current.version + 1, decisions: [...current.decisions], change: { kind: change.kind, author } };
    if (change.kind === 'set_brief') {
      next.brief = { text: change.text, source: change.source, confirmedBy: { ...author, review: change.confirmation } };
    } else if (change.kind === 'propose_decision') {
      const decision = { id: randomUUID(), text: change.text, source: change.source, proposedBy: author, status: 'proposed' as const };
      next.decisions.push(decision);
      next.change!.decisionId = decision.id;
    } else {
      const index = next.decisions.findIndex(item => item.id === change.decisionId);
      if (index < 0) throw new ProjectContextConflict('Decision is absent or already replaced');
      const decision = next.decisions[index]!;
      next.change!.decisionId = decision.id;
      if (change.kind === 'confirm_decision') {
        if (decision.status !== 'proposed') throw new ProjectContextConflict('Only a proposed decision can be confirmed');
        next.decisions[index] = { ...decision, status: 'confirmed', confirmation: { ...author, review: change.confirmation } };
      } else {
        const replacement = change.replacement ? { ...change.replacement, id: randomUUID(), proposedBy: author, status: 'proposed' as const } : undefined;
        next.change!.replaced = { ...decision, status: 'replaced', replacement: { ...author, review: change.confirmation,
          ...(replacement ? { decisionId: replacement.id } : {}) } };
        next.decisions.splice(index, 1);
        if (replacement) next.decisions.push(replacement);
      }
    }
    const parsed = projectContextSchema.safeParse(next);
    if (!parsed.success) throw new ProjectContextConflict('Project context is full; replace obsolete decisions before adding more');
    try { encodeProjectContext(parsed.data); } catch { throw new ProjectContextConflict('Confirmed context is full (24 decisions / 24000 encoded characters); replace obsolete decisions first'); }
    db.prepare('INSERT INTO project_context_versions (project_id, org_id, version, principal_id, request_key, request_json, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, orgId, next.version, principalId, input.idempotencyKey, JSON.stringify(input), JSON.stringify(parsed.data));
    return { context: parsed.data, created: true };
  }).immediate();
}
