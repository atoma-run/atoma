import type { WorkspaceCommand, WorkspaceReply } from '../contracts/workspaceProtocol.js';

/** Progress is transport observation, never checkpoint or delivery acceptance.
 * Unknown totals stay unknown: private exports stream their inventory too. */
export class ComputeTransfers {
  private readonly transfers = new Map<string, { direction: 'upload' | 'download'; kind: 'workspace' | 'checkpoint' | 'delivery';
    bytes: number; files: number; state: 'transferring' | 'transferred' | 'interrupted' }>();
  list() { return [...this.transfers].map(([id, value]) => ({ id, ...value })); }
  observe(command: WorkspaceCommand, reply: WorkspaceReply): void {
    if (reply.method !== command.method) return;
    if (reply.method === 'artifact-open' || reply.method === 'checkpoint-open' || reply.method === 'import-open') {
      // Keep the latest eight streams, including their terminal state.
      if (this.transfers.size >= 8) this.transfers.delete(this.transfers.keys().next().value!);
      this.transfers.set(reply.method === 'import-open' ? reply.value : reply.value.handle, {
        direction: reply.method === 'import-open' ? 'download' : 'upload',
        kind: reply.method === 'artifact-open' ? 'delivery' : reply.method === 'checkpoint-open' ? 'checkpoint' : 'workspace',
        bytes: 0, files: 0, state: 'transferring',
      });
    }
    if (!('handle' in command)) return;
    const transfer = this.transfers.get(command.handle);
    if (!transfer) return;
    const frame = command.method === 'import-frame' ? command.frame : reply.method === 'checkpoint-next' ? reply.value : undefined;
    if (frame?.kind === 'chunk') transfer.bytes += Buffer.byteLength(frame.data, 'base64');
    if (frame?.kind === 'entry' && frame.entry.kind !== 'directory') transfer.files++;
    if (frame?.kind === 'end') transfer.state = 'transferred';
    if ((command.method === 'checkpoint-close' || command.method === 'import-abort') && transfer.state === 'transferring') transfer.state = 'interrupted';
  }
  interrupted(): void { for (const transfer of this.transfers.values()) if (transfer.state === 'transferring') transfer.state = 'interrupted'; }
}
