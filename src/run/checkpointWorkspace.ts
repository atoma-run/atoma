import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { WORKSPACE_LIMITS } from '../contracts/workspaceLimits.js';
export interface SnapshotEntry { path: string; kind: 'directory' | 'file' | 'symlink'; mode: number; content: Buffer }
/** Seal every entry, including scratch and dependencies. No filtered publication inventory; relative internal links keep their identity. */
export function checkpointWorkspaceDigest(root: string, entry?: (value: SnapshotEntry) => void): string {
  if (realpathSync(root) !== resolve(root) || !lstatSync(root).isDirectory()) {
    throw new Error('Checkpoint workspace must be a real directory');
  }
  const hash = createHash('sha256');
  let entries = 0;
  let files = 0;
  let bytes = 0;
  const visit = (dir: string, logical = dir): void => {
    const fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
    if (!fstatSync(fd).isDirectory()) throw new Error('Checkpoint directory changed');
    const pinned = process.platform === 'linux' ? `/proc/self/fd/${fd}` : dir;
    if (process.platform !== 'linux' && realpathSync(dir) !== logical) throw new Error('Checkpoint directory redirected');
    for (const name of readdirSync(pinned).sort()) {
      const path = join(pinned, name);
      const logicalPath = join(logical, name);
      const rel = relative(root, logicalPath);
      const stat = lstatSync(path);
      if (++entries > WORKSPACE_LIMITS.maxEntries || rel.length > WORKSPACE_LIMITS.maxPathChars) {
        throw new Error('Checkpoint workspace exceeds entry/path limits');
      }
      if (stat.isDirectory()) {
        hash.update(JSON.stringify(['directory', rel, stat.mode]));
        entry?.({ path: rel, kind: 'directory', mode: stat.mode, content: Buffer.alloc(0) });
        visit(path, logicalPath);
      } else if (stat.isFile() && stat.nlink === 1) {
        if (++files > WORKSPACE_LIMITS.maxFiles || stat.size > WORKSPACE_LIMITS.maxFileBytes ||
            (bytes += stat.size) > WORKSPACE_LIMITS.maxTotalBytes) throw new Error('Checkpoint workspace exceeds file limits');
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = fstatSync(fd);
          if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev || before.nlink !== 1) {
            throw new Error('Checkpoint workspace changed while reading');
          }
          // Fixed allocation: a concurrent writer cannot grow readFileSync's
          // allocation past the host's limit after the initial stat.
          const data = Buffer.alloc(stat.size + 1);
          let length = 0;
          for (;;) {
            const read = readSync(fd, data, length, data.length - length, null);
            if (read === 0) break;
            length += read;
            if (length === data.length) throw new Error('Checkpoint workspace changed while reading');
          }
          const after = fstatSync(fd);
          if (length !== stat.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw new Error('Checkpoint workspace changed while reading');
          }
          hash.update(JSON.stringify(['file', rel, stat.mode, length]));
          hash.update(data.subarray(0, length));
          entry?.({ path: rel, kind: 'file', mode: stat.mode, content: data.subarray(0, length) });
        } finally { closeSync(fd); }
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        const resolved = relative(root, realpathSync(path));
        if (isAbsolute(target) || resolved === '..' || resolved.startsWith('../') || isAbsolute(resolved)) {
          throw new Error('Checkpoint workspace contains an escaping link or special file');
        }
        hash.update(JSON.stringify(['symlink', rel, target, stat.mode]));
        entry?.({ path: rel, kind: 'symlink', mode: stat.mode, content: Buffer.from(target) });
      } else throw new Error('Checkpoint workspace contains a link or special file');
    }
    } finally { closeSync(fd); }
  };
  visit(root);
  return hash.digest('hex');
}

export function initializeCheckpointWorkspaces(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS run_checkpoint_files (
    snapshot TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, mode INTEGER NOT NULL,
    content BLOB NOT NULL, PRIMARY KEY(snapshot,path)
  ); CREATE TABLE IF NOT EXISTS run_checkpoint_snapshots (id TEXT PRIMARY KEY, digest TEXT NOT NULL, root_mode INTEGER NOT NULL DEFAULT 493)`);
  if (!(db.prepare('PRAGMA table_info(run_checkpoint_snapshots)').all() as { name: string }[]).some(c => c.name === 'root_mode')) {
    db.exec('ALTER TABLE run_checkpoint_snapshots ADD COLUMN root_mode INTEGER NOT NULL DEFAULT 493');
  }
}

/** Called inside the same transaction that publishes the boundary. Failed or
 * changing captures roll back completely. Blobs stay in the backed-up product DB.
 */
export function saveCheckpointWorkspace(db: Database.Database, root: string): { id: string; digest: string } {
  const id = randomUUID();
  const mode = lstatSync(root).mode & 0o777;
  const insert = db.prepare('INSERT INTO run_checkpoint_files VALUES (?,?,?,?,?)');
  const digest = checkpointWorkspaceDigest(root, e => { insert.run(id, e.path, e.kind, e.mode, e.content); });
  if (checkpointWorkspaceDigest(root) !== digest || (lstatSync(root).mode & 0o777) !== mode) throw new Error('Checkpoint workspace is still changing');
  db.prepare('INSERT INTO run_checkpoint_snapshots (id,digest,root_mode) VALUES (?,?,?)').run(id, digest, mode);
  return { id, digest };
}

/** Build into a private new directory, verify every byte, then rename. The old
 * CLI workspace is archived, never recursively overwritten through its paths.
 */
export function restoreCheckpointWorkspace(db: Database.Database, snapshot: string, digest: string, target: string, archive: boolean): void {
  const recorded = db.prepare('SELECT digest,root_mode FROM run_checkpoint_snapshots WHERE id=?').get(snapshot) as { digest: string; root_mode: number } | undefined;
  if (recorded?.digest !== digest) throw new Error('Checkpoint snapshot is unavailable');
  let ancestor = dirname(target);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== resolve(ancestor)) throw new Error('Checkpoint destination is redirected');
  mkdirSync(dirname(target), { recursive: true });
  const parent = realpathSync(dirname(target));
  if (parent !== resolve(dirname(target))) throw new Error('Checkpoint destination is redirected');
  const temp = join(parent, `.checkpoint-${randomUUID()}`);
  mkdirSync(temp, { mode: 0o700 });
  try {
    const rows = db.prepare('SELECT path,kind,mode,content FROM run_checkpoint_files WHERE snapshot=? ORDER BY path').iterate(snapshot);
    let entries = 0;
    let bytes = 0;
    const directories: { path: string; mode: number }[] = [];
    const links: { path: string; target: string }[] = [];
    for (const raw of rows) {
      const e = raw as SnapshotEntry;
      if (++entries > WORKSPACE_LIMITS.maxEntries || e.path.length > WORKSPACE_LIMITS.maxPathChars ||
          !e.path || isAbsolute(e.path) || e.path.split(/[\\/]/).some(p => !p || p === '.' || p === '..') ||
          !Buffer.isBuffer(e.content) || e.content.length > WORKSPACE_LIMITS.maxFileBytes ||
          (bytes += e.content.length) > WORKSPACE_LIMITS.maxTotalBytes) throw new Error('Invalid checkpoint snapshot');
      const path = join(temp, e.path);
      if (e.kind === 'directory') { mkdirSync(path); directories.push({ path, mode: e.mode }); }
      else if (e.kind === 'file') {
        writeFileSync(path, e.content, { flag: 'wx', mode: e.mode & 0o777 });
        chmodSync(path, e.mode & 0o777);
      }
      else if (e.kind === 'symlink') links.push({ path, target: e.content.toString() });
      else throw new Error('Invalid checkpoint entry');
    }
    // Links cannot redirect any file creation: they are created last.
    for (const link of links) symlinkSync(link.target, link.path);
    for (const dir of directories.reverse()) chmodSync(dir.path, dir.mode & 0o777);
    if (checkpointWorkspaceDigest(temp) !== digest) throw new Error('Checkpoint snapshot digest mismatch');
    chmodSync(temp, recorded.root_mode & 0o777);
    if (existsSync(target)) {
      if (!archive) throw new Error('Continuation workspace must be new');
      renameSync(target, `${target}.interrupted-${randomUUID()}`);
    }
    renameSync(temp, target);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
