import { z } from 'zod';
import { artifactManifestSchema, sha256Schema, type ArtifactFile } from './artifactInventory.js';

/**
 * READ RUNS: other runs of the same project whose saved files a new run may
 * read (docs/decisions/read-runs-2026-10-17.md). The client names them; the
 * host copies each one's saved manifest, hash-checked, into the new workspace
 * at `.atoma-runs/<runId>/<path>`, each file with its saved mode, before any
 * model call. Attica run 2e6bdcfc was asked to restore four files to the
 * bytes of run 50019ee0 while seeded from 8402ca88, and nothing it could
 * reach held them.
 *
 * The one home of the directory, the caps, the hand-off from the coordinator
 * to the run process, the task input the planners read, the lines the root
 * acceptor reads and the predicates that recognise a path into a copy.
 * Browser-safe: the copy, its check and the comparison, which touch the disk,
 * live in `src/run/readRuns.ts`.
 */

/**
 * Where the copies live inside the workspace. An `.atoma-*` name, so the
 * inventory, publication, preview and corpus leave it out with every other
 * internal path (`assertPublishableArtifactPath`).
 */
export const READ_RUNS_DIRECTORY = '.atoma-runs';
export const MAX_READ_RUNS = 3;
/** The read runs' saved bytes together. Over it a request is refused, never trimmed. */
export const MAX_READ_RUN_BYTES = 64 * 1024 * 1024;
/**
 * The read runs' saved FILES together, refused over it like the bytes. The
 * largest saved manifest held 1,502 files (2026-10-16). Bytes alone admitted
 * three runs of 100,000 one-byte files: each hash at admission and at launch
 * held the coordinator's event loop about 5.5 s per run, and 300,000 copies
 * pushed the workspace past the checkpoint's file limit, which silently turns
 * off pause, client questions and resume (review 2026-10-17).
 */
export const MAX_READ_RUN_FILES = 10_000;
/**
 * The run process finds the launch index at the path this variable names. A
 * FILE, not the value itself: 1,502 manifest entries (the largest saved
 * manifest, 2026-10-16) exceed Linux's 128 KiB bound on one environment string.
 */
export const READ_RUNS_ENV = 'ATOMA_READ_RUNS';
/** Beside the run's log and traces, outside its workspace, deleted with the run. */
export const READ_RUNS_INDEX_FILENAME = 'read-runs.json';
/** Paths named per kind of difference in the acceptor's line. */
export const READ_RUN_COPY_LISTED_PATHS = 10;
/**
 * Criteria-named files compared with the read runs' saved entries at one root
 * acceptance: the criteria read-back's own I/O cap (`CRITERIA_FILES_MAX`).
 */
export const READ_RUN_FILES_COMPARED = 16;

/** A project run id, the shape `projectRunIdSchema` spells in `projects.ts`, which imports this module. */
const runIdSchema = z.string().uuid();

/** What a request names: 1 to 3 distinct runs, in any order; the store keeps them sorted. */
export const readRunIdsSchema = z.array(runIdSchema).min(1).max(MAX_READ_RUNS)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'read runs must be distinct' });

/** The stored list, read back by spelling only: a later cap must not make an immutable row unreadable. */
export const storedReadRunIdsSchema = z.array(runIdSchema).min(1);

/**
 * THE LAUNCH INDEX the coordinator writes for the run process (mode 0600, in
 * the run directory, never the workspace). Each read run's manifest is the
 * one its row recorded at delivery; the run process re-hashes it against
 * `manifestHash` and copies exactly its entries, each checked again against
 * its size, mode and sha256. `workspacePath` is read by the run process on
 * the host and never mounted into the worker.
 */
export const readRunEntrySchema = z.object({
  runId: runIdSchema,
  status: z.enum(['delivered', 'partial']),
  endedAt: z.string().datetime(),
  workspacePath: z.string().min(1).max(4_096),
  manifestHash: sha256Schema,
  manifest: artifactManifestSchema,
}).strict();
export type ReadRunEntry = z.infer<typeof readRunEntrySchema>;

export const readRunsIndexSchema = z.object({
  version: z.literal(1),
  orgId: z.string().uuid(),
  projectId: z.string().uuid(),
  /** The run this index was written for: another run's index is refused. */
  runId: runIdSchema,
  readRuns: z.array(readRunEntrySchema).min(1).max(MAX_READ_RUNS),
}).strict().superRefine((index, ctx) => {
  const ids = index.readRuns.map((entry) => entry.runId);
  if (new Set(ids).size !== ids.length || ids.some((id, i) => i > 0 && id <= ids[i - 1]!)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['readRuns'], message: 'read runs must be distinct and sorted' });
  }
  if (index.readRuns.reduce((total, entry) => total + entry.manifest.totalBytes, 0) > MAX_READ_RUN_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['readRuns'], message: `read runs exceed ${MAX_READ_RUN_BYTES} bytes` });
  }
  if (index.readRuns.reduce((total, entry) => total + entry.manifest.files.length, 0) > MAX_READ_RUN_FILES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['readRuns'], message: `read runs exceed ${MAX_READ_RUN_FILES} files` });
  }
});
export type ReadRunsIndex = z.infer<typeof readRunsIndexSchema>;

export function encodeReadRunsIndex(index: ReadRunsIndex): string {
  return JSON.stringify(readRunsIndexSchema.parse(index));
}

/** Where one read run's copy lives, relative to the workspace. */
export function readRunCopyPath(runId: string): string {
  return `${READ_RUNS_DIRECTORY}/${runId}`;
}

/** The mode a copy is written with: its saved mode, so a file restored from it keeps its executable bit. */
export function readRunCopyMode(file: Pick<ArtifactFile, 'mode'>): number {
  return file.mode === '100755' ? 0o755 : 0o644;
}

/**
 * The task input every planner, executor and validator of the run reads:
 * where each copy is and what it holds, never the files themselves. Host-owned,
 * like `previousRunResults` (src/atoms/taskContext.ts).
 */
export const readRunInputSchema = z.object({
  runId: runIdSchema,
  path: z.string(),
  status: z.enum(['delivered', 'partial']),
  endedAt: z.string().datetime(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
}).strict();
export type ReadRunInput = z.infer<typeof readRunInputSchema>;

export function readRunsInput(index: ReadRunsIndex): ReadRunInput[] {
  return index.readRuns.map((entry) => readRunInputSchema.parse({
    runId: entry.runId, path: readRunCopyPath(entry.runId), status: entry.status, endedAt: entry.endedAt,
    files: entry.manifest.files.length, bytes: entry.manifest.totalBytes,
  }));
}

/**
 * The text the run's planners, executors and validators read beside
 * `readRuns`, and only then. About 164 tokens (654 characters at four a
 * token), in every prompt of such a run. What it answers, each from the
 * review of 2026-10-17: deleting or editing a copy makes it worthless and no
 * pass gets it back; a parent-owned suite never sees the copies, so a suite
 * comparing with them fails every round; and a whole-tree lint or test run
 * finds them, where excluding them in the project's configuration conflicts
 * with the TypeScript rule against hiding source.
 */
export const READ_RUNS_GUIDANCE = "readRuns are copies of other runs' saved files, chosen by the client; the host keeps them out of every delivery and later run. Leave them in place and unchanged; read, compare or copy from them as the task asks. Parent-owned suites cannot read them: prove a restore or comparison with sha256sum or diff in a shell step (the host also compares the files the criteria name at acceptance). A check run inside them proves nothing about this run's files. Run a tool that walks the whole tree (eslint ., a test runner's default include) on a copy of the workspace without .atoma-runs rather than change the project's configuration, unless the task allows that.";

/**
 * What the host found when it checked one copy against its manifest, just
 * before root acceptance. Each list holds at most `READ_RUN_COPY_LISTED_PATHS`
 * paths; the counts are complete.
 */
export interface ReadRunCopyCheck {
  readonly runId: string;
  readonly files: number;
  /** Saved files whose bytes or mode differ now, or that are no longer regular files. */
  readonly changed: readonly string[];
  readonly changedCount: number;
  readonly missing: readonly string[];
  readonly missingCount: number;
  /**
   * Saved files whose bytes and mode match again, but whose identity or ctime
   * moved since the host wrote them: changed and put back, so a comparison
   * made in between may have read other bytes. Userspace cannot reset a ctime.
   */
  readonly touched: readonly string[];
  readonly touchedCount: number;
  /** Names the run added inside the copy: a separate fact, never a mismatch of the saved files. */
  readonly added: readonly string[];
  readonly addedCount: number;
}

/** No saved file changed, went missing or was changed and put back. Added names do not count. */
export function readRunCopyIntact(check: ReadRunCopyCheck): boolean {
  return check.changedCount === 0 && check.missingCount === 0 && check.touchedCount === 0;
}

/** A name the run chose, JSON-encoded and bounded: it must not print a line of its own into a host block. */
const encodedPath = (path: string): string => JSON.stringify(path.length > 200 ? `${path.slice(0, 200)}…` : path);
const listedPaths = (paths: readonly string[], count: number): string =>
  paths.map(encodedPath).join(', ') + (count > paths.length ? ` and ${count - paths.length} more` : '');

/**
 * One host-written line per read run, for the root acceptor. "Proves nothing"
 * is said only when a saved file changed or is missing; files the run added
 * inside a copy are a separate sentence (an old version run in place leaves
 * `__pycache__` or `node_modules/.vite` behind, and every saved file is still
 * intact).
 */
export function renderReadRunCopies(checks: readonly ReadRunCopyCheck[]): string {
  return checks.map((check) => {
    const head = `READ RUN COPY (host-checked): ${readRunCopyPath(check.runId)}/`;
    const run = check.runId.slice(0, 8);
    const added = check.addedCount === 0 ? '' : ` It also holds ${check.addedCount === 1 ? 'a name' : `${check.addedCount} names`} ` +
      `the run added, which no saved file of that run is: ${listedPaths(check.added, check.addedCount)}.`;
    if (check.changedCount === 0 && check.missingCount === 0) {
      if (check.touchedCount === 0) {
        return `${head} still holds the ${check.files} saved files of run ${run} byte for byte, with their saved modes.${added}`;
      }
      return `${head} holds the ${check.files} saved files of run ${run} byte for byte now, but ${listedPaths(check.touched, check.touchedCount)} ` +
        `${check.touchedCount === 1 ? 'was' : 'were'} changed after the copy: a comparison made meanwhile may be wrong.${added}`;
    }
    const differences = [
      ...(check.changedCount ? [`changed (bytes or mode): ${listedPaths(check.changed, check.changedCount)}`] : []),
      ...(check.missingCount ? [`missing: ${listedPaths(check.missing, check.missingCount)}`] : []),
      ...(check.touchedCount ? [`changed after the copy, equal again: ${listedPaths(check.touched, check.touchedCount)}`] : []),
    ].join('; ');
    return `${head} NO LONGER matches the saved files of run ${run} (${differences}). ` +
      `A comparison with this copy proves nothing about that run.${added}`;
  }).join('\n');
}

/**
 * THE HOST'S OWN COMPARISON of one file the criteria name with each read run
 * that saved a file at that path: this run's file, read on the host, against
 * the saved manifest entry (sha256 and mode), which no model can write. The
 * incident's refusal ("no evidence compared the four files with run
 * 50019ee0") otherwise rested on a model's sha256sum surviving the root's
 * transport cut.
 */
export interface ReadRunFileComparison {
  readonly path: string;
  /** This run's file at `path`: a regular file the host read, nothing there, or something else. */
  readonly here: 'file' | 'absent' | 'unreadable';
  readonly against: ReadonlyArray<{
    readonly runId: string;
    /** Only when `here` is `file`. */
    readonly bytes?: 'equal' | 'differ';
    readonly mode?: { readonly here: ArtifactFile['mode']; readonly saved: ArtifactFile['mode'] };
  }>;
}

export interface ReadRunFileComparisons {
  readonly compared: readonly ReadRunFileComparison[];
  /** Named paths a read run saved, past `READ_RUN_FILES_COMPARED`: not compared. */
  readonly omitted: number;
}

/** One host line per criteria-named path a read run saved. A fact beside the judgement, never a verdict. */
export function renderReadRunFiles(comparisons: ReadRunFileComparisons): string {
  const lines = comparisons.compared.map((comparison) => {
    const head = `READ RUN FILE (host-checked): ${encodedPath(comparison.path)}`;
    const runs = comparison.against.map((against) => `run ${against.runId.slice(0, 8)}`).join(', ');
    if (comparison.here === 'absent') return `${head} is absent from this run's workspace; ${runs} saved one.`;
    if (comparison.here === 'unreadable') return `${head} is not a regular file the host could read here; ${runs} saved one.`;
    return `${head} here ${comparison.against.map((against) => {
      const run = `run ${against.runId.slice(0, 8)}'s saved file`;
      const modeDiffers = against.mode !== undefined && against.mode.here !== against.mode.saved;
      if (against.bytes === 'equal' && !modeDiffers) return `is identical to ${run} (bytes and mode)`;
      const how = [...(against.bytes === 'differ' ? ['bytes'] : []),
        ...(modeDiffers ? [`mode ${against.mode.here} here, ${against.mode.saved} saved`] : [])];
      return `differs from ${run} (${how.join('; ')})`;
    }).join('; ')}.`;
  });
  if (comparisons.omitted > 0) {
    lines.push(`READ RUN FILE (host-checked): ${comparisons.omitted} more criteria-named ${comparisons.omitted === 1 ? 'path' : 'paths'} ` +
      `a read run saved ${comparisons.omitted === 1 ? 'was' : 'were'} not compared (bound of ${READ_RUN_FILES_COMPARED}).`);
  }
  return lines.join('\n');
}

const READ_RUNS_PATTERN = READ_RUNS_DIRECTORY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RUN_ID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/**
 * A path INTO a copy: the directory as a whole path component, then a run id
 * (quotes may wrap either component). The id is required on purpose: a command
 * that only mentions the directory is usually the exclusion the guidance asks
 * for (`--ignore-pattern '.atoma-runs/**'`, `vitest --exclude '**\/.atoma-runs/**'`),
 * and dropping it lost a seeded run's lint replay (review 2026-10-17).
 */
const NAMES_READ_RUN_COPY = new RegExp(`(?:^|[^\\w.-])["']?${READ_RUNS_PATTERN}["']?/+["']?${RUN_ID_PATTERN}(?![0-9a-fA-F-])`);

/**
 * Whether a text names a path inside a read-run copy (`.atoma-runs/<run id>`).
 * Such a check replays only where that copy existed, and a later run never
 * holds one, so the seed copy drops it (`inheritProbeManifest`): an
 * inheritance rule, not a malformation, which the health check never reports.
 * A recipe naming one would carry one organisation's run id into the shared
 * catalogue and replay a path one run held, so skills refuse it too.
 */
export function namesReadRunCopy(text: string): boolean {
  return NAMES_READ_RUN_COPY.test(text);
}

/** The directory itself, anywhere, as a whole name: `.atoma-runs`, `'.atoma-runs/'`, `**\/.atoma-runs/**`. */
const MENTIONS_READ_RUNS = new RegExp(`(?:^|[^\\w.-])${READ_RUNS_PATTERN}(?![\\w.-])`);

/**
 * Whether a text mentions the copies' directory at all. A parent-owned suite
 * that does can never pass: the suite runs on a snapshot that leaves the
 * copies out (src/tools/parentTests.ts), so it is refused at plan time.
 */
export function mentionsReadRunCopies(text: string): boolean {
  return MENTIONS_READ_RUNS.test(text);
}

/** A workspace-relative path under the copies' directory (`.atoma-runs/…`, `./.atoma-runs/…`). */
export function insideReadRunCopies(path: string): boolean {
  return path.replace(/^(?:\.\/)+/, '').split('/')[0] === READ_RUNS_DIRECTORY;
}
