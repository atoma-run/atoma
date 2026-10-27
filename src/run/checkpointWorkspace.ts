import { createHash, randomUUID, type Hash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, dirname, basename } from 'node:path';
import type Database from 'better-sqlite3';
import { WORKSPACE_LIMITS } from '../contracts/workspaceLimits.js';
/** Resolve symlinked parents before launch, including a not-yet-created workspace. */
export function canonicalCheckpointWorkspacePath(workspace: string): string {
  let ancestor = resolve(workspace);
  const tail: string[] = [];
  while (!existsSync(ancestor)) {
    tail.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...tail);
}
export interface SnapshotEntry { path: string; kind: 'directory' | 'file' | 'symlink'; mode: number; content: Buffer }
/** One digest encoding for local capture and streamed checkpoint import. */
export function hashCheckpointEntry(hash: Hash, entry: SnapshotEntry): void {
  if (entry.kind === 'directory') hash.update(JSON.stringify(['directory', entry.path, entry.mode]));
  else if (entry.kind === 'symlink') hash.update(JSON.stringify(['symlink', entry.path, entry.content.toString(), entry.mode]));
  else {
    hash.update(JSON.stringify(['file', entry.path, entry.mode, entry.content.length]));
    hash.update(entry.content);
  }
}
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
        hashCheckpointEntry(hash, { path: rel, kind: 'directory', mode: stat.mode, content: Buffer.alloc(0) });
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
          hashCheckpointEntry(hash, { path: rel, kind: 'file', mode: stat.mode, content: data.subarray(0, length) });
          entry?.({ path: rel, kind: 'file', mode: stat.mode, content: data.subarray(0, length) });
        } finally { closeSync(fd); }
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        const resolved = relative(root, realpathSync(path));
        if (isAbsolute(target) || resolved === '..' || resolved.startsWith('../') || isAbsolute(resolved)) {
          throw new Error('Checkpoint workspace contains an escaping link or special file');
        }
        hashCheckpointEntry(hash, { path: rel, kind: 'symlink', mode: stat.mode, content: Buffer.from(target) });
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
  ); CREATE TABLE IF NOT EXISTS run_checkpoint_snapshots (id TEXT PRIMARY KEY, digest TEXT NOT NULL, root_mode INTEGER NOT NULL DEFAULT 493);
  CREATE TABLE IF NOT EXISTS run_checkpoint_transfers (
    snapshot TEXT PRIMARY KEY, checkpoint_id TEXT, owner TEXT, expires_at INTEGER NOT NULL
  )`);
  if (!(db.prepare('PRAGMA table_info(run_checkpoint_snapshots)').all() as { name: string }[]).some(c => c.name === 'root_mode')) {
    db.exec('ALTER TABLE run_checkpoint_snapshots ADD COLUMN root_mode INTEGER NOT NULL DEFAULT 493');
  }
}

/** The tree's state read BEFORE the boundary's transaction opens (`saveCheckpointWorkspace`). */
export interface CheckpointWorkspaceReading { readonly digest: string; readonly mode: number }
export function readCheckpointWorkspace(root: string): CheckpointWorkspaceReading {
  const mode = lstatSync(root).mode & 0o777;
  return { digest: checkpointWorkspaceDigest(root), mode };
}

/** Called inside the same transaction that publishes the boundary. Failed or
 * changing captures roll back completely. Blobs stay in the backed-up product DB.
 * The stability check compares the capture with a reading taken just before
 * the transaction, not with a second walk inside it: the write lock of the
 * shared store is held for one walk, not two (code review 2026-10-09 2.9).
 * Two consecutive equal walks prove the same either way; no SQLite lock ever
 * held the files still.
 */
export function saveCheckpointWorkspace(db: Database.Database, root: string, before: CheckpointWorkspaceReading): { id: string; digest: string } {
  const id = randomUUID();
  const insert = db.prepare('INSERT INTO run_checkpoint_files VALUES (?,?,?,?,?)');
  const digest = checkpointWorkspaceDigest(root, e => { insert.run(id, e.path, e.kind, e.mode, e.content); });
  const mode = lstatSync(root).mode & 0o777;
  if (before.digest !== digest || before.mode !== mode) throw new Error('Checkpoint workspace is still changing');
  db.prepare('INSERT INTO run_checkpoint_snapshots (id,digest,root_mode) VALUES (?,?,?)').run(id, digest, mode);
  return { id, digest };
}

/** Build into a private new directory, verify every byte, then rename. The old
 * CLI workspace is archived, never recursively overwritten through its paths.
 */
export function restoreCheckpointWorkspace(db: Database.Database, snapshot: string, digest: string, target: string, archive: boolean): void {
  const recorded = db.prepare('SELECT digest,root_mode FROM run_checkpoint_snapshots WHERE id=?').get(snapshot) as { digest: string; root_mode: number } | undefined;
  if (recorded?.digest !== digest) throw new Error('Checkpoint snapshot is unavailable');
  const writer = new CheckpointWorkspaceWriter({ digest, rootMode: recorded.root_mode }, target, archive);
  try {
    const rows = db.prepare('SELECT path,kind,mode,content FROM run_checkpoint_files WHERE snapshot=? ORDER BY path').iterate(snapshot);
    for (const raw of rows) writer.add(raw as SnapshotEntry);
    writer.finish();
  } finally { writer.abort(); }
}

/** The same restore algorithm for stored rows and execution-host transfers.
 * Private files stay unreachable until every byte and link has been checked. */
export class CheckpointWorkspaceWriter {
  private readonly temp: string;
  private entries = 0;
  private bytes = 0;
  private closed = false;
  private readonly directories: { path: string; mode: number }[] = [];
  private readonly links: { path: string; target: string }[] = [];

  constructor(private readonly header: { digest: string; rootMode: number }, private readonly target: string, private readonly archive: boolean) {
    let ancestor = dirname(target);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (realpathSync(ancestor) !== resolve(ancestor)) throw new Error('Checkpoint destination is redirected');
    mkdirSync(dirname(target), { recursive: true });
    const parent = realpathSync(dirname(target));
    if (parent !== resolve(dirname(target))) throw new Error('Checkpoint destination is redirected');
    this.temp = join(parent, `.checkpoint-${randomUUID()}`);
    mkdirSync(this.temp, { mode: 0o700 });
  }

  add(e: SnapshotEntry): void {
    if (this.closed) throw new Error('Checkpoint restoration is closed');
    if (++this.entries > WORKSPACE_LIMITS.maxEntries || e.path.length > WORKSPACE_LIMITS.maxPathChars ||
        !e.path || isAbsolute(e.path) || e.path.split(/[\\/]/).some(p => !p || p === '.' || p === '..') ||
        !Buffer.isBuffer(e.content) || e.content.length > WORKSPACE_LIMITS.maxFileBytes ||
        (this.bytes += e.content.length) > WORKSPACE_LIMITS.maxTotalBytes) throw new Error('Invalid checkpoint snapshot');
    const path = join(this.temp, e.path);
    if (e.kind === 'directory') { mkdirSync(path); this.directories.push({ path, mode: e.mode }); }
    else if (e.kind === 'file') {
      writeFileSync(path, e.content, { flag: 'wx', mode: e.mode & 0o777 });
      chmodSync(path, e.mode & 0o777);
    } else if (e.kind === 'symlink') {
      const target = e.content.toString('utf8');
      if (!Buffer.from(target).equals(e.content)) throw new Error('Invalid checkpoint link encoding');
      this.links.push({ path, target });
    }
    else throw new Error('Invalid checkpoint entry');
  }

  finish(): void {
    if (this.closed) throw new Error('Checkpoint restoration is closed');
    try {
      // Delayed links cannot redirect any entry creation.
      for (const link of this.links) symlinkSync(link.target, link.path);
      for (const dir of this.directories.reverse()) chmodSync(dir.path, dir.mode & 0o777);
      if (checkpointWorkspaceDigest(this.temp) !== this.header.digest) throw new Error('Checkpoint snapshot digest mismatch');
      chmodSync(this.temp, this.header.rootMode & 0o777);
      if (existsSync(this.target)) {
        if (!this.archive) throw new Error('Continuation workspace must be new');
        renameSync(this.target, `${this.target}.interrupted-${randomUUID()}`);
      }
      renameSync(this.temp, this.target);
    } finally { this.abort(); }
  }

  abort(): void {
    if (this.closed) return;
    this.closed = true;
    rmSync(this.temp, { recursive: true, force: true });
  }
}

/** Shared byte GC, including stores which have never created a resumable checkpoint. */
export function pruneCheckpointWorkspaceSnapshots(db: Database.Database): void {
  initializeCheckpointWorkspaces(db);
  const has = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const references = ['SELECT snapshot FROM run_checkpoint_transfers'];
  if (has('run_initial_states')) references.push('SELECT snapshot FROM run_initial_states');
  if (has('run_checkpoints')) references.push("SELECT json_extract(payload,'$.snapshotId') FROM run_checkpoints WHERE state<>'finished' AND json_extract(payload,'$.snapshotId') IS NOT NULL");
  db.transaction(() => {
    db.prepare('DELETE FROM run_checkpoint_transfers WHERE expires_at<=?').run(Date.now());
    const unreferenced = `SELECT id FROM run_checkpoint_snapshots WHERE id NOT IN (${references.join(' UNION ')})`;
    db.exec(`DELETE FROM run_checkpoint_files WHERE snapshot IN (${unreferenced});
      DELETE FROM run_checkpoint_snapshots WHERE id IN (${unreferenced});
      DELETE FROM run_checkpoint_files WHERE snapshot NOT IN (SELECT id FROM run_checkpoint_snapshots)
        AND snapshot NOT IN (SELECT snapshot FROM run_checkpoint_transfers)`);
  }).immediate();
}
