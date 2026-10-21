import type { Server } from 'node:http';
import { BoundedFixedWindowRateLimiter, loginClientAddress, isSecureRequest, type TrustedProxySnapshot } from '../auth/rate-limit.js';
import type { ComputeSession } from '../contracts/computeDevice.js';
import { WebSocketServer } from 'ws';
import { COMPUTE_FRAME_BYTES } from '../contracts/computeProtocol.js';
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
  const sockets = new WebSocketServer({ noServer: true, maxPayload: COMPUTE_FRAME_BYTES, perMessageDeflate: false });
  // A typed named listener lets disposal leave other upgrade consumers intact.
  const listener = (request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    if (request.url !== '/compute/v1') {
      if (request.url?.startsWith('/compute/') || server.listenerCount('upgrade') === 1) socket.destroy();
      return;
    }
    const secure = isSecureRequest(request, proxies) || (executor?.trustedUnixProxy && request.socket.remoteAddress === undefined && request.headers['x-forwarded-proto'] === 'https');
    if (!accepting() || !secure || request.headers.origin || request.headers.cookie || sockets.clients.size >= 32 ||
        !rate.attempt(loginClientAddress(request, proxies)).accepted) {
      socket.destroy(); return;
    }
    try { sockets.handleUpgrade(request, socket, head, ws => {
      const peer = new ComputeConnection(ws, devices, undefined, control, executor ? session => executor.connected(session) : undefined);
      peers.add(peer);
      ws.once('close', () => peers.delete(peer));
      try { admitted(peer); } catch { peer.close(); }
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
    peers.clear(); sockets.close();
  } };
}
