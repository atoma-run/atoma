import { openStoreHandle, storeDbPath } from '../core/stores.js';
import type { RunRecordPublic } from './run.js';

const DDL = `CREATE TABLE IF NOT EXISTS mcp_operator_executions (
 run_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0
);`;
function db() { return openStoreHandle(storeDbPath(), DDL); }
/** Durable projection of the existing operator record, in the primary product store. */
export function saveOperatorExecution(record: RunRecordPublic): void {
  db().prepare(`INSERT INTO mcp_operator_executions(run_id,record_json) VALUES (?,?)
    ON CONFLICT(run_id) DO UPDATE SET record_json=excluded.record_json`).run(record.runId, JSON.stringify(record));
  db().prepare(`DELETE FROM mcp_operator_executions WHERE run_id NOT IN
    (SELECT run_id FROM mcp_operator_executions ORDER BY run_id DESC LIMIT 20)
    AND json_extract(record_json,'$.status') NOT IN ('running','cancelling')`).run();
}
export function operatorExecutions(): RunRecordPublic[] {
  return (db().prepare('SELECT record_json FROM mcp_operator_executions ORDER BY run_id DESC').all() as { record_json: string }[])
    .map(row => {
      const record = JSON.parse(row.record_json) as RunRecordPublic;
      return { ...record, elapsedS: Math.round(((record.endedAt ? Date.parse(record.endedAt) : Date.now()) - Date.parse(record.startedAt)) / 1000) };
    });
}
export function requestOperatorCancellation(runId: string): void {
  db().prepare('UPDATE mcp_operator_executions SET cancel_requested=1 WHERE run_id=?').run(runId);
}
export function operatorCancellationRequested(runId: string): boolean {
  return !!db().prepare('SELECT 1 FROM mcp_operator_executions WHERE run_id=? AND cancel_requested=1').get(runId);
}

export function recoverOperatorExecutions(liveRunIds: ReadonlySet<string>): void {
  for (const record of operatorExecutions()) {
    if (!['running', 'cancelling'].includes(record.status) || liveRunIds.has(record.runId)) continue;
    saveOperatorExecution({ ...record, status: 'spawn-failed', endedAt: new Date().toISOString(),
      hint: 'Run executor was interrupted; consult its retained trace and log before starting new work.' });
  }
}
