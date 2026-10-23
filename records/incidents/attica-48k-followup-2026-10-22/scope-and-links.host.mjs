import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const release = '/home/atoma/releases/f9d71587b1f2111de0d636d31c2734489ca44da5';
const require = createRequire(path.join(release, 'package.json'));
const Database = require('better-sqlite3');
const { parseExecutionObservation } = await import(pathToFileURL(path.join(release, 'dist/contracts/attestation.js')).href);
const db = new Database('/home/atoma/state/atoma.db', { readonly: true, fileMustExist: true });
db.pragma('query_only=ON');
const runId = '1622e44b-8d9f-41dc-8827-a1af7cb38353';
const row = db.prepare('select runs_path from project_runs where project_run_id=? and project_id=? and org_id=?')
  .get(runId, '07864f7c-d8f2-4023-9fca-afd8a7a51e52', 'd28f40d2-14d7-45c7-bce3-928dcb0041a6');
if (!row) throw Error('Expected project run missing');
const trace = JSON.parse(fs.readFileSync(path.join(row.runs_path, runId + '.json'), 'utf8'));
if (trace.id !== runId || trace.provenance?.revision !== path.basename(release)) throw Error('Unexpected trace identity');
const reviewIds = ['ec15fc95-5995-4709-8764-ec2a50a8ce2f', 'f1dc2248-cf49-4e81-b02d-e007dcabd281'];
const offsets = reviewIds.map(id => {
  const event = trace.events.find(e => e.id === id);
  if (!event) return { eventId: id, missing: true };
  const encoded = JSON.stringify(event);
  return { eventId: id, userContentFieldOffset: encoded.indexOf('"userContent":'), totalChars: encoded.length };
});
const evidenceIds = ['2c84965d-2b6e-4275-927b-e815fd453420', 'a0f6749e-30d7-4b0d-aaa1-e84b8e7e6358', '0b005f76-81ec-481d-b892-df791a739925', '1c12c6b7-876e-469b-b57d-0e12291bb653'];
const links = evidenceIds.map(id => {
  const record = (trace.attestations ?? []).find(r => r.eventId === id);
  if (!record) return { evidenceId: id, missing: true };
  const matches = trace.events.filter(e => e.kind === 'tool' && e.name === record.tool).filter(e => {
    const observed = parseExecutionObservation(e.name, e.args, e.result);
    return observed?.request === record.observation.request && observed?.response === record.observation.response;
  });
  return { evidenceId: id, tool: record.tool, recordedExitCode: record.observation.exitCode ?? null,
    candidates: matches.map(e => ({ eventId: e.id, ts: e.ts, atom: e.actor?.name ?? null, branchId: e.branchId ?? null })) };
});
db.close();
console.log(JSON.stringify({ runId, offsets, links, note: 'Offsets and exact request/response equality only; no prompts, commands, file contents or artifacts exported.' }));
