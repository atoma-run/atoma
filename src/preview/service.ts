import {
  previewSummarySchema,
  type PreviewClassification,
  type PreviewDescriptor,
  type PreviewInstance,
  type PreviewSummary,
} from '../contracts/preview.js';
import type { DeliveredPreviewSubject } from '../projects/coordinator.js';
import { buildPreviewDescriptor, usableNodeEntry } from './descriptor.js';
import { effectiveEgressHosts, PreviewStore } from './store.js';

/**
 * THE PREVIEW SERVICE — what the feature DOES, with no transport in it.
 *
 * Deliberately not written inside `src/viz/server.ts`. That file already
 * composes auth, projects, GitHub, push, announcements and the sentinel while
 * still describing itself as a tiny read-only server, and the 2026-08-26
 * Lovable review named it the concrete gap to close: "amincir l'adaptateur
 * HTTP et extraire les services par strangler", starting with one coherent
 * group rather than a rewrite (`records/reviews/lovable-lessons-atoma-2026-08-26.md` §1
 * and §3-P1). The preview is a new coherent group, so it is born extracted:
 * routes translate a request and call in here; the CLI calls the same
 * functions; both stay testable without a socket.
 */

/**
 * Classify a freshly delivered workspace and store the immutable descriptor.
 *
 * Called from inside the delivery path, so it must be quick and total: the
 * classifier reads two small bounded files and stats a handful of candidate
 * names, and returns a reason rather than throwing for anything it meets in a
 * workspace. What it does NOT swallow is a store failure — the coordinator's
 * own guard reports that, because a store that cannot write is a fact an
 * operator needs, not one to hide behind a preview.
 */
export function recordDeliveredPreview(
  store: PreviewStore,
  subject: DeliveredPreviewSubject,
  now?: Date
): PreviewDescriptor {
  const build = (remoteClassification?: PreviewClassification) => buildPreviewDescriptor({
    orgId: subject.orgId,
    projectId: subject.projectId,
    projectRunId: subject.projectRunId,
    workspaceRoot: subject.workspaceRoot,
    ...(remoteClassification ? { remoteClassification } : {}),
    ...(now ? { now } : {}),
  });
  const observed = build(subject.remoteClassification);
  return store.putDescriptor(inheritSeedDescriptor(store, subject, observed) ?? observed);
}

/**
 * A run that recorded no observation of its own inherits its seed's Node entry.
 *
 * Only `unsupported-deliverable` qualifies: that reason means the run's probe
 * manifest held no HTTP and no browser evidence at all, never that evidence
 * pointed elsewhere (`not-runnable`, a static page). A Compute export carries
 * only publishable files, so `.atoma-probes.json` never reaches the next seed
 * and every run that did not restart the server itself was classified
 * unsupported (Attica 84ae80d1, 7bbae0dc, 695faae8, 2026-10-22). The seed's
 * descriptor is host-written and immutable, and the entry must still be a
 * usable file in THIS delivered workspace, checked by the host; nothing a model
 * wrote is read. A static seed needs no inheritance: its `index.html` already
 * classifies from the files.
 */
function inheritSeedDescriptor(store: PreviewStore, subject: DeliveredPreviewSubject,
  observed: PreviewDescriptor): PreviewDescriptor | null {
  if (!subject.seedRunId || observed.availability !== 'unavailable' || observed.unavailableReason !== 'unsupported-deliverable') return null;
  const seed = store.getDescriptor(subject.orgId, subject.seedRunId);
  if (seed?.projectId !== subject.projectId || seed.availability !== 'available' || seed.kind !== 'node' || !seed.entry) return null;
  const entry = usableNodeEntry(subject.workspaceRoot, seed.entry);
  return entry ? { ...observed, availability: 'available', kind: 'node', entry, unavailableReason: null } : null;
}

/**
 * The only shape a browser receives, assembled from the three rows.
 *
 * A MISSING DESCRIPTOR IS `legacy-run`, not an error and not an empty screen:
 * runs delivered before this contract existed are simply not described, there
 * is no backfill, and saying so lets the surface offer the one thing that
 * actually helps — start a new run. A missing INSTANCE is `stopped` at
 * generation 0, which is the truthful reading of "nothing is running".
 */
export function previewSummary(input: {
  readonly descriptor: PreviewDescriptor | null;
  readonly instance: PreviewInstance | null;
  readonly approvedHosts: readonly string[];
  readonly operatorAllowedHosts?: readonly string[];
  /**
   * Whether the run is still going. Without it this projection could only
   * describe previews that ALREADY EXIST, and a run in flight was told it had
   * nothing to preview until something had already previewed it — a control
   * that could never appear, so a preview that could never be asked for.
   */
  readonly runInFlight?: boolean;
}): PreviewSummary {
  const { descriptor, instance } = input;
  const terminal = instance?.mode === 'terminal';
  // AN IN-FLIGHT PREVIEW HAS NO DESCRIPTOR, by contract: a descriptor is
  // immutable and describes what DELIVERY observed, while a snapshot is a
  // moment. Reading its absence as `legacy-run` would describe a run that is
  // building right now as one delivered before the feature existed.
  //
  // A run that is STILL GOING is previewable for the same reason and one step
  // earlier: nothing has been observed yet, and the answer is "ask and find
  // out" rather than "there is nothing here". What the snapshot then contains
  // is decided by classifying the COPY, which is the only honest moment to
  // decide it.
  // An explicit host status wins over the historical source of an instance.
  // A stopped snapshot does not make a failed/cancelled run reopenable.
  const inFlight = input.runInFlight ?? (instance?.source === 'in-flight');
  const requestedHosts = descriptor?.requestedHosts ?? [];
  const { allowed, blocked } = effectiveEgressHosts(requestedHosts, input.approvedHosts, input.operatorAllowedHosts);
  return previewSummarySchema.parse({
    // What the DELIVERY supports, never the mode the last instance used: a
    // stopped terminal left `mode` on its row, and reading that as the run's
    // capability announced `available` for a run an app open refuses. The
    // terminal capability is `terminalAvailable`, from the run's status.
    availability: descriptor?.availability ?? (inFlight ? 'available' : 'unavailable'),
    kind: descriptor?.kind ?? null,
    reason: descriptor ? descriptor.unavailableReason : inFlight ? null : 'legacy-run',
    ...(instance?.mode ? { mode: instance.mode } : {}),
    state: instance?.state ?? 'stopped',
    generation: instance?.generation ?? 0,
    source: instance?.source ?? 'delivered',
    snapshotAt: instance?.snapshotAt ?? null,
    readyAt: instance?.readyAt ?? null,
    expiresAt: instance?.expiresAt ?? null,
    errorCode: instance?.errorCode ?? null,
    requestedHosts,
    allowedHosts: terminal ? [] : allowed,
    blockedHosts: blocked,
  });
}

/** Read a run's complete preview state in one place. */
export function readPreviewSummary(
  store: PreviewStore,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly projectRunId: string;
    readonly runInFlight?: boolean;
    readonly operatorAllowedHosts?: readonly string[];
  }
): PreviewSummary {
  const descriptor = store.getDescriptor(input.orgId, input.projectRunId);
  return previewSummary({
    descriptor,
    instance: store.getInstance(input.orgId, input.projectRunId),
    approvedHosts: store.listApprovedHosts(input.orgId, input.projectId),
    operatorAllowedHosts: input.operatorAllowedHosts,
    runInFlight: input.runInFlight,
  });
}
