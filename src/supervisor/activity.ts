import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { peekDeploymentPending, runLeaseOwnerLive } from '../mcp/runLock.js';
import { readBoundedJson } from '../sentinel/sources.js';
import { isIndexEntryLive } from '../viz/liveness.js';
import type { VizRunIndexEntry } from '../viz/trace.js';

/**
 * IS A RUN EXECUTING RIGHT NOW — the one question both supervisor stages gate
 * on, answered once.
 *
 * The analyst and the mender spend the operator's model quota and the
 * mender's full check owns the machine for minutes, so neither may start
 * beside a run (`docs/supervisor-design.md`, quota sequencing). Two stages
 * with two predicates would drift on the exact question that keeps them off a
 * live batch — which is what the out-of-product scripts had before they were
 * given one shared module.
 *
 * Nothing here is new: the operator index is read through the sentinel's
 * bounded reader, liveness is the repository's ONE live predicate
 * (`isIndexEntryLive`), and the MCP lease is peeked through the lock module's
 * own read-only accessor. A torn index read counts as ACTIVE — a run is
 * writing it — and an unreadable lease counts as unknown, which the index
 * check then decides alone.
 *
 * A deployment WAITING for the slot counts as active too, although nothing
 * runs yet: it is what stops a stage from taking the slot back the moment the
 * current holder releases it. The mender chained mends with no gap and
 * refused two deployments in a row on 2026-09-27; the acquisition refuses
 * such a taker anyway, and this is the same fact read before any work starts.
 */
export interface ActivityProbe {
  readonly runsDir: string;
  readonly leasePath: string;
}

export interface Activity {
  readonly active: boolean;
  /** Why, for the operator's console line. */
  readonly reason: 'live-index-entry' | 'index-torn' | 'lease-held' | 'deployment-pending' | 'idle';
}

export function probeActivity(probe: ActivityProbe, now = Date.now()): Activity {
  const entries = readBoundedJson<unknown>(join(probe.runsDir, 'index.json'));
  if (entries === null && indexExists(probe.runsDir)) return { active: true, reason: 'index-torn' };
  if (Array.isArray(entries)) {
    for (const entry of entries as VizRunIndexEntry[]) {
      if (entry && typeof entry === 'object' && isIndexEntryLive(entry, now)) {
        return { active: true, reason: 'live-index-entry' };
      }
    }
  }
  // By birth identity, not pid: a dead owner's pid reused after a reboot —
  // by any process, the mender itself included — would otherwise read as a
  // run forever, and the stages that reclaim such a row would never try.
  if (runLeaseOwnerLive(probe.leasePath)) return { active: true, reason: 'lease-held' };
  if (peekDeploymentPending(probe.leasePath)) return { active: true, reason: 'deployment-pending' };
  return { active: false, reason: 'idle' };
}

function indexExists(runsDir: string): boolean {
  return existsSync(join(runsDir, 'index.json'));
}

export function anyRunActive(probe: ActivityProbe, now = Date.now()): boolean {
  return probeActivity(probe, now).active;
}

/** Finished operator runs, oldest first, from the same bounded read. */
export function finishedRuns(runsDir: string): VizRunIndexEntry[] {
  const entries = readBoundedJson<unknown>(join(runsDir, 'index.json'));
  if (!Array.isArray(entries)) return [];
  return (entries as VizRunIndexEntry[])
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.endedAt === 'string')
    .sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));
}
