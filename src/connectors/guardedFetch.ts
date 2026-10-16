import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { guardedLookup } from '../auth/clientMetadata.js';

/**
 * THE ONE OUTBOUND REQUEST TO A CUSTOMER'S MCP SERVER.
 * ===================================================
 *
 * A connector URL, its OAuth discovery documents and its token endpoint are
 * all chosen by an organisation, so every byte this host sends to them goes
 * through here and nowhere else. The bounds are the client-metadata fetch's
 * (src/auth/clientMetadata.ts), widened only where MCP needs it:
 *
 * - HTTPS only, a DNS name (never an IP literal, which would skip the
 *   lookup below), no credentials in the URL. Any port: a customer's server
 *   may listen on 8443, and the address check is what keeps the host's own
 *   services out, not the port.
 * - Every resolved address public and not this machine's own, checked in the
 *   socket's own lookup, so the address checked is the address connected to.
 *   `agent: false` is load-bearing: a proxy agent resolves the name itself
 *   and the lookup would never run. `fetch()` would skip the hook too.
 * - This fetch follows NO redirect: a 3xx is handed back as a status. The
 *   SDK may itself re-issue a same-origin 307/308, and that request comes
 *   back through here with every check; nothing carries the Authorization
 *   header to a host the organisation never named.
 * - A bounded response body and a bounded time, whatever the caller asks.
 */

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
type Resolve = (hostname: string) => Promise<LookupAddress[]>;

export const CONNECTOR_FETCH_TIMEOUT_MS = 120_000;
export const CONNECTOR_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;

export class ConnectorFetchError extends Error {}

export interface ConnectorFetchOptions {
  readonly resolve?: Resolve;
  readonly own?: () => ReadonlySet<string>;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /**
   * TESTS ONLY: plain HTTP to a loopback listener, without the address guard.
   * Never derived from configuration or environment; production callers
   * cannot reach a code path that sets it.
   */
  readonly loopbackForTests?: boolean;
}

/** A connector URL as stored: HTTPS, a host, no credentials or fragment. `null` otherwise. */
export function connectorUrl(value: string, options: { loopbackForTests?: boolean } = {}): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.username || url.password || url.hash || !url.hostname) return null;
  const loopback = options.loopbackForTests === true && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  // An IP literal never reaches the socket's lookup, so the address guard
  // would not run: a DNS name is required (`https://2130706433/` is
  // normalised to 127.0.0.1 by the URL parser and refused here too).
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 && !loopback) return null;
  if (url.protocol === 'https:') return url;
  if (options.loopbackForTests && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return url;
  return null;
}

function requestBody(body: RequestInit['body'], headers: Headers): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) {
    if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    return body.toString();
  }
  throw new ConnectorFetchError('unsupported connector request body');
}

/** A web stream that errors once more than `limit` bytes have passed. */
function bounded(source: Readable, limit: number): ReadableStream<Uint8Array> {
  let seen = 0;
  const web = Readable.toWeb(source) as ReadableStream<Uint8Array>;
  return web.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        source.destroy();
        controller.error(new ConnectorFetchError('connector response is too large'));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

export function connectorFetch(options: ConnectorFetchOptions = {}): FetchLike {
  const lookup = guardedLookup(options.resolve, options.own);
  const timeoutMs = Math.min(options.timeoutMs ?? CONNECTOR_FETCH_TIMEOUT_MS, CONNECTOR_FETCH_TIMEOUT_MS);
  const maxBytes = Math.min(options.maxResponseBytes ?? CONNECTOR_MAX_RESPONSE_BYTES, CONNECTOR_MAX_RESPONSE_BYTES);
  return async (input, init) => {
    const raw = input instanceof Request ? input.url : input.toString();
    const url = connectorUrl(raw, { loopbackForTests: options.loopbackForTests === true });
    if (!url) throw new ConnectorFetchError('connector requests must use an HTTPS URL without credentials');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const body = requestBody(init?.body, headers);
    if (body !== undefined && Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      throw new ConnectorFetchError('connector request is too large');
    }
    if (!headers.has('user-agent')) headers.set('user-agent', 'atoma-connector');
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])]);
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new ConnectorFetchError('connector request aborted');
    const plain = url.protocol === 'http:';
    const send = plain ? httpRequest : httpsRequest;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = send(url, {
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(headers),
        signal,
        agent: false,
        ...(plain ? {} : { lookup: lookup as never }),
      }, (incoming) => {
        const status = incoming.statusCode ?? 502;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        // A redirect is reported, never followed (see the module comment).
        const empty = [204, 205, 304].includes(status) || (status >= 300 && status < 400);
        if (empty) incoming.resume();
        // The Response constructor refuses statuses outside 200..599.
        const safeStatus = status >= 200 && status <= 599 ? status : 502;
        resolve(new Response(empty ? null : bounded(incoming, maxBytes), { status: safeStatus, headers: responseHeaders }));
      });
      outgoing.on('error', (error) => reject(error instanceof ConnectorFetchError ? error
        : new ConnectorFetchError(signal.aborted ? 'connector request timed out or was cancelled' : `connector is unreachable: ${error.message}`.slice(0, 300))));
      outgoing.end(body);
    });
  };
}
