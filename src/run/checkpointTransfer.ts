import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type Database from 'better-sqlite3';
import { CHECKPOINT_CHUNK_BYTES, checkpointTransferEntrySchema, checkpointTransferHeaderSchema,
  type CheckpointTransferEntry, type CheckpointTransferHeader } from '../contracts/checkpointTransfer.js';
import { WORKSPACE_LIMITS } from '../contracts/workspaceLimits.js';
import { hashCheckpointEntry, initializeCheckpointWorkspaces, type SnapshotEntry } from './checkpointWorkspace.js';

/**
 * One receiver per authenticated transfer. The caller owns admission and teardown.
 * Incomplete rows have no snapshot row and cannot be restored or continued.
 * At most one file is buffered; no database transaction spans network input.
 */
export class CheckpointReceiver {
  readonly id = randomUUID();
  private readonly header: CheckpointTransferHeader;
  private readonly hash = createHash('sha256');
  private pending?: { entry: CheckpointTransferEntry; bytes: Buffer; offset: number };
  private previous?: string;
  private entries = 0;
  private files = 0;
  private bytes = 0;
  private state: 'receiving' | 'complete' | 'aborted' = 'receiving';
  private readonly expiresAt = Date.now() + 30 * 60_000;

  constructor(private readonly db: Database.Database, header: CheckpointTransferHeader,
    scope?: { checkpointId: string; owner: string }) {
    this.header = checkpointTransferHeaderSchema.parse(header);
    initializeCheckpointWorkspaces(db);
    db.prepare('INSERT INTO run_checkpoint_transfers VALUES (?,?,?,?)')
      .run(this.id, scope?.checkpointId ?? null, scope?.owner ?? null, this.expiresAt);
  }

  begin(input: CheckpointTransferEntry): void {
    this.assertReceiving();
    if (this.pending) throw new Error('Checkpoint entry is incomplete');
    const entry = checkpointTransferEntrySchema.parse(input);
    const kindMode = { directory: 0o040000, file: 0o100000, symlink: 0o120000 }[entry.kind];
    if ((entry.mode & 0o170000) !== kindMode) throw new Error('Checkpoint entry mode does not match its kind');
    if (++this.entries > WORKSPACE_LIMITS.maxEntries ||
        (entry.kind === 'file' && ++this.files > WORKSPACE_LIMITS.maxFiles) ||
        (this.bytes += entry.size) > WORKSPACE_LIMITS.maxTotalBytes) throw new Error('Checkpoint exceeds workspace limits');
    if (entry.kind === 'directory' && entry.size !== 0) throw new Error('Directory has content');
    if (entry.kind === 'symlink' && (entry.size === 0 || entry.size > WORKSPACE_LIMITS.maxPathChars * 4)) {
      throw new Error('Invalid checkpoint link size');
    }
    if (this.previous && comparePaths(this.previous, entry.path) >= 0) throw new Error('Checkpoint entries are not in traversal order');
    const parent = posix.dirname(entry.path);
    if (parent !== '.' && this.row(parent)?.kind !== 'directory') throw new Error('Checkpoint parent is not a directory');
    this.pending = { entry, bytes: Buffer.alloc(entry.size), offset: 0 };
    if (entry.size === 0) this.finishEntry();
  }

  append(offset: number, chunk: Uint8Array): void {
    this.assertReceiving();
    const pending = this.pending;
    if (!pending || offset !== pending.offset || chunk.byteLength === 0 || chunk.byteLength > CHECKPOINT_CHUNK_BYTES ||
        pending.offset + chunk.byteLength > pending.entry.size) throw new Error('Invalid checkpoint chunk');
    pending.bytes.set(chunk, pending.offset);
    pending.offset += chunk.byteLength;
    if (pending.offset === pending.entry.size) this.finishEntry();
  }

  finish(): { id: string; digest: string } {
    this.assertReceiving();
    if (this.pending) throw new Error('Checkpoint entry is incomplete');
    const digest = this.hash.digest('hex');
    try {
      if (digest !== this.header.digest) throw new Error('Checkpoint snapshot digest mismatch');
      const links = this.db.prepare("SELECT path FROM run_checkpoint_files WHERE snapshot=? AND kind='symlink'").iterate(this.id);
      for (const raw of links) this.resolveLink((raw as { path: string }).path);
      this.db.prepare('INSERT INTO run_checkpoint_snapshots (id,digest,root_mode) VALUES (?,?,?)')
        .run(this.id, digest, this.header.rootMode);
      this.state = 'complete';
      return { id: this.id, digest };
    } catch (error) { this.abort(); throw error; }
  }

  abort(): void {
    if (this.state !== 'receiving') return;
    this.pending = undefined;
    this.db.prepare('DELETE FROM run_checkpoint_files WHERE snapshot=?').run(this.id);
    this.db.prepare('DELETE FROM run_checkpoint_transfers WHERE snapshot=?').run(this.id);
    this.state = 'aborted';
  }

  private assertReceiving(): void {
    if (this.state !== 'receiving') throw new Error('Checkpoint transfer is closed');
    if (Date.now() >= this.expiresAt) { this.abort(); throw new Error('Checkpoint transfer expired'); }
  }
  private row(path: string): { kind: string; content: Buffer } | undefined {
    return this.db.prepare('SELECT kind,content FROM run_checkpoint_files WHERE snapshot=? AND path=?')
      .get(this.id, path) as { kind: string; content: Buffer } | undefined;
  }
  private finishEntry(): void {
    const pending = this.pending!;
    const entry: SnapshotEntry = { ...pending.entry, content: pending.bytes };
    if (entry.kind === 'symlink') {
      const target = entry.content.toString('utf8');
      if (!Buffer.from(target).equals(entry.content) || target.includes('\0') || target.includes('\\') || posix.isAbsolute(target)) {
        throw new Error('Invalid checkpoint link');
      }
    }
    this.db.prepare('INSERT INTO run_checkpoint_files VALUES (?,?,?,?,?)')
      .run(this.id, entry.path, entry.kind, entry.mode, entry.content);
    hashCheckpointEntry(this.hash, entry);
    this.previous = entry.path;
    this.pending = undefined;
  }
  private resolveLink(path: string): void {
    let parts = path.split('/');
    const resolved: string[] = [];
    let links = 0;
    while (parts.length) {
      const part = parts.shift()!;
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (resolved.length === 0) throw new Error('Checkpoint link escapes workspace');
        resolved.pop(); continue;
      }
      const row = this.row([...resolved, part].join('/'));
      if (!row) throw new Error('Checkpoint contains a dangling link');
      if (row.kind === 'symlink') {
        if (++links > 40) throw new Error('Checkpoint link cycle or excessive depth');
        parts = [...row.content.toString('utf8').split('/'), ...parts];
      } else {
        if (parts.length && row.kind !== 'directory') throw new Error('Checkpoint link crosses a file');
        resolved.push(part);
      }
    }
  }
}

/** Match readdir().sort() depth-first traversal, not flattened path ordering. */
function comparePaths(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return left.length - right.length;
}
