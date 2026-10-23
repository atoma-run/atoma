/** Shared platform-only readers for HTTP and MCP. Paths are never accepted from callers. */
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { assayRecordStatus, skillAssayRecordSchema, type AssayListing, type AssaySummary, type SkillAssayRecord } from '../contracts/skillAssay.js';
import { readBoundedJson } from '../sentinel/sources.js';

const SCAN_MAX = 2000;
const RECORD_MAX = 256 * 1024;
function contained(root: string, path: string): string {
  const real = realpathSync(path);
  const rel = relative(realpathSync(root), real);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Assay evidence path refused');
  return real;
}
function recordAt(dir: string): SkillAssayRecord | null {
  try {
    const parsed = skillAssayRecordSchema.safeParse(readBoundedJson(contained(dir, join(dir, 'assay.json')), RECORD_MAX));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
function summary(id: string, record: SkillAssayRecord): AssaySummary {
  const status = assayRecordStatus(record);
  return { id, namespace: record.namespace, skillId: record.skillId, surfaceDigest: record.surfaceDigest,
    startedAt: record.startedAt, endedAt: record.endedAt, status,
    judgement: status === 'completed' ? record.judgement : null,
    failure: record.failure ?? (status === 'failed' ? 'Legacy attempt contains invalid execution evidence; no recipe judgement.' : null),
    totalCostUsd: record.totalCostUsd, cases: record.cases.length,
    arms: record.cases.flatMap(c => [c.with, c.without].map(a => ({ arm: a.arm, outcome: a.outcome,
      matched: a.matched, llmCalls: a.llmCalls, durationS: a.durationS, traceId: a.traceId }))) };
}
export function listAssays(supervisorDir: string, opts: { before?: string; limit?: number } = {}): AssayListing {
  const root = join(supervisorDir, 'assays');
  let names: string[];
  try { names = readdirSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Assay history unavailable');
    return { assays: [], nextBefore: null, scanned: 0, unreadable: 0, scanTruncated: false };
  }
  const rows: AssaySummary[] = [];
  let unreadable = 0;
  for (const name of names.slice(0, SCAN_MAX)) {
    try {
      const dir = contained(root, join(root, name));
      const record = recordAt(dir);
      if (record) rows.push(summary(name, record)); else unreadable++;
    } catch { unreadable++; }
  }
  rows.sort((a, b) => b.endedAt.localeCompare(a.endedAt) || b.id.localeCompare(a.id));
  const cursor = (row: AssaySummary) => `${row.endedAt}|${row.id}`;
  const remaining = opts.before ? rows.filter(r => cursor(r) < opts.before!) : rows;
  const page = remaining.slice(0, Math.max(1, Math.min(50, opts.limit ?? 20)));
  return { assays: page, nextBefore: remaining.length > page.length ? cursor(page[page.length - 1]!) : null,
    scanned: Math.min(names.length, SCAN_MAX), unreadable, scanTruncated: names.length > SCAN_MAX };
}
export function showAssay(supervisorDir: string, opts: {
  id: string; section?: 'record' | 'log' | 'trace'; caseIndex?: number; arm?: 'with' | 'without'; offset?: number; limit?: number;
}) {
  if (!/^[a-zA-Z0-9_-]{1,300}$/.test(opts.id)) throw new Error('Invalid assay id');
  const root = join(supervisorDir, 'assays');
  const dir = contained(root, join(root, opts.id));
  const record = recordAt(dir);
  if (!record) throw new Error('Assay record unavailable');
  const projected = summary(opts.id, record);
  if (!opts.section || opts.section === 'record') return { summary: projected,
    record: { ...record, status: projected.status, judgement: projected.judgement, applied: projected.status === 'completed' && record.applied,
      cases: record.cases.slice(0, 10).map(c => ({ ...c, task: c.task.slice(0, 4000) })) }, untrusted: true };
  const index = opts.caseIndex ?? 0;
  if (!Number.isInteger(index) || index < 0 || !record.cases[index]) throw new Error('Invalid assay case');
  const arm = opts.arm ?? 'with';
  const result = record.cases[index][arm];
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  if (opts.section === 'log') {
    const path = contained(dir, join(dir, result.logPath));
    const size = statSync(path).size;
    const length = Math.min(Math.max(1, opts.limit ?? 16000), 16000, Math.max(0, size - offset));
    const fd = openSync(path, 'r');
    try {
      const bytes = Buffer.alloc(length);
      const read = readSync(fd, bytes, 0, length, offset);
      return { id: opts.id, section: 'log', text: bytes.subarray(0, read).toString('utf8'),
        offset, nextOffset: offset + read < size ? offset + read : null, totalBytes: size, untrusted: true };
    } finally { closeSync(fd); }
  }
  if (!result.traceId || !/^[a-zA-Z0-9_-]+$/.test(result.traceId)) throw new Error('Assay trace unavailable');
  const path = contained(dir, join(dir, 'runs', `${index}-${arm}`, `${result.traceId}.json`));
  const trace = readBoundedJson<{ events?: unknown[]; totals?: unknown; id?: string }>(path);
  if (!trace || !Array.isArray(trace.events)) throw new Error('Assay trace unavailable or exceeds reader limit');
  const events: unknown[] = [];
  let bytes = 0;
  for (const event of trace.events.slice(offset, offset + Math.min(50, Math.max(1, opts.limit ?? 20)))) {
    const encoded = JSON.stringify(event);
    const item = encoded.length > 12000 ? { omitted: true, reason: 'event exceeds 12000 characters', preview: encoded.slice(0, 1000) } : event;
    const size = JSON.stringify(item).length;
    if (bytes + size > 24000) break;
    events.push(item); bytes += size;
  }
  return { id: opts.id, section: 'trace', traceId: trace.id, totals: trace.totals, events,
    offset, nextOffset: offset + events.length < trace.events.length ? offset + events.length : null,
    totalEvents: trace.events.length, untrusted: true };
}
