import WebSocket, { type RawData } from 'ws';
import { computeHelloSchema, computeClientFrameSchema, computeExecutionSchema, COMPUTE_FRAME_BYTES,
  type ComputeExecution, type ComputeServerFrame } from '../contracts/computeProtocol.js';
import { workspaceCommandSchema, type WorkspaceCommand, type WorkspaceReply } from '../contracts/workspaceProtocol.js';
import type { ComputeSession } from '../contracts/computeDevice.js';
import type { ComputeDeviceStore } from './computeDevices.js';

/** A lost response is never permission to retry a workspace mutation. */
export class ComputeIndeterminateError extends Error {
  constructor() { super('Compute operation indeterminate; stop reconciliation required'); }
}

/** One authenticated socket generation. The caller must supply a TLS-protected
 * socket with compression disabled and maxPayload=COMPUTE_FRAME_BYTES.
 * No public endpoint or coordinator admission is enabled by this module. */
export class ComputeConnection {
  private session?: ComputeSession;
  private credential = '';
  private heartbeatId = 0;
  private next = 0;
  private execution?: ComputeExecution;
  private closed = false;
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly helloDeadline: ReturnType<typeof setTimeout>;
  private pending?: {
    id: number; execution: ComputeExecution; method: WorkspaceCommand['method'];
    resolve: (reply: WorkspaceReply) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  constructor(private readonly socket: WebSocket, private readonly devices: ComputeDeviceStore,
    private readonly timeoutMs = 120_000) {
    this.helloDeadline = setTimeout(() => this.close(), 5000);
    this.helloDeadline.unref();
    this.watchdog = setInterval(() => {
      if (!this.session) return;
      try { this.validate(); } catch { this.close(); }
    }, 1000);
    this.watchdog.unref();
    socket.on('message', (data, binary) => this.receive(data, binary));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }
  private validate(): void {
    if (!this.session) throw new Error('Compute transport unavailable');
    this.devices.validateSession(this.session);
    if (this.execution) this.devices.authorizeOperation(this.session, this.execution.runId, this.execution.generation);
  }
  identity(): ComputeSession | undefined { return this.session && !this.closed ? { ...this.session } : undefined; }
  private send(frame: ComputeServerFrame): void {
    const text = JSON.stringify(frame);
    if (this.closed || this.socket.readyState !== WebSocket.OPEN ||
      Buffer.byteLength(text) > COMPUTE_FRAME_BYTES || this.socket.bufferedAmount > COMPUTE_FRAME_BYTES) {
      throw new Error('Compute transport unavailable');
    }
    this.socket.send(text, error => { if (error) this.close(); });
  }
  private receive(data: RawData, binary: boolean): void {
    if (this.closed) return;
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (binary || bytes.length > (this.session ? COMPUTE_FRAME_BYTES : 4096)) throw new Error('Invalid frame');
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!this.session) {
        const hello = computeHelloSchema.parse(parsed);
        this.session = this.devices.connect(hello.credential, hello.capabilities).session;
        this.credential = hello.credential;
        clearTimeout(this.helloDeadline);
        this.send({ kind: 'ready', version: 1, session: this.session });
        return;
      }
      this.validate();
      const frame = computeClientFrameSchema.parse(parsed);
      if (frame.kind === 'heartbeat') {
        if (frame.id <= this.heartbeatId) throw new Error('Replayed heartbeat');
        this.devices.heartbeat(this.credential, this.session);
        this.heartbeatId = frame.id;
        this.send({ kind: 'heartbeat', id: frame.id });
        return;
      }
      const pending = this.pending;
      if (!pending || frame.response.id !== pending.id || frame.execution.runId !== pending.execution.runId ||
        frame.execution.generation !== pending.execution.generation) throw new Error('Unexpected result');
      this.devices.authorizeOperation(this.session, pending.execution.runId, pending.execution.generation);
      if (frame.response.ok && frame.response.reply.method !== pending.method) throw new Error('Mismatched result');
      clearTimeout(pending.timer);
      this.pending = undefined;
      if (frame.response.ok) pending.resolve(frame.response.reply);
      else pending.reject(new Error('Remote workspace operation failed'));
    } catch { this.close(); }
  }
  /** Single flight also serializes privileged workspace imports and guards.
   * Busy callers are refused before dispatch, never buffered for later replay. */
  request(execution: ComputeExecution, input: WorkspaceCommand): Promise<WorkspaceReply> {
    try {
      const command = workspaceCommandSchema.parse(input), target = computeExecutionSchema.parse(execution);
      if (this.closed || !this.session) throw new Error('Compute transport unavailable');
      if (this.pending) throw new Error('Compute workspace busy');
      this.devices.authorizeOperation(this.session, target.runId, target.generation);
      // Check size before dispatch: a local oversized request has no remote effect.
      const frame = { kind: 'workspace-command' as const, id: ++this.next, execution: target, command };
      if (Buffer.byteLength(JSON.stringify(frame)) > COMPUTE_FRAME_BYTES) throw new Error('Compute frame too large');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.close(), this.timeoutMs);
        timer.unref();
        this.execution = target;
        this.pending = { id: frame.id, execution: target, method: command.method, resolve, reject, timer };
        try { this.send(frame); } catch { this.close(); }
      });
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('Compute request failed')); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloDeadline); clearInterval(this.watchdog);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new ComputeIndeterminateError());
      this.pending = undefined;
    }
    try { if (this.session) this.devices.disconnect(this.session); }
    catch {
      // A failed database write cannot keep the socket alive. Its persisted
      // lease still expires; no stop or slot release is inferred here.
    }
    this.credential = '';
    this.socket.terminate();
  }
}
