import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  createMcpHandler,
  isLegacyRequest,
  type McpHttpHandler,
  type McpServer,
} from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { SessionEventStore } from './eventStore.js';
import { FROZEN_BODY_LIMIT_BYTES, servableWhileFrozen } from './frozen.js';
import { callerKey, callerTier, describeCaller, type McpCaller } from './identity.js';
import type { ResourceEvents } from './resources.js';
import type { ProtocolEraName } from './taskWire.js';

/**
 * THE MCP OVER HTTP — one route on the viz server, `/mcp`, speaking the
 * Streamable HTTP transport to Claude Code, Codex and anything else that
 * takes a URL and a bearer.
 *
 * ONE SESSION, ONE SERVER, ONE CALLER. An `initialize` request authenticates
 * the caller, builds a server holding only the tools that caller's tier
 * admits, and binds both to a session id. Every later request on that session
 * must present the SAME caller: a token revoked between two calls ends the
 * session with a 401 rather than riding the id it opened. Sessions are
 * in-memory and idle-swept, and a host restart forgets them; an authenticated
 * caller presenting a forgotten id has it reopened in place, so a deployment
 * is invisible to a connected client. The state that matters (runs, verdicts,
 * the journal) lives in the stores, never in a session.
 *
 * WHAT MOVED HERE FROM THE OLD STDIO ARGUMENT. Stdio was "no socket the run
 * could reach". On a gated deployment a run holds no bearer and is inside a
 * container with no network, so the identity layer is what neutralises the
 * reachable port — the same answer the viz's own project launcher gave. On the
 * ungated loopback path the operator is anonymous, and a local run could
 * indeed call this route; it could equally shell out to `npm run run:build`,
 * so the route adds no capability the run did not already have.
 *
 * WHAT THE BROWSER CANNOT DO, AND BY WHICH CONTROL. `allowedHosts` pins the
 * Host, which is what defeats DNS rebinding: a page on an attacker domain
 * resolved to this address still sends that domain as Host and is refused.
 * `allowedOrigins` pins the Origin, which the SDK checks ONLY when the header
 * is present, so a CLI client that sends none is unaffected while a page that
 * sends one is refused by name. Origin is defence in depth, not the
 * load-bearing control: nothing here emits CORS headers, and MCP's own
 * required headers (`content-type: application/json`, `Accept:
 * text/event-stream`) are not CORS-safelisted, so a cross-origin page is
 * stopped at a preflight this server never answers. Both are passed, and
 * neither is described as doing the other's work.
 *
 * TWO PROTOCOL ERAS ON ONE ROUTE (2026-09-30). A 2025-11-25 client opens a
 * session with `initialize` and everything below applies to it. A 2026-07-28
 * client carries its protocol version and capabilities on every request and
 * has no session: its requests go to the SDK's per-request handler
 * (`createMcpHandler`), which builds a server for the caller each time, and
 * the tasks extension's `tasks/*` requests — which that handler refuses — are
 * answered here (`taskWire.ts`). `isLegacyRequest` decides; a request that
 * names a session is always 2025. Host and Origin are checked here for both,
 * because the 2026 handler checks neither.
 *
 * SESSIONS ARE CEILINGED TWICE. A session holds a whole `McpServer` and a
 * replay ring worth megabytes (`eventStore.ts`), and the only other reclaim
 * is the day-long idle sweep — so a client that re-initialises in a loop
 * would grow this map until the process died. A caller past its own ceiling
 * loses its STALEST session, which is self-limiting and costs that caller
 * only; the global ceiling refuses with 503 and is the backstop, never the
 * first line.
 */

export interface McpHttpHostOptions {
  /** Null → 401. The host never guesses an identity. */
  readonly resolveCaller: (req: IncomingMessage) => McpCaller | null;
  /** A server for `caller` answering `era`: once per session (2025) or once per request (2026). */
  readonly buildServer: (caller: McpCaller, era: ProtocolEraName) => McpServer;
  /**
   * Hooks this process's run-finished events onto the 2026 `subscriptions/listen`
   * streams; returns the unhook. The 2025 sessions hook their own (`resources.ts`).
   */
  readonly resourceEvents?: (events: ResourceEvents) => () => void;
  /**
   * Whether `caller` may hear of `uri` on a 2026 `subscriptions/listen`, where
   * one process-wide bus serves every listener. Absent: none.
   */
  readonly mayFollow?: (caller: McpCaller, uri: string) => boolean;
  /** `Host` values this route answers; anything else is 403 by the transport. */
  readonly allowedHosts: readonly string[];
  /** `Origin` values this route answers WHEN the header is sent; an absent Origin is unaffected. */
  readonly allowedOrigins?: readonly string[];
  readonly resourceMetadataUrl?: string;
  readonly idleMs?: number;
  /** Hard ceiling for one HTTP POST, including stalled bodies. */
  readonly maxRequestMs?: number;
  /** Total live sessions on this host. Past it, a new session is refused. */
  readonly maxSessions?: number;
  /** Live sessions one caller may hold. Past it, that caller's stalest session is dropped. */
  readonly maxSessionsPerCaller?: number;
  readonly now?: () => number;
  /** How long a POST body may take to arrive; past it the request is closed. */
  readonly bodyTimeoutMs?: number;
  /** How long a session's opening may take; the calls it then answers are bounded by `maxRequestMs`. */
  readonly openTimeoutMs?: number;
  /** SSE keepalive cadence of the 2026 streams; the SDK's 15 s when absent. */
  readonly keepAliveMs?: number;
  readonly logger?: (line: string) => void;
}

interface Session {
  readonly id: string;
  readonly transport: NodeStreamableHTTPServerTransport;
  readonly server: McpServer;
  /** The session's replay ring, held so `health()` can report the depth it lost. */
  readonly events: SessionEventStore;
  readonly key: string;
  lastSeenMs: number;
  readonly activePosts: Map<ServerResponse, number>;
}

/**
 * A day. Thirty minutes made a client back from a break meet "session
 * expired" (2026-09-28); memory stays bounded by the two session ceilings,
 * not by this clock, and a session swept anyway is resumed below.
 */
export const MCP_SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * The ids this host mints bind a random UUID to the caller identity and tier.
 * Only an id with the matching owner binding is resumed:
 * anything else was never ours, and answers 404 as before.
 */
const RESUMABLE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}$/;
function sessionOwner(key: string): string { return createHash('sha256').update(key).digest('hex'); }
export const MCP_MAX_REQUEST_MS = 3 * 60 * 60 * 1000;

/**
 * The request ceiling a deployment asks for (`ATOMA_MCP_MAX_REQUEST_MS`), or
 * the default. It must cover the longest call a client may hold open — a
 * project run with preparation and finalization, a campaign — so it is the
 * operator's to raise, never below one minute; a malformed value is refused
 * rather than guessed.
 */
export function mcpMaxRequestMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['ATOMA_MCP_MAX_REQUEST_MS'];
  if (raw === undefined || raw.trim() === '') return MCP_MAX_REQUEST_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 60_000) {
    throw new Error(`ATOMA_MCP_MAX_REQUEST_MS must be an integer of at least 60000 ms (got ${JSON.stringify(raw)})`);
  }
  return value;
}
export const MCP_SESSION_HEADER = 'mcp-session-id';
/** How long a POST body may take to arrive. */
export const MCP_BODY_TIMEOUT_MS = 30_000;
/** The host's backstop. At 4 MiB of replay ring apiece this bounds the rings at ~512 MiB. */
export const MCP_MAX_SESSIONS = 128;
/** One caller's share. A client needs one session; a handful covers a reconnect storm. */
export const MCP_MAX_SESSIONS_PER_CALLER = 8;

export interface McpHttpHealth {
  readonly sessions: number;
  readonly initializing: number;
  readonly opened: number;
  /** Requests answered 401: no caller, or a caller that does not own the session it presented. */
  readonly refused: number;
  /** Sessions dropped to keep a caller inside its own ceiling. */
  readonly evicted: number;
  /** Sessions refused 503 by the host ceiling. Non-zero means the backstop is load-bearing. */
  readonly overflowed: number;
  /** Unknown session ids an authenticated caller presented, reopened under the same id. */
  readonly resumed: number;
  /** Frames the live sessions' rings dropped: replay depth a reconnect can no longer reach. */
  readonly replayEvictions: number;
  /** 2026-07-28 requests served since start; a 2026 client has no session to count. */
  readonly modernRequests: number;
  /**
   * Who speaks what: `<protocol version> <client name>` → sessions opened
   * (2025) or requests (2026). How the migration to 2026 is measured; bounded.
   */
  readonly clients: Readonly<Record<string, number>>;
}

/** How many distinct `<version> <client>` pairs `health()` keeps; past it they count under `other`. */
const MAX_CLIENT_KINDS = 64;
/** How many kinds one caller may name; past it its requests count under `other`, so no token fills the table. */
const MAX_CLIENT_KINDS_PER_CALLER = 4;
/** 2026 `subscriptions/listen` streams one caller may hold open, and the process. */
export const MCP_MAX_LISTENS_PER_CALLER = 8;
export const MCP_MAX_LISTENS = 512;

/**
 * The SDK's id for the standalone GET notification stream
 * (`WebStandardStreamableHTTPServerTransport._standaloneSseStreamId`). Every
 * other stream answers one request. Pinned by `tests/mcp-http-lifetimes`
 * against the installed SDK, so an upgrade that renames it fails a test
 * rather than silently pinning subscriptions.
 */
export const STANDALONE_SSE_STREAM_ID = '_GET_stream';

/**
 * When `req` is a GET resuming the stream of a call still UNANSWERED, the time
 * that call began (its stream's first frame); otherwise undefined. The SDK
 * holds a resumed stream open after replaying it, so the GET resuming a call
 * already answered would otherwise pin its session to the request ceiling for
 * a response that was already delivered (2026-09-25 adversarial review).
 */
function resumedCallStart(events: SessionEventStore, req: IncomingMessage): number | undefined {
  if (req.method !== 'GET') return undefined;
  const header = req.headers['last-event-id'];
  const lastEventId = Array.isArray(header) ? header[0] : header;
  if (!lastEventId) return undefined;
  const stream = events.streamState(lastEventId);
  if (!stream || stream.streamId === STANDALONE_SSE_STREAM_ID || stream.answered) return undefined;
  return stream.firstStoredMs;
}

export class McpHttpHost {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<symbol, { key: string; close: () => void }>();
  private readonly options: McpHttpHostOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly sweeper: NodeJS.Timeout;
  private readonly maxSessions: number;
  private readonly maxPerCaller: number;
  private opened = 0;
  private refused = 0;
  private evicted = 0;
  private overflowed = 0;
  private resumed = 0;
  private modernRequests = 0;
  private readonly clients = new Map<string, number>();
  /** The kinds each caller has named, bounded by `MAX_CLIENT_KINDS_PER_CALLER`. */
  private readonly kindsByCaller = new Map<string, Set<string>>();
  /** Open 2026 listen streams per caller. */
  private readonly listens = new Map<string, number>();
  private readonly modern: McpHttpHandler;
  private readonly unhookResourceEvents: () => void;
  /**
   * Sessions this host dropped ON PURPOSE to hold a caller inside its ceiling.
   * They stay gone: resumed, each would evict the next stalest, and a caller
   * over its share would cycle its sessions on every call. Bounded, oldest out.
   */
  private readonly evictedIds = new Set<string>();

  constructor(options: McpHttpHostOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.log = options.logger ?? (() => {});
    this.maxSessions = options.maxSessions ?? MCP_MAX_SESSIONS;
    this.maxPerCaller = options.maxSessionsPerCaller ?? MCP_MAX_SESSIONS_PER_CALLER;
    const idleMs = options.idleMs ?? MCP_SESSION_IDLE_MS;
    this.sweeper = setInterval(() => void this.sweep(idleMs), Math.max(60_000, Math.min(idleMs, 5 * 60_000)));
    this.sweeper.unref();
    // The 2026 handler builds one server per REQUEST, for the caller this host
    // authenticated and handed over as `authInfo.extra.caller`. 2025 traffic
    // never reaches it (`legacy: 'reject'`): the sessions below serve it.
    this.modern = createMcpHandler((context) => {
      const caller = (context.authInfo?.extra as { caller?: McpCaller } | undefined)?.caller;
      if (!caller) throw new Error('a 2026-era request reached the MCP handler without an authenticated caller');
      return options.buildServer(caller, 'modern');
    }, {
      legacy: 'reject', maxSubscriptions: MCP_MAX_LISTENS, onerror: (error) => this.log(`2026 request failed: ${error.message}`),
      // EVERY 2026 call answers as SSE, opened once the request passed the
      // SDK's validation ladder (refusals keep their HTTP status), so its
      // keepalive comments flow from the start. In the default 'auto' mode a
      // call whose client sent no progressToken stayed a deferred JSON body
      // and sent NO byte until the result — a run start lasts minutes, and an
      // idle proxy timeout or client deadline would cut it (2026-10-03).
      responseMode: 'sse',
      ...(options.keepAliveMs !== undefined ? { keepAliveMs: options.keepAliveMs } : {}),
    });
    this.unhookResourceEvents = options.resourceEvents?.({
      updated: (uri) => this.modern.notify.resourceUpdated(uri),
      listChanged: () => this.modern.notify.resourcesChanged(),
    }) ?? (() => {});
  }

  health(): McpHttpHealth {
    let replayEvictions = 0;
    for (const session of this.sessions.values()) replayEvictions += session.events.evictions();
    return {
      sessions: this.sessions.size, initializing: this.pending.size, opened: this.opened, refused: this.refused, evicted: this.evicted,
      overflowed: this.overflowed, resumed: this.resumed, replayEvictions, modernRequests: this.modernRequests,
      clients: Object.fromEntries(this.clients),
    };
  }

  /**
   * Counts one client kind: a 2025 `initialize`, or one 2026 request. The name
   * is the client's own claim, so each caller adds at most a few kinds and the
   * table at most `MAX_CLIENT_KINDS`: one token cannot push the real clients
   * under `other` (review 2026-09-30, 8).
   */
  private countClient(caller: McpCaller, protocolVersion: unknown, clientInfo: unknown): void {
    const version = typeof protocolVersion === 'string' ? protocolVersion.slice(0, 20) : 'unknown';
    const name = clientInfo && typeof clientInfo === 'object' && typeof (clientInfo as { name?: unknown }).name === 'string'
      ? (clientInfo as { name: string }).name.slice(0, 60) : 'unknown';
    let kind = `${version} ${name}`;
    const key = callerKey(caller);
    const named = this.kindsByCaller.get(key) ?? new Set<string>();
    if (!named.has(kind) && (named.size >= MAX_CLIENT_KINDS_PER_CALLER || this.kindsByCaller.size >= 4 * MAX_CLIENT_KINDS)) kind = 'other';
    else if (!named.has(kind)) this.kindsByCaller.set(key, named.add(kind));
    if (!this.clients.has(kind) && this.clients.size >= MAX_CLIENT_KINDS) kind = 'other';
    this.clients.set(kind, (this.clients.get(kind) ?? 0) + 1);
  }

  /**
   * Host pinned, Origin pinned when sent — for both eras, since the 2026
   * handler checks neither. Answers 403 and returns false when refused.
   */
  private admitted(req: IncomingMessage, res: ServerResponse): boolean {
    const host = req.headers.host;
    const origin = req.headers.origin;
    const reason = !host || !this.options.allowedHosts.includes(host) ? `Invalid Host header: ${host ?? '(none)'}`
      : origin !== undefined && this.options.allowedOrigins && !this.options.allowedOrigins.includes(origin) ? `Invalid Origin header: ${origin}`
      : null;
    if (!reason) return true;
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: reason }, id: null }));
    return false;
  }

  /**
   * `frozen`: a deployment holds writes (`src/viz/deployment.ts`). A POST is
   * then read here, and served only when `servableWhileFrozen` says it starts
   * nothing; the rest waits with the freeze's own 503.
   */
  async handle(req: IncomingMessage, res: ServerResponse, options: { readonly frozen?: boolean } = {}): Promise<void> {
    const caller = this.options.resolveCaller(req);
    if (!caller) {
      this.refused += 1;
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': this.options.resourceMetadataUrl
          ? `Bearer realm="atoma", error="invalid_token", resource_metadata="${this.options.resourceMetadataUrl}", scope="mcp"`
          : 'Bearer realm="atoma", error="invalid_token"',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'a valid access token is required' }, id: null }));
      return;
    }
    if (!this.admitted(req, res)) return;
    // Every POST is read here, once: its era is decided from the body, and the
    // transports are handed the parsed message rather than the stream.
    let body: unknown;
    if (req.method === 'POST') {
      // Nothing is reserved or allocated while a body is still arriving, and one
      // that has not arrived in `bodyTimeoutMs` is closed: a fragmented body
      // holds a socket, never a session's place or a server.
      const deadline = setTimeout(() => { req.destroy(); res.destroy(); }, this.options.bodyTimeoutMs ?? MCP_BODY_TIMEOUT_MS);
      deadline.unref();
      try {
        body = await readBoundedJson(req, options.frozen ? FROZEN_BODY_LIMIT_BYTES : DEFAULT_MAX_REQUEST_BODY_SIZE);
      } finally {
        clearTimeout(deadline);
      }
      if (res.destroyed) return;
      if (body === undefined) {
        if (options.frozen) frozenRefusal(res);
        else unreadableBody(res);
        return;
      }
    }
    const header = req.headers[MCP_SESSION_HEADER];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (!sessionId && req.method === 'POST' && !(await isLegacyRequest(webRequestOf(req), body))) {
      await this.handleModern(req, res, caller, body, options);
      return;
    }
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        // A session this host no longer holds — a restart, which every
        // deployment is, or the idle sweep — presented by a caller who
        // authenticated just now. It is REOPENED under the same id, bound to
        // that caller, so the client never sees the cut: until 2026-09-28 it
        // answered 404, and a client failed one call after each deployment,
        // some for good. Nothing of the old session comes back (its task ids,
        // subscriptions and replay ring were memory); runs never lived here.
        if (req.method !== 'DELETE' && RESUMABLE_SESSION_ID.test(sessionId) && sessionId.endsWith(`.${sessionOwner(callerKey(caller))}`) && !this.evictedIds.has(sessionId)) {
          await this.open(req, res, caller, body, sessionId, options.frozen === true);
          return;
        }
        this.unknownSession(res);
        return;
      }
      if (session.key !== callerKey(caller)) {
        // The session was opened by a different identity or tier than the one
        // now presenting it — a revoked and re-minted token, a role change.
        // A different caller must not destroy the rightful owner's session.
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'session does not belong to this caller' }, id: null }));
        return;
      }
      session.lastSeenMs = this.now();
      // A call ANSWERING pins the session for as long as its response is
      // open: a POST, and the GET that RESUMES a cut POST's stream with
      // `Last-Event-ID` while its response is still owed — the replay
      // contract promises that call its response (2026-09-25 review, 1.3a).
      // The resumed call keeps the start of the original one, so reconnecting
      // never extends the request ceiling. The standalone notification stream
      // does not pin: an abandoned subscription remains sweepable.
      const resumed = resumedCallStart(session.events, req);
      if (req.method === 'POST') this.pinWhileAnswering(session, res, this.now());
      else if (resumed !== undefined) this.pinWhileAnswering(session, res, resumed);
      if (options.frozen && body !== undefined && !servableWhileFrozen(session.server, body)) {
        frozenRefusal(res);
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'no session; POST an initialize request first' }, id: null }));
      return;
    }
    // A new session: the transport validates that the body is `initialize`.
    const opening = body as { method?: unknown; params?: { protocolVersion?: unknown; clientInfo?: unknown } } | undefined;
    if (opening?.method === 'initialize') this.countClient(caller, opening.params?.protocolVersion, opening.params?.clientInfo);
    await this.open(req, res, caller, body, undefined, options.frozen === true);
  }

  /**
   * One 2026-07-28 request: the tasks extension's methods answered here, the
   * rest through the SDK's per-request handler. Under a write freeze a POST
   * that starts nothing is served, judged against this caller's tools.
   */
  private async handleModern(
    req: IncomingMessage,
    res: ServerResponse,
    caller: McpCaller,
    body: unknown,
    options: { readonly frozen?: boolean }
  ): Promise<void> {
    this.modernRequests += 1;
    const meta = (body as { params?: { _meta?: Record<string, unknown> } } | undefined)?.params?._meta;
    this.countClient(caller, meta?.['io.modelcontextprotocol/protocolVersion'], meta?.['io.modelcontextprotocol/clientInfo']);
    if (options.frozen && !servableWhileFrozen(this.options.buildServer(caller, 'modern'), body)) {
      frozenRefusal(res);
      return;
    }
    // A call that outlives the request ceiling is closed, as a 2025 one is.
    const ceiling = setTimeout(() => {
      this.log('a 2026 response past the request ceiling was closed');
      res.destroy();
    }, this.options.maxRequestMs ?? MCP_MAX_REQUEST_MS);
    ceiling.unref();
    res.once('close', () => clearTimeout(ceiling));
    let forwarded = body;
    if (isListen(body)) {
      // One bus serves every 2026 listener, so a caller names only what it may
      // hear of, and holds a bounded number of streams (review 2026-09-30, 2 and 3).
      const key = callerKey(caller);
      const open = this.listens.get(key) ?? 0;
      if (open >= MCP_MAX_LISTENS_PER_CALLER) {
        res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: `at most ${MCP_MAX_LISTENS_PER_CALLER} open subscriptions/listen streams per caller` } }));
        return;
      }
      this.listens.set(key, open + 1);
      res.once('close', () => {
        const left = (this.listens.get(key) ?? 1) - 1;
        if (left > 0) this.listens.set(key, left);
        else this.listens.delete(key);
      });
      forwarded = this.followable(caller, body);
    }
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    const response = await this.modern.fetch(webRequestOf(req, abort.signal), {
      parsedBody: forwarded,
      authInfo: { token: 'atoma-caller', clientId: callerKey(caller), scopes: [], extra: { caller } },
    });
    await sendWebResponse(res, response);
  }

  /**
   * A listen request narrowed to what `caller` may hear of: the resource URIs
   * `mayFollow` admits, and the list-changed notice only at the platform tier,
   * the only one listing the operator traces whose end changes a listing.
   */
  private followable(caller: McpCaller, body: ListenRequest): ListenRequest {
    const filter = body.params.notifications;
    const mayFollow = this.options.mayFollow ?? (() => false);
    const uris = Array.isArray(filter.resourceSubscriptions)
      ? filter.resourceSubscriptions.filter((uri): uri is string => typeof uri === 'string' && mayFollow(caller, uri))
      : undefined;
    const notifications: Record<string, unknown> = { ...filter, ...(uris ? { resourceSubscriptions: uris } : {}) };
    if (callerTier(caller) !== 'platform') delete notifications['resourcesListChanged'];
    return { ...body, params: { ...body.params, notifications } };
  }

  /**
   * Open a session for `caller`: a new one on `initialize`, or, with
   * `resumeId`, the id a client still holds after this host forgot it. Both
   * count against the same two ceilings and reserve before allocating.
   */
  private async open(req: IncomingMessage, res: ServerResponse, caller: McpCaller, body: unknown, resumeId?: string, frozen = false): Promise<void> {
    const key = callerKey(caller);
    // This caller's own ceiling first, so a busy client reclaims from itself
    // rather than from the host — and only then the host's backstop.
    this.reclaim(key);
    const pendingForCaller = [...this.pending.values()].filter(value => value.key === key).length;
    const liveForCaller = [...this.sessions.values()].filter(value => value.key === key).length;
    if (this.sessions.size + this.pending.size >= this.maxSessions || pendingForCaller + liveForCaller >= this.maxPerCaller) {
      this.overflowed += 1;
      this.log(`session refused for ${describeCaller(caller)}: session capacity exhausted (${this.sessions.size} ready, ${this.pending.size} initializing)`);
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'too many active MCP sessions on this host; retry shortly' }, id: null }));
      return;
    }
    // Reserve synchronously before allocating or awaiting a fragmented body.
    const reservation = Symbol(key);
    const closePending = () => { req.destroy(); res.destroy(); };
    this.pending.set(reservation, { key, close: closePending });
    // Bounds the OPENING only: cleared the moment the session exists, so the
    // first call on a session resumed after a restart is not cut at 30s with
    // it (review 2026-09-30, pre-existing since 2026-09-28).
    const initializationTimer = setTimeout(closePending, this.options.openTimeoutMs ?? MCP_BODY_TIMEOUT_MS);
    initializationTimer.unref();
    try {
      const server = this.options.buildServer(caller, 'legacy');
      const events = new SessionEventStore(undefined, undefined, this.now);
      let session: Session | null = null;
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => resumeId ?? `${randomUUID()}.${sessionOwner(key)}`,
        // SSE responses, NEVER plain JSON. In JSON mode the SDK drops every
        // notification related to a request — a `notifications/progress` sent
        // during a `waitMs` long-poll reached nobody (measured 2026-09-07: 0 of 3
        // delivered, against 3 of 3 over SSE). The stream is also what the event
        // store replays after a cut connection (`Last-Event-ID`). Host and
        // Origin were checked by `admitted`, for both eras.
        eventStore: events,
        onsessioninitialized: (id) => {
          clearTimeout(initializationTimer);
          this.pending.delete(reservation);
          session = { id, transport, server, events, key, lastSeenMs: this.now(), activePosts: new Map() };
          this.sessions.set(id, session);
          if (resumeId) this.resumed += 1;
          else this.opened += 1;
          this.log(`session ${id.slice(0, 8)} ${resumeId ? 'resumed' : 'opened'} for ${describeCaller(caller)}`);
        },
        onsessionclosed: (id) => {
          this.sessions.delete(id);
        },
      });
      transport.onclose = () => {
        if (session) this.sessions.delete(session.id);
      };
      try {
        await server.connect(transport);
        if (resumeId) {
          const initialised = await this.initialiseResumed(transport, req, resumeId, caller);
          const live = this.sessions.get(resumeId);
          if (!initialised || !live) {
            if (live) await this.drop(live, 'resume failed');
            this.unknownSession(res);
            return;
          }
          // The request that found its session gone is answered like any other
          // on a live session: a POST pins it while it answers.
          if (req.method === 'POST') this.pinWhileAnswering(live, res, this.now());
        }
        // Read already, under a freeze: classified against THIS session's tools.
        if (frozen && body !== undefined && !servableWhileFrozen(server, body)) {
          frozenRefusal(res);
          return;
        }
        await transport.handleRequest(req, res, body);
      } finally {
        // Not an initialize, a refused one, or a throw on the way: the transport
        // has already answered, and nothing else will ever close this server —
        // the sweeper only walks `sessions`, which this one never entered.
        if (!session) {
          await transport.close().catch(() => {});
          await server.close().catch(() => {});
        }
      }
    } finally {
      clearTimeout(initializationTimer);
      this.pending.delete(reservation);
    }
  }

  private unknownSession(res: ServerResponse): void {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unknown or expired session; initialize again' }, id: null }));
  }

  /**
   * Put a fresh transport and server through the protocol's opening under a
   * forgotten id, so the request that presented it is served as it would have
   * been: the `initialize` the client sent before the restart, and its
   * `notifications/initialized`, replayed here with the version the request
   * names. The client's declared capabilities are not known again; no tool
   * here reads them. The SDK's Node transport wraps a web-standard one, the
   * only door to an `initialize` that is not an HTTP request; a release that
   * moves it resumes nothing and answers 404 as before, and
   * `tests/mcp-http-lifetimes` fails first.
   */
  private async initialiseResumed(transport: NodeStreamableHTTPServerTransport, req: IncomingMessage, id: string, caller: McpCaller): Promise<boolean> {
    const web = (transport as unknown as { _webStandardTransport?: { handleRequest?: (request: Request) => Promise<Response> } })._webStandardTransport;
    const host = req.headers.host;
    if (typeof web?.handleRequest !== 'function' || !host) return false;
    const header = req.headers['mcp-protocol-version'];
    const asked = Array.isArray(header) ? header[0] : header;
    // A session is a 2025 thing: the resumed opening names a 2025 version.
    const protocolVersion = asked && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) && asked < '2026' ? asked : LATEST_PROTOCOL_VERSION;
    const url = `http://${host}/mcp`;
    const headers = { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const initialize = await web.handleRequest(new Request(url, { method: 'POST', headers, body: JSON.stringify({
      jsonrpc: '2.0', id: `resume-${id}`, method: 'initialize',
      params: { protocolVersion, capabilities: {}, clientInfo: { name: 'atoma-resumed-session', version: '1' } },
    }) }));
    await initialize.text();
    if (!initialize.ok) return false;
    const initialized = await web.handleRequest(new Request(url, {
      method: 'POST', headers: { ...headers, 'mcp-session-id': id, 'mcp-protocol-version': protocolVersion },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }));
    await initialized.text();
    if (initialized.status !== 202) return false;
    this.countClient(caller, protocolVersion, { name: 'atoma-resumed-session' });
    return true;
  }

  /**
   * Keep one caller inside its own ceiling by dropping its stalest session.
   * A loop, not an `if`: a lowered ceiling or a burst can leave several over.
   */
  private reclaim(key: string): void {
    for (;;) {
      const mine = [...this.sessions.values()].filter((session) => session.key === key);
      if (mine.length + [...this.pending.values()].filter(value => value.key === key).length < this.maxPerCaller) return;
      // A session still ANSWERING a call is never the victim. Its `lastSeenMs`
      // froze when the call began, which made it the "stalest" exactly while
      // a caller waited on it (2026-09-25 review, 1.3b). With every place
      // busy, the admission check below answers 503, as for pending ones.
      const idle = mine.filter((session) => session.activePosts.size === 0);
      if (idle.length === 0) return;
      const stalest = idle.reduce((oldest, session) => (session.lastSeenMs < oldest.lastSeenMs ? session : oldest));
      this.evicted += 1;
      this.evictedIds.add(stalest.id);
      if (this.evictedIds.size > 1024) this.evictedIds.delete(this.evictedIds.values().next().value!);
      void this.drop(stalest, 'caller session ceiling');
    }
  }

  /**
   * Keep `session` out of the idle sweep and of `reclaim` until `res` ends, or
   * until the call begun at `startedMs` outlives the request ceiling.
   */
  private pinWhileAnswering(session: Session, res: ServerResponse, startedMs: number): void {
    session.activePosts.set(res, startedMs);
    const finished = () => {
      session.activePosts.delete(res);
      session.lastSeenMs = this.now();
      res.off('finish', finished);
      res.off('close', finished);
    };
    res.once('finish', finished);
    res.once('close', finished);
  }

  private async drop(session: Session, reason: string): Promise<void> {
    this.sessions.delete(session.id);
    this.log(`session ${session.id.slice(0, 8)} closed (${reason})`);
    await session.transport.close().catch(() => {});
    await session.server.close().catch(() => {});
  }

  private async sweep(idleMs: number): Promise<void> {
    const cutoff = this.now() - idleMs;
    const requestCutoff = this.now() - (this.options.maxRequestMs ?? MCP_MAX_REQUEST_MS);
    for (const session of [...this.sessions.values()]) {
      // A call past the hard ceiling ends ALONE: its response is closed, and
      // the session keeps its other calls, its tasks and their results. Until
      // 2026-09-26 the whole session was dropped (review 2.11).
      for (const [res, started] of [...session.activePosts.entries()]) {
        if (started >= requestCutoff) continue;
        this.log(`session ${session.id.slice(0, 8)}: a response past the request ceiling was closed`);
        session.activePosts.delete(res);
        // It was answering until now: the idle clock restarts here, not at the
        // call's start ('close' fires after this loop has moved on).
        session.lastSeenMs = this.now();
        res.destroy();
      }
      if (session.activePosts.size === 0 && session.lastSeenMs < cutoff) await this.drop(session, 'idle');
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.unhookResourceEvents();
    await this.modern.close().catch(() => {});
    for (const pending of this.pending.values()) pending.close();
    this.pending.clear();
    for (const session of [...this.sessions.values()]) await this.drop(session, 'host closing');
  }
}

/** The write freeze's own answer, in the shape an MCP client reads. */
function frozenRefusal(res: ServerResponse): void {
  res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'deployment in progress; retry this request shortly' }, id: null }));
}

interface ListenRequest {
  readonly id?: unknown;
  readonly method: 'subscriptions/listen';
  readonly params: { readonly notifications: { readonly resourceSubscriptions?: unknown[] } & Record<string, unknown> } & Record<string, unknown>;
}

function isListen(body: unknown): body is ListenRequest {
  const message = body as { method?: unknown; params?: { notifications?: unknown } } | null;
  return !!message && typeof message === 'object' && !Array.isArray(message) && message.method === 'subscriptions/listen'
    && !!message.params?.notifications && typeof message.params.notifications === 'object';
}


/** A body this host cannot read — too large, cut off, or not JSON — answered as the SDK answers it. */
function unreadableBody(res: ServerResponse): void {
  res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: the body is not JSON, or is larger than the host reads' }, id: null }));
}

/**
 * The web `Request` the SDK's 2026 entry and `isLegacyRequest` read, built
 * from the headers alone: the body was read already and travels parsed.
 */
function webRequestOf(req: IncomingMessage, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(':') || name === 'content-length' || name === 'transfer-encoding') continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/mcp'}`, {
    method: req.method ?? 'POST', headers, ...(signal ? { signal } : {}),
  });
}

/** A web `Response` written to the Node one, streamed, and cancelled when the client goes. */
async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.once('close', () => { void reader.cancel().catch(() => {}); });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // The client went away mid-stream; nothing is owed to it any more.
  } finally {
    res.end();
  }
}

/** A JSON body of at most `limit` bytes, or undefined when it is larger, cut off or not JSON. */
async function readBoundedJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buffer.length;
      if (size > limit) return undefined;
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
