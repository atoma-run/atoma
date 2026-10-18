import WebSocket from 'ws';
import { ComputeLease } from './computeLease.js';
import { COMPUTE_FRAME_BYTES, computeExecutionSchema, computeHelloSchema, computeServerFrameSchema,
  type ComputeExecution } from '../contracts/computeProtocol.js';
import type { ComputeCapabilities, ComputeSession } from '../contracts/computeDevice.js';
import { workspaceReplySchema, type WorkspaceCommand, type WorkspaceReply } from '../contracts/workspaceProtocol.js';

/** Outbound, one-generation workspace channel. The trusted launcher binds the
 * execution and private handler before connecting; the wire cannot choose a
 * filesystem root or engine profile. Reconnection requires a new client. */
export async function connectComputeWorkspace(options: {
  url: string; credential: string; capabilities: ComputeCapabilities; execution: ComputeExecution;
  execute: (command: WorkspaceCommand) => Promise<WorkspaceReply>;
  stopWorkloads: () => Promise<void>;
  /** Optional deployment CA; certificate and hostname validation remain enabled. */
  ca?: string;
}) {
  const url = new URL(options.url);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/compute/v1') {
    throw new Error('Compute requires a configured WSS endpoint');
  }
  const execution = computeExecutionSchema.parse(options.execution);
  const hello = computeHelloSchema.parse({ kind: 'hello', version: 1, credential: options.credential, capabilities: options.capabilities });
  const lease = new ComputeLease(options.stopWorkloads);
  const socket = new WebSocket(url, { ca: options.ca, maxPayload: COMPUTE_FRAME_BYTES,
    perMessageDeflate: false, followRedirects: false, handshakeTimeout: 5000 });
  let closed = false, busy = false, lastId = 0, session: ComputeSession | undefined;
  let resolveReady: (session: ComputeSession) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<ComputeSession>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const close = () => {
    if (!closed) {
      closed = true; clearInterval(heartbeat); clearTimeout(deadline);
      socket.terminate(); rejectReady(new Error('Compute connection lost; reconciliation required'));
    }
    return lease.stop();
  };
  const send = (frame: unknown) => {
    const text = JSON.stringify(frame);
    if (closed || socket.readyState !== WebSocket.OPEN || Buffer.byteLength(text) > COMPUTE_FRAME_BYTES || socket.bufferedAmount > COMPUTE_FRAME_BYTES) {
      throw new Error('Compute transport unavailable');
    }
    socket.send(text, error => { if (error) void close(); });
  };
  const beat = () => {
    try { send({ kind: 'heartbeat', id: lease.heartbeatSent() }); } catch { void close(); }
  };
  const heartbeat = setInterval(() => { if (session) beat(); }, 5000); heartbeat.unref();
  const deadline = setTimeout(() => { void close(); }, 5000); deadline.unref();
  socket.on('open', () => { try { send(hello); } catch { void close(); } });
  socket.on('error', () => { void close(); });
  socket.on('close', () => { void close(); });
  socket.on('message', (data, binary) => {
    if (closed) return;
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (binary || bytes.length > COMPUTE_FRAME_BYTES) throw new Error('Invalid frame');
      const frame = computeServerFrameSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (frame.kind === 'ready') {
        if (session) throw new Error('Repeated handshake');
        session = frame.session; beat(); return;
      }
      if (!session) throw new Error('Missing handshake');
      if (frame.kind === 'heartbeat') {
        if (!lease.acknowledge(frame.id)) throw new Error('Invalid heartbeat');
        clearTimeout(deadline); resolveReady(session); return;
      }
      lease.assertActive();
      if (busy || frame.id <= lastId || frame.execution.runId !== execution.runId || frame.execution.generation !== execution.generation) {
        throw new Error('Unbound workspace request');
      }
      busy = true; lastId = frame.id;
      void (async () => {
        // An already-dispatched operation may finish after disconnect. Its
        // result is discarded; engine teardown, not this promise, proves stop.
        try {
          lease.assertActive();
          const reply = workspaceReplySchema.parse(await options.execute(frame.command));
          if (reply.method !== frame.command.method) throw new Error('Mismatched workspace result');
          lease.assertActive();
          send({ kind: 'workspace-result', execution, response: { id: frame.id, ok: true, reply } });
        } catch { void close(); }
        finally { busy = false; }
      })();
    } catch { void close(); }
  });
  const identity = await ready;
  return { session: identity, close, state: () => lease.state() };
}
