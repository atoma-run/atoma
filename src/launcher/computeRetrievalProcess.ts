import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { computeRetrievalCommandSchema, computeRetrievalResponseSchema, type ComputeRetrievalCommand, type ComputeRetrievalReply } from '../contracts/computeRetrieval.js';
import { COMPUTE_FRAME_BYTES } from '../contracts/computeProtocol.js';

/** One private retrieval process, one request in flight, no replay. */
export function computeRetrievalProcess(child: ChildProcessWithoutNullStreams) {
  let nextId = 0, closed = false, buffer = Buffer.alloc(0);
  let pending: { id: number; method: ComputeRetrievalCommand['method']; resolve(value: ComputeRetrievalReply): void;
    reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const stop = () => {
    closed = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Compute retrieval interrupted')); pending = undefined; }
    child.kill();
  };
  const exited = new Promise<void>(resolve => child.once('close', () => { stop(); resolve(); }));
  child.on('error', stop); child.stdin.on('error', stop); child.stderr.resume();
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      if (buffer.length + chunk.length > COMPUTE_FRAME_BYTES) throw new Error('Oversized retrieval response');
      buffer = Buffer.concat([buffer, chunk]);
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const reply = computeRetrievalResponseSchema.parse(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
        buffer = buffer.subarray(newline + 1);
        if (!pending || pending.id !== reply.id || (reply.ok && reply.reply.method !== pending.method)) throw new Error('Unexpected retrieval response');
        const call = pending; pending = undefined; clearTimeout(call.timer);
        if (reply.ok) call.resolve(reply.reply); else call.reject(new Error(`Compute retrieval ${call.method} unavailable`));
      }
    } catch { stop(); }
  });
  return { execute: (input: ComputeRetrievalCommand): Promise<ComputeRetrievalReply> => {
    const command = computeRetrievalCommandSchema.parse(input);
    if (closed || pending) return Promise.reject(new Error('Compute retrieval unavailable or busy'));
    const id = ++nextId, text = JSON.stringify({ id, command }) + '\n';
    if (Buffer.byteLength(text) > COMPUTE_FRAME_BYTES || child.stdin.writableLength > COMPUTE_FRAME_BYTES) return Promise.reject(new Error('Retrieval frame too large'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(stop, command.method === 'prepare' ? 30 * 60_000 : 120_000); timer.unref();
      pending = { id, method: command.method, resolve, reject, timer }; child.stdin.write(text);
    });
  }, close: async () => { stop(); await exited; } };
}
