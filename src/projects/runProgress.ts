import { lstatSync } from 'node:fs';
import { z } from 'zod';
import { acceptanceSchema } from '../contracts/depthRouting.js';
import { PROJECT_RUN_WAITING_MESSAGE, type ProjectRun } from '../contracts/projects.js';
import type { RunProgress } from '../contracts/clientExperience.js';
import { readBoundedRunFile } from '../viz/runIndex.js';
import { resolveProjectRunTraceFile } from './store.js';

const traceProgressSchema = z.object({ id: z.string(), endedAt: z.string().optional(), events: z.array(z.unknown()) });
const eventSchema = z.object({ kind: z.string(), ts: z.number().finite().min(0).max(8.64e15), role: z.string().optional() });
type Evidence = Omit<RunProgress, 'message'> & { ended: boolean };
// Only the small projection is cached, never a trace or model response. A task
// poll stats the receipt; unchanged files are not parsed again.
const cache = new Map<string, { stamp: string; value: Evidence | null }>();

function evidence(file: string, runId: string): Evidence | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) return null;
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const prior = cache.get(file);
    if (prior?.stamp === stamp) return prior.value;
    const read = readBoundedRunFile(file);
    let value: Evidence | null = null;
    if (read.ok) {
      const parsed = traceProgressSchema.safeParse(JSON.parse(read.bytes.toString('utf8')));
      if (parsed.success && parsed.data.id === runId) {
        value = { stage: 'preparing', source: 'trace', evidence: 'available', lastActivityAt: null,
          criteria: [], criteriaTruncated: false, acceptanceApproved: null, ended: !!parsed.data.endedAt };
        for (const raw of parsed.data.events) {
          const event = eventSchema.safeParse(raw);
          if (!event.success) continue;
          const { kind, role, ts } = event.data;
          const at = new Date(ts).toISOString();
          if (!value.lastActivityAt || value.lastActivityAt < at) value.lastActivityAt = at;
          if (kind === 'llm-start' || kind === 'llm') {
            if (role === 'plan' || role === 'fallback-plan' || role === 'draft-checklist' || role === 'prefilter') value.stage = 'planning';
            else if (role === 'execute' || role === 'fallback-execute') value.stage = 'building';
            else if (role === 'validate-plan' || role === 'validate-result') value.stage = 'checking';
          } else if (kind === 'tool') value.stage = 'building';
          else if (kind === 'acceptance') {
            const accepted = acceptanceSchema.safeParse(raw);
            if (!accepted.success) continue;
            value.stage = 'checking';
            value.acceptanceApproved = accepted.data.approved;
            value.criteria = (accepted.data.checklist ?? []).slice(0, 12).map(item => ({
              id: item.id.slice(0, 80), behaviour: item.behaviour.slice(0, 400), status: item.status,
              met: item.judgement?.met ?? null, reason: (item.judgement?.reason ?? '').slice(0, 600),
            }));
            value.criteriaTruncated = (accepted.data.checklist?.length ?? 0) > 12;
          }
        }
      }
    }
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(file, { stamp, value });
    return value;
  } catch { return null; }
}

const messages: Record<RunProgress['stage'], string> = {
  queued: PROJECT_RUN_WAITING_MESSAGE, preparing: 'Preparing the run.', planning: 'Planning the work.',
  building: 'Carrying out the planned work.', checking: 'Checking the work against its requirements.',
  finalizing: 'Finalizing the result and its files.', finished: 'Run finished.', unknown: 'Run in progress; detailed activity is unavailable.',
};

/** Read-only projection. Persisted lifecycle status always outranks trace activity. */
export function projectRunProgress(run: ProjectRun): RunProgress {
  const file = resolveProjectRunTraceFile({ projectRunId: run.projectRunId, runsPath: run.hostPaths.runsPath, traceId: run.traceId });
  const detail = file ? evidence(file, run.traceId ?? run.projectRunId) : null;
  const terminal = run.status !== 'queued' && run.status !== 'running';
  const stage = terminal ? 'finished' : run.status === 'queued' ? 'queued' : detail?.ended ? 'finalizing' : detail?.stage ?? 'unknown';
  const criteria = detail?.criteria ?? [];
  const met = criteria.filter(item => item.met === true).length;
  return {
    stage, message: terminal ? `Run ${run.status}.` : messages[stage] + (criteria.length ? ` Latest recorded review: ${met}/${criteria.length} criteria judged met.` : ''),
    source: detail ? 'trace' : 'run', evidence: detail ? 'available' : 'unavailable',
    lastActivityAt: detail?.lastActivityAt ?? run.endedAt ?? run.startedAt ?? run.createdAt,
    criteria, criteriaTruncated: detail?.criteriaTruncated ?? false, acceptanceApproved: detail?.acceptanceApproved ?? null,
  };
}
