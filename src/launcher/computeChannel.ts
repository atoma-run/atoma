import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import { computeServerFrameSchema, COMPUTE_FRAME_BYTES } from '../contracts/computeProtocol.js';
import { COMPUTE_RESUME_PROTOCOL, COMPUTE_TRANSPORT_BYTES, COMPUTE_TRANSPORT_QUEUE_BYTES,
  COMPUTE_TRANSPORT_QUEUE_FRAMES, computeTransportFrameSchema, type ComputeResume } from '../contracts/computeTransport.js';
import type { ComputeSession } from '../contracts/computeDevice.js';

type Events = {
  open: []; message: [RawData, boolean]; error: [Error]; close: [number, Buffer];
  interrupted: []; resumed: [];
};
/** The application sees one channel for one lease. Transport retransmission is
 * deduplicated before application dispatch, including while a command awaits.
 * No channel state survives a process restart or a terminal lease close. */
export class ComputeChannel extends EventEmitter<Events> {
  private socket?: WebSocket;
  private closed = false;
  private sent = 0;
  private received = 0;
  private acknowledged = 0;
  private transmitted = 0;
  private writing?: WebSocket;
  private bytes = 0;
  private readonly pending = new Map<number, { body: Record<string, unknown>; bytes: number }>();
  private secret?: string;
  private session?: ComputeSession;
  private epoch = 0;
  private candidate?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private candidateDeadline?: ReturnType<typeof setTimeout>;
  private retryDelay = 250;
  private client?: { url: URL; ca?: string; credential: string; machineId: string; assertActive(): void };

  constructor(socket: WebSocket, private readonly side: 'client' | 'server') {
    super();
    if (side === 'server') this.secret = randomBytes(32).toString('base64url');
    this.bind(socket);
  }
  static connect(options: NonNullable<ComputeChannel['client']>): ComputeChannel {
    const socket = new WebSocket(options.url, COMPUTE_RESUME_PROTOCOL, { ca: options.ca,
      maxPayload: COMPUTE_TRANSPORT_BYTES, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 5000 });
    const channel = new ComputeChannel(socket, 'client');
    channel.client = options;
    return channel;
  }
  /** Gateway-only lookup capability, never persisted or logged. */
  token(): string | undefined { return this.secret; }
  get readyState(): number {
    if (this.closed) return WebSocket.CLOSED;
    return this.secret ? WebSocket.OPEN : (this.socket?.readyState ?? WebSocket.CLOSED);
  }
  get bufferedAmount(): number { return this.socket?.bufferedAmount ?? 0; }
  private bind(socket: WebSocket): void {
    const previous = this.socket;
    this.socket = socket; this.transmitted = this.acknowledged; this.writing = undefined;
    if (previous && previous !== socket) previous.terminate();
    socket.on('open', () => { if (this.socket === socket && !this.closed) this.emit('open'); });
    socket.on('message', (data, binary) => {
      if (this.socket !== socket || this.closed) return;
      try { this.receive(data, binary); } catch { this.fail(); }
    });
    socket.on('error', error => {
      if (this.socket !== socket || this.closed) return;
      if (this.secret) this.interrupt();
      else { this.emit('error', error); this.terminate(); }
    });
    socket.on('close', (code, reason) => {
      if (this.socket !== socket || this.closed) return;
      if (this.secret) this.interrupt();
      else this.finish(code, reason);
    });
  }
  private receive(data: RawData, binary: boolean): void {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (binary || bytes.length > COMPUTE_TRANSPORT_BYTES) throw new Error('Invalid transport frame');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!this.secret) {
      const open = computeTransportFrameSchema.safeParse(value);
      if (!open.success || open.data.kind !== 'channel-open') {
        // No negotiation by subprotocol echo alone: older ws servers echo it too.
        this.emit('message', bytes, false); return;
      }
      const ready = computeServerFrameSchema.parse(open.data.body);
      if (ready.kind !== 'ready' || open.data.seq !== 1 || open.data.ack !== 0) throw new Error('Invalid transport handshake');
      this.secret = open.data.token; this.session = ready.session;
    }
    const frame = computeTransportFrameSchema.parse(value);
    if (frame.kind === 'channel-close') { this.finish(1000, Buffer.alloc(0)); return; }
    if (frame.kind === 'channel-resumed') throw new Error('Unexpected resume');
    if (frame.kind === 'channel-open' && (this.side !== 'client' || this.received !== 0)) throw new Error('Repeated open');
    this.acknowledge(frame.ack);
    if (frame.kind === 'channel-ack') return;
    if (frame.seq <= this.received) { this.ack(); return; }
    if (frame.seq !== this.received + 1) throw new Error('Transport sequence gap');
    const text = JSON.stringify(frame.body);
    if (Buffer.byteLength(text) > COMPUTE_FRAME_BYTES) throw new Error('Oversize application frame');
    // Receipt, not completion: fence duplicates before invoking async handlers.
    this.received = frame.seq;
    this.emit('message', Buffer.from(text), false);
    this.ack();
  }
  private acknowledge(ack: number): void {
    if (ack < this.acknowledged || ack > this.sent) throw new Error('Invalid transport acknowledgement');
    this.acknowledged = ack;
    for (const [seq, frame] of this.pending) if (seq <= ack) { this.bytes -= frame.bytes; this.pending.delete(seq); }
  }
  private write(value: unknown, done?: () => void): void {
    const socket = this.socket;
    if (!socket || this.closed) return;
    if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > COMPUTE_TRANSPORT_BYTES) { this.interrupt(); return; }
    socket.send(JSON.stringify(value), error => {
      if (this.socket !== socket || this.closed) return;
      if (error) this.interrupt(); else done?.();
    });
  }
  private ack(): void { this.write({ kind: 'channel-ack', ack: this.received }); }
  private flush(): void {
    const socket = this.socket;
    if (!socket || this.closed || this.writing === socket) return;
    const next = [...this.pending].find(([seq]) => seq > this.transmitted);
    if (!next) return;
    const [seq, frame] = next;
    this.transmitted = seq; this.writing = socket;
    const value = this.side === 'server' && seq === 1 && this.epoch === 0
      ? { kind: 'channel-open', token: this.secret, seq, ack: this.received, body: frame.body }
      : { kind: 'channel-data', seq, ack: this.received, body: frame.body };
    // One application frame at a time into TCP. A reconnect backlog must not
    // overflow the socket merely because its retained queue is larger than it.
    this.write(value, () => { this.writing = undefined; this.flush(); });
  }
  send(text: string, callback?: (error?: Error) => void): void {
    try {
      if (this.closed) throw new Error('Compute channel closed');
      if (!this.secret) { this.socket!.send(text, callback); return; }
      const bytes = Buffer.byteLength(text);
      if (bytes > COMPUTE_FRAME_BYTES || this.bytes + bytes > COMPUTE_TRANSPORT_QUEUE_BYTES ||
          this.pending.size >= COMPUTE_TRANSPORT_QUEUE_FRAMES || this.sent === Number.MAX_SAFE_INTEGER) throw new Error('Compute transport capacity exceeded');
      const body = JSON.parse(text) as Record<string, unknown>, seq = ++this.sent;
      this.pending.set(seq, { body, bytes }); this.bytes += bytes;
      this.flush();
      callback?.();
    } catch { this.fail(); callback?.(new Error('Compute channel unavailable')); }
  }
  /** Authentication and live-lease checks belong to the gateway/connection. */
  resume(socket: WebSocket, request: ComputeResume): void {
    if (this.closed || request.token !== this.secret || request.epoch <= this.epoch ||
        request.received < this.acknowledged || request.received > this.sent) throw new Error('Compute resume unavailable');
    this.acknowledge(request.received); this.epoch = request.epoch;
    this.bind(socket);
    this.write({ kind: 'channel-resumed', token: this.secret, epoch: this.epoch, received: this.received });
    this.flush(); this.emit('resumed');
  }
  /** Also called after two missing heartbeat replies, for silent stale TCP. */
  reconnect(): void {
    if (!this.client || !this.secret || !this.session || this.closed || this.candidate || this.retry) return;
    this.interrupt();
  }
  private interrupt(): void {
    const socket = this.socket; this.socket = undefined;
    socket?.terminate();
    if (socket) this.emit('interrupted');
    if (!this.client || !this.session || this.closed || this.retry || this.candidate) return;
    this.retry = setTimeout(() => {
      this.retry = undefined; this.dial();
    }, this.retryDelay);
    this.retry.unref();
    this.retryDelay = Math.min(2000, this.retryDelay * 2);
  }
  private dial(): void {
    const client = this.client;
    if (!client || !this.session || !this.secret || this.closed) return;
    try { client.assertActive(); } catch { this.terminate(); return; }
    const epoch = ++this.epoch;
    const candidate = new WebSocket(client.url, COMPUTE_RESUME_PROTOCOL, { ca: client.ca,
      maxPayload: COMPUTE_TRANSPORT_BYTES, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 5000 });
    this.candidate = candidate;
    const failed = () => {
      if (this.candidate !== candidate) return;
      this.candidate = undefined; clearTimeout(this.candidateDeadline);
      candidate.terminate(); this.interrupt();
    };
    this.candidateDeadline = setTimeout(failed, 5000); this.candidateDeadline.unref();
    candidate.on('error', failed); candidate.on('close', failed);
    candidate.once('open', () => {
      if (this.candidate !== candidate || this.closed) return;
      const request: ComputeResume = { kind: 'channel-resume', token: this.secret!, epoch,
        received: this.received, credential: client.credential, machineId: client.machineId, session: this.session! };
      candidate.send(JSON.stringify(request), error => { if (error) failed(); });
    });
    candidate.once('message', (data, binary) => {
      if (this.candidate !== candidate || this.closed) return;
      try {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (binary || bytes.length > 4096) throw new Error('Invalid resume');
        const frame = computeTransportFrameSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        if (frame.kind !== 'channel-resumed' || frame.token !== this.secret || frame.epoch !== epoch) throw new Error('Invalid resume');
        client.assertActive(); this.acknowledge(frame.received);
        this.candidate = undefined; clearTimeout(this.candidateDeadline); this.retryDelay = 250;
        this.bind(candidate); this.flush(); this.emit('resumed');
      } catch { failed(); }
    });
  }
  private fail(): void { this.finish(1002, Buffer.alloc(0)); }
  private finish(code: number, reason: Buffer, graceful = false): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retry); clearTimeout(this.candidateDeadline);
    const socket = this.socket, candidate = this.candidate;
    this.socket = undefined; this.candidate = undefined;
    if (graceful && socket?.readyState === WebSocket.OPEN) {
      // Flush the explicit terminal frame before TCP teardown. An abrupt close
      // here would look like another network migration to the remote peer.
      socket.close(1000);
      const deadline = setTimeout(() => socket.terminate(), 1000); deadline.unref();
      socket.once('close', () => clearTimeout(deadline));
    } else socket?.terminate();
    candidate?.terminate();
    this.pending.clear(); this.bytes = 0; this.secret = undefined; this.session = undefined; this.client = undefined;
    this.emit('close', code, reason);
  }
  terminate(): void {
    if (this.secret) this.write({ kind: 'channel-close' });
    this.finish(1000, Buffer.alloc(0), true);
  }
}

/** Structural boundary shared with legacy raw WebSockets. */
export type ComputeSocket = Pick<ComputeChannel, 'readyState' | 'bufferedAmount' | 'send' | 'terminate'> & {
  on(event: 'message', listener: (data: RawData, binary: boolean) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
};
