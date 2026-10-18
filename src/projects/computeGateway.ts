import type { Server } from 'node:https';
import { TLSSocket } from 'node:tls';
import { WebSocketServer } from 'ws';
import { COMPUTE_FRAME_BYTES } from '../contracts/computeProtocol.js';
import { ComputeConnection } from './computeConnection.js';
import type { ComputeDeviceStore } from './computeDevices.js';

/** Explicit opt-in, direct TLS only. Never trusts forwarded-proto headers.
 * The application must supply its own connection/IP admission before upgrade.
 * This is not mounted by the production server until pairing/audit/receipts exist. */
export function attachComputeGateway(server: Server, devices: ComputeDeviceStore,
  admitted: (connection: ComputeConnection) => void) {
  const peers = new Set<ComputeConnection>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: COMPUTE_FRAME_BYTES, perMessageDeflate: false });
  // A typed named listener lets disposal leave other upgrade consumers intact.
  const listener = (request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    if (request.url !== '/compute/v1') return;
    if (!(socket instanceof TLSSocket) || !socket.encrypted || request.headers.origin || sockets.clients.size >= 32) {
      socket.destroy(); return;
    }
    sockets.handleUpgrade(request, socket, head, ws => {
      const peer = new ComputeConnection(ws, devices);
      peers.add(peer);
      ws.once('close', () => peers.delete(peer));
      try { admitted(peer); } catch { peer.close(); }
    });
  };
  server.on('upgrade', listener);
  return { close() {
    server.off('upgrade', listener);
    for (const peer of peers) peer.close();
    peers.clear(); sockets.close();
  } };
}
