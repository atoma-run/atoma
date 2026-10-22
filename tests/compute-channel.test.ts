import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ComputeChannel } from '../src/launcher/computeChannel.js';
import { COMPUTE_FRAME_BYTES } from '../src/contracts/computeProtocol.js';
import { COMPUTE_TRANSPORT_QUEUE_FRAMES, type ComputeResume } from '../src/contracts/computeTransport.js';

// Deterministic fault injection supplements the actual TLS/store/client tests
// in compute-connection. Late callbacks can be delivered after socket fencing.
class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  send(text: string, done?: (error?: Error) => void) { this.sent.push(text); done?.(); }
  terminate() { this.readyState = WebSocket.CLOSED; this.emit('close', 1006, Buffer.alloc(0)); }
  close() { this.terminate(); }
  frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  wire() { return this as unknown as WebSocket; }
}
function fixture() {
  const socket = new Socket(), channel = new ComputeChannel(socket.wire(), 'server');
  const delivered = vi.fn(), closed = vi.fn();
  channel.on('message', delivered); channel.on('close', closed);
  channel.send(JSON.stringify({ kind: 'ready' }));
  const request: ComputeResume = { kind: 'channel-resume', token: channel.token()!, received: 1, epoch: 1,
    credential: 'a'.repeat(43), machineId: randomUUID(), session: { deviceId: randomUUID(), sessionId: randomUUID(), generation: 1 } };
  return { socket, channel, delivered, closed, request };
}
it('deduplicates received commands while their asynchronous application work is still pending', () => {
  const f = fixture();
  const frame = { kind: 'channel-data', seq: 1, ack: 1, body: { kind: 'command' } };
  f.socket.frame(frame); f.socket.frame(frame);
  expect(f.delivered).toHaveBeenCalledOnce(); expect(f.closed).not.toHaveBeenCalled();
  f.channel.terminate();
});
it('fences old socket messages, errors and close callbacks after reattachment', () => {
  const f = fixture(), replacement = new Socket();
  f.channel.resume(replacement.wire(), f.request);
  f.socket.frame({ kind: 'channel-data', seq: 1, ack: 1, body: { stale: true } });
  f.socket.emit('error', new Error('late')); f.socket.terminate();
  expect(f.delivered).not.toHaveBeenCalled(); expect(f.closed).not.toHaveBeenCalled();
  replacement.frame({ kind: 'channel-data', seq: 1, ack: 1, body: { current: true } });
  expect(f.delivered).toHaveBeenCalledOnce(); f.channel.terminate();
});
it.each(['sequence-gap', 'future-ack', 'binary', 'oversize', 'extra-field'] as const)('fails closed on %s', defect => {
  const f = fixture();
  const frame = { kind: 'channel-data', seq: 1, ack: 1, body: { value: 'ok' } };
  if (defect === 'binary') f.socket.emit('message', Buffer.from('{}'), true);
  else f.socket.frame({ ...frame, ...(defect === 'sequence-gap' ? { seq: 2 } : defect === 'future-ack' ? { ack: 2 } :
    defect === 'oversize' ? { body: { value: 'x'.repeat(COMPUTE_FRAME_BYTES) } } : { extra: true }) });
  expect(f.closed).toHaveBeenCalledOnce(); expect(f.delivered).not.toHaveBeenCalled();
});
it.each(['frames', 'bytes'] as const)('bounds unacknowledged %s during an outage and cannot be revived after overflow', limit => {
  const f = fixture(); f.socket.terminate();
  if (limit === 'frames') for (let i = 0; i < COMPUTE_TRANSPORT_QUEUE_FRAMES; i++) f.channel.send('{}');
  else for (let i = 0; i < 9; i++) f.channel.send(JSON.stringify({ value: 'x'.repeat(COMPUTE_FRAME_BYTES - 100) }));
  expect(f.closed).toHaveBeenCalledOnce(); expect(f.channel.readyState).toBe(WebSocket.CLOSED);
  expect(() => f.channel.resume(new Socket().wire(), f.request)).toThrow();
});
it('retransmits only unacknowledged frames and rejects a stale resume epoch without displacing its successor', () => {
  const f = fixture();
  f.socket.frame({ kind: 'channel-ack', ack: 1 });
  f.channel.send(JSON.stringify({ kind: 'one' })); f.channel.send(JSON.stringify({ kind: 'two' }));
  const replacement = new Socket(); f.channel.resume(replacement.wire(), { ...f.request, received: 2 });
  expect(replacement.sent.map(text => JSON.parse(text))).toEqual([
    { kind: 'channel-resumed', token: f.request.token, epoch: 1, received: 0 },
    { kind: 'channel-data', seq: 3, ack: 0, body: { kind: 'two' } },
  ]);
  expect(() => f.channel.resume(new Socket().wire(), { ...f.request, received: 3 })).toThrow();
  expect(replacement.readyState).toBe(WebSocket.OPEN); expect(f.closed).not.toHaveBeenCalled();
  f.channel.terminate();
});
it('drains a retained multi-frame backlog one socket write at a time', () => {
  class SlowSocket extends Socket {
    callbacks: (() => void)[] = [];
    override send(text: string, done?: (error?: Error) => void) {
      this.sent.push(text);
      if (JSON.parse(text).kind === 'channel-data') {
        this.bufferedAmount = Buffer.byteLength(text);
        this.callbacks.push(() => { this.bufferedAmount = 0; done?.(); });
      } else done?.();
    }
  }
  const f = fixture(); f.socket.frame({ kind: 'channel-ack', ack: 1 }); f.socket.terminate();
  for (let i = 0; i < 4; i++) f.channel.send(JSON.stringify({ value: 'x'.repeat(COMPUTE_FRAME_BYTES - 100) }));
  const replacement = new SlowSocket(); f.channel.resume(replacement.wire(), f.request);
  expect(replacement.sent).toHaveLength(2); // resume handshake + first data only
  for (let i = 0; i < 4; i++) {
    expect(replacement.callbacks).toHaveLength(1); replacement.callbacks.shift()!();
  }
  expect(replacement.sent).toHaveLength(5); expect(f.closed).not.toHaveBeenCalled();
  f.channel.terminate();
});
