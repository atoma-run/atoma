import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CHECKPOINT_CHUNK_BYTES, checkpointTransferEntrySchema, type CheckpointExport } from '../contracts/checkpointTransfer.js';
import { checkpointWorkspaceDigest } from './checkpointWorkspace.js';

/**
 * Seal to private execution-host disk before transport starts. Reuse the two
 * stable walks and digest encoding of hosted checkpoints. No snapshot bytes
 * are retained in the orchestrator and no asynchronous writer can alter the spool.
 */
export function captureCheckpointExport(root: string): CheckpointExport {
  const beforeMode = lstatSync(root).mode & 0o777;
  const before = checkpointWorkspaceDigest(root);
  const directory = mkdtempSync(join(tmpdir(), 'atoma-checkpoint-export-'));
  const spool = join(directory, 'snapshot');
  let fd: number | undefined;
  let closed = false;
  let started = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (fd !== undefined) { closeSync(fd); fd = undefined; }
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    fd = openSync(spool, 'wx+', 0o600);
    // The Linux/macOS service keeps only the descriptor: process death cannot
    // leave a multi-hundred-megabyte spool behind on the execution host.
    if (process.platform !== 'win32') rmSync(directory, { recursive: true, force: true });
    const write = (bytes: Buffer) => {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd!, bytes, offset, bytes.length - offset);
    };
    const digest = checkpointWorkspaceDigest(root, entry => {
      const metadata = Buffer.from(JSON.stringify({ path: entry.path, kind: entry.kind, mode: entry.mode, size: entry.content.length }));
      const length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
      write(length); write(metadata); write(entry.content);
    });
    const rootMode = lstatSync(root).mode & 0o777;
    if (digest !== before || rootMode !== beforeMode) throw new Error('Checkpoint workspace is still changing');
    const size = fstatSync(fd).size;
    return {
      header: { digest, rootMode }, close,
      async *frames() {
        if (started || closed) throw new Error('Checkpoint export is closed');
        started = true;
        let position = 0;
        const read = (length: number) => {
          if (closed || position + length > size) throw new Error('Checkpoint export interrupted');
          const bytes = Buffer.alloc(length);
          let offset = 0;
          while (offset < length) {
            const count = readSync(fd!, bytes, offset, length - offset, position + offset);
            if (!count) throw new Error('Checkpoint export interrupted');
            offset += count;
          }
          position += length;
          return bytes;
        };
        try {
          while (position < size) {
            const length = read(4).readUInt32BE();
            if (length > 8192) throw new Error('Invalid checkpoint export entry');
            const entry = checkpointTransferEntrySchema.parse(JSON.parse(read(length).toString('utf8')) as unknown);
            yield { kind: 'entry', entry };
            for (let offset = 0; offset < entry.size; offset += CHECKPOINT_CHUNK_BYTES) {
              yield { kind: 'chunk', offset, bytes: read(Math.min(CHECKPOINT_CHUNK_BYTES, entry.size - offset)) };
            }
          }
        } finally { close(); }
      },
    };
  } catch (error) { close(); throw error; }
}
