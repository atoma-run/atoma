import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { recordComputeDiagnostic, computeErrorCode, computeFailure, type ComputeCloseReason, type ComputeDiagnostic } from '../contracts/computeDiagnostics.js';
import { computePreviewCommandSchema, computePreviewIdentitySchema, type ComputePreviewIdentity, type ComputePreviewCommand, type ComputePreviewReply } from '../contracts/computePreview.js';
import { computeRetrievalCommandSchema, type ComputeRetrievalCommand, type ComputeRetrievalReply } from '../contracts/computeRetrieval.js';
import { computeToolCommandSchema, type ComputeToolCommand } from '../contracts/computeTools.js';
import { workerCallTimeoutMs } from '../contracts/commandTimeouts.js';
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
export type ComputeRunControl = (orgId: string, execution: ComputeExecution, action: 'pause' | 'stop') => void | Promise<void>;
export class ComputeConnection {
  private readonly connectionId = randomUUID();
  private readonly openedAt = performance.now();
  private lastReceiveAt = this.openedAt;
  private lastHeartbeatAt?: number;
  private session?: ComputeSession;
  private credential = '';
  private heartbeatId = 0;
  private controlId = 0;
  private controlling = false;
  private next = 0;
  private execution?: ComputeExecution;
  private recovery?: ComputeExecution;
  private drainingTools = false;
  private closed = false;
  private readonly interruption = new AbortController();
  get signal(): AbortSignal { return this.interruption.signal; }
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly helloDeadline: ReturnType<typeof setTimeout>;
  private readonly tools = new Map<number, { method: ComputeToolCommand['method']; execution: ComputeExecution; resolve: (result: unknown) => void; reject: (error: Error) => void; startedAt: number; timer: ReturnType<typeof setTimeout> }>();
  private previewIdentity?: ComputePreviewIdentity;
  private readonly previews = new Map<number, { identity: ComputePreviewIdentity; method: ComputePreviewCommand['method'];
    resolve(value: ComputePreviewReply): void; reject(error: Error): void; startedAt: number; timer: ReturnType<typeof setTimeout> }>();
  private retrieval?: { id: number; execution: ComputeExecution; method: ComputeRetrievalCommand['method'];
    resolve(value: ComputeRetrievalReply): void; reject(error: Error): void; startedAt: number; timer: ReturnType<typeof setTimeout> };
  private binding?: { id: number; resolve(): void; reject(error: Error): void; startedAt: number; timer: ReturnType<typeof setTimeout> };
  private pending?: {
    id: number; execution: ComputeExecution; method: WorkspaceCommand['method'];
    resolve: (reply: WorkspaceReply) => void; reject: (error: Error) => void;
    startedAt: number; timer: ReturnType<typeof setTimeout>;
  };

  constructor(private readonly socket: WebSocket, private readonly devices: ComputeDeviceStore,
    private readonly timeoutMs = 120_000, private readonly control?: ComputeRunControl,
    private readonly connected?: (session: ComputeSession) => void) {
    this.helloDeadline = setTimeout(() => this.close('handshake-timeout'), 5000);
    this.helloDeadline.unref();
    this.watchdog = setInterval(() => {
      if (!this.session) return;
      try { this.validate(); } catch (error) { this.close('session-invalid', { failure: computeFailure(error), errorCode: computeErrorCode(error) }); }
    }, 1000);
    this.watchdog.unref();
    socket.on('message', (data, binary) => this.receive(data, binary));
    socket.on('error', error => this.close('socket-error', { errorCode: computeErrorCode(error) }));
    socket.on('close', (code, reason) => this.close('socket-close', { closeCode: code, closeReasonBytes: reason.length }));
  }
  private validate(): void {
    if (!this.session) throw new Error('Compute transport unavailable');
    this.devices.validateSession(this.session);
    if (this.previewIdentity) this.devices.authorizePreview(this.session, this.previewIdentity.runId);
    if (this.execution) this.devices.authorizeOperation(this.session, this.execution.runId, this.execution.generation);
  }
  identity(): ComputeSession | undefined { return this.session && !this.closed ? { ...this.session } : undefined; }
  executing(): boolean { return Boolean(this.execution); }
  private send(frame: ComputeServerFrame): void {
    const text = JSON.stringify(frame);
    if (this.closed || this.socket.readyState !== WebSocket.OPEN ||
      Buffer.byteLength(text) > COMPUTE_FRAME_BYTES || this.socket.bufferedAmount > COMPUTE_FRAME_BYTES) {
      throw new Error('Compute transport unavailable');
    }
    this.socket.send(text, error => { if (error) this.close('send-error', { errorCode: computeErrorCode(error) }); });
  }
  private receive(data: RawData, binary: boolean): void {
    if (this.closed) return;
    this.lastReceiveAt = performance.now();
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (binary || bytes.length > (this.session ? COMPUTE_FRAME_BYTES : 4096)) throw new Error('Invalid frame');
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!this.session) {
        const hello = computeHelloSchema.parse(parsed);
        this.devices.bindMachine(hello.credential, hello.machineId);
        const connected = this.devices.connect(hello.credential, hello.capabilities);
        this.session = connected.session;
        this.connected?.(this.session);
        this.recovery = connected.recovery ? { runId: connected.recovery.runId, generation: connected.recovery.generation } : undefined;
        this.credential = hello.credential;
        this.diagnostic('connected');
        clearTimeout(this.helloDeadline);
        this.send({ kind: 'ready', version: 1, session: this.session, recovery: this.recovery ?? null });
        return;
      }
      this.validate();
      const frame = computeClientFrameSchema.parse(parsed);
      if (frame.kind === 'machine-control') {
        if (this.controlling || frame.id <= this.controlId) throw new Error('Compute control busy or replayed');
        this.controlId = frame.id; this.controlling = true;
        const command = frame.command;
        void (async () => {
          let ok = false;
          try {
            if (command.action === 'accepting') this.devices.setAccepting(this.credential, this.session!, command.value);
            else {
              if (!this.control || command.execution.runId !== this.execution?.runId || command.execution.generation !== this.execution.generation) throw new Error('Compute control unavailable');
              const orgId = this.devices.executionOrganisation(this.session!, command.execution.runId, command.execution.generation);
              await this.control(orgId, command.execution, command.action);
            }
            ok = true;
          } catch { /* Bounded response; control details never cross organizations. */ }
          finally { this.controlling = false; }
          try { this.send({ kind: 'machine-result', id: frame.id, ok }); } catch (error) { this.close('send-error', { failure: computeFailure(error), errorCode: computeErrorCode(error) }); }
        })();
        return;
      }
      if (frame.kind === 'heartbeat') {
        if (frame.id <= this.heartbeatId) throw new Error('Replayed heartbeat');
        this.devices.heartbeat(this.credential, this.session);
        this.heartbeatId = frame.id;
        this.lastHeartbeatAt = performance.now();
        this.send({ kind: 'heartbeat', id: frame.id });
        return;
      }
      if (frame.kind === 'stopped') {
        if (!this.recovery || frame.execution.runId !== this.recovery.runId || frame.execution.generation !== this.recovery.generation) {
          throw new Error('Unexpected stop report');
        }
        this.devices.acknowledgeStopped(this.credential, this.session, frame.execution.runId, frame.execution.generation);
        this.recovery = undefined;
        this.send({ kind: 'reconciled', id: frame.id, execution: frame.execution }); return;
      }
      if (frame.kind === 'assigned') {
        const binding = this.binding;
        if (!binding || binding.id !== frame.id || frame.execution.runId !== this.execution?.runId ||
          frame.execution.generation !== this.execution.generation) throw new Error('Unexpected assignment');
        clearTimeout(binding.timer); this.binding = undefined; binding.resolve(); return;
      }
      if (frame.kind === 'preview-result') {
        const pending = this.previews.get(frame.response.id);
        if (!pending || JSON.stringify(frame.identity) !== JSON.stringify(pending.identity)) throw new Error('Unexpected preview result');
        this.devices.authorizePreview(this.session, pending.identity.runId);
        if (frame.response.ok && frame.response.reply.method !== pending.method) throw new Error('Mismatched preview result');
        clearTimeout(pending.timer); this.previews.delete(frame.response.id);
        if (frame.response.ok) {
          if (pending.method === 'stop') this.previewIdentity = undefined;
          pending.resolve(frame.response.reply);
        } else pending.reject(new Error('Compute preview unavailable'));
        return;
      }
      if (frame.kind === 'retrieval-result') {
        const pending = this.retrieval;
        if (!pending || frame.response.id !== pending.id || frame.execution.runId !== pending.execution.runId ||
          frame.execution.generation !== pending.execution.generation) throw new Error('Unexpected retrieval result');
        if (frame.response.ok && frame.response.reply.method !== pending.method) throw new Error('Mismatched retrieval result');
        clearTimeout(pending.timer); this.retrieval = undefined;
        if (frame.response.ok) pending.resolve(frame.response.reply); else pending.reject(new Error('Compute retrieval unavailable'));
        return;
      }
      if (frame.kind === 'tool-result') {
        const pending = this.tools.get(frame.response.id);
        if (!pending || frame.execution.runId !== pending.execution.runId || frame.execution.generation !== pending.execution.generation) {
          throw new Error('Unexpected tool result');
        }
        this.devices.authorizeOperation(this.session, pending.execution.runId, pending.execution.generation);
        clearTimeout(pending.timer); this.tools.delete(frame.response.id);
        if (pending.method === 'drain') this.drainingTools = false;
        if (frame.response.ok) pending.resolve(frame.response.result);
        else pending.reject(new Error(frame.response.error));
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
    } catch (error) { this.close('invalid-frame', { failure: computeFailure(error), errorCode: computeErrorCode(error) }); }
  }
  /** Reserve through the store first, then bind the issued generation locally.
   * Failed or lost acknowledgement retains the assignment as indeterminate. */
  bind(execution: ComputeExecution, recover?: ComputeExecution): Promise<void> {
    try {
      const target = computeExecutionSchema.parse(execution);
      if (recover && (computeExecutionSchema.parse(recover).runId !== target.runId || recover.generation >= target.generation)) throw new Error('Invalid recovery generation');
      if (this.closed || !this.session || this.execution || this.pending || this.tools.size) throw new Error('Compute assignment unavailable');
      this.devices.authorizeOperation(this.session, target.runId, target.generation);
      this.execution = target;
      return new Promise((resolve, reject) => {
        const id = ++this.next, timer = setTimeout(() => this.close('assignment-timeout'), this.timeoutMs);
        timer.unref(); this.binding = { id, resolve, reject, startedAt: performance.now(), timer };
        try { this.send({ kind: 'assign', id, execution: target, ...(recover ? { recover } : {}) }); } catch (error) { this.close('send-error', { failure: computeFailure(error), errorCode: computeErrorCode(error) }); }
      });
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('Compute assignment failed')); }
  }
  /** Single flight also serializes privileged workspace imports and guards.
   * Busy callers are refused before dispatch, never buffered for later replay. */
  request(execution: ComputeExecution, input: WorkspaceCommand): Promise<WorkspaceReply> {
    try {
      const command = workspaceCommandSchema.parse(input), target = computeExecutionSchema.parse(execution);
      if (this.closed || !this.session || this.binding) throw new Error('Compute transport unavailable');
      if (this.pending) throw new Error('Compute workspace busy');
      this.devices.authorizeOperation(this.session, target.runId, target.generation);
      // Check size before dispatch: a local oversized request has no remote effect.
      const frame = { kind: 'workspace-command' as const, id: ++this.next, execution: target, command };
      if (Buffer.byteLength(JSON.stringify(frame)) > COMPUTE_FRAME_BYTES) throw new Error('Compute frame too large');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.close('workspace-timeout'), this.timeoutMs);
        timer.unref();
        this.execution = target;
        this.pending = { id: frame.id, execution: target, method: command.method, resolve, reject, startedAt: performance.now(), timer };
        try { this.send(frame); } catch (error) { this.close('send-error', { failure: computeFailure(error), errorCode: computeErrorCode(error) }); }
      });
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('Compute request failed')); }
  }
  requestPreview(input: ComputePreviewIdentity, commandInput: ComputePreviewCommand): Promise<ComputePreviewReply> {
    try {
      const identity = computePreviewIdentitySchema.parse(input), command = computePreviewCommandSchema.parse(commandInput);
      if (this.closed || !this.session || this.previews.size >= 20) throw new Error('Compute preview unavailable');
      this.devices.authorizePreview(this.session, identity.runId);
      if (command.method === 'start') {
        if (this.previewIdentity) throw new Error('Compute preview busy');
        this.previewIdentity = identity;
      } else if (JSON.stringify(this.previewIdentity) !== JSON.stringify(identity)) throw new Error('Compute preview generation unavailable');
      const frame = { kind: 'preview-command' as const, id: ++this.next, identity, command };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.close('preview-timeout'), this.timeoutMs); timer.unref();
        this.previews.set(frame.id, { identity, method: command.method, resolve, reject, startedAt: performance.now(), timer });
        try { this.send(frame); } catch (error) { this.close('send-error', { failure: computeFailure(error), errorCode: computeErrorCode(error) }); }
      });
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('Compute preview request failed')); }
  }
  requestRetrieval(execution: ComputeExecution, input: ComputeRetrievalCommand): Promise<ComputeRetrievalReply> {
    try {
      const command = computeRetrievalCommandSchema.parse(input), target = computeExecutionSchema.parse(execution);
      if (this.closed || !this.session || this.binding || this.retrieval) throw new Error('Compute retrieval unavailable or busy');
      this.devices.authorizeOperation(this.session, target.runId, target.generation);
      const frame = { kind: 'retrieval-command' as const, id: ++this.next, execution: target, command };
      if (Buffer.byteLength(JSON.stringify(frame)) > COMPUTE_FRAME_BYTES) throw new Error('Compute frame too large');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.close('retrieval-timeout'), command.method === 'prepare' ? 30 * 60_000 : this.timeoutMs);
        timer.unref(); this.retrieval = { id: frame.id, execution: target, method: command.method, resolve, reject, startedAt: performance.now(), timer };
        try { this.send(frame); } catch (error) { this.close('send-error', { failure: computeFailure(error), errorCode: computeErrorCode(error) }); }
      });
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('Compute retrieval request failed')); }
  }
  requestTool(execution: ComputeExecution, input: ComputeToolCommand): Promise<unknown> {
    try {
      const command = computeToolCommandSchema.parse(input), target = computeExecutionSchema.parse(execution);
      if (this.closed || !this.session || this.binding) throw new Error('Compute transport unavailable');
      if (this.drainingTools || (command.method !== 'drain' && this.tools.size >= 32)) throw new Error('Compute tool capacity exceeded');
      this.devices.authorizeOperation(this.session, target.runId, target.generation);
      const frame = { kind: 'tool-command' as const, id: ++this.next, execution: target, command };
      if (Buffer.byteLength(JSON.stringify(frame)) > COMPUTE_FRAME_BYTES) throw new Error('Compute frame too large');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.close('tool-timeout'), command.method === 'invoke'
          ? workerCallTimeoutMs(command.name, command.args, this.timeoutMs) : this.timeoutMs);
        timer.unref(); this.execution = target;
        this.drainingTools = command.method === 'drain';
        this.tools.set(frame.id, { method: command.method, execution: target, resolve, reject, startedAt: performance.now(), timer });
        try { this.send(frame); } catch (error) { this.close('send-error', { failure: computeFailure(error), errorCode: computeErrorCode(error) }); }
      });
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('Compute request failed')); }
  }
  private diagnostic(reason: ComputeCloseReason, extra: Pick<ComputeDiagnostic, 'errorCode' | 'closeCode' | 'closeReasonBytes' | 'failure'> = {}): void {
    const now = performance.now();
    const pending: ComputeDiagnostic['pending'] = [];
    if (this.binding) pending.push({ channel: 'assignment', id: this.binding.id, ageMs: now - this.binding.startedAt });
    if (this.pending) pending.push({ channel: 'workspace', id: this.pending.id, method: this.pending.method, ageMs: now - this.pending.startedAt });
    if (this.retrieval) pending.push({ channel: 'retrieval', id: this.retrieval.id, method: this.retrieval.method, ageMs: now - this.retrieval.startedAt });
    for (const [id, item] of this.tools) pending.push({ channel: 'tools', id, method: item.method, ageMs: now - item.startedAt });
    for (const [id, item] of this.previews) pending.push({ channel: 'preview', id, method: item.method, ageMs: now - item.startedAt });
    recordComputeDiagnostic({ at: new Date().toISOString(), side: 'server', reason, connectionId: this.connectionId,
      ...(this.session ? { deviceId: this.session.deviceId, sessionId: this.session.sessionId, connectionGeneration: this.session.generation } : {}),
      ...(this.execution ? { runId: this.execution.runId, executionGeneration: this.execution.generation } : {}),
      ageMs: now - this.openedAt, lastReceiveAgoMs: now - this.lastReceiveAt,
      lastHeartbeatAgoMs: this.lastHeartbeatAt === undefined ? null : now - this.lastHeartbeatAt,
      socketState: this.socket.readyState, bufferedBytes: this.socket.bufferedAmount, pending, ...extra });
  }
  close(reason: ComputeCloseReason = 'local-close', extra: Pick<ComputeDiagnostic, 'errorCode' | 'closeCode' | 'closeReasonBytes' | 'failure'> = {}): void {
    if (this.closed) return;
    this.closed = true;
    this.diagnostic(reason, extra);
    this.interruption.abort(new ComputeIndeterminateError());
    clearTimeout(this.helloDeadline); clearInterval(this.watchdog);
    for (const pending of this.tools.values()) { clearTimeout(pending.timer); pending.reject(new ComputeIndeterminateError()); }
    this.tools.clear();
    for (const pending of this.previews.values()) { clearTimeout(pending.timer); pending.reject(new ComputeIndeterminateError()); }
    this.previews.clear();
    if (this.retrieval) { clearTimeout(this.retrieval.timer); this.retrieval.reject(new ComputeIndeterminateError()); this.retrieval = undefined; }
    if (this.binding) { clearTimeout(this.binding.timer); this.binding.reject(new ComputeIndeterminateError()); this.binding = undefined; }
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
