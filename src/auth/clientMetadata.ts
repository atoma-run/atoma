import { promises as dns, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { z } from 'zod';
import { hasControlCharacters } from './values.js';

/**
 * OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document,
 * MCP authorization 2026-07-28): a client names itself by an HTTPS URL, and
 * the authorization server fetches the JSON document that URL serves.
 *
 * This is the ONE place the server fetches a URL a client chose, so the
 * fetch is the SSRF surface and every bound lives here: HTTPS on the default
 * port, a DNS name (never an IP literal), every resolved address public —
 * checked in the socket's own lookup, so the address checked is the address
 * connected to — no redirects, a small body, a short deadline, a bounded
 * cache and a process-wide fetch rate. Redirect targets are still never
 * fetched.
 */

export const CLIENT_METADATA_MAX_BYTES = 5_120;
export const CLIENT_METADATA_TIMEOUT_MS = 5_000;
const CACHE_MIN_MS = 5 * 60_000;
const CACHE_DEFAULT_MS = 60 * 60_000;
const CACHE_MAX_MS = 24 * 60 * 60_000;
/** A refused or unreachable document is not fetched again for this long. */
const FAILURE_TTL_MS = 60_000;
const MAX_CACHED = 512;
/** Fetches per minute for the whole process: an anonymous GET can trigger one. */
const FETCHES_PER_MINUTE = 30;
/** Fetches per minute for one requesting address, so one address cannot spend the process's budget. */
const FETCHES_PER_REQUESTER = 5;
/** Documents being fetched at once: the resolver and the sockets are shared with everything else. */
const MAX_IN_FLIGHT = 4;
const DNS_TIMEOUT_MS = 2_000;

export interface MetadataClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

export class ClientMetadataError extends Error {}

/** Loopback over HTTP, or HTTPS; never credentials or a fragment. The DCR rule, shared. */
export function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)));
  } catch { return false; }
}

/** RFC 8252 loopback callbacks may choose a port; every other byte stays exact. */
export function matchesRegisteredRedirect(callback: string, registered: string): boolean {
  if (!isAllowedRedirectUri(callback) || !isAllowedRedirectUri(registered)) return false;
  if (callback === registered) return true;
  // Compare the original strings, not URL-normalized paths, hosts or escapes.
  // localhost is already an allowed loopback spelling in the registration contract.
  const loopback = /^(http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost))(?::[0-9]+)?(\/.*)$/;
  const actual = loopback.exec(callback);
  const expected = loopback.exec(registered);
  return actual !== null && expected !== null && actual[1] === expected[1] && actual[2] === expected[2];
}

/**
 * A client id that names a metadata document: HTTPS, a DNS name, the default
 * port, a path other than `/`, no query, fragment, credentials or dot
 * segments — and already in canonical form, so the document's `client_id`
 * is compared against exactly what the client sent. `null` for anything
 * else, including every id DCR issues (UUIDs).
 */
export function metadataClientUrl(value: string): URL | null {
  if (!value.startsWith('https://') || value.length > 512) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // A trailing dot names the same host under another spelling (`atoma.run.`),
  // which is how a host comparison is dodged.
  if (url.href !== value || url.protocol !== 'https:' || url.port !== '' || url.username || url.password ||
    url.search || url.hash || url.pathname === '/' || isIP(host) !== 0 || !host.includes('.') || host.endsWith('.') ||
    url.pathname.split('/').some((segment) => segment === '.' || segment === '..' || /%2e/i.test(segment))) {
    return null;
  }
  return url;
}

const BLOCKED_V4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
/** Global unicast only (2000::/3), minus the documentation, 6to4, Teredo and IETF blocks. */
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');
}

/** True only for an address a public service would answer from. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  return GLOBAL_V6.check(address, 'ipv6') && !BLOCKED_V6.check(address, 'ipv6');
}

type Resolve = (hostname: string) => Promise<LookupAddress[]>;
/**
 * c-ares, not `dns.lookup`: getaddrinfo runs on libuv's four-thread pool, and a
 * name whose nameserver never answers would hold a thread for the resolver's
 * whole timeout, starving file reads, crypto and every other lookup of the
 * process. One try, a short timeout, no /etc/hosts.
 */
const systemResolve: Resolve = async (hostname) => {
  const resolver = new dns.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
  const addresses = [
    ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
    ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
  ];
  if (addresses.length === 0) throw new ClientMetadataError(`${hostname} does not resolve`);
  return addresses;
};

/** This machine's own addresses: a public one is still this server. */
function localAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(entry.address.replace(/%.*$/, '').toLowerCase());
  }
  return addresses;
}

/**
 * The socket's lookup: resolve, refuse the name if ANY address is not public
 * or is this server's own (a mixed answer is how a rebinding name hides its
 * private record), and hand the socket only checked addresses. Honours `all`,
 * which Node's happy-eyeballs connect asks for. The callback runs outside the
 * promise chain, so it is called once whatever it does.
 */
export function guardedLookup(resolve: Resolve = systemResolve, own: () => ReadonlySet<string> = localAddresses) {
  return (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
    resolve(hostname).then((addresses) => {
      const ownAddresses = own();
      if (addresses.length === 0 || !addresses.every((entry) =>
        isPublicAddress(entry.address) && !ownAddresses.has(entry.address.toLowerCase()))) {
        throw new ClientMetadataError(`${hostname} does not resolve to public addresses only`);
      }
      return addresses;
    }).then(
      (addresses) => process.nextTick(() => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      }),
      (error: unknown) => process.nextTick(() => callback(error instanceof Error ? error : new Error(String(error))))
    );
  };
}

const documentSchema = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(80).refine((value) => !hasControlCharacters(value)),
  redirect_uris: z.array(z.string().max(2048).refine(isAllowedRedirectUri)).min(1).max(10),
  // Public clients only: a document asking for private_key_jwt names a
  // client this server cannot authenticate, so it is refused, not downgraded.
  token_endpoint_auth_method: z.literal('none').optional(),
  // Other grants a client also uses elsewhere are its business; this server
  // only ever issues the authorization code flow.
  grant_types: z.array(z.string().max(100)).max(10).refine((grants) => grants.includes('authorization_code')).optional(),
  response_types: z.array(z.string().max(100)).max(10).refine((types) => types.includes('code')).optional(),
});

/** Validate a fetched document against the id it was fetched for. */
export function parseClientMetadata(clientId: string, raw: string): MetadataClient {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ClientMetadataError('client metadata is not JSON'); }
  const document = documentSchema.safeParse(parsed);
  if (!document.success) throw new ClientMetadataError('client metadata lacks a valid client_name or redirect_uris');
  if (document.data.client_id !== clientId) throw new ClientMetadataError('client metadata names another client_id');
  return { client_id: clientId, client_name: document.data.client_name, redirect_uris: document.data.redirect_uris };
}

/** `max-age` clamped to the cache's bounds; `no-store`/`no-cache` keep the floor. */
export function cacheLifetimeMs(header: string | undefined): number {
  const maxAge = header ? /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(header) : null;
  if (header && /(?:^|,)\s*no-(?:store|cache)\b/i.test(header)) return CACHE_MIN_MS;
  if (!maxAge) return CACHE_DEFAULT_MS;
  return Math.min(CACHE_MAX_MS, Math.max(CACHE_MIN_MS, Number(maxAge[1]) * 1000));
}

export type FetchDocument = (url: URL) => Promise<{ body: string; cacheControl: string | undefined }>;

/** The one outbound request: guarded lookup, no redirect, bounded body and time. */
export function fetchClientMetadataDocument(resolve?: Resolve): FetchDocument {
  const lookup = guardedLookup(resolve);
  return (url) => new Promise((settle, fail) => {
    // `agent: false` is load-bearing: with the global agent, NODE_USE_ENV_PROXY
    // and HTTPS_PROXY send the request through a proxy that resolves the name
    // itself, and the lookup below is never called (review 2026-09-30).
    // `fetch()` would skip the lookup hook too.
    const req = request(url, {
      method: 'GET', lookup: lookup as never, agent: false,
      headers: { accept: 'application/json', 'user-agent': 'atoma-oauth-client-metadata' },
      timeout: CLIENT_METADATA_TIMEOUT_MS,
    }, (res) => {
      const type = res.headers['content-type'] ?? '';
      if (res.statusCode !== 200 || !/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) {
        res.resume(); req.destroy();
        fail(new ClientMetadataError(`client metadata answered ${res.statusCode ?? 'no status'} ${type}`.trim()));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > CLIENT_METADATA_MAX_BYTES) { req.destroy(new ClientMetadataError('client metadata is too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => settle({ body: Buffer.concat(chunks).toString('utf8'), cacheControl: res.headers['cache-control'] }));
      res.on('error', fail);
    });
    const deadline = setTimeout(() => req.destroy(new ClientMetadataError('client metadata timed out')), CLIENT_METADATA_TIMEOUT_MS);
    req.on('timeout', () => req.destroy(new ClientMetadataError('client metadata timed out')));
    req.on('error', (error) => fail(error instanceof ClientMetadataError ? error : new ClientMetadataError('client metadata is unreachable')));
    req.on('close', () => clearTimeout(deadline));
    req.end();
  });
}

/**
 * Resolves metadata client ids through a bounded cache. An anonymous GET can
 * make this server fetch, so fetches are bounded per requesting address and
 * for the process, at most four run at once, one fetch serves every request
 * waiting for the same id, refusals live apart from verified documents (so
 * junk cannot evict them), and a verified document past its lifetime is
 * still served when a new fetch is refused by a budget or cannot be read.
 */
export class ClientMetadataResolver {
  private readonly verified = new Map<string, { client: MetadataClient; expiresAt: number }>();
  private readonly refused = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<MetadataClient>>();
  private readonly fetches: number[] = [];
  private readonly byRequester = new Map<string, number[]>();

  constructor(private readonly options: {
    ownHost: string; fetchDocument?: FetchDocument; now?: () => number;
  }) {}

  async resolve(clientId: string, requester = 'unknown'): Promise<MetadataClient> {
    const url = metadataClientUrl(clientId);
    if (!url) throw new ClientMetadataError('not a client metadata URL');
    // A document on this instance's own host would be this server fetching itself.
    if (url.host === this.options.ownHost) throw new ClientMetadataError('client metadata cannot live on this server');
    const now = (this.options.now ?? Date.now)();
    const known = this.verified.get(clientId);
    if (known && known.expiresAt > now) return known.client;
    if ((this.refused.get(clientId) ?? 0) > now) throw new ClientMetadataError('client metadata was refused recently');
    const pending = this.inFlight.get(clientId);
    if (pending) return pending;
    const budget = this.admit(requester, now);
    if (budget) {
      if (known) return known.client;
      throw new ClientMetadataError(budget);
    }
    const fetching = this.fetch(url, clientId, now, known?.client).finally(() => this.inFlight.delete(clientId));
    this.inFlight.set(clientId, fetching);
    return fetching;
  }

  /** Null when a fetch may start now; the refusal otherwise. */
  private admit(requester: string, now: number): string | null {
    const recent = (times: number[]): number[] => {
      while (times.length > 0 && times[0]! <= now - 60_000) times.shift();
      return times;
    };
    const mine = recent(this.byRequester.get(requester) ?? []);
    if (this.inFlight.size >= MAX_IN_FLIGHT) return 'client metadata fetches are busy';
    if (recent(this.fetches).length >= FETCHES_PER_MINUTE) return 'client metadata fetch rate reached';
    if (mine.length >= FETCHES_PER_REQUESTER) return 'client metadata fetch rate reached for this address';
    this.fetches.push(now);
    mine.push(now);
    this.bounded(this.byRequester, requester, mine);
    return null;
  }

  private async fetch(url: URL, clientId: string, now: number, stale: MetadataClient | undefined): Promise<MetadataClient> {
    let fetched: { body: string; cacheControl: string | undefined };
    try {
      fetched = await (this.options.fetchDocument ?? fetchClientMetadataDocument())(url);
    } catch (error) {
      // Unreachable is not refused: the last verified reading still stands.
      if (stale) return stale;
      this.bounded(this.refused, clientId, now + FAILURE_TTL_MS);
      throw error instanceof ClientMetadataError ? error : new ClientMetadataError('client metadata is unreachable');
    }
    try {
      const client = parseClientMetadata(clientId, fetched.body);
      this.bounded(this.verified, clientId, { client, expiresAt: now + cacheLifetimeMs(fetched.cacheControl) });
      this.refused.delete(clientId);
      return client;
    } catch (error) {
      // A document that now says something else withdraws the old reading.
      this.verified.delete(clientId);
      this.bounded(this.refused, clientId, now + FAILURE_TTL_MS);
      throw error;
    }
  }

  private bounded<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    if (map.size >= MAX_CACHED) map.delete(map.keys().next().value!);
    map.set(key, value);
  }
}
