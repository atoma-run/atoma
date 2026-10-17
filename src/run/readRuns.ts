import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WORKSPACE_LIMITS } from '../contracts/workspaceLimits.js';
import {
  READ_RUN_COPY_LISTED_PATHS,
  READ_RUN_FILES_COMPARED,
  READ_RUNS_DIRECTORY,
  readRunCopyMode,
  readRunsIndexSchema,
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
  normalizeArtifactPath,
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
/** Keyed `<runId>/<path>`. */
export type ReadRunCopyIdentities = ReadonlyMap<string, CopyIdentity>;
const identityKey = (runId: string, path: string): string => `${runId}/${path}`;

function identityOf(path: string): CopyIdentity | undefined {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isFile() ? { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs, mode: stat.mode } : undefined;
  } catch {
    return undefined;
  }
}

const sameIdentity = (a: CopyIdentity, b: CopyIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.mode === b.mode;

const copyTarget = (workspaceRoot: string, runId: string, file: Pick<ArtifactFile, 'path'>): string =>
  join(workspaceRoot, READ_RUNS_DIRECTORY, runId, ...file.path.split('/'));

export interface ReadRunCopyReport {
  readonly runs: number;
  readonly files: number;
  readonly bytes: number;
  /** Each copy's identity right after it was written, for `checkReadRunCopies`. */
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
 * read-only mode never stopped the workspace's owner anyway. So a change to a
 * copy is DETECTED, not prevented: `checkReadRunCopies` compares bytes and
 * mode, and tells a copy changed and put back by its identity.
 *
 * THROWS on the first file that no longer matches, and on a workspace that
 * already holds the directory: a run starts from copies it can trust or not
 * at all.
 */
export function materialiseReadRuns(workspaceRoot: string, index: ReadRunsIndex): ReadRunCopyReport {
  mkdirSync(workspaceRoot, { recursive: true });
  const base = join(workspaceRoot, READ_RUNS_DIRECTORY);
  mkdirSync(base, { mode: 0o755 });
  const identities = new Map<string, CopyIdentity>();
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
      const identity = identityOf(target);
      if (identity) identities.set(identityKey(entry.runId, file.path), identity);
      files += 1;
      bytes += content.length;
    }
  }
  return { runs: index.readRuns.length, files, bytes, identities };
}

/**
 * The copies' identities as the workspace holds them now: the baseline a
 * continuation takes after its sealed workspace was restored (new files, new
 * inodes), before any tool can touch them. A file that is not there, or not a
 * regular file, gets none.
 */
export function captureReadRunCopies(workspaceRoot: string, index: ReadRunsIndex): ReadRunCopyIdentities {
  const identities = new Map<string, CopyIdentity>();
  for (const entry of index.readRuns) {
    for (const file of entry.manifest.files) {
      const identity = identityOf(copyTarget(workspaceRoot, entry.runId, file));
      if (identity) identities.set(identityKey(entry.runId, file.path), identity);
    }
  }
  return identities;
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
        const recorded = identities?.get(identityKey(entry.runId, file.path));
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
    return { runId: entry.runId, files: entry.manifest.files.length, ...found };
  });
}

/**
 * THE HOST'S COMPARISON at root acceptance: each workspace path the criteria
 * name that a read run saved, this run's file read on the host (the artifact
 * jail, O_NOFOLLOW, sha256 and mode) against the saved manifest entry. Never
 * through the model-facing `read_file`, which marks a file read and so
 * disarms `write_file`'s blind-overwrite refusal. A path no read run saved,
 * or that is not a canonical workspace path, is not compared; past
 * `READ_RUN_FILES_COMPARED` such paths are counted, not read. Never throws.
 */
export function compareReadRunFiles(workspaceRoot: string, index: ReadRunsIndex, paths: readonly string[]): ReadRunFileComparisons {
  const saved = index.readRuns.map((entry) => ({ runId: entry.runId, files: new Map(entry.manifest.files.map((file) => [file.path, file])) }));
  const wanted: string[] = [];
  for (const raw of paths) {
    let path: string;
    try { path = normalizeArtifactPath(raw); } catch { continue; }
    if (!wanted.includes(path) && saved.some((run) => run.files.has(path))) wanted.push(path);
  }
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
