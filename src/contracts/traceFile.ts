import { lstatSync, readFileSync } from 'node:fs';
import { MAX_TRACE_BYTES } from './traceFields.js';

/**
 * The outcome of a bounded read. TWO refusals, because callers answer them
 * differently: a list SKIPS a row, while `/api/runs/:id` must say something,
 * and "past the ceiling" is not "no such run".
 */
export type BoundedRunFileRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: 'unreadable' | 'overCeiling' };

/**
 * The one place viz reads a whole file out of the run corpus — a trace, or the
 * operator `index.json` that points at them. Reviewed 2026-08-27 (2.4, 3.9):
 * `summarizeTraceFile` was bounded while `/api/runs/:id` and
 * `listOperatorRunIndex` still read whole documents. Nothing caps these files
 * in the pipeline: `TraceRecorder.persist()` rewrites the full trace after
 * every flush, measured at 1.48 MB and growing ~19KB per tool call.
 *
 * It hands back BYTES, not a parsed document, because the detail route serves
 * the trace byte-for-byte and a delta rejoins the complete run BEFORE
 * projection: re-serialising here would put this reader inside a wire contract
 * it does not own. That is also why it is not the sentinel's `readBoundedJson`
 * (`src/sentinel/sources.ts`), which owns the same NUMBER for a watch that only
 * ever wants the parsed value. One ceiling, two jobs, neither drifting into the
 * other.
 *
 * `lstatSync`, not `statSync`: a symlink is refused rather than followed out of
 * the corpus. The stat is a moment older than the read it guards, accepted
 * deliberately — at 32 MiB against ~19KB per persist the race overshoots by a
 * flush, never by an order of magnitude, and large-trace consumers instead use the bounded projections or streaming
 * ranges in `src/contracts/traceFields.ts`.
 */
export function readBoundedRunFile(file: string): BoundedRunFileRead {
  let size: number;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) return { ok: false, reason: 'unreadable' };
    size = stat.size;
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (size > MAX_TRACE_BYTES) return { ok: false, reason: 'overCeiling' };
  try {
    return { ok: true, bytes: readFileSync(file) };
  } catch {
    // Unlinked or replaced between the stat and the read: absent by the time
    // it mattered, and the caller's disposition for absent is the right one.
    return { ok: false, reason: 'unreadable' };
  }
}
