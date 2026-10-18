import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { RunCheckpointStore } from '../src/run/checkpoint.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { runCheckpointSchema } from '../src/contracts/runCheckpoint.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKPOINT_CHUNK_BYTES } from '../src/contracts/checkpointTransfer.js';
import { checkpointWorkspaceDigest, restoreCheckpointWorkspace, hashCheckpointEntry, type SnapshotEntry } from '../src/run/checkpointWorkspace.js';
import { captureCheckpointExport } from '../src/run/checkpointExport.js';
import { CheckpointReceiver } from '../src/run/checkpointTransfer.js';

const roots: string[] = [];
const databases: Database.Database[] = [];
afterEach(() => { closeStoreHandles(); for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-transfer-'))); roots.push(root);
  const source = join(root, 'source'); mkdirSync(source);
  const db = new Database(':memory:'); databases.push(db);
  return { root, source, db };
}
function send(receiver: CheckpointReceiver, entry: SnapshotEntry) {
  receiver.begin({ path: entry.path, kind: entry.kind, mode: entry.mode, size: entry.content.length });
  for (let offset = 0; offset < entry.content.length; offset += CHECKPOINT_CHUNK_BYTES) {
    receiver.append(offset, entry.content.subarray(offset, offset + CHECKPOINT_CHUNK_BYTES));
  }
}

describe('streamed checkpoints', () => {
  it('restores a byte-exact ordinary checkpoint, including links, modes and traversal order', () => {
    const { root, source, db } = fixture();
    mkdirSync(join(source, 'a')); mkdirSync(join(source, 'z'));
    writeFileSync(join(source, 'a', 'script'), 'hello', { mode: 0o755 });
    writeFileSync(join(source, 'a.txt'), Buffer.alloc(3 * CHECKPOINT_CHUNK_BYTES + 7, 42));
    symlinkSync('../a/script', join(source, 'z', 'command'));
    const entries: SnapshotEntry[] = [];
    const digest = checkpointWorkspaceDigest(source, entry => entries.push(entry));
    const receiver = new CheckpointReceiver(db, { digest, rootMode: statSync(source).mode & 0o777 });
    for (const entry of entries) send(receiver, entry);
    // Completed bytes alone are not a usable checkpoint.
    expect(() => restoreCheckpointWorkspace(db, receiver.id, digest, join(root, 'early'), false)).toThrow('unavailable');
    const snapshot = receiver.finish();
    restoreCheckpointWorkspace(db, snapshot.id, digest, join(root, 'restored'), false);
    expect(checkpointWorkspaceDigest(join(root, 'restored'))).toBe(digest);
    expect(readFileSync(join(root, 'restored/z/command'), 'utf8')).toBe('hello');
    expect(() => receiver.begin({ path: 'late', kind: 'file', mode: 0o100644, size: 0 })).toThrow('closed');
  });

  it('discards a disconnected transfer without publishing a snapshot', () => {
    const { db } = fixture();
    const receiver = new CheckpointReceiver(db, { digest: '0'.repeat(64), rootMode: 0o755 });
    receiver.begin({ path: 'done', kind: 'file', mode: 0o100644, size: 0 });
    receiver.begin({ path: 'partial', kind: 'file', mode: 0o100644, size: 3 });
    receiver.append(0, Buffer.from('ab'));
    expect(() => receiver.finish()).toThrow('incomplete');
    receiver.abort(); receiver.abort();
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_checkpoint_files').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_checkpoint_snapshots').get()).toEqual({ n: 0 });
  });

  it('refuses missing parents, duplicate paths, traversal and out-of-order chunks', () => {
    const { db } = fixture();
    const receiver = new CheckpointReceiver(db, { digest: '0'.repeat(64), rootMode: 0o755 });
    for (const path of ['../secret', '/secret', 'a//b', 'a/../b', 'a\\b', 'a\0b', 'missing/file']) {
      expect(() => receiver.begin({ path, kind: 'file', mode: 0o100644, size: 0 })).toThrow();
    }
    receiver.begin({ path: 'file', kind: 'file', mode: 0o100644, size: 3 });
    expect(() => receiver.append(1, Buffer.from('a'))).toThrow('chunk');
    receiver.append(0, Buffer.from('abc'));
    expect(() => receiver.begin({ path: 'file', kind: 'file', mode: 0o100644, size: 0 })).toThrow('order');
    expect(() => receiver.finish()).toThrow('digest');
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_checkpoint_files').get()).toEqual({ n: 0 });
  });

  it('never holds the shared write transaction while waiting for a chunk', () => {
    const { db } = fixture();
    const receiver = new CheckpointReceiver(db, { digest: '0'.repeat(64), rootMode: 0o755 });
    receiver.begin({ path: 'file', kind: 'file', mode: 0o100644, size: 3 });
    receiver.append(0, Buffer.from('a'));
    expect(db.inTransaction).toBe(false);
    receiver.append(1, Buffer.from('bc'));
    expect(db.inTransaction).toBe(false);
    receiver.abort();
  });
});


it('pins an imported snapshot against concurrent pruning and consumes it only for its claimed run', () => {
  const { root, source } = fixture();
  writeFileSync(join(source, 'file'), 'saved');
  const store = new RunCheckpointStore(join(root, 'product.db'));
  const data = runCheckpointSchema.parse({ version: 1, id: randomUUID(), goal: 'Test transfer', workspace: '/not-on-this-host',
    policy: '{}', actor: null, checklist: null, root: null, completed: [], workspaceDigest: null, processes: [],
    consumed: { tokens: 0, costUsd: 0 }, remainingMs: 60000, lastRunId: null });
  const owner = store.claim(data, true);
  store.beginSegment(data, Date.now() + 60000);
  const entries: SnapshotEntry[] = [];
  const digest = checkpointWorkspaceDigest(source, e => entries.push(e));
  expect(() => store.receiveWorkspace(data, 'wrong-owner', { digest, rootMode: 0o755 })).toThrow('not owned');
  const receiver = store.receiveWorkspace(data, owner, { digest, rootMode: 0o755 });
  for (const entry of entries) send(receiver, entry);
  store.pruneSnapshots();
  const snapshot = receiver.finish();
  store.pruneSnapshots();
  expect(() => store.boundaryFromSnapshot(data, 'wrong-owner', snapshot)).toThrow('unavailable');
  store.boundaryFromSnapshot(data, owner, snapshot);
  store.materialize(data, join(root, 'restored-remote'), false);
  expect(readFileSync(join(root, 'restored-remote/file'), 'utf8')).toBe('saved');
  expect(() => store.boundaryFromSnapshot(data, owner, snapshot)).toThrow('unavailable');
});

it.each(['../outside', 'missing', 'link'])('rejects a correctly hashed but unsafe link to %s', target => {
  const { db } = fixture();
  const entry: SnapshotEntry = { path: 'link', kind: 'symlink', mode: 0o120755, content: Buffer.from(target) };
  const hash = createHash('sha256'); hashCheckpointEntry(hash, entry);
  const receiver = new CheckpointReceiver(db, { digest: hash.digest('hex'), rootMode: 0o755 });
  send(receiver, entry);
  expect(() => receiver.finish()).toThrow(/link/);
  expect(db.prepare('SELECT COUNT(*) AS n FROM run_checkpoint_snapshots').get()).toEqual({ n: 0 });
});


it('streams a stable private capture while the live workspace continues to change', async () => {
  const { root, source, db } = fixture();
  writeFileSync(join(source, 'large'), Buffer.alloc(3 * CHECKPOINT_CHUNK_BYTES + 17, 42));
  const snapshot = captureCheckpointExport(source);
  const receiver = new CheckpointReceiver(db, snapshot.header);
  writeFileSync(join(source, 'large'), 'later live write');
  for await (const frame of snapshot.frames()) {
    if (frame.kind === 'entry') receiver.begin(frame.entry);
    else { expect(frame.bytes.length).toBeLessThanOrEqual(CHECKPOINT_CHUNK_BYTES); receiver.append(frame.offset, frame.bytes); }
  }
  const imported = receiver.finish();
  restoreCheckpointWorkspace(db, imported.id, imported.digest, join(root, 'export-restored'), false);
  expect(readFileSync(join(root, 'export-restored/large'))).toEqual(Buffer.alloc(3 * CHECKPOINT_CHUNK_BYTES + 17, 42));
  expect(readFileSync(join(source, 'large'), 'utf8')).toBe('later live write');
  await expect(snapshot.frames().next()).rejects.toThrow('closed');
});
