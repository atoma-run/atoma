import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const protocol = __PROTOCOL__;
const sources = __SOURCES__;
const release = '/home/atoma/releases/f488de32aa9ec8b9bbbfbca39b32226619b7a99a';
const require = createRequire(path.join(release, 'package.json'));
const Database = require('better-sqlite3');
const { renderObservations } = await import(pathToFileURL(path.join(release, 'dist/contracts/attestation.js')).href);
const db = new Database('/home/atoma/state/atoma.db', { readonly: true, fileMustExist: true });
db.pragma('query_only=ON');
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const render = (arm, budget, evidence) => {
  const exports = {};
  // This code comes from the two pinned repository revisions, never trace data.
  new Function('exports', 'transportWitnesses', 'budget', sources[arm].compiled)(exports,
    value => (value ?? []).filter(w => w.source === 'transport-observed'), budget);
  return exports.renderTransportEvidence(evidence);
};
function witnesses(records) {
  const lines = renderObservations(records);
  return records.map((r, index) => ({ source: 'transport-observed', eventId: r.eventId, tool: r.tool, observed: lines[index],
    ...(r.observation.kind === 'browser' ? { browser: { ok: r.observation.ok,
      check: JSON.stringify([r.observation.executedInteractions, r.observation.smoke ?? null, r.observation.viewport ?? null]),
      ...(r.observation.document ? { document: r.observation.document } : {}),
    } } : {}),
  }));
}
function commandKey(record) {
  try {
    const args = JSON.parse(record.observation.request);
    delete args.note;
    return JSON.stringify([record.attempt ?? 1, record.branchId ?? 'root', args]);
  } catch { return record.eventId; }
}
function outcome(record) {
  if (Number.isSafeInteger(record.observation.exitCode)) return record.observation.exitCode;
  try {
    const value = JSON.parse(record.observation.response);
    return Number.isSafeInteger(value.exitCode) ? value.exitCode : null;
  } catch { return null; }
}
const excluded = {}, cases = [], rows = [], runMetadata = [];
const exclude = reason => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
for (const rid of protocol.phaseA.runs) {
  const row = db.prepare('select status,runs_path from project_runs where project_run_id=? and project_id=? and org_id=?')
    .get(rid, '07864f7c-d8f2-4023-9fca-afd8a7a51e52', 'd28f40d2-14d7-45c7-bce3-928dcb0041a6');
  if (!row) throw Error('Expected run missing');
  const trace = JSON.parse(fs.readFileSync(path.join(row.runs_path, rid + '.json'), 'utf8'));
  if (trace.id !== rid) throw Error('Run identity changed');
  const records = trace.attestations ?? [];
  const positions = new Map(records.map((r, i) => [r.eventId, i]));
  runMetadata.push({ runId: rid, status: row.status, eventCount: trace.events.length, attestationCount: records.length });
  for (const [index, event] of trace.events.entries()) {
    if (rid.startsWith('b920') && index > protocol.phaseA.b920MaxEventIndex) break;
    if (event.kind !== 'llm' || event.role !== 'validate-result') continue;
    if (event.actor?.tier !== 2) { exclude('not-L2-result-review'); continue; }
    const content = event.userContent ?? '';
    const marker = '== TRANSPORT-OBSERVED TOOL EVIDENCE ==';
    const start = content.indexOf(marker);
    if (start < 0) { exclude('no-transport-block'); continue; }
    const next = content.indexOf('\n== ', start + marker.length);
    const block = content.slice(start, next < 0 ? undefined : next);
    const original = block.split('\n').filter(line => /^[0-9a-f-]{36}: /.test(line));
    if (!original.length) { exclude('no-visible-records'); continue; }
    const visible = original.map(line => records[positions.get(line.slice(0, 36))]);
    if (visible.some(r => !r)) { exclude('missing-attestation'); continue; }
    const branches = new Set(visible.map(r => r.branchId ?? 'root'));
    const attempts = new Set(visible.map(r => r.attempt ?? 1));
    if (branches.size !== 1 || attempts.size !== 1) { exclude('multi-origin-scope'); continue; }
    const branch = [...branches][0], attempt = [...attempts][0];
    const last = Math.max(...visible.map(r => positions.get(r.eventId)));
    const scope = records.slice(0, last + 1).filter(r => (r.branchId ?? 'root') === branch && (r.attempt ?? 1) === attempt);
    const evidence = witnesses(scope);
    const baseline = render('baseline', 24000, evidence);
    if (JSON.stringify(baseline.lines) !== JSON.stringify(original)) { exclude('baseline-not-exact'); continue; }
    const latest = new Map();
    for (const r of scope) if (r.tool === 'run_shell' || r.tool === 'record_probe') latest.set(commandKey(r), r);
    let verdict = null;
    try { verdict = JSON.parse(event.response).approved; } catch { /* Unknown is not a negative verdict. */ }
    const end = trace.events.findIndex((e, i) => i > index && (e.kind === 'acceptance' || (e.kind === 'tool' && ['edit_file', 'write_file'].includes(e.name))));
    const window = trace.events.slice(index + 1, end < 0 ? undefined : end);
    const windowCalls = window.filter(e => e.kind === 'llm');
    cases.push({ runId: rid, eventId: event.id, eventIndex: index, branch, attempt,
      records: scope.length, commands: latest.size, inputSha256: hash(evidence), originalVerdict: verdict,
      originalDurationMs: event.durationMs, originalUsage: event.usage, originalCostUsd: event.costUsd,
      followingWindow: { endIndex: end < 0 ? trace.events.length : end,
        modelCalls: windowCalls.length, toolCalls: window.filter(e => e.kind === 'tool').length,
        subscriptionEquivalentUsd: windowCalls.reduce((sum, e) => sum + (e.costUsd ?? 0), 0),
        attribution: 'Run-wide work until next source write or root acceptance; concurrent/unrelated work may be included.' },
    });
    for (const arm of Object.keys(sources)) for (const budget of protocol.budgetsChars) {
      const projected = render(arm, budget, evidence), ids = projected.eventIds;
      const kept = [...latest.values()].filter(r => ids.has(r.eventId));
      rows.push({ eventId: event.id, arm, budget, actualChars: projected.lines.join('\n').length,
        omittedRecords: projected.omitted, latestCommands: latest.size, keptLatestCommands: kept.length,
        knownSuccesses: [...latest.values()].filter(r => outcome(r) === 0).length,
        keptKnownSuccesses: kept.filter(r => outcome(r) === 0).length,
        knownFailures: [...latest.values()].filter(r => outcome(r) !== null && outcome(r) !== 0).length,
        keptKnownFailures: kept.filter(r => outcome(r) !== null && outcome(r) !== 0).length,
        unknownOutcomes: [...latest.values()].filter(r => outcome(r) === null).length,
        keptUnknownOutcomes: kept.filter(r => outcome(r) === null).length,
        keptReads: scope.filter(r => r.tool === 'read_file' && ids.has(r.eventId)).length,
        keptBrowsers: scope.filter(r => r.tool === 'validate_html' && ids.has(r.eventId)).length,
        partialShells: projected.lines.filter(line => line.includes('PARTIAL SHELL OBSERVATION (omitted content is unknown; assertions are incomplete):')).length,
      });
    }
  }
}
db.close();
console.log(JSON.stringify({ schema: 1, protocolSha256: hash(JSON.stringify(protocol, null, 2) + '\n'),
  generatedAt: new Date().toISOString(), sources: Object.fromEntries(Object.entries(sources).map(([arm, s]) => [arm,
    { revision: s.revision, sourceSha256: s.sourceSha256, projectionSha256: s.projectionSha256 }])),
  runMetadata, includedCases: cases.length, excluded, cohortSha256: hash(cases.map(c => [c.runId, c.eventId, c.inputSha256])),
  cases, rows, limitation: 'Projection audit only: no model judgments, no approval/freshness credit, no causal total-run cost conclusion.' }));
