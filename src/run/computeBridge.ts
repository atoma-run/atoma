import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { COMPUTE_FRAME_BYTES } from '../contracts/computeProtocol.js';
import { computeBridgeAddressSchema, computeBridgeRequestSchema, computeBridgeResponseSchema, type ComputeBridgeCall } from '../contracts/computeBridge.js';
import { workerCallTimeoutMs } from '../contracts/commandTimeouts.js';

function write(socket: Socket, value: unknown): void {
  const line = JSON.stringify(value) + '\n';
  if (socket.destroyed || Buffer.byteLength(line) > COMPUTE_FRAME_BYTES || socket.writableLength > COMPUTE_FRAME_BYTES) throw new Error('Compute bridge unavailable');
  socket.write(line);
}
function lines(socket: Socket, receive: (value: unknown) => void): void {
  let buffer = Buffer.alloc(0);
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: Buffer) => {
    try {
      if (buffer.length + chunk.length > COMPUTE_FRAME_BYTES) throw new Error('Compute bridge frame too large');
      buffer = Buffer.concat([buffer, chunk]);
      let end: number;
      while ((end = buffer.indexOf(10)) !== -1) {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)));
        buffer = buffer.subarray(end + 1); receive(value);
      }
    } catch { socket.destroy(); }
  });
}

/** One host child, a private 0700 directory and a one-use capability. */
export async function serveComputeBridge(execute: (call: ComputeBridgeCall) => Promise<unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'ac-')), socketPath = join(root, 'rpc');
  chmodSync(root, 0o700);
  const token = randomBytes(32).toString('base64url');
  let address;
  try { address = computeBridgeAddressSchema.parse({ socket: socketPath, token }); }
  catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  const clients = new Set<Socket>();
  let claimed = false;
  const server = createServer(socket => {
    if (claimed || clients.size) { socket.destroy(); return; }
    clients.add(socket);
    const deadline = setTimeout(() => socket.destroy(), 5000); deadline.unref();
    let authenticated = false, lastId = 0, inFlight = 0;
    socket.once('close', () => { clearTimeout(deadline); clients.delete(socket); });
    lines(socket, value => {
      if (!authenticated) {
        if (value !== token) throw new Error('Compute bridge authentication failed');
        authenticated = true; claimed = true; clearTimeout(deadline); write(socket, { ready: true }); return;
      }
      const request = computeBridgeRequestSchema.parse(value);
      if (request.id <= lastId || inFlight >= 34) throw new Error('Compute bridge request refused');
      lastId = request.id; inFlight++;
      void execute(request.call).then(value => {
        write(socket, { id: request.id, ok: true, value });
      }, error => {
        write(socket, { id: request.id, ok: false, error: error instanceof Error ? error.message.slice(0, 8192) : 'Compute operation failed' });
      }).catch(() => socket.destroy()).finally(() => { inFlight--; });
    });
  });
  try { server.listen(socketPath); await once(server, 'listening'); }
  catch (error) { server.close(); rmSync(root, { recursive: true, force: true }); throw error; }
  return { address, close: async () => {
    for (const socket of clients) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  } };
}

export async function connectComputeBridge(input: unknown) {
  const address = computeBridgeAddressSchema.parse(input);
  const socket = createConnection(address.socket);
  let id = 0, closed = false, ready = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const established = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(deadline); socket.destroy();
    const error = new Error('Compute bridge lost; operation outcome unknown');
    rejectReady(error);
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
  };
  const deadline = setTimeout(close, 5000); deadline.unref();
  socket.once('connect', () => { try { write(socket, address.token); } catch { close(); } });
  socket.once('close', close);
  lines(socket, value => {
    if (!ready) {
      if (JSON.stringify(value) !== '{"ready":true}') throw new Error('Compute bridge handshake refused');
      ready = true; clearTimeout(deadline); resolveReady(); return;
    }
    const response = computeBridgeResponseSchema.parse(value), call = pending.get(response.id);
    if (!call) throw new Error('Unknown compute response');
    pending.delete(response.id); clearTimeout(call.timer);
    if (response.ok) call.resolve(response.value); else call.reject(new Error(response.error));
  });
  await established;
  return { close, send: (call: ComputeBridgeCall): Promise<unknown> => {
    if (closed || pending.size >= 34) return Promise.reject(new Error('Compute bridge unavailable'));
    const request = computeBridgeRequestSchema.parse({ id: ++id, call });
    return new Promise((resolve, reject) => {
      const timeout = call.channel === 'tools' && call.command.method === 'invoke'
        ? workerCallTimeoutMs(call.command.name, call.command.args, 120_000) : call.channel === 'retrieval' && call.command.method === 'prepare' ? 30 * 60_000 : 120_000;
      const timer = setTimeout(close, timeout); timer.unref();
      pending.set(id, { resolve, reject, timer });
      try { write(socket, request); } catch { close(); }
    });
  } };
}
