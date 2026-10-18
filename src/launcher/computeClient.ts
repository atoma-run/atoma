import { ComputeBandwidth } from './computeBandwidth.js';
import { computePreviewReplySchema, type ComputePreviewIdentity, type ComputePreviewCommand } from '../contracts/computePreview.js';
import { computeRetrievalReplySchema, type ComputeRetrievalCommand } from '../contracts/computeRetrieval.js';
import type { ToolExecutor } from '../core/types.js';
import WebSocket from 'ws';
import { ComputeLease } from './computeLease.js';
import { COMPUTE_FRAME_BYTES, computeExecutionSchema, computeHelloSchema, computeServerFrameSchema,
  type ComputeExecution, type ComputeControl } from '../contracts/computeProtocol.js';
import type { ComputeCapabilities, ComputeSession } from '../contracts/computeDevice.js';
import { workspaceReplySchema, type WorkspaceCommand, type WorkspaceReply } from '../contracts/workspaceProtocol.js';

/** Outbound, one-generation workspace channel. The trusted launcher binds the
 * execution and private handler before connecting; the wire cannot choose a
 * filesystem root or engine profile. Reconnection requires a new client. */
export interface ComputeLocalExecution {
  retrieval?: (command: ComputeRetrievalCommand) => Promise<unknown>;
  execute: (command: WorkspaceCommand) => Promise<WorkspaceReply>;
  tools?: ToolExecutor & { drain(): Promise<void> };
}
export async function connectComputeWorkspace(options: {
  url: string; machineId: string; credential: string; capabilities: ComputeCapabilities; execution?: ComputeExecution;
  reconcile?: (execution: ComputeExecution) => Promise<void>;
  assign?: (execution: ComputeExecution, recover?: ComputeExecution) => Promise<ComputeLocalExecution>;
  execute?: (command: WorkspaceCommand) => Promise<WorkspaceReply>;
  preview?: (identity: ComputePreviewIdentity, command: ComputePreviewCommand) => Promise<unknown>;
  stopWorkloads: () => Promise<void>;
  tools?: ToolExecutor & { drain(): Promise<void> };
  /** Optional deployment CA; certificate and hostname validation remain enabled. */
  ca?: string;
}) {
  const url = new URL(options.url);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/compute/v1') {
    throw new Error('Compute requires a configured WSS endpoint');
  }
  if (options.assign ? options.execution || options.execute || options.tools : !options.execution || !options.execute) {
    throw new Error('Compute requires either a fixed execution or an assignment handler');
  }
  let execution = options.execution ? computeExecutionSchema.parse(options.execution) : undefined;
  let local: ComputeLocalExecution | undefined = options.execute ? { execute: options.execute, tools: options.tools } : undefined;
  let assigning = false;
  let recovery: ComputeExecution | null = null, reconciling = false;
  const hello = computeHelloSchema.parse({ kind: 'hello', version: 1, machineId: options.machineId, credential: options.credential, capabilities: options.capabilities });
  const bandwidth = new ComputeBandwidth(), transferAbort = new AbortController();
  let allocation: Promise<void> | undefined;
  const lease = new ComputeLease(async () => { await allocation; await options.stopWorkloads(); });
  const socket = new WebSocket(url, { ca: options.ca, maxPayload: COMPUTE_FRAME_BYTES,
    perMessageDeflate: false, followRedirects: false, handshakeTimeout: 5000 });
  let retrievalBusy = false, activePreviews = 0;
  let activeTools = 0, draining = false, controlId = 0;
  let control: { id: number; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  let closed = false, busy = false, lastId = 0, session: ComputeSession | undefined;
  let resolveReady: (session: ComputeSession) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<ComputeSession>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveFinished!: (confirmed: boolean) => void;
  const finished = new Promise<boolean>(resolve => { resolveFinished = resolve; });
  const close = () => {
    if (!closed) {
      closed = true; transferAbort.abort(); clearInterval(heartbeat); clearTimeout(deadline);
      if (control) { clearTimeout(control.timer); control.reject(new Error('Compute control indeterminate')); control = undefined; }
      socket.terminate(); rejectReady(new Error('Compute connection lost; reconciliation required'));
    }
    return lease.stop().then(confirmed => { resolveFinished(confirmed); return confirmed; });
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
        session = frame.session; recovery = frame.recovery; beat(); return;
      }
      if (!session) throw new Error('Missing handshake');
      if (frame.kind === 'heartbeat') {
        if (!lease.acknowledge(frame.id)) throw new Error('Invalid heartbeat');
        clearTimeout(deadline);
        if (!recovery) resolveReady(session);
        else if (!reconciling) {
          if (!options.reconcile) throw new Error('Compute reconciliation required');
          reconciling = true;
          const target = recovery;
          allocation = (async () => {
            try {
              await options.reconcile!(target); lease.assertActive();
              send({ kind: 'stopped', id: 1, execution: target });
            } catch { void close(); }
          })();
        }
        return;
      }
      lease.assertActive();
      if (frame.kind === 'machine-result') {
        if (!control || control.id !== frame.id) throw new Error('Unexpected compute control response');
        const pending = control; control = undefined; clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(); else pending.reject(new Error('Compute control unavailable for this run')); return;
      }
      if (frame.kind === 'reconciled') {
        if (!recovery || !reconciling || frame.id !== 1 || frame.execution.runId !== recovery.runId ||
          frame.execution.generation !== recovery.generation) throw new Error('Unexpected reconciliation');
        recovery = null; resolveReady(session); return;
      }
      if (recovery) throw new Error('Compute reconciliation pending');
      if (frame.id <= lastId) throw new Error('Replayed compute request');
      lastId = frame.id;
      if (frame.kind === 'assign') {
        if (execution || assigning || !options.assign) throw new Error('Compute assignment unavailable');
        if (frame.recover && (frame.recover.runId !== frame.execution.runId || frame.recover.generation >= frame.execution.generation)) throw new Error('Invalid recovery generation');
        assigning = true;
        allocation = (async () => {
          try {
            const bound = await (frame.recover ? options.assign!(frame.execution, frame.recover) : options.assign!(frame.execution));
            if (closed) throw new Error('Assignment cancelled');
            lease.assertActive();
            execution = frame.execution; local = bound;
            send({ kind: 'assigned', id: frame.id, execution });
          } catch { void close(); }
        })();
        return;
      }
      if (frame.kind === 'preview-command') {
        if (!options.preview || activePreviews >= 20) throw new Error('Compute preview unavailable');
        activePreviews++;
        void (async () => {
          try {
            const reply = computePreviewReplySchema.parse(await options.preview!(frame.identity, frame.command));
            if (reply.method !== frame.command.method) throw new Error('Compute preview reply mismatch');
            lease.assertActive();
            send({ kind: 'preview-result', identity: frame.identity, response: { id: frame.id, ok: true, reply } });
          } catch {
            try { lease.assertActive(); send({ kind: 'preview-result', identity: frame.identity, response: { id: frame.id, ok: false, error: 'preview-unavailable' } }); }
            catch { void close(); }
          } finally { activePreviews--; }
        })();
        return;
      }
      if (!execution || !local || frame.execution.runId !== execution.runId || frame.execution.generation !== execution.generation) {
        throw new Error('Unbound workspace request');
      }
      if (frame.kind === 'retrieval-command') {
        if (!local.retrieval || retrievalBusy) throw new Error('Compute retrieval unavailable or busy');
        retrievalBusy = true;
        const retrieve = local.retrieval;
        void (async () => {
          try {
            if (frame.command.method === 'upload' && frame.command.frame.kind === 'chunk') {
              await bandwidth.consume(Buffer.byteLength(frame.command.frame.data, 'base64'), transferAbort.signal);
            }
            lease.assertActive();
            const reply = computeRetrievalReplySchema.parse(await retrieve(frame.command));
            if (reply.method !== frame.command.method) throw new Error('Compute retrieval reply mismatch');
            lease.assertActive();
            send({ kind: 'retrieval-result', execution, response: { id: frame.id, ok: true, reply } });
          } catch {
            try { lease.assertActive(); send({ kind: 'retrieval-result', execution, response: { id: frame.id, ok: false, error: 'retrieval-unavailable' } }); }
            catch { void close(); }
          } finally { retrievalBusy = false; }
        })();
        return;
      }
      if (frame.kind === 'tool-command') {
        const tools = local.tools;
        if (!tools || draining || (frame.command.method !== 'drain' && activeTools >= 32)) throw new Error('Tool channel unavailable');
        if (frame.command.method === 'drain') draining = true;
        activeTools++;
        void (async () => {
          try {
            lease.assertActive();
            const command = frame.command;
            let result: unknown = null;
            if (command.method === 'drain') await tools.drain();
            else {
              if (!tools.has(command.name)) throw new Error('Tool unavailable');
              result = await tools.execute(command.name, command.args);
            }
            lease.assertActive();
            send({ kind: 'tool-result', execution, response: { id: frame.id, ok: true, result } });
          } catch (error) {
            if (frame.command.method === 'drain') { void close(); return; }
            try {
              lease.assertActive();
              send({ kind: 'tool-result', execution, response: { id: frame.id, ok: false,
                error: error instanceof Error ? error.message.slice(0, 8192) : 'Tool failed' } });
            } catch { void close(); }
          } finally { activeTools--; if (frame.command.method === 'drain') draining = false; }
        })();
        return;
      }
      if (busy) throw new Error('Workspace channel busy');
      busy = true;
      void (async () => {
        // An already-dispatched operation may finish after disconnect. Its
        // result is discarded; engine teardown, not this promise, proves stop.
        try {
          lease.assertActive();
          if (frame.command.method === 'import-frame' && frame.command.frame.kind === 'chunk') {
            await bandwidth.consume(Buffer.byteLength(frame.command.frame.data, 'base64'), transferAbort.signal);
            lease.assertActive();
          }
          const reply = workspaceReplySchema.parse(await local.execute(frame.command));
          if (reply.method === 'checkpoint-next' && reply.value.kind === 'chunk') {
            await bandwidth.consume(Buffer.byteLength(reply.value.data, 'base64'), transferAbort.signal);
          }
          if (reply.method !== frame.command.method) throw new Error('Mismatched workspace result');
          lease.assertActive();
          send({ kind: 'workspace-result', execution, response: { id: frame.id, ok: true, reply } });
        } catch { void close(); }
        finally { busy = false; }
      })();
    } catch { void close(); }
  });
  const identity = await ready;
  const requestControl = (action: 'pause' | 'stop' | 'accepting', value?: boolean): Promise<void> => {
    if (closed || control || (action !== 'accepting' && !execution)) return Promise.reject(new Error('Compute control unavailable'));
    const command: ComputeControl = action === 'accepting' ? { action, value: value === true } : { action, execution: execution! };
    return new Promise((resolve, reject) => {
      const id = ++controlId, timer = setTimeout(() => { void close(); }, 10_000); timer.unref();
      control = { id, resolve, reject, timer };
      try { lease.assertActive(); send({ kind: 'machine-control', id, command }); } catch { void close(); }
    });
  };
  return { session: identity, close, finished, requestControl, state: () => lease.state() };
}
