/**
 * WHAT A SEEDED RUN DID TO THE FILES IT STARTED FROM — a mechanical fact the
 * root acceptor reads beside the delivery, never a verdict.
 *
 * Production run 902b2c21 (2026-09-27) was asked to add pages "around the
 * existing configurator … unchanged in behaviour". It wrote a home page over
 * the 13394-byte configurator and a 2090-byte stand-in with invented prices,
 * and was approved on every criterion: nothing the acceptor read said what
 * had happened to the bytes it was asked to keep. The host holds both sides —
 * the workspace as seeded, and as delivered — so the comparison is a fact.
 */

/**
 * One file of a workspace, as the host read it. `lineHashes` are the hashes
 * of its distinct non-blank trimmed lines, only for text small enough to
 * compare: hashes, not text, because the starting side lives for the run.
 */
export interface WorkspaceFileSnapshot {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly lineHashes?: readonly string[];
}

/** The starting side: the seed's files, and whether a cap cut the walk short. */
export interface StartingSnapshot {
  readonly files: readonly WorkspaceFileSnapshot[];
  readonly truncated: boolean;
}

/** The delivered side: the seed's own paths read again, and the files that are new. */
export interface DeliveredSnapshot {
  readonly files: readonly WorkspaceFileSnapshot[];
  readonly added: readonly WorkspaceFileSnapshot[];
  readonly addedTruncated: boolean;
}

export interface StartingFileChange {
  readonly path: string;
  /**
   * `moved`: most of its starting lines left this file but live in another
   * delivered file — code moved from index.html to app.js is not code lost.
   */
  readonly status: 'removed' | 'rewritten' | 'moved' | 'changed';
  readonly before: number;
  readonly after?: number;
  /** Share of its starting lines still in this file, when both sides are text. */
  readonly keptHere?: number;
  /** Share of its starting lines anywhere in the delivered text files. */
  readonly keptAnywhere?: number;
}

export interface StartingWorkspaceComparison {
  readonly changes: readonly StartingFileChange[];
  readonly unchanged: number;
  readonly added: readonly string[];
  readonly startTruncated: boolean;
  readonly addedTruncated: boolean;
  readonly startFiles: number;
}

/** Below this share of its starting lines found anywhere, a changed file is reported as rewritten. */
export const REWRITTEN_BELOW = 0.5;
/**
 * A file with fewer distinct lines is only ever `changed`: one edited line of
 * a one-line JSON file would otherwise read as a rewrite (adversarial review
 * 2026-09-27).
 */
export const MIN_LINES_TO_JUDGE_REWRITE = 8;

function share(start: readonly string[], present: ReadonlySet<string>): number {
  if (start.length === 0) return 1;
  let kept = 0;
  for (const line of start) if (present.has(line)) kept += 1;
  return kept / start.length;
}

const STATUS_ORDER = { removed: 0, rewritten: 1, moved: 2, changed: 3 } as const;

export function compareStartingWorkspace(start: StartingSnapshot, now: DeliveredSnapshot): StartingWorkspaceComparison {
  const current = new Map(now.files.map((file) => [file.path, file]));
  const everywhere = new Set<string>();
  for (const file of [...now.files, ...now.added]) for (const line of file.lineHashes ?? []) everywhere.add(line);
  const changes: StartingFileChange[] = [];
  let unchanged = 0;
  for (const file of start.files) {
    const after = current.get(file.path);
    if (!after) {
      changes.push({ path: file.path, status: 'removed', before: file.bytes });
      continue;
    }
    if (after.sha256 === file.sha256) {
      unchanged += 1;
      continue;
    }
    const judged = file.lineHashes && after.lineHashes && file.lineHashes.length >= MIN_LINES_TO_JUDGE_REWRITE;
    const keptHere = judged ? share(file.lineHashes, new Set(after.lineHashes)) : undefined;
    const keptAnywhere = judged ? share(file.lineHashes, everywhere) : undefined;
    const status = keptAnywhere !== undefined && keptAnywhere < REWRITTEN_BELOW ? 'rewritten'
      : keptHere !== undefined && keptHere < REWRITTEN_BELOW ? 'moved' : 'changed';
    changes.push({
      path: file.path, status, before: file.bytes, after: after.bytes,
      ...(keptHere !== undefined ? { keptHere } : {}),
      ...(keptAnywhere !== undefined ? { keptAnywhere } : {}),
    });
  }
  // What matters first: a removal or a rewrite must never hide behind a cap.
  changes.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.path.localeCompare(b.path));
  return { changes, unchanged, added: now.added.map((file) => file.path), startTruncated: start.truncated,
    addedTruncated: now.addedTruncated, startFiles: start.files.length };
}

const MAX_LISTED = 20;
const pct = (value: number): string => `${Math.round(value * 100)}%`;

function describe(change: StartingFileChange): string {
  if (change.status === 'removed') return `- ${change.path}: REMOVED (${change.before} bytes at the start)`;
  const size = `${change.before} → ${change.after} bytes`;
  if (change.status === 'rewritten') {
    return `- ${change.path}: REWRITTEN ${size}; ${pct(change.keptAnywhere!)} of its starting lines remain anywhere in the delivery`;
  }
  if (change.status === 'moved') {
    return `- ${change.path}: moved ${size}; keeps ${pct(change.keptHere!)} of its starting lines here, ${pct(change.keptAnywhere!)} across the delivered files`;
  }
  return `- ${change.path}: changed ${size}${change.keptHere !== undefined ? `, keeps ${pct(change.keptHere)} of its starting lines` : ''}`;
}

/** The block the root acceptor reads; '' when the run did not start from a seeded workspace. */
export function renderStartingWorkspace(comparison: StartingWorkspaceComparison | undefined): string {
  if (!comparison) return '';
  const lines = comparison.changes.slice(0, MAX_LISTED).map(describe);
  const more = comparison.changes.length > MAX_LISTED ? [`- …and ${comparison.changes.length - MAX_LISTED} more, each changed or moved`] : [];
  const added = comparison.added.length > 0
    ? [`New files: ${comparison.added.slice(0, MAX_LISTED).join(', ')}${comparison.added.length > MAX_LISTED || comparison.addedTruncated ? ', …' : ''}.`]
    : [];
  return [
    'STARTING WORKSPACE — this run began from an existing deliverable; the host compared the files it started',
    'with to the files it delivers (mechanical):',
    ...(comparison.startTruncated ? [`The starting snapshot covers ${comparison.startFiles} files only: files past that cap are not compared.`] : []),
    ...(lines.length > 0 ? lines : ['- no compared starting file was removed or changed']),
    ...more,
    `Unchanged starting files: ${comparison.unchanged}.`,
    ...added,
    'A task that asks to keep, extend or leave something unchanged is judged against this: behaviour whose',
    'code the run removed or rewrote is not kept unless the evidence shows it working again. A moved file\'s',
    'code still exists; restructuring the task allows is not a defect.',
  ].join('\n');
}
