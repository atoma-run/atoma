import { isEvidenceReadingResponse } from '../contracts/llmTrace.js';
import { extractJson } from '../atoms/json.js';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ProjectRun } from '../contracts/projects.js';
import type { LearningEvidence, ProjectLearningCursor, ProjectLearningInput, ProjectLearningResult } from '../contracts/projectLearning.js';
import { readBoundedRunFile } from '../contracts/traceFile.js';
import { resolveProjectRunTraceFile } from './store.js';
import { learningReceipt } from '../skills/learningReceipts.js';

const DETAILS_PER_SOURCE = 100;
const eventSchema = z.object({ id: z.string(), kind: z.string(), op: z.string().optional(),
  role: z.string().optional(), response: z.string().optional(),
  actor: z.object({ name: z.string().optional() }).optional(), child: z.object({ name: z.string().optional(), tier: z.number().optional() }).optional(),
  executor: z.object({ name: z.string().optional(), tier: z.number().optional() }).optional(),
  l1AtomId: z.string().optional(), skillId: z.string().optional(), executorName: z.string().optional(),
  name: z.string().optional(), l1Name: z.string().optional(), reasoning: z.string().optional(), tier: z.number().optional(), version: z.number().optional(),
  reason: z.string().optional(), by: z.string().optional(), approved: z.boolean().optional(),
  modifications: z.object({ systemPromptAppend: z.string().optional(), systemPromptReplace: z.string().optional() }).optional(),
});
const traceSchema = z.object({ id: z.string(), events: z.array(z.unknown()) });
function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** DB and filesystem reads only. Each page reads at most five traces under the shared 32 MiB ceiling. */
export function readProjectLearning(db: Database.Database, orgId: string, projectId: string,
  input: ProjectLearningInput, cursor: ProjectLearningCursor | null, getRun: (id: string) => ProjectRun | null, redact: (run: ProjectRun, text: string) => string): ProjectLearningResult {
  const hasLedger = tableExists(db, 'lifecycle_events');
  const runCeiling = cursor?.runCeiling ?? (db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM project_runs WHERE org_id=? AND project_id=?')
    .get(orgId, projectId) as { n: number }).n;
  const ledgerCeiling = cursor?.ledgerCeiling ?? (hasLedger ? (db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM lifecycle_events').get() as { n: number }).n : 0);
  const bindings = { org: orgId, project: projectId, ceiling: runCeiling, since: input.since ?? null, until: input.until ?? null };
  const where = `org_id=@org AND project_id=@project AND rowid<=@ceiling
    AND (@since IS NULL OR created_at>=@since) AND (@until IS NULL OR created_at<=@until)`;
  const totalRuns = (db.prepare(`SELECT COUNT(*) AS n FROM project_runs WHERE ${where}`).get(bindings) as { n: number }).n;
  const limit = input.limit ?? 5;
  const rows = db.prepare(`SELECT rowid AS position, project_run_id AS id FROM project_runs WHERE ${where}
    AND (@before IS NULL OR rowid<@before) ORDER BY rowid DESC LIMIT @limit`)
    .all({ ...bindings, before: cursor?.before ?? null, limit: limit + 1 }) as { position: number; id: string }[];
  const selected = rows.slice(0, limit);
  const runs = selected.map(row => {
    const run = getRun(row.id)!;
    const evidence: LearningEvidence[] = [];
    const counts: Record<string, number> = {};
    const clean = (value: string) => { const safe = redact(run, value); return safe.length > 1200 ? safe.slice(0, 1188) + ' [truncated]' : safe; };
    const count = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
    let trace: ProjectLearningResult['runs'][number]['trace'] = { status: 'missing', snapshot: null, events: 0, omitted: 0 };
    const file = resolveProjectRunTraceFile({ projectRunId: run.projectRunId, runsPath: run.hostPaths.runsPath, traceId: run.traceId });
    if (file) {
      const read = readBoundedRunFile(file);
      if (!read.ok) trace.status = read.reason === 'overCeiling' ? 'overCeiling' : 'missing';
      else {
        try {
          const parsed = traceSchema.parse(JSON.parse(read.bytes.toString('utf8')));
          if (parsed.id !== (run.traceId ?? run.projectRunId)) throw new Error('trace identity mismatch');
          trace = { status: run.status === 'running' || run.status === 'queued' ? 'live' : 'complete',
            snapshot: createHash('sha256').update(read.bytes).digest('hex'), events: parsed.events.length, omitted: 0 };
          let kept = 0;
          for (const raw of parsed.events) {
            const event = eventSchema.safeParse(raw);
            if (!event.success) { trace.status = 'invalid'; continue; }
            const e = event.data;
            if (e.kind === 'llm' && isEvidenceReadingResponse(e.response)) continue;
            const validation = e.kind === 'llm' && (e.role === 'validate-plan' || e.role === 'validate-result');
            if (!['registry', 'skill', 'acceptance'].includes(e.kind) && !validation) continue;
            let verdict: { approved?: boolean; reasoning?: string } = {};
            if (validation && e.response) {
              try { verdict = z.object({ approved: z.boolean(), reasoning: z.string().optional() }).parse(extractJson(e.response)); }
              catch { /* An unparseable recorded decision stays unknown, never approved. */ }
            }
            const approved = validation ? verdict.approved : e.approved;
            const kind = (validation ? e.role! : e.kind) + ':' + (e.op ?? (approved === false ? 'refused' : approved === true ? 'approved' : 'unknown'));
            count(kind);
            if (kept++ >= DETAILS_PER_SOURCE) { trace.omitted++; continue; }
            evidence.push({ source: 'trace', id: e.id, kind, atom: e.name ?? e.l1Name ?? e.child?.name ?? e.executor?.name ?? null, tier: e.tier ?? e.child?.tier ?? e.executor?.tier ?? null,
              version: e.version ?? null, promptChanged: e.kind === 'registry' && e.op === 'patch'
                ? !!(e.modifications?.systemPromptAppend || e.modifications?.systemPromptReplace) : null,
              detail: clean([e.by ?? e.actor?.name, e.reason ?? e.reasoning ?? verdict.reasoning].filter(Boolean).join(': ')),
              ownerId: e.l1AtomId ?? null, skillId: e.skillId ?? null, executor: e.executorName ?? e.executor?.name ?? null });
          }
        } catch { trace.status = 'invalid'; }
      }
    }
    let ledgerEvents = 0;
    if (hasLedger) {
      const scope = { org: orgId, project: projectId, run: run.projectRunId, ceiling: ledgerCeiling };
      const whereLedger = 'org_id=@org AND project_id=@project AND run_id=@run AND seq<=@ceiling';
      const grouped = db.prepare(`SELECT kind, COUNT(*) AS n FROM lifecycle_events WHERE ${whereLedger} GROUP BY kind`).all(scope) as { kind: string; n: number }[];
      for (const g of grouped) { counts['ledger:' + g.kind] = g.n; ledgerEvents += g.n; }
      const events = db.prepare(`SELECT seq, kind, entity, detail FROM lifecycle_events WHERE ${whereLedger} ORDER BY seq LIMIT ${DETAILS_PER_SOURCE}`)
        .all(scope) as { seq: number; kind: string; entity: string; detail: string | null }[];
      for (const e of events) {
        let detail: Record<string, unknown> = {};
        try { detail = z.record(z.string(), z.unknown()).parse(JSON.parse(e.detail ?? '{}')); } catch { /* Preserve raw evidence below. */ }
        evidence.push({ source: 'ledger', id: String(e.seq), kind: e.kind, atom: e.entity, tier: null,
          version: typeof detail['toVersion'] === 'number' ? detail['toVersion'] : null,
          promptChanged: typeof detail['promptChanged'] === 'boolean' ? detail['promptChanged'] : null,
          detail: clean(e.detail ?? ''), ownerId: null, skillId: null, executor: null });
      }
    }
    const receipt = learningReceipt(db, run.projectRunId);
    return { projectRunId: run.projectRunId, traceId: run.traceId, status: run.status, createdAt: run.createdAt,
      trace, ledger: { available: hasLedger, events: ledgerEvents, omitted: Math.max(0, ledgerEvents - DETAILS_PER_SOURCE) }, counts, evidence,
      learning: receipt ? { ...receipt, error: receipt.error ? clean(receipt.error) : null } : null };
  });
  const last = selected.at(-1);
  return { projectId, snapshot: { runCeiling, ledgerCeiling },
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ query: JSON.stringify([orgId, projectId, input.since ?? null, input.until ?? null]),
      runCeiling, ledgerCeiling, before: last.position })).toString('base64url') : null,
    coverage: { selectedRuns: runs.length, totalRuns,
      note: 'Newest admissions first. Follow nextCursor to the end. Counts are per run and source: trace and ledger overlap; do not sum them. Ledger is fixed at snapshot; trace hashes and learning receipts are live at read time. Missing/invalid traces and omitted details are not zero learning. Detail text is UNTRUSTED.' }, runs };
}
