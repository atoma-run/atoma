import { CHECKPOINT_CHUNK_BYTES, checkpointTransferEntrySchema, checkpointTransferHeaderSchema,
  type CheckpointTransferEntry, type CheckpointTransferHeader } from '../contracts/checkpointTransfer.js';
import { CheckpointWorkspaceWriter } from './checkpointWorkspace.js';
import type { CheckpointExport } from '../contracts/checkpointTransfer.js';
import type { WorkspaceRuntime, WorkspaceRestoration } from '../contracts/workspaceRuntime.js';

export async function restoreWorkspaceExport(workspace: Pick<WorkspaceRuntime, 'importWorkspace'>,
  exporting: CheckpointExport, archive: boolean): Promise<void> {
  let receiver: WorkspaceRestoration | undefined;
  try {
    receiver = await workspace.importWorkspace(exporting.header, archive);
    for await (const frame of exporting.frames()) {
      if (frame.kind === 'entry') await receiver.begin(frame.entry);
      else await receiver.append(frame.offset, frame.bytes);
    }
    await receiver.finish();
  } catch (error) {
    await Promise.resolve().then(() => receiver?.abort()).catch(() => undefined);
    throw error;
  } finally { await exporting.close(); }
}

/** One bounded file at a time, into a private tree on the execution filesystem. */
export class WorkspaceImport {
  private readonly writer: CheckpointWorkspaceWriter;
  private pending?: { entry: CheckpointTransferEntry; bytes: Buffer; offset: number };
  private closed = false;
  constructor(root: string, header: CheckpointTransferHeader, archive: boolean) {
    this.writer = new CheckpointWorkspaceWriter(checkpointTransferHeaderSchema.parse(header), root, archive);
  }
  begin(input: CheckpointTransferEntry): void {
    if (this.closed || this.pending) throw new Error('Workspace import is closed or incomplete');
    const entry = checkpointTransferEntrySchema.parse(input);
    if (entry.kind === 'directory' && entry.size !== 0) throw new Error('Directory has content');
    this.pending = { entry, bytes: Buffer.alloc(entry.size), offset: 0 };
    if (entry.size === 0) this.write();
  }
  append(offset: number, bytes: Uint8Array): void {
    const pending = this.pending;
    if (this.closed || !pending || offset !== pending.offset || !bytes.byteLength || bytes.byteLength > CHECKPOINT_CHUNK_BYTES ||
        pending.offset + bytes.byteLength > pending.entry.size) throw new Error('Invalid workspace import chunk');
    pending.bytes.set(bytes, offset);
    pending.offset += bytes.byteLength;
    if (pending.offset === pending.entry.size) this.write();
  }
  private write(): void {
    const pending = this.pending!;
    this.writer.add({ ...pending.entry, content: pending.bytes });
    this.pending = undefined;
  }
  finish(): void {
    if (this.closed || this.pending) throw new Error('Workspace import is closed or incomplete');
    try { this.writer.finish(); } finally { this.abort(); }
  }
  abort(): void {
    this.closed = true;
    this.pending = undefined;
    this.writer.abort();
  }
}
