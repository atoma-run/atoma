import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import type { ProjectRun } from '../contracts/projects.js';
import { MAX_TRACE_BYTES } from '../contracts/traceFields.js';
import {
  encodeStandingHttpEvidence,
  standingHttpObservationsOf,
  type StandingHttpObservation,
} from '../contracts/standingHttpEvidence.js';
import { resolveProjectRunTraceFile, type ProjectStore } from './store.js';

function traceOf(run: ProjectRun): unknown {
  const path = resolveProjectRunTraceFile({ projectRunId: run.projectRunId,
    runsPath: run.hostPaths.runsPath, traceId: run.traceId });
  if (!path || run.bytesExpiredAt) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TRACE_BYTES) return undefined;
    const trace = JSON.parse(readFileSync(fd).toString('utf8')) as { id?: unknown };
    return trace.id === run.traceId ? trace : undefined;
  } finally { closeSync(fd); }
}

/**
 * The HTTP observations the host recorded in the seed lineage (at most three
 * hops, same project and org, delivered or partial, never a comparison rerun),
 * newest run first, for root acceptance to weigh against the code digest the
 * delivered workspace holds (`src/contracts/standingHttpEvidence.ts`).
 */
export function standingHttpEvidenceFor(store: ProjectStore, seed: ProjectRun | null): string | undefined {
  if (!seed) return undefined;
  const observations: StandingHttpObservation[] = [];
  const visited = new Set<string>();
  let current: ProjectRun | null = seed;
  for (let hop = 0; current && hop < 3; hop++) {
    if (current.orgId !== seed.orgId || current.projectId !== seed.projectId ||
      current.rerunOf || visited.has(current.projectRunId) ||
      (current.status !== 'delivered' && current.status !== 'partial')) break;
    visited.add(current.projectRunId);
    try {
      observations.push(...standingHttpObservationsOf(current.projectRunId, traceOf(current)));
    } catch { /* An unreadable trace is no evidence, never an error for the new run. */ }
    try { if (store.getRepositorySync(current.orgId, current.projectRunId)?.taken) break; }
    catch { break; }
    current = current.seed?.kind === 'run' ? store.getProjectRun(seed.orgId, current.seed.runId) : null;
  }
  return encodeStandingHttpEvidence(observations);
}
