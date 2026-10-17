import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WORKSPACE_LIMITS } from '../contracts/workspaceLimits.js';
import {
  READ_RUN_COPY_LISTED_PATHS,
  READ_RUN_FILES_COMPARED,
  READ_RUNS_DIRECTORY,
  readRunCopyMode,
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
 * Every copied file (`<runId>/<path>`) and every directory (`.atoma-runs`
 * itself as `''`, then `<runId>` and `<runId>/<dir>`) as the host left them.
 * Files alone missed a whole copy moved aside, duplicated, edited, compared
 * and moved back: every file kept its identity (review 2026-10-17, second pass).
 */
export interface ReadRunCopyIdentities {
  readonly files: ReadonlyMap<string, CopyIdentity>;
  readonly directories: ReadonlyMap<string, DirectoryIdentity>;
}
const identityKey = (runId: string, path: string): string => `${runId}/${path}`;

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
  join(workspaceRoot, READ_RUNS_DIRECTORY, runId, ...file.path.split('/'));

export interface ReadRunCopyReport {
  readonly runs: number;
  readonly files: number;
  readonly bytes: number;
  /** Each copy's identity right after it was written, its directories' too, for `checkReadRunCopies`. */
  readonly identities: ReadRunCopyIdentities;
}

/**
 * Copy every read run's saved files into `<workspace>/.atoma-runs/<runId>/`,
 * at launch and again after a deepening's seed copy. Each file is read from the
 * other run's workspace through `readManifestArtifact` (O_NOFOLLOW, identity,
 * size, mode and sha256 against its manifest entry) and written as a NEW file
 * with its SAVED mode: 0755 for a 100755 entry, 0644 otherwise. Nothing
 * outside the manifest crosses: no dependencies, no probe manifest, no
 * secret-like name, none of which a manifest ever lists.
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
  const base = join(workspaceRoot, READ_RUNS_DIRECTORY);
  mkdirSync(base, { mode: 0o755 });
  let files = 0;
  let bytes = 0;
  for (const entry of index.readRuns) {
    mkdirSync(join(base, entry.runId), { mode: 0o755 });
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
 * directories: taken right after the copy, and the baseline a continuation
 * takes after its sealed workspace was restored (new files, new inodes),
 * before any tool can touch them. A file that is not there, or not a regular
 * file, gets none; nor does a directory that is not a real one. The walk stops
 * at the workspace entry limit.
 */
export function captureReadRunCopies(workspaceRoot: string, index: ReadRunsIndex): ReadRunCopyIdentities {
  const files = new Map<string, CopyIdentity>();
  const directories = new Map<string, DirectoryIdentity>();
  const base = join(workspaceRoot, READ_RUNS_DIRECTORY);
  const top = directoryIdentityOf(base);
  if (top) directories.set('', top);
  let visited = 0;
  const walk = (directory: string, key: string): void => {
    if (++visited > WORKSPACE_LIMITS.maxEntries) return;
    const identity = directoryIdentityOf(directory);
    if (!identity) return;
    directories.set(key, identity);
    for (const name of identity.names) walk(join(directory, name), `${key}/${name}`);
  };
  for (const entry of index.readRuns) {
    walk(join(base, entry.runId), entry.runId);
    for (const file of entry.manifest.files) {
      const identity = identityOf(copyTarget(workspaceRoot, entry.runId, file));
      if (identity) files.set(identityKey(entry.runId, file.path), identity);
    }
  }
  return { files, directories };
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
 * names added since the copy. Never throws. A copy directory that is gone or
 * was replaced by a link holds none of its files. The walk for added names
 * stops at the workspace entry limit, so a count past it is a lower bound.
 */
export function checkReadRunCopies(workspaceRoot: string, index: ReadRunsIndex, identities?: ReadRunCopyIdentities): ReadRunCopyCheck[] {
  const base = join(workspaceRoot, READ_RUNS_DIRECTORY);
  return index.readRuns.map((entry) => {
    const root = join(base, entry.runId);
    const found = {
      changed: [] as string[], missing: [] as string[], touched: [] as string[], added: [] as string[],
      changedCount: 0, missingCount: 0, touchedCount: 0, addedCount: 0,
    };
    const note = (kind: 'changed' | 'missing' | 'touched' | 'added', path: string): void => {
      found[`${kind}Count`] += 1;
      if (found[kind].length < READ_RUN_COPY_LISTED_PATHS) found[kind].push(path);
    };
    const present = realDirectory(base) && realDirectory(root);
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
    // A directory of this copy, or `.atoma-runs` itself, moved or modified
    // with its names unchanged: a whole copy swapped aside and back.
    let swapped = false;
    for (const [key, recorded] of identities?.directories ?? []) {
      if (key !== '' && key !== entry.runId && !key.startsWith(`${entry.runId}/`)) continue;
      const path = key === '' ? base : join(base, ...key.split('/'));
      if (directoryTouched(recorded, directoryIdentityOf(path))) { swapped = true; break; }
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
