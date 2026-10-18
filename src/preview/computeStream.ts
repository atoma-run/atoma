import { Duplex } from 'node:stream';
import { COMPUTE_PREVIEW_CHUNK_BYTES, computePreviewReplySchema, type ComputePreviewCommand } from '../contracts/computePreview.js';

/** Backpressure is end-to-end: one bounded read and one acknowledged write.
 * The HTTP gateway retains parsing, origin, grant and header policy. */
export async function openComputePreviewStream(send: (command: ComputePreviewCommand) => Promise<unknown>): Promise<Duplex> {
  const call = async (command: ComputePreviewCommand) => {
    const reply = computePreviewReplySchema.parse(await send(command));
    if (reply.method !== command.method) throw new Error('Preview relay response mismatch');
    return reply;
  };
  const opened = await call({ method: 'connect' });
  if (opened.method !== 'connect') throw new Error('Preview relay unavailable');
  const stream = opened.value;
  let reading = false;
  const socket = new Duplex({ highWaterMark: COMPUTE_PREVIEW_CHUNK_BYTES,
    read() {
      if (reading) return;
      reading = true;
      void call({ method: 'read', stream }).then(reply => {
        reading = false;
        if (reply.method !== 'read') throw new Error('Preview relay read mismatch');
        if (reply.value === null) socket.push(null);
        else {
          const bytes = Buffer.from(reply.value, 'base64');
          if (bytes.length > COMPUTE_PREVIEW_CHUNK_BYTES || bytes.toString('base64') !== reply.value) throw new Error('Invalid preview relay bytes');
          socket.push(bytes);
        }
      }).catch((error: unknown) => socket.destroy(error instanceof Error ? error : new Error('Preview relay unavailable')));
    },
    write(chunk: Buffer, _encoding, callback) {
      void (async () => {
        for (let offset = 0; offset < chunk.length; offset += COMPUTE_PREVIEW_CHUNK_BYTES) {
          await call({ method: 'write', stream, data: chunk.subarray(offset, offset + COMPUTE_PREVIEW_CHUNK_BYTES).toString('base64') });
        }
      })().then(() => callback(), (error: unknown) => callback(error instanceof Error ? error : new Error('Preview relay write failed')));
    },
    final(callback) {
      void call({ method: 'end', stream }).then(() => callback(), (error: unknown) => callback(error instanceof Error ? error : new Error('Preview relay end failed')));
    },
    destroy(error, callback) {
      void call({ method: 'disconnect', stream }).catch(() => {}).finally(() => callback(error));
    },
  });
  return socket;
}
