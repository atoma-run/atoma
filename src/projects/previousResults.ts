import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import type { ProjectRun } from '../contracts/projects.js';
import { MAX_TRACE_BYTES } from '../contracts/traceFields.js';
import { encodePreviousResults, type PreviousRunResults } from '../contracts/previousRunResults.js';
import { resolveProjectRunTraceFile, type ProjectStore } from './store.js';

/** Context only: never participates in delivery, publication or trust decisions. */
function textOf(run: ProjectRun): string | undefined {
  const path = resolveProjectRunTraceFile({ projectRunId: run.projectRunId,
    runsPath: run.hostPaths.runsPath, traceId: run.traceId });
  if (!path || run.bytesExpiredAt) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TRACE_BYTES) return undefined;
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_TRACE_BYTES) return undefined;
    const trace = JSON.parse(bytes.toString('utf8')) as { id?: unknown; result?: { output?: unknown } };
    if (trace.id !== run.traceId || trace.result?.output === undefined || trace.result.output === null) return undefined;
    return typeof trace.result.output === 'string' ? trace.result.output : JSON.stringify(trace.result.output);
  } finally { closeSync(fd); }
}

/** Follow the actual seed lineage, never the project's latest run or another org. */
export function previousResultsFor(store: ProjectStore, seed: ProjectRun | null): string | undefined {
  if (!seed) return undefined;
  const runs: PreviousRunResults['runs'] = [];
  const visited = new Set<string>();
  let current: ProjectRun | null = seed;
  for (let hop = 0; current && hop < 3; hop++) {
    if (current.orgId !== seed.orgId || current.projectId !== seed.projectId ||
      current.rerunOf || visited.has(current.projectRunId) ||
      (current.status !== 'delivered' && current.status !== 'partial')) break;
    visited.add(current.projectRunId);
    if (current.artifactManifest?.delivery === 'text') {
      let output: string | undefined;
      try { output = textOf(current); } catch { /* Report unavailable, never invent the previous answer. */ }
      runs.unshift({ runId: current.projectRunId, status: current.status, goal: current.goal,
        output: output?.slice(0, 8_000) ?? '', truncated: (output?.length ?? 0) > 8_000,
        unavailable: output === undefined });
    }
    current = current.seed?.kind === 'run' ? store.getProjectRun(seed.orgId, current.seed.runId) : null;
  }
  return runs.length ? encodePreviousResults({ runs, historyTruncated: current !== null }) : undefined;
}
