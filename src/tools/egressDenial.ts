/**
 * Ask the run's egress proxy whether it refuses a destination.
 *
 * Called by `fetch_url` only AFTER its own request failed, so a healthy
 * request pays nothing. It sends `CONNECT host:port` — the proxy decides a
 * CONNECT and an absolute-form request with the same `decideEgress` call on
 * the same host and port — reads the status line and the proxy's own body,
 * and closes. An allowed tunnel is closed before any byte reaches the origin.
 * Anything but the proxy's 403 (no proxy, no answer, another status, a
 * timeout) is `undefined`: the caller keeps the error it had.
 */
import { connect } from 'node:net';
import { EGRESS_DENIAL_HEADER, EGRESS_DENIED_PREFIX, type EgressDenialKind } from '../contracts/egressDenial.js';

export interface EgressDenial {
  readonly host: string;
  readonly port: number;
  /** The proxy's reason, after the prefix. Host-authored text. */
  readonly reason: string;
  /** `unknown`: a proxy that predates the kind header. */
  readonly kind: EgressDenialKind | 'unknown';
}

const PROBE_TIMEOUT_MS = 3000;
const MAX_REPLY_BYTES = 4096;

function noProxyMatches(hostname: string, env: NodeJS.ProcessEnv): boolean {
  const raw = env['NO_PROXY'] ?? env['no_proxy'] ?? '';
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).some((entry) => {
    if (entry === '*') return true;
    const bare = entry.replace(/^\*?\./, '');
    return hostname === bare || hostname.endsWith(`.${bare}`);
  });
}

/** The proxy Node's env-proxy support would use for this URL, or undefined. */
export function egressProxyFor(target: URL, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return undefined;
  const hostname = target.hostname.toLowerCase();
  if (noProxyMatches(hostname, env)) return undefined;
  const raw = target.protocol === 'https:'
    ? env['HTTPS_PROXY'] ?? env['https_proxy']
    : env['HTTP_PROXY'] ?? env['http_proxy'];
  if (!raw) return undefined;
  try {
    const proxy = new URL(raw);
    return proxy.protocol === 'http:' ? proxy : undefined;
  } catch {
    return undefined;
  }
}

export function probeEgressDenial(
  rawUrl: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<EgressDenial | undefined> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return Promise.resolve(undefined);
  }
  const proxy = egressProxyFor(target, opts.env ?? process.env);
  if (!proxy) return Promise.resolve(undefined);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  return new Promise((resolve) => {
    let settled = false;
    let reply = Buffer.alloc(0);
    const socket = connect(Number(proxy.port) || 80, proxy.hostname);
    const finish = (value: EgressDenial | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
    // The proxy ENDS its socket after a refusal, so a 403 is read whole at
    // close; any other status settles as soon as its line arrives (an allowed
    // tunnel stays open and is closed here, before a byte reaches the origin).
    const status = (): string | undefined => /^HTTP\/1\.[01] (\d{3})/.exec(reply.toString('latin1'))?.[1];
    const parseRefusal = (): void => {
      const text = reply.toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const body = split < 0 ? '' : text.slice(split + 4);
      if (status() !== '403' || !body.startsWith(EGRESS_DENIED_PREFIX)) return finish(undefined);
      const header = new RegExp(`^${EGRESS_DENIAL_HEADER}:[ \\t]*(\\S+)`, 'im').exec(text.slice(0, split))?.[1]?.toLowerCase();
      const kind = header === 'policy' || header === 'resolution' ? header : 'unknown';
      const reason = body.slice(EGRESS_DENIED_PREFIX.length).split('\n', 1)[0]!.trim();
      finish({ host, port, reason, kind });
    };
    socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on('data', (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]).subarray(0, MAX_REPLY_BYTES);
      const code = status();
      if (code && code !== '403') finish(undefined);
      else if (reply.length >= MAX_REPLY_BYTES) parseRefusal();
    });
    socket.on('error', () => finish(undefined));
    socket.on('close', parseRefusal);
  });
}

/** What `fetch_url` returns in place of a bare `fetch failed`. */
export function egressDenialError(denial: EgressDenial): string {
  const where = `${denial.host}:${denial.port}`;
  if (denial.kind === 'policy') {
    return `egress denied by this run's host network policy: ${where} is not reachable from this execution target (${denial.reason}). ` +
      'The allowlist is set by the host, not by the run, and does not change while the run lasts: retrying, another URL on this host, ' +
      'run_shell, curl or a script\'s own fetch cannot reach it. Treat it as a blocker of the work that needs this host and report it as such.';
  }
  return `the run's egress proxy refused ${where}: ${denial.reason}.`;
}
