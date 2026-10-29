import WebSocket, { type RawData } from 'ws';
import { COMPUTE_RESUME_PROTOCOL, COMPUTE_TRANSPORT_BYTES, COMPUTE_TRANSPORT_QUEUE_BYTES, COMPUTE_TRANSPORT_QUEUE_FRAMES } from '../contracts/computeTransport.js';

/** Forward one authenticated resume to its still-live generation. The host
 * derives this Unix path; no device address, credential or frame is logged. */
export function relayComputeResume(front: WebSocket, socketPath: string, first: Buffer): () => void {
  if (!socketPath.startsWith('/') || /[:?#\s]/.test(socketPath) || Buffer.byteLength(socketPath) > 100) throw new Error('Invalid Compute gateway path');
  const back = new WebSocket(`ws+unix:${socketPath}:/compute/v1`, COMPUTE_RESUME_PROTOCOL, {
    headers: { 'x-forwarded-proto': 'https', 'x-atoma-compute-relay': '1' },
    maxPayload: COMPUTE_TRANSPORT_BYTES, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 5000,
  });
  let closed = false;
  const close = () => { if (!closed) { closed = true; clearTimeout(deadline); front.terminate(); back.terminate(); } };
  const deadline = setTimeout(close, 5000); deadline.unref();
  const pending = new Map<WebSocket, number>();
  const forward = (to: WebSocket, data: RawData, binary: boolean) => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (binary || bytes.length > COMPUTE_TRANSPORT_BYTES || to.readyState !== WebSocket.OPEN ||
        to.bufferedAmount + bytes.length > COMPUTE_TRANSPORT_QUEUE_BYTES ||
        (pending.get(to) ?? 0) >= COMPUTE_TRANSPORT_QUEUE_FRAMES) { close(); return; }
    pending.set(to, (pending.get(to) ?? 0) + 1);
    to.send(bytes, { binary: false }, error => { pending.set(to, (pending.get(to) ?? 1) - 1); if (error) close(); });
  };
  front.on('error', close); back.on('error', close);
  front.once('close', close); back.once('close', close);
  front.on('message', (data, binary) => forward(back, data, binary));
  back.on('message', (data, binary) => { clearTimeout(deadline); forward(front, data, binary); });
  back.once('open', () => { if (!closed) forward(back, first, false); });
  return close;
}
