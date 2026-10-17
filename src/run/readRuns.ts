import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WORKSPACE_LIMITS } from '../contracts/workspaceLimits.js';
import {
  READ_RUN_COPIES_DIRECTORY,
  READ_RUN_COPY_LISTED_PATHS,
  READ_RUN_FILES_COMPARED,
  READ_RUNS_DIRECTORY,
  readRunCopyMode,
  readRunCopyPath,
  readRunsIndexSchema,
  savedPathsNamed,
  type ReadRunCopyCheck,
  type ReadRunFileComparison,
  type ReadRunFileComparisons,
  type ReadRunsIndex,
} from '../contracts/readRuns.js';
import type { ArtifactFile } from '../contracts/artifactInventory.js';
import {
  ArtifactPolicyError,
  artifactManifestHash,
  DEFAULT_ARTIFACT_LIMITS,
  readManifestArtifact,
  secureReadWorkspaceFile,
} from '../projects/artifacts.js';

/**
 * THE RUN PROCESS'S HALF of read runs (docs/decisions/read-runs-2026-10-17.md):
 * the launch index the coordinator wrote, the copy into the workspace, the
 * check root acceptance reads, and the host's comparison of the files the
 * criteria name. The shapes and every text a model reads live in
 * src/contracts/readRuns.ts.
 */

/**
 * The launch index, read once: a regular file, the strict schema, and every
 * manifest hashed again against the hash its row recorded. Anything else
 * THROWS, and the runner refuses the launch before any model call.
 */
export function readReadRunsIndex(path: string): ReadRunsIndex {
  let raw: string;
  try {
    if (!lstatSync(path).isFile()) throw new Error('not a regular file');
    raw = readFileSync(path, 'utf8');
  } catch { throw new Error('the read-run index is unreadable'); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('the read-run index is not valid JSON'); }
  const result = readRunsIndexSchema.safeParse(parsed);
  if (!result.success) throw new Error('the read-run index has an invalid shape');
  for (const entry of result.data.readRuns) {
    if (artifactManifestHash(entry.manifest) !== entry.manifestHash) {
      throw new Error(`read run ${entry.runId}: its manifest does not match its recorded hash`);
    }
  }
  return result.data;
}

/**
 * A copied file as the host left it: what any later write, chmod, rename or
 * link moves. The ctime is the part userspace cannot set back, so a copy
 * changed and then restored to its bytes is still told apart.
 */
interface CopyIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly ctimeNs: bigint;
  readonly mode: bigint;
}
/** A copy's directory as the host left it, with the names it held. */
interface DirectoryIdentity extends CopyIdentity {
  readonly names: readonly string[];
}
/**
 * Every copied file (`<runId>/<path>`) and every directory, by its workspace
 * path, as the host left them: `.atoma-runs` and `.atoma-runs/node_modules`,
 * which every copy sits below, then each copy and the directories inside it.
 * Files alone missed a whole copy moved aside, duplicated, edited, compared
 * and moved back: every file kept its identity (review 2026-10-17, second
 * pass). The shared directories count for every copy: moving
 * `.atoma-runs/node_modules` aside and back moves them all.
 */
export interface ReadRunCopyIdentities {
  readonly files: ReadonlyMap<string, CopyIdentity>;
  readonly directories: ReadonlyMap<string, DirectoryIdentity>;
}
const identityKey = (runId: string, path: string): string => `${runId}/${path}`;
/** The directories above every copy, outermost first. */
const COPY_ANCESTORS = [READ_RUNS_DIRECTORY, READ_RUN_COPIES_DIRECTORY] as const;
const inWorkspace = (workspaceRoot: string, path: string): string => join(workspaceRoot, ...path.split('/'));
/** A directory on the way to `copy` or inside it: its identity counts for that copy. */
const onCopyPath = (directory: string, copy: string): boolean =>
  directory === copy || copy.startsWith(`${directory}/`) || directory.startsWith(`${copy}/`);

function statIdentity(path: string, kind: 'file' | 'directory'): CopyIdentity | undefined {
  try {
    const stat = lstatSync(path, { bigint: true });
    return (kind === 'file' ? stat.isFile() : stat.isDirectory())
      ? { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs, mode: stat.mode } : undefined;
  } catch {
    return undefined;
  }
}
const identityOf = (path: string): CopyIdentity | undefined => statIdentity(path, 'file');

function directoryIdentityOf(path: string): DirectoryIdentity | undefined {
  const identity = statIdentity(path, 'directory');
  if (!identity) return undefined;
  try { return { ...identity, names: readdirSync(path).sort() }; } catch { return undefined; }
}

const sameIdentity = (a: CopyIdentity, b: CopyIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.mode === b.mode;

/**
 * A directory moved or modified since the host left it: another inode, or the
 * same one whose ctime moved while it holds the same names. A ctime moved by
 * names added or removed is explained by them, and they are reported as such
 * (installing an old version inside a copy adds `node_modules`).
 */
function directoryTouched(recorded: DirectoryIdentity, now: DirectoryIdentity | undefined): boolean {
  if (!now) return false;
  if (now.dev !== recorded.dev || now.ino !== recorded.ino) return true;
  if (now.ctimeNs === recorded.ctimeNs && now.mode === recorded.mode) return false;
  return now.names.length === recorded.names.length && now.names.every((name, i) => name === recorded.names[i]);
}

const copyTarget = (workspaceRoot: string, runId: string, file: Pick<ArtifactFile, 'path'>): string =>
  join(inWorkspace(workspaceRoot, readRunCopyPath(runId)), ...file.path.split('/'));

export interface ReadRunCopyReport {
  readonly runs: number;
  readonly files: number;
  readonly bytes: number;
  /**
   * Each copy's identity right after it was written. The runner takes them
   * again once the worker mounting them started (`captureReadRunCopies`).
   */
  readonly identities: ReadRunCopyIdentities;
}

/**
 * Copy every read run's saved files into
 * `<workspace>/.atoma-runs/node_modules/<runId>/`, at launch and again after a
 * deepening's seed copy. Each file is read from the other run's workspace
 * through `readManifestArtifact` (O_NOFOLLOW, identity, size, mode and sha256
 * against its manifest entry) and written as a NEW file with its SAVED mode:
 * 0755 for a 100755 entry, 0644 otherwise. Nothing outside the manifest
 * crosses: no dependencies, no probe manifest, no secret-like name, none of
 * which a manifest ever lists.
 *
 * Not read-only, on purpose (review 2026-10-17): `cp` gives a new file its
 * source's bits, so 0444 copies made every file restored from them read-only
 * (`edit_file` then failed EACCES, and the next run's seed copy kept 0444) and
 * dropped the executable bit a saved script had. Directories are 0755, and a
 * read-only mode never stopped the workspace's owner's shell anyway. The
 * model's write tools refuse a copy (src/tools/readRunCopies.ts); a change a
 * shell makes is DETECTED: `checkReadRunCopies` compares bytes and mode, and
 * tells a copy changed and put back, or a directory swapped, by its identity.
 *
 * THROWS on the first file that no longer matches, and on a workspace that
 * already holds the directory: a run starts from copies it can trust or not
 * at all.
 */
export function materialiseReadRuns(workspaceRoot: string, index: ReadRunsIndex): ReadRunCopyReport {
  mkdirSync(workspaceRoot, { recursive: true });
  // One level at a time, never recursive: `.atoma-runs` already there throws.
  for (const directory of COPY_ANCESTORS) mkdirSync(inWorkspace(workspaceRoot, directory), { mode: 0o755 });
  let files = 0;
  let bytes = 0;
  for (const entry of index.readRuns) {
    mkdirSync(inWorkspace(workspaceRoot, readRunCopyPath(entry.runId)), { mode: 0o755 });
    for (const file of entry.manifest.files) {
      let content: Buffer;
      // Read BEFORE the target is named: the read refuses a path that is not
      // canonical, publishable and inside the other workspace.
      try { content = readManifestArtifact({ workspaceRoot: entry.workspacePath, expected: file }); }
      catch (error) {
        throw new Error(`read run ${entry.runId}: ${error instanceof ArtifactPolicyError ? error.message : 'a saved file could not be read'}`);
      }
      const target = copyTarget(workspaceRoot, entry.runId, file);
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      const mode = readRunCopyMode(file);
      writeFileSync(target, content, { flag: 'wx', mode });
      // The mode a umask cannot narrow: every reader of the workspace may read it.
      chmodSync(target, mode);
      files += 1;
      bytes += content.length;
    }
  }
  return { runs: index.readRuns.length, files, bytes, identities: captureReadRunCopies(workspaceRoot, index) };
}

/**
 * The copies' identities as the workspace holds them now, files and
 * directories: taken once the worker that mounts them has started, before any
 * tool call, at launch, at the deepening restart and in a continuation (whose
 * restore made new files). Not at copy time: Docker Desktop changes the mount
 * source's ctime when a container starts (measured; Linux does not), which
 * read as a directory moved. A file that is not there, or not a regular
 * file, gets none; nor does a directory that is not a real one. The walk stops
 * at the workspace entry limit.
 */
export function captureReadRunCopies(workspaceRoot: string, index: ReadRunsIndex): ReadRunCopyIdentities {
  const files = new Map<string, CopyIdentity>();
  const directories = new Map<string, DirectoryIdentity>();
  for (const ancestor of COPY_ANCESTORS) {
    const identity = directoryIdentityOf(inWorkspace(workspaceRoot, ancestor));
    if (identity) directories.set(ancestor, identity);
  }
  let visited = 0;
  const walk = (key: string): void => {
    if (++visited > WORKSPACE_LIMITS.maxEntries) return;
    const identity = directoryIdentityOf(inWorkspace(workspaceRoot, key));
    if (!identity) return;
    directories.set(key, identity);
    for (const name of identity.names) walk(`${key}/${name}`);
  };
  for (const entry of index.readRuns) {
    walk(readRunCopyPath(entry.runId));
    for (const file of entry.manifest.files) {
      const identity = identityOf(copyTarget(workspaceRoot, entry.runId, file));
      if (identity) files.set(identityKey(entry.runId, file.path), identity);
    }
  }
  return { files, directories };
}

/**
 * The first read run whose copy sits where runs before 2026-10-17 put it,
 * `.atoma-runs/<runId>`, with nothing at today's path: what a continuation
 * restores from a workspace an older version sealed, since a checkpoint seals
 * every entry, copies included, and a continuation restores them as they
 * were. Nothing reads them there, so the runner refuses that continuation
 * before any model call. None is moved: no production run had read another
 * when the copies moved (0 of 384 project runs).
 */
export function legacyReadRunCopy(workspaceRoot: string, index: ReadRunsIndex): string | undefined {
  const exists = (path: string): boolean => {
    try { lstatSync(path); return true; } catch { return false; }
  };
  return index.readRuns.find((entry) => exists(inWorkspace(workspaceRoot, `${READ_RUNS_DIRECTORY}/${entry.runId}`)) &&
    !exists(inWorkspace(workspaceRoot, readRunCopyPath(entry.runId))))?.runId;
}

/**
 * The mount point of the read-only `.atoma-runs` mount, before each backend
 * start: absent (a continuation whose sealed workspace lost it) it is created
 * empty, so the check reports every file missing and no worker can fill it;
 * anything but a real directory THROWS, before any worker starts. The
 * launcher's guard checks again right before the engine.
 */
export function ensureReadRunMountPoint(workspaceRoot: string): void {
  const directory = inWorkspace(workspaceRoot, READ_RUNS_DIRECTORY);
  try { mkdirSync(directory, { mode: 0o755 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!realDirectory(directory)) throw new Error(`${READ_RUNS_DIRECTORY} is not a real directory; the read-run copies cannot be mounted`);
}

function realDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Each copy checked against its manifest, as root acceptance reads it: the
 * saved files whose bytes or mode differ (or that are no longer regular
 * files), the missing ones, the ones that match again but whose identity or
 * ctime moved since `identities` was taken (changed and put back), and the
 * names added since the copy. Never throws. A copy is read only through real
 * directories: one that is gone, or a link at any level from `.atoma-runs`
 * down to the copy, holds none of its files. The walk for added names stops
 * at the workspace entry limit, so a count past it is a lower bound.
 */
export function checkReadRunCopies(workspaceRoot: string, index: ReadRunsIndex, identities?: ReadRunCopyIdentities): ReadRunCopyCheck[] {
  return index.readRuns.map((entry) => {
    const copy = readRunCopyPath(entry.runId);
    const root = inWorkspace(workspaceRoot, copy);
    const found = {
      changed: [] as string[], missing: [] as string[], touched: [] as string[], added: [] as string[],
      changedCount: 0, missingCount: 0, touchedCount: 0, addedCount: 0,
    };
    const note = (kind: 'changed' | 'missing' | 'touched' | 'added', path: string): void => {
      found[`${kind}Count`] += 1;
      if (found[kind].length < READ_RUN_COPY_LISTED_PATHS) found[kind].push(path);
    };
    const present = [...COPY_ANCESTORS, copy].every((directory) => realDirectory(inWorkspace(workspaceRoot, directory)));
    for (const file of entry.manifest.files) {
      if (!present) { note('missing', file.path); continue; }
      try {
        const read = secureReadWorkspaceFile(root, file.path, DEFAULT_ARTIFACT_LIMITS);
        if (read.file.size !== file.size || read.file.sha256 !== file.sha256 || read.file.mode !== file.mode) {
          note('changed', file.path);
          continue;
        }
        const recorded = identities?.files.get(identityKey(entry.runId, file.path));
        const now = identityOf(copyTarget(workspaceRoot, entry.runId, file));
        if (recorded && (!now || !sameIdentity(recorded, now))) note('touched', file.path);
      } catch (error) {
        note(error instanceof ArtifactPolicyError && error.code === 'missing' ? 'missing' : 'changed', file.path);
      }
    }
    if (present) {
      const expected = new Set(entry.manifest.files.map((file) => file.path));
      let visited = 0;
      const walk = (directory: string, prefix: string): void => {
        let names: string[];
        try { names = readdirSync(directory).sort(); } catch { return; }
        for (const name of names) {
          if (++visited > WORKSPACE_LIMITS.maxEntries) return;
          const relative = prefix ? `${prefix}/${name}` : name;
          let stat;
          try { stat = lstatSync(join(directory, name)); } catch { continue; }
          if (stat.isDirectory()) walk(join(directory, name), relative);
          else if (!expected.has(relative)) note('added', relative);
        }
      };
      walk(root, '');
    }
    // A directory of this copy, or one above it, moved or modified with its
    // names unchanged: a whole copy, or all of them, swapped aside and back.
    let swapped = false;
    for (const [key, recorded] of identities?.directories ?? []) {
      if (!onCopyPath(key, copy)) continue;
      if (directoryTouched(recorded, directoryIdentityOf(inWorkspace(workspaceRoot, key)))) { swapped = true; break; }
    }
    return { runId: entry.runId, files: entry.manifest.files.length, ...found, directoryTouched: swapped };
  });
}

/**
 * THE HOST'S COMPARISON at root acceptance: each saved path of a read run that
 * the criteria name (`savedPathsNamed`: the manifest's own paths, found in the
 * criteria text), this run's file read on the host (the artifact jail,
 * O_NOFOLLOW, sha256 and mode) against the saved manifest entry. Never
 * through the model-facing `read_file`, which marks a file read and so
 * disarms `write_file`'s blind-overwrite refusal. Past
 * `READ_RUN_FILES_COMPARED` named paths are counted, not read. Never throws.
 */
export function compareReadRunFiles(workspaceRoot: string, index: ReadRunsIndex, criteria: readonly string[]): ReadRunFileComparisons {
  const saved = index.readRuns.map((entry) => ({ runId: entry.runId, files: new Map(entry.manifest.files.map((file) => [file.path, file])) }));
  const wanted = savedPathsNamed(criteria, new Set(saved.flatMap((run) => [...run.files.keys()])));
  const compared = wanted.slice(0, READ_RUN_FILES_COMPARED).map((path): ReadRunFileComparison => {
    const holders = saved.flatMap((run) => {
      const file = run.files.get(path);
      return file ? [{ runId: run.runId, file }] : [];
    });
    let here: ArtifactFile;
    try {
      here = secureReadWorkspaceFile(workspaceRoot, path, DEFAULT_ARTIFACT_LIMITS).file;
    } catch (error) {
      const absent = error instanceof ArtifactPolicyError && error.code === 'missing';
      return { path, here: absent ? 'absent' : 'unreadable', against: holders.map(({ runId }) => ({ runId })) };
    }
    return { path, here: 'file', against: holders.map(({ runId, file }) => ({
      runId,
      bytes: here.size === file.size && here.sha256 === file.sha256 ? 'equal' as const : 'differ' as const,
      mode: { here: here.mode, saved: file.mode },
    })) };
  });
  return { compared, omitted: Math.max(0, wanted.length - READ_RUN_FILES_COMPARED) };
}

/**
 * Remove a directory of read-run copies, whatever the run did to its modes,
 * and SAY why when it cannot: never a throw (third check 2026-10-17). A shell
 * that ran `chmod -R a-w .atoma-runs` left directories nobody could empty, and
 * removing them failed the deepening that 44fd3757 had carried out. So every
 * real directory below gets u+rwx back first, walked with `lstat` and never
 * through a link (a chmod follows links; a link is removed, never what it
 * points at), then the tree goes. Asynchronous: up to `MAX_READ_RUN_FILES`
 * unlinks never hold the server's event loop. Resolves null once removed (or
 * already absent), else the reason.
 */
export async function removeReadRunCopies(directory: string): Promise<string | null> {
  const writable = async (path: string): Promise<void> => {
    let stat;
    try { stat = await lstat(path); } catch { return; }
    if (!stat.isDirectory()) return;
    await chmod(path, (stat.mode & 0o7777) | 0o700);
    for (const name of await readdir(path)) await writable(join(path, name));
  };
  try {
    await writable(directory);
    await rm(directory, { recursive: true, force: true });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
