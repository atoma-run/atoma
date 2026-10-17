import { z } from 'zod';
import { artifactManifestSchema, sha256Schema, type ArtifactFile } from './artifactInventory.js';

/**
 * READ RUNS: other runs of the same project whose saved files a new run may
 * read (docs/decisions/read-runs-2026-10-17.md). The client names them; the
 * host copies each one's saved manifest, hash-checked, into the new workspace
 * at `.atoma-runs/node_modules/<runId>/<path>`, each file with its saved mode,
 * before any model call. Attica run 2e6bdcfc was asked to restore four files
 * to the bytes of run 50019ee0 while seeded from 8402ca88, and nothing it
 * could reach held them.
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
/**
 * The directory below it that holds the copies, one per read run. A path with
 * a dot-directory AND a `node_modules` component is skipped by every tool that
 * skips either one (2026-10-17). Copies at `.atoma-runs/<runId>` were walked by
 * ESLint's flat config, Vitest's default include, Jest and `prettier --check .`,
 * which skip `node_modules` but not dot-directories: one old lint defect failed
 * a project's whole-tree check, and a clean copy made Vitest count another
 * run's tests as this run's. npm manages only the root `node_modules`.
 */
export const READ_RUN_COPIES_PARENT = 'node_modules';
/** The workspace path of the directory holding the copies: `.atoma-runs/node_modules`. */
export const READ_RUN_COPIES_DIRECTORY = `${READ_RUNS_DIRECTORY}/${READ_RUN_COPIES_PARENT}`;
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

/** Where one read run's copy lives, relative to the workspace: `.atoma-runs/node_modules/<runId>`. */
export function readRunCopyPath(runId: string): string {
  return `${READ_RUN_COPIES_DIRECTORY}/${runId}`;
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
 * `readRuns`, and only then. About 169 tokens (675 characters at four a
 * token), in every prompt of such a run. What it answers, each from the
 * reviews of 2026-10-17: deleting or editing a copy makes it worthless and no
 * pass gets it back (write_file and edit_file also refuse them); a
 * parent-owned suite never sees the copies, so a suite comparing with them
 * fails every round; and a whole-tree lint or test run skips them under
 * `node_modules`, while a tool configured to reach them anyway runs on a copy
 * of the workspace, because excluding them in the project's configuration
 * conflicts with the TypeScript rule against hiding source. Of later runs it
 * says only what is true of all of them: a continuation and a comparison
 * rerun read the same runs again, but no run is seeded with these copies.
 */
export const READ_RUNS_GUIDANCE = "readRuns are copies of other runs' saved files, chosen by the client; the host never delivers them or seeds them into the next run. Leave them in place and unchanged; read, compare or copy from them as the task asks. Parent-owned suites cannot read them: prove a restore or comparison with sha256sum or diff in a shell step (the host also compares the files the criteria name at acceptance). A check run inside them proves nothing about this run's files. They sit under a node_modules directory, which linters and test runners skip; if one still reaches them, run it on a copy of the workspace without .atoma-runs, unless the task allows changing the project's configuration.";

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
  /**
   * A directory of the copy, or one above it (`.atoma-runs`, its
   * `node_modules`), was replaced or moved after the copy, its names
   * unchanged: a whole copy swapped aside, edited, compared and swapped back
   * keeps every file's identity (review 2026-10-17, second pass). A change
   * explained by names added or removed is not this.
   */
  readonly directoryTouched: boolean;
}

/** No saved file changed, went missing or was changed and put back, and no directory was swapped. Added names do not count. */
export function readRunCopyIntact(check: ReadRunCopyCheck): boolean {
  return check.changedCount === 0 && check.missingCount === 0 && check.touchedCount === 0 && !check.directoryTouched;
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
    const directory = 'a directory of it was moved or modified';
    if (check.changedCount === 0 && check.missingCount === 0) {
      if (check.touchedCount === 0 && !check.directoryTouched) {
        return `${head} still holds the ${check.files} saved files of run ${run} byte for byte, with their saved modes.${added}`;
      }
      const touched = [...(check.directoryTouched ? [directory] : []),
        ...(check.touchedCount ? [`${listedPaths(check.touched, check.touchedCount)} ${check.touchedCount === 1 ? 'was' : 'were'} changed`] : [])];
      return `${head} holds the ${check.files} saved files of run ${run} byte for byte now, but ${touched.join(', and ')} ` +
        `after the copy: a comparison made meanwhile may be wrong.${added}`;
    }
    const differences = [
      ...(check.changedCount ? [`changed (bytes or mode): ${listedPaths(check.changed, check.changedCount)}`] : []),
      ...(check.missingCount ? [`missing: ${listedPaths(check.missing, check.missingCount)}`] : []),
      ...(check.touchedCount ? [`changed after the copy, equal again: ${listedPaths(check.touched, check.touchedCount)}`] : []),
      ...(check.directoryTouched ? [`${directory} after the copy`] : []),
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

/** What may continue a path: a match followed by one of these names a longer path. */
const CONTINUES_PATH = /^(?:[\w/-]|\.[\w-])/;
/** What may precede a path: a match preceded by one of these is part of a longer path. */
const EXTENDS_PATH = /[\w.\-/]/;

/**
 * The saved paths a criterion text names, in the order the text first names
 * them: each read run's manifest path itself, spelled out, found at a path
 * boundary, a leading `./` or `/` accepted, a sentence's closing period too
 * ("browser/x.js."), never inside a longer path (`src/browser/x.js`,
 * `browser/x.js.bak`). The read-back's own extension list missed `.tsx`,
 * `bin/cli`, `Makefile`, images and `./x.js`, so a restore criterion got no
 * host line (second review 2026-10-17). A stem never counts: "todo",
 * "notes" or "design" in a sentence named TODO.md, NOTES.md and DESIGN.md
 * and took the comparison's slots (third check); the criteria read-back
 * keeps its own stem rule.
 */
export function savedPathsNamed(texts: readonly string[], saved: Iterable<string>): string[] {
  const text = texts.join('\n');
  const hits = new Map<string, number>();
  for (const path of saved) {
    for (let from = 0; ;) {
      const at = text.indexOf(path, from);
      if (at < 0) break;
      from = at + 1;
      if (CONTINUES_PATH.test(text.slice(at + path.length, at + path.length + 2))) continue;
      const start = at >= 2 && text.startsWith('./', at - 2) ? at - 2 : text[at - 1] === '/' ? at - 1 : at;
      if (start > 0 && EXTENDS_PATH.test(text[start - 1]!)) continue;
      hits.set(path, at);
      break;
    }
  }
  return [...hits.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([path]) => path);
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
 * One path component between the directory and a run id, quotes and all:
 * `node_modules`, where the copies sit since 2026-10-17, or a glob standing for
 * it (`.atoma-runs/*\/<run id>`). Optional: a probe manifest or recipe recorded
 * while the copies sat at `.atoma-runs/<run id>` still spells them so, and
 * replays no better for it.
 */
const COPIES_COMPONENT = '(?:[^/\\s]+/+)?';

/**
 * A path INTO a copy: the directory as a whole path component, then a run id,
 * at most one component between them (quotes may wrap any of them). The id
 * is required here: a text that only mentions the directory is often a
 * command that excludes the copies (`--ignore-pattern '.atoma-runs/**'`,
 * `vitest --exclude '**\/.atoma-runs/**'`), which replays anywhere, and
 * dropping it lost a seeded run's lint replay (review 2026-10-17). Commands
 * that reach the copies without an id are `reachesReadRunCopies`'s.
 */
const NAMES_READ_RUN_COPY = new RegExp(`(?:^|[^\\w.-])["']?${READ_RUNS_PATTERN}["']?/+${COPIES_COMPONENT}["']?${RUN_ID_PATTERN}(?![0-9a-fA-F-])`);

/**
 * Whether a text names a path inside a read-run copy
 * (`.atoma-runs/node_modules/<run id>`, or `.atoma-runs/<run id>` as it was
 * spelled before 2026-10-17). Such a check replays only where that copy
 * existed, and a later run never holds one, so the seed copy drops it
 * (`inheritProbeManifest`): an inheritance rule, not a malformation, which the
 * health check never reports. A recipe naming one would carry one
 * organisation's run id into the shared catalogue and replay a path one run
 * held, so skills refuse it too.
 */
export function namesReadRunCopy(text: string): boolean {
  return NAMES_READ_RUN_COPY.test(text);
}

/**
 * The directory, then a glob where `node_modules` or a run id would be:
 * `.atoma-runs/*\/x.js`, `".atoma-runs"/**\/x.js`, `.atoma-runs/node_modules/*\/x.js`.
 */
const GLOB_INTO_READ_RUNS = new RegExp(`(?:^|[^\\w.-])["']?${READ_RUNS_PATTERN}["']?/+${COPIES_COMPONENT}["']?[*?[{]`, 'g');
/** A shell entering the directory: `cd .atoma-runs && …`, `pushd ./.atoma-runs`. */
const ENTERS_READ_RUNS = new RegExp(`(?:^|[;&|(\\s"'])(?:cd|pushd)\\s+["']?(?:\\./)?${READ_RUNS_PATTERN}(?=[/"'\\s;&|)]|$)`);
/** An option whose argument is a pattern to leave out: `--exclude`, `--ignore-pattern`, `--exclude-dir`, `--ignore`. */
const EXCLUSION_OPTION = /^--?[\w-]*(?:[Ee]xclude|[Ii]gnore)[\w-]*$/;
/**
 * Short options that exclude only for their own command: `zip -x`, `7z -x`,
 * `fd -E`. Elsewhere `-x` traces a script (`bash -x`) and `-E` takes a regex.
 */
const SHORT_EXCLUSIONS: Readonly<Record<string, readonly string[]>> = {
  '-x': ['zip', 'unzip', '7z', '7za', '7zr'],
  '-E': ['fd', 'fdfind'],
};
/** A word that ends one shell command and starts another. */
const COMMAND_SEPARATOR = /^(?:;|&&|\|\|?|\(|.*;)$/;
/** A pathspec git leaves out: `:!…`, `:^…`, `:(exclude)…`, `:(top,exclude)…`. */
const GIT_EXCLUDED_PATHSPEC = /^:(?:[!^]|\([^)]*\bexclude\b[^)]*\))/;
/** A find path test: its argument is a pattern, excluded when negated or pruned. */
const FIND_PATH_TEST = /^-i?(?:path|wholename)$/;
/** What ends a find expression's tests before an action: a later `-prune` belongs to another branch. */
const FIND_ACTION = /^(?:-print0?|-printf|-exec(?:dir)?|-ok(?:dir)?|-delete|-ls|-fprint\S*|;|&&|\|\|?|\\;)$/;

/**
 * Whether the shell word holding `at` is a pattern a command leaves out
 * rather than a path it reads: a negated glob, bare or as an option's value
 * (`'!.atoma-runs/**'`, `--glob='!.atoma-runs/**'`), the argument of an
 * exclusion option, inline or next (`--exclude=…`, `--ignore-pattern '…'`,
 * `zip -x '…'`, `fd -E '…'`), a git pathspec excluding it (`':!…'`,
 * `':(exclude)…'`), or a find path negated or pruned (`-not -path`,
 * `! -path`, `-path … -prune`, a group of paths then `-prune`). Words split
 * on whitespace; quotes are ignored (third check 2026-10-17).
 */
function exclusionArgument(command: string, at: number): boolean {
  const wordStart = command.slice(0, at).search(/\S*$/);
  const prefix = command.slice(wordStart, at).replace(/["']/g, '');
  const value = prefix.replace(/^-{1,2}[\w-]+=/, '');
  if (value.startsWith('!') || GIT_EXCLUDED_PATHSPEC.test(value) || /^--?[\w-]*(?:[Ee]xclude|[Ii]gnore)[\w-]*=/.test(prefix)) return true;
  const before = command.slice(0, wordStart).trimEnd().split(/\s+/).map((word) => word.replace(/["']/g, ''));
  const previous = before.at(-1) ?? '';
  if (EXCLUSION_OPTION.test(previous)) return true;
  const owners = SHORT_EXCLUSIONS[previous];
  if (owners) {
    let start = before.length;
    while (start > 0 && !COMMAND_SEPARATOR.test(before[start - 1]!)) start -= 1;
    if (before.slice(start).some((word) => owners.includes(word.split('/').pop()!))) return true;
  }
  if (!FIND_PATH_TEST.test(previous)) return false;
  if (before.at(-2) === '-not' || before.at(-2) === '!') return true;
  // Pruned: a `-prune` comes before this branch's action, past a group's `\)`.
  for (const word of command.slice(at).split(/\s+/).slice(1)) {
    if (word === '-prune') return true;
    if (FIND_ACTION.test(word)) return false;
  }
  return false;
}

/**
 * Whether a shell COMMAND reaches into the copies: a path naming a run id
 * (`namesReadRunCopy`), a glob where `node_modules` or the id would be that is
 * not a pattern the command leaves out (`diff -q x.js
 * .atoma-runs/node_modules/*\/x.js`), or a shell entering the directory (`cd
 * .atoma-runs/node_modules && sha256sum *\/x.js`). Such a recorded command
 * fails where the copies are absent, so the seed copy drops it (review
 * 2026-10-17, second pass). A variable holding the directory
 * (`D=.atoma-runs; cat $D/…`) is out of reach: no reader of a command string
 * can follow it.
 */
export function reachesReadRunCopies(command: string): boolean {
  if (namesReadRunCopy(command) || ENTERS_READ_RUNS.test(command)) return true;
  for (const match of command.matchAll(GLOB_INTO_READ_RUNS)) {
    const at = match.index + match[0].indexOf(READ_RUNS_DIRECTORY);
    if (!exclusionArgument(command, at)) return true;
  }
  return false;
}

/** The directory itself, anywhere, as a whole name: `.atoma-runs`, `'.atoma-runs/'`, `**\/.atoma-runs/**`. */
const MENTIONS_READ_RUNS = new RegExp(`(?:^|[^\\w.-])${READ_RUNS_PATTERN}(?![\\w.-])`);

/**
 * Whether a text mentions the copies' directory at all. A parent-owned suite
 * cannot read it: the suite runs on a snapshot that leaves the copies out
 * (src/tools/parentTests.ts), so a suite mentioning it is refused at plan
 * time. Any mention, not only a path with an id: `join('.atoma-runs', id)`
 * spells none.
 */
export function mentionsReadRunCopies(text: string): boolean {
  return MENTIONS_READ_RUNS.test(text);
}

/** A workspace-relative path under the copies' directory (`.atoma-runs/…`, `./.atoma-runs/…`). */
export function insideReadRunCopies(path: string): boolean {
  return path.replace(/^(?:\.\/)+/, '').split('/')[0] === READ_RUNS_DIRECTORY;
}
