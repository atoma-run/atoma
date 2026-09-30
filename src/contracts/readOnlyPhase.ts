/**
 * WHAT A READ-ONLY PHASE CHANGED, AND WHAT THE RUNTIME PUT BACK — a
 * mechanical fact the phase's validator and the root acceptor read, never a
 * verdict.
 *
 * A root plan of two sequential phases or more gives a phase no `outputs`
 * only when it reads and verifies ("Omit the key only on read-only phases").
 * Two production runs wrote anyway: run 04ea696f's verification phase
 * (2026-09-30) replaced the page it was verifying with another one, which was
 * delivered, and run f793b338's "read-only inspect" subtask (2026-09-27)
 * overwrote a home page 23 times without reading it. The host now
 * photographs the workspace when such a phase starts and restores every file
 * it changed when it ends (`src/run/readOnlyPhase.ts`), whatever wrote it: an
 * element, a shell, a compiled script or a fallback. Refusing the writes
 * instead was built and reviewed first; a verifier that found a real defect
 * then looped between a gate asking for the fix and a fence refusing it, and a
 * fallback wrote the page anyway (docs/incidents/production-runs-2026-09-30.md).
 *
 * What such a phase OBSERVED while its changes stood is no proof of the files
 * as they were put back: when a restoration matters, its attestations count
 * for no acceptance (`staleObservations`) and its probe manifest is put back
 * with the rest. `.atoma-scratch/` and every name the workspace snapshot
 * skips (`.git`, `node_modules`, caches, the other `.atoma-*` names) are never
 * restored, and neither is a SQLite database a live process may hold open.
 */

/** The prefix a restored phase's summary carries, before what its executor reported. */
export const READ_ONLY_RESTORED_PREFIX = '[READ-ONLY PHASE RESTORED';

/** The line every validator reads beside a read-only task (`verdict.ts`). */
export const READ_ONLY_TASK_LINE =
  'Task mode: READ-ONLY PHASE — its plan declared no outputs, so the runtime undoes whatever it changes when it ends.';

/**
 * One path the phase changed. `changed`: its bytes, type or mode differ from
 * the phase's start. `removed`: the phase deleted it. `created`: the phase
 * added it (a directory's path ends in `/`). `restored` is false when the
 * runtime could not put it back, and `reason` says why.
 */
export interface ReadOnlyRestoredPath {
  readonly path: string;
  readonly change: 'changed' | 'removed' | 'created';
  /** Bytes at the phase's start, for a regular file that existed then. */
  readonly before?: number;
  /** Bytes when the phase ended, for a regular file that existed then. */
  readonly after?: number;
  readonly restored: boolean;
  readonly reason?: string;
}

export interface ReadOnlyRestoration {
  /** The phase's description, as its plan stated it (cut to a line). */
  readonly phase: string;
  readonly attempt: number;
  /** What the phase changed and the runtime put back, or failed to. */
  readonly paths: readonly ReadOnlyRestoredPath[];
  /**
   * What the phase changed that the runtime deliberately left as it is: a
   * SQLite database and its sidecars, which a live process may hold open,
   * and a file a process was writing when the phase started (a log). A fact
   * for the reader, never a restoration: it alone does not make one matter.
   */
  readonly left: readonly ReadOnlyRestoredPath[];
  /**
   * The photograph could not see everything: past its cap, or inside a
   * directory it could not list. Nothing there was compared, and nothing the
   * phase added there was removed.
   */
  readonly partial: boolean;
  /** The workspace could not be photographed at all: NOTHING was restored. */
  readonly unguarded?: string;
  /** The attestation event ids this execution recorded (see `staleObservations`). */
  readonly observations: readonly string[];
  /**
   * The paths among `paths` the phase changed ITSELF (`executionOwns`): what
   * makes a restoration DAMAGE rather than a side effect of verifying (a
   * server rewriting its data file, a log).
   */
  readonly written: readonly string[];
}

/** What the atom side hands the host when an execution ends. */
export interface ReadOnlyExecutionRecord {
  /** Attestation event ids the execution recorded. */
  readonly observations?: readonly string[];
  /** Workspace paths its element writes (`write_file`, `edit_file`) named, as the tools were asked. */
  readonly writes?: readonly string[];
  /** The entry file of every Node server it started. */
  readonly serverEntries?: readonly string[];
  /** The request of every `run_shell` and `record_probe` call it made, as attested. */
  readonly commands?: readonly string[];
  /** Every change is its own: a compiled script ran, and nothing else did. */
  readonly ownsEveryChange?: true;
}

/** One read-only execution in flight: `end` restores and reports, and never throws. */
export interface ReadOnlyPhaseGuard {
  end(record?: ReadOnlyExecutionRecord): ReadOnlyRestoration;
}

/**
 * The host capability on `RunContext.readOnlyPhases`. Absent, a phase marked
 * read-only runs exactly as any other: nothing is photographed or restored.
 */
export interface ReadOnlyPhases {
  begin(phase: string, attempt: number): ReadOnlyPhaseGuard;
  /** Every guarded execution, in order, whether it changed anything or not. */
  restorations(): readonly ReadOnlyRestoration[];
}

/** What a guarded result carries (`Result.readOnlyRestoration`): the restoration, and the summary as its executor wrote it. */
export interface ResultRestoration {
  readonly restoration: ReadOnlyRestoration;
  readonly summary: string;
}

/** Did the execution leave anything a reader must be told about? */
export function restorationMatters(restoration: ReadOnlyRestoration): boolean {
  return restoration.paths.length > 0 || restoration.partial || restoration.unguarded !== undefined;
}

/**
 * Did the phase change files ITSELF, through its own element writes, that
 * the runtime then put back? Only then is everything it observed suspect,
 * its credit withheld, its manifest put back and its servers stopped. A
 * verifier whose probes made a server rewrite its data file did its job
 * (second adversarial review, 2026-09-30).
 */
export function restorationDamaged(restoration: ReadOnlyRestoration): boolean {
  return restoration.written.length > 0;
}

/**
 * The observations no acceptance may count: every one a DAMAGED execution
 * recorded. They were made while its own changes stood — a page it rewrote
 * and laid out at 375 px, a server it rewrote and probed — so they describe
 * files the delivery no longer holds. A browser observation of any other
 * restored execution is judged by its document digest instead
 * (`rootAcceptance.ts`).
 */
export function staleObservations(restorations: readonly ReadOnlyRestoration[]): ReadonlySet<string> {
  return new Set(restorations.filter(restorationDamaged).flatMap((restoration) => restoration.observations));
}

/**
 * Does a restored path cover a path a tool call named? The file itself, or
 * anything inside a directory the phase created. A relative spelling must
 * match exactly: tail-matching it read `.atoma-scratch/data.json`, a
 * sanctioned scratch write, as the phase rewriting `data.json` (third
 * review). An absolute one (`/workspace/index.html`, the container's mount)
 * matches by one of its tails.
 */
export function restoredPathCoversWrite(restored: string, write: string): boolean {
  const directory = restored.endsWith('/');
  const bare = directory ? restored.slice(0, -1) : restored;
  const covers = (path: string): boolean => path === bare || (directory && path.startsWith(`${bare}/`));
  if (!write.startsWith('/')) return covers(write);
  const parts = write.split('/').filter(Boolean);
  return parts.some((_, index) => covers(parts.slice(index).join('/')));
}

/** Is a restored path, or its file name, a whole word of a command's text? */
function namedIn(restored: string, command: string): boolean {
  const bare = restored.endsWith('/') ? restored.slice(0, -1) : restored;
  const base = bare.slice(bare.lastIndexOf('/') + 1);
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\w./-])(?:${escape(bare)}|${escape(base)})(?:$|[^\\w./-])`).test(command);
}

/**
 * Did the execution change this restored path ITSELF? Its element writes
 * named it; a Node server it started runs it; one of its shell or probe
 * commands names it (a `sed -i` is a write no element records, third
 * review); or it was a compiled script, and every change is the script's.
 */
export function executionOwns(restored: string, record: ReadOnlyExecutionRecord): boolean {
  if (record.ownsEveryChange) return true;
  const owned = [...(record.writes ?? []), ...(record.serverEntries ?? [])];
  return owned.some((path) => restoredPathCoversWrite(restored, path)) ||
    (record.commands ?? []).some((command) => namedIn(restored, command));
}

const LISTED_PATHS = 12;

function describePath(path: ReadOnlyRestoredPath): string {
  const size = path.before !== undefined && path.after !== undefined
    ? `, ${path.before} → ${path.after} bytes`
    : path.before !== undefined ? `, ${path.before} bytes at the start` : path.after !== undefined ? `, ${path.after} bytes` : '';
  const done = path.change === 'created' ? 'removed' : 'restored';
  const outcome = path.restored
    ? `${done}${path.reason ? ` — ${path.reason}` : ''}`
    : `NOT ${done}${path.reason ? `: ${path.reason}` : ''}`;
  return `${path.path} (${path.change}${size}; ${outcome})`;
}

function describeList(paths: readonly ReadOnlyRestoredPath[]): string {
  const listed = paths.slice(0, LISTED_PATHS).map(describePath);
  const more = paths.length > LISTED_PATHS ? [`and ${paths.length - LISTED_PATHS} more`] : [];
  return [...listed, ...more].join(', ');
}

/** Every path of a restoration, in the words the prefix, the acceptor block and the run log share. */
export function describeRestoredPaths(restoration: ReadOnlyRestoration): string {
  const put = restoration.paths.length === 0 ? 'no file it could compare had changed' : describeList(restoration.paths);
  return restoration.left.length === 0 ? put : `${put}; left as they are: ${describeList(restoration.left)}`;
}

const PARTIAL_NOTE = 'The photograph could not see every file (a cap, or a directory it could not list): nothing there was compared or removed.';

/**
 * The runtime's line at the head of a restored phase's summary. What the
 * phase observed of a restored file was a version that no longer exists, and
 * the line says so, so that neither its validator nor the next phase reads a
 * fix it reports as a fix that stands.
 */
export function renderRestorationPrefix(restoration: ReadOnlyRestoration): string {
  if (restoration.unguarded !== undefined) {
    return `${READ_ONLY_RESTORED_PREFIX}: none — the runtime could not photograph the workspace when this read-only ` +
      `phase started (${restoration.unguarded}), so what it changed was NOT put back]`;
  }
  return `${READ_ONLY_RESTORED_PREFIX} — this phase's plan declared no outputs, so the runtime put back what it ` +
    `changed: ${describeRestoredPaths(restoration)}.` + (restoration.partial ? ` ${PARTIAL_NOTE}` : '') +
    ' What this phase observed while its changes stood is not evidence about the files as they now are, and a fix it reports was undone.]';
}

/**
 * The block the root acceptor reads: every read-only phase of the attempt,
 * the ones that changed nothing included — a defect a read-only phase found
 * is still in the files, because no read-only phase can fix it. '' when no
 * read-only phase ran.
 */
export function renderRestorationsBlock(restorations: readonly ReadOnlyRestoration[]): string {
  if (restorations.length === 0) return '';
  const reported = restorations.filter((restoration) => restorationMatters(restoration) || restoration.left.length > 0);
  const untouched = [...new Set(restorations.map((restoration) => restoration.phase))]
    .filter((phase) => !reported.some((restoration) => restoration.phase === phase));
  return [
    'READ-ONLY PHASES — the plan gave these phases no outputs; the runtime photographed the workspace when each one',
    'started and put back what it changed when it ended (mechanical):',
    ...reported.map((restoration) => restoration.unguarded !== undefined
      ? `- phase ${JSON.stringify(restoration.phase)}: NOT guarded (${restoration.unguarded}); what it changed stands`
      : `- phase ${JSON.stringify(restoration.phase)}: ${describeRestoredPaths(restoration)}` +
        (restoration.partial ? ' (its photograph could not see every file)' : '')),
    ...(untouched.length > 0 ? [`- changed nothing: ${untouched.map((phase) => JSON.stringify(phase)).join(', ')}`] : []),
    'Observations a phase made while its changes stood are not counted as evidence about the delivered files. A',
    'read-only phase cannot fix what it finds: a defect it names is still in the delivered files unless a later',
    'phase with outputs fixed it. A process such a phase started may still hold a restored file and rewrite it.',
  ].join('\n');
}
