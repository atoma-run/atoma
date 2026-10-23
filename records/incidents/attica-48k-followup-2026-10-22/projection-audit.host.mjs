import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const protocol = {"schema":1,"recordedAt":"2026-10-22 08:24:41 UTC","runId":"1622e44b-8d9f-41dc-8827-a1af7cb38353","projectId":"07864f7c-d8f2-4023-9fca-afd8a7a51e52","selectorRevision":"f9d71587b1f2111de0d636d31c2734489ca44da5","budgetsChars":[24000,48000],"goal":"Assess evidence visibility and actual retry causes in the one ordinary Attica run using 48k.","registration":"Analysis plan recorded during the run after the first 692 summary events and 23 review responses were read. This is not a pre-registered end-to-end randomized comparison.","cohort":"Every completed L2 RESULT review with a transport block whose 48k rendering is reconstructed exactly, including omission count and provenance scope; enumerate exclusions. Inventory all other reviews separately, including plans and L3.","measurements":["retained latest command identities and outcome status","partial versus complete excerpts; retained inspected reads/browser observations","recorded verdict and concrete refusal cause","missing-at-24k but present-at-48k evidence relevant to each refusal","time, model calls, tool calls and subscription-equivalent cost between refusal and recovery, labelled for concurrent work","final run outcome and independently checked saved source/build/history integrity"],"guards":["Use the same pinned selector and observation set for both caps; change only the cap.","Match actual 48k visible lines and omission count before including a reconstruction.","A retained command or partial excerpt does not prove assertions, freshness or correctness.","A counterfactual projection does not demonstrate the verdict a model would issue at 24k.","Older runs changed engine/source versions, so cross-run differences are confounded.","No new paid model calls while this run is active; no new product run, engine patch, client acceptance, publication or live-site traffic.","No broad rawtrace/artifact exports or bypasses; bounded MCP reads and host-local numeric projections only."],"phaseA":{"runs":["1622e44b-8d9f-41dc-8827-a1af7cb38353"]}};
const sources = {"current":{"revision":"f9d71587b1f2111de0d636d31c2734489ca44da5","sourceSha256":"342dc6e4336eb77476523682a402416089d896b7f01c486a17d643abfd116df5","projectionSha256":"65d72cb359d83a132869b7aeba71fc8b06c8b3adce594b16cae305f74317712b","compiled":"\"use strict\";\nObject.defineProperty(exports, \"__esModule\", { value: true });\nexports.renderTransportEvidence = renderTransportEvidence;\nconst MAX_TOOL_EVIDENCE_CHARS = budget;\nconst MAX_BROWSER_EVIDENCE_LINES = 8;\nfunction requestField(observed, field) {\n    const start = observed.indexOf('request=');\n    const end = observed.indexOf('; observed result=', start);\n    if (start < 0 || end < 0)\n        return undefined;\n    try {\n        const value = JSON.parse(observed.slice(start + 'request='.length, end))?.[field];\n        return typeof value === 'string' ? value : undefined;\n    }\n    catch {\n        return undefined;\n    }\n}\nfunction probeCommand(observed) {\n    const start = observed.indexOf('request=');\n    const end = observed.indexOf('; observed result=', start);\n    if (start < 0 || end < 0)\n        return observed;\n    const request = observed.slice(start + 'request='.length, end);\n    try {\n        const parsed = JSON.parse(request);\n        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))\n            return observed;\n        const { note: _note, ...args } = parsed;\n        // Tool spellings differ, but the same request in the same lane is one\n        // check even when a later direct shell call reruns a recorded probe.\n        const lane = observed.slice(0, start).replace(/^(?:record_probe|run_shell)/, 'shell');\n        return lane + JSON.stringify(args);\n    }\n    catch {\n        // A cut request is unknown, not equal to another request with the same head.\n        return observed;\n    }\n}\nfunction shellEvidenceExcerpt(observed, limit) {\n    const line = observed.replace(/\\r/g, '\\\\r').replace(/\\n/g, '\\\\n');\n    if (line.length <= limit)\n        return line;\n    const label = 'PARTIAL SHELL OBSERVATION (omitted content is unknown; assertions are incomplete): ';\n    const marker = ' [omitted] ';\n    const available = Math.max(0, limit - label.length - marker.length);\n    const head = Math.ceil(available * 0.7);\n    const tail = available - head;\n    return label + line.slice(0, head) + marker + (tail ? line.slice(-tail) : '');\n}\nfunction renderTransportEvidence(evidence) {\n    const observed = transportWitnesses(evidence);\n    const browserIds = new Set(observed.filter((witness) => witness.tool === 'validate_html')\n        .slice(-MAX_BROWSER_EVIDENCE_LINES).map((witness) => witness.eventId));\n    const keep = new Set(browserIds);\n    const excerpts = new Map();\n    let evidenceChars = observed.filter((witness) => browserIds.has(witness.eventId))\n        .reduce((total, witness) => total + witness.eventId.length + 3 + witness.observed.length, 0);\n    // EARLIER PASSING CHECKS the latest lines no longer show, newest first,\n    // within a third of the budget. Run 7f80148d (2026-10-10) proved a reload\n    // persistence and a Tab-and-Enter journey, then made ~150 more browser calls\n    // tuning a timer; the root saw the last eight and refused both criteria as\n    // never observed. A check is its executed actions, smoke and size. Its\n    // LATEST run decides (an older pass of a check that later failed stays out),\n    // and a pass of a document since rewritten stays out: the page it proved is\n    // gone. The same per-command rule recorded probes follow below.\n    const latestDocument = new Map();\n    for (const witness of observed) {\n        const document = witness.browser?.document;\n        if (document)\n            latestDocument.set(document.path, document.sha256);\n    }\n    const seenChecks = new Set(observed.filter((witness) => browserIds.has(witness.eventId))\n        .flatMap((witness) => witness.browser ? [witness.browser.check] : []));\n    // Paths a write or edit touched AFTER the witness being considered: the\n    // walk is newest first, so the set holds exactly the later writes.\n    const writtenLater = new Set();\n    let revivedChars = 0;\n    for (const witness of [...observed].reverse()) {\n        if (witness.tool === 'write_file' || witness.tool === 'edit_file') {\n            const path = requestField(witness.observed, 'path');\n            if (path)\n                writtenLater.add(path.replace(/^\\.\\//, ''));\n            continue;\n        }\n        const facts = witness.browser;\n        if (witness.tool !== 'validate_html' || !facts || keep.has(witness.eventId) || seenChecks.has(facts.check))\n            continue;\n        seenChecks.add(facts.check);\n        if (!facts.ok)\n            continue;\n        if (facts.document && (latestDocument.get(facts.document.path) !== facts.document.sha256 || writtenLater.has(facts.document.path)))\n            continue;\n        const length = witness.eventId.length + 3 + witness.observed.length;\n        // A quarter of the budget stays for the file reads below (run ce89c84a).\n        if (revivedChars + length > MAX_TOOL_EVIDENCE_CHARS / 3 ||\n            evidenceChars + length > MAX_TOOL_EVIDENCE_CHARS - MAX_TOOL_EVIDENCE_CHARS / 4)\n            continue;\n        keep.add(witness.eventId);\n        revivedChars += length;\n        evidenceChars += length;\n    }\n    // Preserve inspected source alongside execution results. These are still\n    // bounded historical excerpts, including any stale-read marker; no coverage\n    // or current-file claim follows from selecting them (run ce89c84a).\n    let readChars = 0;\n    for (const witness of [...observed].reverse()) {\n        if (witness.tool !== 'read_file')\n            continue;\n        const length = witness.eventId.length + 3 + witness.observed.length;\n        if (readChars + length > MAX_TOOL_EVIDENCE_CHARS / 2 ||\n            evidenceChars + length > MAX_TOOL_EVIDENCE_CHARS)\n            break;\n        keep.add(witness.eventId);\n        readChars += length;\n        evidenceChars += length;\n    }\n    // Both shell tools produce transport observations. Direct run_shell checks\n    // must survive later reads too (Attica ba6b0a21). Keep the latest outcome,\n    // including failures; this selection grants no freshness or proof credit.\n    const latestCommands = new Map();\n    const recordedCommands = new Set();\n    for (const witness of [...observed].reverse()) {\n        if (witness.tool !== 'record_probe' && witness.tool !== 'run_shell')\n            continue;\n        const key = probeCommand(witness.observed);\n        if (!latestCommands.has(key))\n            latestCommands.set(key, witness);\n        if (witness.tool === 'record_probe')\n            recordedCommands.add(key);\n    }\n    // Share the remaining space between command identities before their payloads.\n    // Otherwise a long successful matrix/check disappears while a short failed\n    // invocation fits, and the reviewer sees only the failure (Attica b920faf6).\n    // Recorded probes retain priority; latest outcomes, including failures, win.\n    const commands = [true, false].flatMap(priority => [...latestCommands]\n        .filter(([key]) => recordedCommands.has(key) === priority)\n        .map(([, witness]) => witness));\n    const remaining = MAX_TOOL_EVIDENCE_CHARS - evidenceChars;\n    const overhead = commands.reduce((max, witness) => Math.max(max, witness.eventId.length + 3), 0);\n    const selected = commands.slice(0, Math.max(0, Math.floor(remaining / (256 + overhead))));\n    for (const [index, witness] of selected.entries()) {\n        const allowance = Math.floor((MAX_TOOL_EVIDENCE_CHARS - evidenceChars) / (selected.length - index));\n        const excerpt = shellEvidenceExcerpt(witness.observed, allowance - witness.eventId.length - 3);\n        keep.add(witness.eventId);\n        excerpts.set(witness.eventId, excerpt);\n        evidenceChars += witness.eventId.length + 3 + excerpt.length;\n    }\n    for (const witness of [...observed].reverse()) {\n        if (witness.tool === 'validate_html' || witness.tool === 'run_shell' || witness.tool === 'record_probe' || keep.has(witness.eventId))\n            continue;\n        const length = witness.eventId.length + 3 + witness.observed.length;\n        if (evidenceChars + length > MAX_TOOL_EVIDENCE_CHARS)\n            break;\n        keep.add(witness.eventId);\n        evidenceChars += length;\n    }\n    const lines = observed.filter((witness) => keep.has(witness.eventId))\n        .map((witness) => `${witness.eventId}: ${excerpts.get(witness.eventId) ?? witness.observed}`);\n    return { lines, omitted: observed.length - lines.length, eventIds: keep };\n}\n"}};
const release = '/home/atoma/releases/f9d71587b1f2111de0d636d31c2734489ca44da5';
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
  if (trace.provenance?.revision !== protocol.selectorRevision) throw Error('Unexpected trace revision');
  const records = trace.attestations ?? [];
  const positions = new Map(records.map((r, i) => [r.eventId, i]));
  runMetadata.push({ runId: rid, status: row.status, eventCount: trace.events.length, attestationCount: records.length, provenance: trace.provenance, traceContentSha256: hash(JSON.stringify(trace)), completed: !!trace.endedAt });
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
    const baseline = render('current', 48000, evidence);
    const omissionMatch = block.match(/(\d+) earlier observations omitted/);
    const actualOmitted = omissionMatch ? Number(omissionMatch[1]) : 0;
    if (baseline.omitted !== actualOmitted) { exclude('omission-count-not-exact'); continue; }
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
        keptCommandEventIds: kept.map(r => r.eventId),
        keptReadEventIds: scope.filter(r => r.tool === 'read_file' && ids.has(r.eventId)).map(r => r.eventId),
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
