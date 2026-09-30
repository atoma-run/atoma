import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  chmodSync,
  type Stats,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { PROBE_MANIFEST_FILENAME } from '../contracts/probeManifest.js';
import {
  describeRestoredPaths,
  executionOwns,
  restorationMatters,
  type ReadOnlyExecutionRecord,
  type ReadOnlyPhases,
  type ReadOnlyRestoration,
  type ReadOnlyRestoredPath,
} from '../contracts/readOnlyPhase.js';
import { skippedBySnapshot } from './workspace.js';

/**
 * THE HOST'S PHOTOGRAPH AND RESTORE OF A READ-ONLY PHASE
 * (`src/contracts/readOnlyPhase.ts`).
 *
 * The workspace is read and written from the HOST side while the run's tools
 * keep running beside it: servers a phase started, shells it left behind, in
 * a container whose only view of the host is this directory. A path is
 * therefore never trusted between two operations. On Linux every operation
 * below the root goes through `/proc/self/fd/<fd>/<name>`: the kernel
 * resolves the descriptor to the directory it was opened on, never to a path
 * that could have been swapped for a symlink since, and each final component
 * is opened `O_NOFOLLOW`. A directory a container replaced by a link to a host
 * path would otherwise receive the restored bytes, or lose its files, on the
 * HOST. Elsewhere (a developer's machine) paths are joined and every ancestor
 * is checked before each change, which narrows the window without closing it.
 * Names are read as bytes: a name that is not UTF-8 is still a file.
 *
 * A file is put back by removing whatever holds its name and creating it
 * anew (`O_CREAT | O_EXCL | O_NOFOLLOW`), never by writing into the inode that
 * holds it now: that inode may be a hard link the phase made to another file.
 * A process that holds the old inode open keeps its own version; for most
 * files that is harmless, but a SQLite database and its `-wal`/`-shm`/
 * `-journal` are never restored or removed — replacing them under a live
 * connection loses committed rows and ships the phase's own writes anyway.
 */

const FD_RELATIVE = process.platform === 'linux' && existsSync('/proc/self/fd');
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
/** Windows keeps no POSIX mode worth restoring. */
const MODES = process.platform !== 'win32';
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');
const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'];
const SQLITE_REASON = 'a SQLite database, which a live process may hold open';
const WRITING_REASON = 'a process was writing it when the phase started';
/**
 * `O_PATH` (Linux x86-64 and arm64): a descriptor that opens nothing, so a
 * directory whose mode forbids reading can still have its mode put back
 * through `/proc/self/fd`. Not in `fs.constants`.
 */
const O_PATH = 0o10000000;
/** A file modified this recently may be mid-write: read it a second time. */
const RECENT_WRITE_MS = 2000;

export interface ReadOnlyPhaseLimits {
  /** Files, directories and links the photograph walks before it stops (partial). */
  readonly maxEntries: number;
  readonly maxDepth: number;
  /** A larger file is compared by hash, but cannot be put back. */
  readonly maxKeptFileBytes: number;
  /** Bytes kept for the whole photograph. */
  readonly maxKeptBytes: number;
  /** A larger file is compared by identity only (size, inode, times). */
  readonly maxHashedFileBytes: number;
  /** Bytes hashed for the whole photograph; past it, files are compared by identity. */
  readonly maxHashedBytes: number;
  /** Entries each restore pass may remove, directories' contents included. */
  readonly maxRemovedEntries: number;
}

export const DEFAULT_READ_ONLY_PHASE_LIMITS: ReadOnlyPhaseLimits = {
  maxEntries: 50_000,
  maxDepth: 32,
  maxKeptFileBytes: 16 * 1024 * 1024,
  maxKeptBytes: 64 * 1024 * 1024,
  maxHashedFileBytes: 64 * 1024 * 1024,
  maxHashedBytes: 256 * 1024 * 1024,
  maxRemovedEntries: 20_000,
};

/** An open directory: its descriptor on Linux, and the host path it was opened at. */
interface Dir {
  readonly fd: number | undefined;
  readonly path: string;
  /** Every directory from below the root down to this one: what path mode re-checks. */
  readonly chain: readonly string[];
}

type SnapshotNode =
  | {
      readonly kind: 'file';
      readonly inode: string;
      readonly size: number;
      readonly mode: number;
      readonly identity: string;
      readonly sha256?: string;
      readonly bytes?: Buffer;
      readonly sqlite?: true;
      /** It changed while it was read: its bytes are not a state to restore. */
      readonly unstable?: true;
      /** It could not be opened: only its identity is known. */
      readonly unreadable?: true;
    }
  | {
      readonly kind: 'dir';
      readonly inode: string;
      readonly mode: number;
      readonly children: ReadonlyMap<string, SnapshotEntry>;
      /** Every entry was listed: only then can one be recognised as the phase's. */
      readonly complete: boolean;
    }
  | { readonly kind: 'link'; readonly inode: string; readonly target: Buffer }
  /** A socket, a fifo, or an entry that could not be read: never compared, never touched. */
  | { readonly kind: 'other'; readonly inode?: string };

interface SnapshotEntry {
  readonly name: Buffer;
  readonly node: SnapshotNode;
}

/** The manifest as the phase found it: put back only when the phase changed something else. */
type ManifestState = { readonly bytes: Buffer; readonly mode: number } | 'absent' | 'unkept';

export interface ReadOnlyPhaseSnapshot {
  readonly root: string;
  /** Null when the workspace root did not exist yet. */
  readonly tree: ReadonlyMap<string, SnapshotEntry> | null;
  /** The root's own listing was whole (each directory below carries its own flag). */
  readonly rootComplete: boolean;
  /** Every directory's listing was whole. */
  readonly complete: boolean;
  /** The root directory's own mode: a phase that makes the root read-only blocks every restore in it. */
  readonly rootMode?: number;
  readonly manifest: ManifestState;
  readonly limits: ReadOnlyPhaseLimits;
}

const MANIFEST_NAME = Buffer.from(PROBE_MANIFEST_FILENAME);

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (errorCode(error) ?? message).slice(0, 120);
}

const keyOf = (name: Buffer): string => name.toString('latin1');
const shown = (name: Buffer): string => name.toString('utf8');
const inodeOf = (stats: Stats): string => `${stats.dev}:${stats.ino}`;
const identityOf = (stats: Stats): string =>
  `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;

function at(dir: Dir, name: Buffer): string | Buffer {
  return dir.fd === undefined ? join(dir.path, shown(name)) : Buffer.concat([Buffer.from(`/proc/self/fd/${dir.fd}/`), name]);
}

function listNames(dir: Dir): Buffer[] {
  return readdirSync(dir.fd === undefined ? dir.path : `/proc/self/fd/${dir.fd}`, { encoding: 'buffer' });
}

/** Path mode only: every directory between the root and `dir` is still a real directory. */
function checkChain(dir: Dir): void {
  if (dir.fd !== undefined) return;
  for (const path of dir.chain) {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${path} stopped being a directory`);
  }
}

function openRoot(root: string): Dir {
  if (!FD_RELATIVE) {
    if (!lstatSync(root).isDirectory()) throw new Error('the workspace root is not a directory');
    return { fd: undefined, path: root, chain: [] };
  }
  return { fd: openSync(root, constants.O_RDONLY | DIRECTORY), path: root, chain: [] };
}

function openChild(dir: Dir, name: Buffer): Dir {
  const path = join(dir.path, shown(name));
  if (dir.fd === undefined) {
    checkChain(dir);
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('not a directory');
    return { fd: undefined, path, chain: [...dir.chain, path] };
  }
  return { fd: openSync(at(dir, name), constants.O_RDONLY | DIRECTORY | NOFOLLOW), path, chain: [] };
}

function closeDir(dir: Dir): void {
  if (dir.fd !== undefined) closeSync(dir.fd);
}

function lstatAt(dir: Dir, name: Buffer): Stats | undefined {
  try {
    return lstatSync(at(dir, name));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

interface FileRead {
  readonly stats: Stats;
  readonly sha256?: string;
  readonly bytes?: Buffer;
  readonly sqlite: boolean;
  readonly unstable?: true;
}

/** One regular file, read through a descriptor that cannot have been redirected. */
function readAt(dir: Dir, name: Buffer, keepUpTo: number, hashUpTo: number): FileRead {
  const fd = openSync(at(dir, name), constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error('not a regular file');
    const head = Buffer.alloc(SQLITE_HEADER.length);
    const headBytes = readSync(fd, head, 0, head.length, 0);
    const sqlite = headBytes === SQLITE_HEADER.length && head.equals(SQLITE_HEADER);
    if (stats.size > hashUpTo) return { stats, sqlite };
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const count = readSync(fd, chunk, 0, chunk.length, total);
      if (count === 0) break;
      total += count;
      if (total > hashUpTo) return { stats, sqlite };
      const bytes = chunk.subarray(0, count);
      hash.update(bytes);
      if (total <= keepUpTo) chunks.push(bytes);
    }
    if (identityOf(fstatSync(fd)) !== identityOf(stats)) return { stats, sqlite, unstable: true };
    return {
      stats,
      sqlite,
      sha256: hash.digest('hex'),
      ...(total <= keepUpTo ? { bytes: Buffer.concat(chunks, total) } : {}),
    };
  } finally {
    closeSync(fd);
  }
}

function createAt(dir: Dir, name: Buffer, bytes: Buffer, mode: number): void {
  checkChain(dir);
  const fd = openSync(
    at(dir, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    MODES ? mode & 0o777 : 0o666
  );
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    // The process umask narrowed the mode `open` created it with.
    if (MODES) fchmodSync(fd, mode & 0o777);
  } finally {
    closeSync(fd);
  }
}

function chmodFileAt(dir: Dir, name: Buffer, mode: number): void {
  const fd = openSync(at(dir, name), constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    fchmodSync(fd, mode & 0o777);
  } finally {
    closeSync(fd);
  }
}

/** A directory's mode, set through its own descriptor on Linux. */
function chmodDir(dir: Dir, mode: number): void {
  if (dir.fd !== undefined) {
    fchmodSync(dir.fd, mode & 0o777);
    return;
  }
  checkChain(dir);
  chmodSync(dir.path, mode & 0o777);
}

function modeOfDir(dir: Dir): number {
  return dir.fd !== undefined ? fstatSync(dir.fd).mode : lstatSync(dir.path).mode;
}

/** Remove what holds `name`, a directory with everything in it; links are removed, never followed. */
function removeAt(dir: Dir, name: Buffer, budget: { entries: number }, depth: number, limits: ReadOnlyPhaseLimits): void {
  const stats = lstatAt(dir, name);
  if (!stats) return;
  budget.entries -= 1;
  if (budget.entries < 0) throw new Error(`more than ${limits.maxRemovedEntries} entries to remove`);
  if (!stats.isDirectory()) {
    checkChain(dir);
    unlinkSync(at(dir, name));
    return;
  }
  if (depth >= limits.maxDepth) throw new Error('nested too deep to remove');
  const child = openChild(dir, name);
  try {
    for (const entry of listNames(child)) removeAt(child, entry, budget, depth + 1, limits);
  } finally {
    closeDir(child);
  }
  checkChain(dir);
  rmdirSync(at(dir, name));
}

/** Is `name` a SQLite sidecar of a database among `databases` (keys of the same directory)? */
function sqliteSidecar(name: Buffer, databases: ReadonlySet<string>): boolean {
  const key = keyOf(name);
  return SQLITE_SIDECARS.some((suffix) => key.endsWith(suffix) && databases.has(key.slice(0, -suffix.length)));
}

interface WalkState {
  entries: number;
  kept: number;
  hashed: number;
  capped: boolean;
  readonly limits: ReadOnlyPhaseLimits;
}

function fileNode(dir: Dir, name: Buffer, state: WalkState): SnapshotNode {
  let read: FileRead;
  try {
    const keepUpTo = Math.min(state.limits.maxKeptFileBytes, state.limits.maxKeptBytes - state.kept);
    const hashUpTo = Math.min(state.limits.maxHashedFileBytes, state.limits.maxHashedBytes - state.hashed);
    read = readAt(dir, name, keepUpTo, hashUpTo);
    // Read TWICE what changed recently: a file timestamp only moves once per
    // kernel tick, so a write landing during the first read can leave every
    // stat field as it was, and bytes torn by a live writer must never become
    // what a restore puts back. A file untouched for two seconds cannot be
    // mid-write, and reading 50,000 of them twice cost seconds (review 2).
    if (read.sha256 !== undefined) {
      if (Date.now() - Math.max(read.stats.mtimeMs, read.stats.ctimeMs) < RECENT_WRITE_MS) {
        const again = readAt(dir, name, 0, hashUpTo);
        if (again.sha256 !== read.sha256 || identityOf(again.stats) !== identityOf(read.stats)) {
          read = { stats: read.stats, sqlite: read.sqlite, unstable: true };
        }
      }
      state.hashed += read.stats.size;
    }
  } catch (error) {
    const stats = lstatAt(dir, name);
    if (!stats) throw error;
    return { kind: 'file', inode: inodeOf(stats), size: stats.size, mode: stats.mode, identity: identityOf(stats), unreadable: true };
  }
  if (read.bytes) state.kept += read.bytes.length;
  return {
    kind: 'file',
    inode: inodeOf(read.stats),
    size: read.stats.size,
    mode: read.stats.mode,
    identity: identityOf(read.stats),
    ...(read.sha256 !== undefined ? { sha256: read.sha256 } : {}),
    ...(read.bytes ? { bytes: read.bytes } : {}),
    ...(read.sqlite ? { sqlite: true as const } : {}),
    ...(read.unstable ? { unstable: true as const } : {}),
  };
}

function walk(dir: Dir, depth: number, state: WalkState): { children: Map<string, SnapshotEntry>; complete: boolean } {
  const children = new Map<string, SnapshotEntry>();
  let names: Buffer[];
  try {
    names = listNames(dir);
  } catch {
    return { children, complete: false };
  }
  names.sort((a, b) => Buffer.compare(a, b));
  for (const name of names) {
    if (skippedBySnapshot(shown(name))) continue;
    if (state.capped || state.entries >= state.limits.maxEntries) {
      state.capped = true;
      return { children, complete: false };
    }
    state.entries += 1;
    let stats: Stats | undefined;
    try {
      stats = lstatAt(dir, name);
    } catch {
      children.set(keyOf(name), { name, node: { kind: 'other' } });
      continue;
    }
    // Gone between the listing and its stat: nothing to photograph.
    if (!stats) continue;
    if (stats.isDirectory()) {
      if (depth >= state.limits.maxDepth) {
        children.set(keyOf(name), { name, node: { kind: 'dir', inode: inodeOf(stats), mode: stats.mode, children: new Map(), complete: false } });
        continue;
      }
      let child: Dir;
      try {
        child = openChild(dir, name);
      } catch {
        children.set(keyOf(name), { name, node: { kind: 'dir', inode: inodeOf(stats), mode: stats.mode, children: new Map(), complete: false } });
        continue;
      }
      try {
        const inner = walk(child, depth + 1, state);
        children.set(keyOf(name), { name, node: { kind: 'dir', inode: inodeOf(stats), mode: stats.mode, ...inner } });
      } finally {
        closeDir(child);
      }
      if (state.capped) return { children, complete: false };
    } else if (stats.isFile()) {
      try {
        children.set(keyOf(name), { name, node: fileNode(dir, name, state) });
      } catch {
        // Vanished while it was read.
      }
    } else if (stats.isSymbolicLink()) {
      try {
        children.set(keyOf(name), { name, node: { kind: 'link', inode: inodeOf(stats), target: readlinkSync(at(dir, name), { encoding: 'buffer' }) } });
      } catch {
        children.set(keyOf(name), { name, node: { kind: 'other', inode: inodeOf(stats) } });
      }
    } else {
      children.set(keyOf(name), { name, node: { kind: 'other', inode: inodeOf(stats) } });
    }
  }
  return { children, complete: true };
}

function everyDirComplete(tree: ReadonlyMap<string, SnapshotEntry>): boolean {
  for (const { node } of tree.values()) {
    if (node.kind === 'dir' && (!node.complete || !everyDirComplete(node.children))) return false;
  }
  return true;
}

function snapshotManifest(root: Dir, limits: ReadOnlyPhaseLimits): ManifestState {
  try {
    const stats = lstatAt(root, MANIFEST_NAME);
    if (!stats) return 'absent';
    if (!stats.isFile()) return 'unkept';
    const read = readAt(root, MANIFEST_NAME, limits.maxKeptFileBytes, limits.maxKeptFileBytes);
    return read.bytes && !read.unstable ? { bytes: read.bytes, mode: read.stats.mode } : 'unkept';
  } catch {
    return 'unkept';
  }
}

/** What a read-only phase starts from, read before it runs. Throws only when the root cannot be opened. */
export function snapshotReadOnlyPhase(
  root: string,
  limits: ReadOnlyPhaseLimits = DEFAULT_READ_ONLY_PHASE_LIMITS
): ReadOnlyPhaseSnapshot {
  let dir: Dir;
  try {
    dir = openRoot(root);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { root, tree: null, rootComplete: true, complete: true, manifest: 'absent', limits };
    throw error;
  }
  const state: WalkState = { entries: 0, kept: 0, hashed: 0, capped: false, limits };
  try {
    const { children, complete } = walk(dir, 0, state);
    return { root, tree: children, rootComplete: complete, complete: complete && everyDirComplete(children),
      rootMode: modeOfDir(dir), manifest: snapshotManifest(dir, limits), limits };
  } finally {
    closeDir(dir);
  }
}

interface RestoreState {
  readonly paths: ReadOnlyRestoredPath[];
  /** What the phase changed that is deliberately left as it is (a live SQLite database). */
  readonly left: ReadOnlyRestoredPath[];
  /** Removals of what replaced a photographed entry, and removals of what the phase added: one budget each. */
  readonly replaced: { entries: number };
  readonly created: { entries: number };
  readonly limits: ReadOnlyPhaseLimits;
}

const pathOf = (rel: string, name: Buffer): string => (rel ? `${rel}/${shown(name)}` : shown(name));

/** The keys of the SQLite databases a directory holds, photographed or present now. */
function databasesOf(dir: Dir, tree: ReadonlyMap<string, SnapshotEntry>, present: readonly Buffer[]): Set<string> {
  const databases = new Set<string>();
  for (const [key, { node }] of tree) if (node.kind === 'file' && node.sqlite) databases.add(key);
  for (const name of present) {
    const key = keyOf(name);
    if (databases.has(key)) continue;
    try {
      const stats = lstatAt(dir, name);
      if (stats?.isFile() && readAt(dir, name, 0, 0).sqlite) databases.add(key);
    } catch {
      // Unreadable: not recognisable as a database.
    }
  }
  return databases;
}

function restoreFile(
  dir: Dir,
  entry: SnapshotEntry,
  node: Extract<SnapshotNode, { kind: 'file' }>,
  path: string,
  depth: number,
  databases: ReadonlySet<string>,
  state: RestoreState
): void {
  const current = lstatAt(dir, entry.name);
  const currentSize = current?.isFile() ? { after: current.size } : {};
  if (current?.isFile()) {
    // Bytes, not stat fields, decide: a same-size rewrite within one kernel
    // tick leaves inode, size and both times as they were. A file without a
    // hash (too large, unreadable, being written) is compared by identity.
    if (node.sha256 === undefined) {
      if (identityOf(current) === node.identity) return;
    } else {
      const now = readAt(dir, entry.name, 0, state.limits.maxHashedFileBytes);
      if (now.sha256 === node.sha256) {
        if (MODES && (now.stats.mode & 0o777) !== (node.mode & 0o777)) {
          checkChain(dir);
          chmodFileAt(dir, entry.name, node.mode);
          state.paths.push({ path, change: 'changed', before: node.size, ...currentSize, restored: true, reason: 'its mode only' });
        }
        return;
      }
    }
  }
  const change = current ? 'changed' : 'removed';
  // A database the photograph saw empty can be live now (review 2): the
  // header as it stands decides too.
  if (node.sqlite || sqliteSidecar(entry.name, databases) || databases.has(keyOf(entry.name))) {
    state.left.push({ path, change, before: node.size, ...currentSize, restored: false, reason: SQLITE_REASON });
    return;
  }
  if (node.unstable) {
    state.left.push({ path, change, before: node.size, ...currentSize, restored: false, reason: WRITING_REASON });
    return;
  }
  const unrestorable = !node.bytes
    ? node.unreadable ? 'it could not be read when the phase started' : 'larger than the photograph keeps'
    : undefined;
  if (unrestorable) {
    state.paths.push({ path, change, before: node.size, ...currentSize, restored: false, reason: unrestorable });
    return;
  }
  if (current) removeAt(dir, entry.name, state.replaced, depth, state.limits);
  createAt(dir, entry.name, node.bytes!, node.mode);
  state.paths.push({ path, change, before: node.size, ...currentSize, restored: true });
}

/**
 * Open a photographed directory to restore it. A phase that set it to a mode
 * that forbids opening it (000) has its mode put back first, through an
 * `O_PATH` descriptor that opens nothing, then it is opened again.
 */
function openRestorable(dir: Dir, name: Buffer, mode: number): Dir {
  try {
    return openChild(dir, name);
  } catch (error) {
    if (errorCode(error) !== 'EACCES' || dir.fd === undefined || !MODES) throw error;
    const fd = openSync(at(dir, name), O_PATH | NOFOLLOW | DIRECTORY);
    try {
      chmodSync(`/proc/self/fd/${fd}`, mode & 0o777);
    } finally {
      closeSync(fd);
    }
    return openChild(dir, name);
  }
}

/** Pass one: every photographed entry as it was, directories first made writable again. */
function restorePhotographed(dir: Dir, tree: ReadonlyMap<string, SnapshotEntry>, rel: string, depth: number, state: RestoreState): void {
  const present = listNames(dir);
  const databases = databasesOf(dir, tree, present);
  for (const entry of tree.values()) {
    const { node } = entry;
    const path = pathOf(rel, entry.name);
    try {
      if (node.kind === 'other') continue;
      if (node.kind === 'file') {
        restoreFile(dir, entry, node, path, depth, databases, state);
        continue;
      }
      const current = lstatAt(dir, entry.name);
      if (node.kind === 'link') {
        if (current?.isSymbolicLink() && readlinkSync(at(dir, entry.name), { encoding: 'buffer' }).equals(node.target)) continue;
        if (current) removeAt(dir, entry.name, state.replaced, depth, state.limits);
        checkChain(dir);
        symlinkSync(node.target, at(dir, entry.name));
        state.paths.push({ path, change: current ? 'changed' : 'removed', restored: true });
        continue;
      }
      const isDirectory = current?.isDirectory() === true && !current.isSymbolicLink();
      if (current && !isDirectory) {
        removeAt(dir, entry.name, state.replaced, depth, state.limits);
        state.paths.push({ path: `${path}/`, change: 'changed', restored: true });
      }
      if (!isDirectory) {
        checkChain(dir);
        mkdirSync(at(dir, entry.name), { mode: MODES ? node.mode & 0o777 : 0o777 });
      }
      const child = openRestorable(dir, entry.name, node.mode);
      try {
        // A phase that made a directory read-only would make every restore
        // inside it fail: its mode comes back first.
        if (MODES && (modeOfDir(child) & 0o777) !== (node.mode & 0o777)) {
          chmodDir(child, node.mode);
          if (isDirectory) state.paths.push({ path: `${path}/`, change: 'changed', restored: true, reason: 'its mode only' });
        }
        restorePhotographed(child, node.children, path, depth + 1, state);
      } finally {
        closeDir(child);
      }
    } catch (error) {
      state.paths.push({ path: node.kind === 'dir' ? `${path}/` : path, change: 'changed', restored: false, reason: reasonOf(error) });
    }
  }
}

/** Pass two: what the phase added, in every directory the photograph saw whole. */
function removeAdded(dir: Dir, tree: ReadonlyMap<string, SnapshotEntry>, complete: boolean, rel: string, depth: number, state: RestoreState): void {
  const present = listNames(dir);
  const databases = databasesOf(dir, tree, present);
  const photographedInodes = new Map<string, string>();
  for (const [key, { node }] of tree) if (node.inode !== undefined) photographedInodes.set(node.inode, key);
  const presentKeys = new Set(present.map(keyOf));
  for (const name of present) {
    if (skippedBySnapshot(shown(name))) continue;
    const key = keyOf(name);
    const path = pathOf(rel, name);
    const entry = tree.get(key);
    if (entry) {
      if (entry.node.kind !== 'dir') continue;
      try {
        const current = lstatAt(dir, name);
        if (!current?.isDirectory()) continue;
        const child = openChild(dir, name);
        try {
          removeAdded(child, entry.node.children, entry.node.complete, path, depth + 1, state);
        } finally {
          closeDir(child);
        }
      } catch (error) {
        state.paths.push({ path: `${path}/`, change: 'changed', restored: false, reason: reasonOf(error) });
      }
      continue;
    }
    // A directory the photograph did not see whole cannot tell what the phase added.
    if (!complete) continue;
    let stats: Stats | undefined;
    try {
      stats = lstatAt(dir, name);
      if (!stats || !(stats.isFile() || stats.isDirectory() || stats.isSymbolicLink())) continue;
      const shownPath = stats.isDirectory() ? `${path}/` : path;
      // The photographed file under another name, with the photographed name
      // gone from the listing: a case-only rename on a case-insensitive
      // volume, where removing the new spelling removes the file itself.
      // When both names are listed it is a hard link, a rename the phase made
      // over a restored file, or an inode the filesystem reused: the phase's,
      // and removed like any other (review 2: ext4 reused a freed inode 20
      // times out of 20).
      const alias = photographedInodes.get(inodeOf(stats));
      if (alias !== undefined && !presentKeys.has(alias)) continue;
      if (stats.isFile() && (databases.has(key) || sqliteSidecar(name, databases))) {
        state.left.push({ path, change: 'created', after: stats.size, restored: false, reason: SQLITE_REASON });
        continue;
      }
      removeAt(dir, name, state.created, depth, state.limits);
      state.paths.push({ path: shownPath, change: 'created', ...(stats.isFile() ? { after: stats.size } : {}), restored: true });
    } catch (error) {
      state.paths.push({ path: stats?.isDirectory() ? `${path}/` : path, change: 'created', restored: false, reason: reasonOf(error) });
    }
  }
}

function restoreManifest(root: Dir, manifest: ManifestState, state: RestoreState): void {
  const reason = 'its records were made while the phase\'s changes stood';
  try {
    const current = lstatAt(root, MANIFEST_NAME);
    if (manifest === 'unkept') {
      if (current) state.paths.push({ path: PROBE_MANIFEST_FILENAME, change: 'changed', restored: false, reason: 'the photograph could not keep it' });
      return;
    }
    if (manifest === 'absent') {
      if (!current) return;
      removeAt(root, MANIFEST_NAME, state.created, 0, state.limits);
      state.paths.push({ path: PROBE_MANIFEST_FILENAME, change: 'created', restored: true, reason });
      return;
    }
    if (current?.isFile()) {
      const now = readAt(root, MANIFEST_NAME, 0, state.limits.maxHashedFileBytes);
      if (now.sha256 === createHash('sha256').update(manifest.bytes).digest('hex')) return;
    }
    if (current) removeAt(root, MANIFEST_NAME, state.replaced, 0, state.limits);
    createAt(root, MANIFEST_NAME, manifest.bytes, manifest.mode);
    state.paths.push({ path: PROBE_MANIFEST_FILENAME, change: current ? 'changed' : 'removed', restored: true, reason });
  } catch (error) {
    state.paths.push({ path: PROBE_MANIFEST_FILENAME, change: 'changed', restored: false, reason: reasonOf(error) });
  }
}

/**
 * Put back what the phase changed and report every path; the root itself
 * failing is reported, not thrown. The probe manifest is put back only when
 * something else was: a phase that changed nothing keeps what it recorded.
 */
export function restoreReadOnlyPhase(snapshot: ReadOnlyPhaseSnapshot, record: ReadOnlyExecutionRecord = {}): {
  paths: ReadOnlyRestoredPath[];
  left: ReadOnlyRestoredPath[];
  partial: boolean;
  written: string[];
} {
  const state: RestoreState = {
    paths: [], left: [], replaced: { entries: snapshot.limits.maxRemovedEntries },
    created: { entries: snapshot.limits.maxRemovedEntries }, limits: snapshot.limits,
  };
  let root: Dir;
  try {
    root = openRootRestorable(snapshot);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      return { paths: [{ path: '.', change: 'changed', restored: false, reason: reasonOf(error) }], left: [], partial: !snapshot.complete, written: [] };
    }
    if (snapshot.tree === null) return { paths: [], left: [], partial: false, written: [] };
    try {
      mkdirSync(snapshot.root, { recursive: true });
      root = openRoot(snapshot.root);
    } catch (again) {
      return { paths: [{ path: '.', change: 'removed', restored: false, reason: reasonOf(again) }], left: [], partial: !snapshot.complete, written: [] };
    }
  }
  const tree = snapshot.tree ?? new Map<string, SnapshotEntry>();
  const owned: ReadOnlyExecutionRecord = {
    ...record,
    writes: (record.writes ?? []).map(normalizeWrite),
    serverEntries: (record.serverEntries ?? []).map(normalizeWrite),
  };
  let written: string[] = [];
  try {
    if (MODES && snapshot.rootMode !== undefined && (modeOfDir(root) & 0o777) !== (snapshot.rootMode & 0o777)) {
      chmodDir(root, snapshot.rootMode);
      state.paths.push({ path: './', change: 'changed', restored: true, reason: 'its mode only' });
    }
    restorePhotographed(root, tree, '', 0, state);
    removeAdded(root, tree, snapshot.rootComplete, '', 0, state);
    written = state.paths.filter((path) => executionOwns(path.path, owned)).map((path) => path.path);
    // The records a phase made while its OWN changes stood describe them:
    // they go back with the rest. A verifier that changed nothing itself keeps them.
    if (written.length > 0) restoreManifest(root, snapshot.manifest, state);
  } catch (error) {
    state.paths.push({ path: '.', change: 'changed', restored: false, reason: reasonOf(error) });
  } finally {
    closeDir(root);
  }
  return { paths: state.paths, left: state.left, partial: !snapshot.complete, written };
}

/**
 * Open the root to restore it. A phase that set the root to a mode that
 * forbids opening it (000, 0300) has the photographed mode put back first,
 * through an `O_PATH` descriptor, or no restore could reach anything in it.
 */
function openRootRestorable(snapshot: ReadOnlyPhaseSnapshot): Dir {
  try {
    return openRoot(snapshot.root);
  } catch (error) {
    if (errorCode(error) !== 'EACCES' || !FD_RELATIVE || !MODES || snapshot.rootMode === undefined) throw error;
    const fd = openSync(snapshot.root, O_PATH | DIRECTORY);
    try {
      chmodSync(`/proc/self/fd/${fd}`, snapshot.rootMode & 0o777);
    } finally {
      closeSync(fd);
    }
    return openRoot(snapshot.root);
  }
}

/** A path a tool call named, as the tools were asked for it, in the restore's spelling. */
function normalizeWrite(path: string): string {
  return posix.normalize(path.replace(/\\/g, '/')).replace(/^\.\//, '');
}

/**
 * The capability a run's context carries (`RunContext.readOnlyPhases`),
 * bound to the host path the tools write to. `log` hears every restoration
 * that matters, so the run log says what was put back.
 */
export function readOnlyPhasesFor(
  root: string,
  log: (line: string) => void,
  limits: ReadOnlyPhaseLimits = DEFAULT_READ_ONLY_PHASE_LIMITS
): ReadOnlyPhases {
  const restorations: ReadOnlyRestoration[] = [];
  return {
    begin(phase, attempt) {
      const label = phase.replace(/\s+/g, ' ').trim().slice(0, 160);
      let snapshot: ReadOnlyPhaseSnapshot | undefined;
      let unguarded: string | undefined;
      try {
        snapshot = snapshotReadOnlyPhase(root, limits);
      } catch (error) {
        unguarded = reasonOf(error);
      }
      let ended: ReadOnlyRestoration | undefined;
      return {
        end(record = {}) {
          if (ended) return ended;
          const restored = snapshot ? restoreReadOnlyPhase(snapshot, record) : undefined;
          const outcome: Omit<ReadOnlyRestoration, 'observations'> = restored
            ? { phase: label, attempt, paths: restored.paths, left: restored.left, partial: restored.partial, written: restored.written }
            : { phase: label, attempt, paths: [], left: [], partial: true, unguarded: unguarded ?? 'unknown', written: [] };
          ended = { ...outcome, observations: restorationMatters({ ...outcome, observations: [] }) ? [...(record.observations ?? [])] : [] };
          // The photograph can hold tens of megabytes; nothing reads it again.
          snapshot = undefined;
          restorations.push(ended);
          if (restorationMatters(ended)) {
            log(ended.unguarded !== undefined
              ? `[read-only phase] ${JSON.stringify(label)}: NOT guarded (${ended.unguarded})`
              : `[read-only phase] ${JSON.stringify(label)}: put back ${describeRestoredPaths(ended)}` +
                (ended.partial ? ' (the photograph could not see every file)' : ''));
          }
          return ended;
        },
      };
    },
    restorations: () => restorations,
  };
}
