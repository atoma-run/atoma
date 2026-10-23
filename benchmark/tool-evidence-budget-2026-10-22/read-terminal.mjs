import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const runId = 'b920faf6-7bd7-4e89-87f8-7176c1c97f92';
const query = `import sqlite3,json,datetime
d=sqlite3.connect('file:/home/atoma/state/atoma.db?mode=ro',uri=True)
d.execute('PRAGMA query_only=ON')
r=d.execute('select status,ended_at,artifact_manifest_hash from project_runs where project_run_id=? and project_id=? and org_id=?',('${runId}','07864f7c-d8f2-4023-9fca-afd8a7a51e52','d28f40d2-14d7-45c7-bce3-928dcb0041a6')).fetchone()
if not r: raise RuntimeError('Missing canonical receipt')
print(json.dumps({'runId':'${runId}','status':r[0],'endedAt':r[1],'manifestHash':r[2],'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}))
`;
const receipt = JSON.parse(execFileSync('ssh', ['mgf@atoma.run', 'sudo', '-n', '-u', 'atoma', 'python3', '-'], { input: query, encoding: 'utf8' }));
console.log(JSON.stringify(receipt));
if (['delivered', 'partial', 'failed', 'cancelled'].includes(receipt.status) && receipt.endedAt) {
  writeFileSync(new URL('active-run-terminal.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n');
} else process.exitCode = 75;
