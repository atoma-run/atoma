import type { Server } from 'node:http';
import { BoundedFixedWindowRateLimiter, loginClientAddress, isSecureRequest, type TrustedProxySnapshot } from '../auth/rate-limit.js';
import type { ComputeSession } from '../contracts/computeDevice.js';
import { WebSocketServer } from 'ws';
import { ComputeChannel } from '../launcher/computeChannel.js';
import { COMPUTE_RESUME_PROTOCOL, COMPUTE_TRANSPORT_BYTES, computeResumeSchema } from '../contracts/computeTransport.js';
import { computeHelloSchema } from '../contracts/computeProtocol.js';
import { ComputeConnection, type ComputeRunControl } from './computeConnection.js';
import type { ComputeDeviceStore } from './computeDevices.js';

/** Explicit host opt-in. Forwarded TLS is accepted only from configured exact
 * proxy addresses, using the same boundary as authenticated HTTP admission. */
export function attachComputeGateway(server: Server, devices: ComputeDeviceStore,
  admitted: (connection: ComputeConnection) => void,
  proxies: TrustedProxySnapshot = { addresses: [] }, accepting: () => boolean = () => true, control?: ComputeRunControl,
  executor?: { connected(session: ComputeSession): void; trustedUnixProxy: boolean }) {
  const rate = new BoundedFixedWindowRateLimiter(30, 60_000, 1024);
  const peers = new Set<ComputeConnection>();
  // Keep the 32 logical-peer cap; allow a replacement handshake alongside
  // each stale physical socket until authentication fences its predecessor.
  const resumable = new Map<string, { peer: ComputeConnection; channel: ComputeChannel }>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: COMPUTE_TRANSPORT_BYTES, perMessageDeflate: false });
  // A typed named listener lets disposal leave other upgrade consumers intact.
  const listener = (request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    if (request.url !== '/compute/v1') {
      if (request.url?.startsWith('/compute/') || server.listenerCount('upgrade') === 1) socket.destroy();
      return;
    }
    const secure = isSecureRequest(request, proxies) || (executor?.trustedUnixProxy && request.socket.remoteAddress === undefined && request.headers['x-forwarded-proto'] === 'https');
    if (!accepting() || !secure || request.headers.origin || request.headers.cookie || sockets.clients.size >= 64 ||
        !rate.attempt(loginClientAddress(request, proxies)).accepted) {
      socket.destroy(); return;
    }
    try { sockets.handleUpgrade(request, socket, head, ws => {
      const admit = (wire: import('../launcher/computeChannel.js').ComputeSocket) => {
        if (peers.size >= 32) { wire.terminate(); return; }
        const peer = new ComputeConnection(wire, devices, undefined, control, executor ? session => executor.connected(session) : undefined);
        peers.add(peer);
        wire.on('close', () => peers.delete(peer));
        if (wire instanceof ComputeChannel) {
          const token = wire.token()!;
          resumable.set(token, { peer, channel: wire });
          wire.on('close', () => resumable.delete(token));
        }
        try { admitted(peer); } catch { peer.close(); }
        return peer;
      };
      if (ws.protocol !== COMPUTE_RESUME_PROTOCOL) { admit(ws); return; }
      const deadline = setTimeout(() => ws.terminate(), 5000); deadline.unref();
      ws.on('error', () => { /* An unauthenticated handshake owns no work. */ });
      ws.once('close', () => clearTimeout(deadline));
      ws.once('message', (data, binary) => {
        clearTimeout(deadline);
        try {
          const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          if (binary || bytes.length > 4096) throw new Error('Invalid handshake');
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          const resume = computeResumeSchema.safeParse(value);
          if (resume.success) {
            const existing = resumable.get(resume.data.token);
            if (!existing) throw new Error('Compute resume unavailable');
            existing.peer.authorizeResume(resume.data);
            existing.channel.resume(ws, resume.data);
          } else {
            computeHelloSchema.parse(value);
            const channel = new ComputeChannel(ws, 'server');
            if (admit(channel)) channel.emit('message', bytes, false);
          }
        } catch { ws.terminate(); }
      });
    }); } catch { socket.destroy(); }
  };
  server.on('upgrade', listener);
  return { connectionFor(session: ComputeSession): ComputeConnection | undefined {
    return [...peers].find(peer => {
      const identity = peer.identity();
      return identity?.deviceId === session.deviceId && identity.sessionId === session.sessionId && identity.generation === session.generation;
    });
  }, closeIdle(keep: (session: ComputeSession) => boolean = () => false) {
    for (const peer of peers) {
      const session = peer.identity();
      if (!peer.executing() && !(session && keep(session))) peer.close('idle-cutover');
    }
  }, close() {
    server.off('upgrade', listener);
    for (const peer of peers) peer.close('gateway-shutdown');
    peers.clear(); resumable.clear();
    for (const socket of sockets.clients) if (socket.readyState !== 2) socket.terminate();
    sockets.close();
  } };
}
