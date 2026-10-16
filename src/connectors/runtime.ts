import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ConnectorLaunchSet, McpCallFailure } from '../contracts/mcpConnectors.js';
import type { McpConnectorService } from '../tools/mcpConnectors.js';
import { openConnectorSession, type ConnectorSession } from './client.js';
import { ConnectorFetchError, connectorFetch, type FetchLike } from './guardedFetch.js';
import { openConnectorAuthority, type ConnectorAuthority } from './store.js';

/**
 * The run process's half: sessions to the connections the coordinator handed
 * it, opened on first use and reused for the run, plus the read-only
 * authority asked before every call. It never holds a refresh token, never
 * writes the store and never reads a secret column.
 */

export interface ConnectorRuntimeOptions {
  readonly launch: ConnectorLaunchSet;
  readonly authority: ConnectorAuthority;
  readonly fetch?: FetchLike;
}

export function connectorFailure(error: unknown): McpCallFailure {
  if (error instanceof UnauthorizedError) return 'unavailable';
  if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) return 'unavailable';
  if (error instanceof ConnectorFetchError && /timed out|cancelled/.test(error.message)) return 'timed_out';
  if (error instanceof Error && error.name === 'AbortError') return 'timed_out';
  if (error instanceof McpError && error.code === -32001) return 'timed_out';
  return 'failed';
}

/**
 * The model's message for a failure: never a URL, a path or a response body
 * (`Error POSTing to endpoint: <body>` can echo a secret path), only what
 * kind of failure it was.
 */
export function describeConnectorError(error: unknown): string {
  if (error instanceof UnauthorizedError) return 'the server refused the organisation\'s credential';
  if (error instanceof StreamableHTTPError) {
    return error.code === 401 || error.code === 403 ? 'the server refused the organisation\'s credential'
      : error.code ? `the server answered HTTP ${error.code}` : 'the server closed the connection';
  }
  if (error instanceof McpError) return `the server answered with an error (code ${error.code})`;
  if (error instanceof ConnectorFetchError) {
    return /timed out|cancelled/.test(error.message) ? 'the server did not answer in time'
      : /too large/.test(error.message) ? 'the server\'s answer was too large'
      : /public addresses|HTTPS/.test(error.message) ? 'the server address is not allowed' : 'the server is unreachable';
  }
  return 'the call failed';
}

export function createConnectorRuntime(options: ConnectorRuntimeOptions): McpConnectorService {
  const fetch = options.fetch ?? connectorFetch();
  const ready = new Map(options.launch.connectors.flatMap(connector =>
    connector.status === 'ready' ? [[connector.key, connector] as const] : []));
  const sessions = new Map<string, Promise<ConnectorSession>>();
  const launchedUrls = new Map(options.launch.connectors.flatMap(connector =>
    connector.status === 'ready' ? [[connector.serverId, connector.url] as const] : []));
  let disposed = false;

  const session = (key: string, signal: AbortSignal, timeoutMs: number): Promise<ConnectorSession> => {
    if (disposed) return Promise.reject(new Error('MCP connectors are closed'));
    const target = ready.get(key);
    if (!target) return Promise.reject(new Error('this server is not available in this run'));
    let opening = sessions.get(key);
    if (!opening) {
      opening = openConnectorSession({ url: target.url, headers: target.headers }, fetch, signal, timeoutMs);
      sessions.set(key, opening);
      // A failed open is forgotten, so the next call can try again.
      opening.catch(() => { if (sessions.get(key) === opening) sessions.delete(key); });
    }
    return opening;
  };

  /**
   * A protocol answer (`McpError`: unknown tool, invalid params, a request
   * timeout) keeps the session; anything else is the transport, and the
   * next call reconnects.
   */
  const withSession = async <T>(key: string, signal: AbortSignal, timeoutMs: number, work: (s: ConnectorSession) => Promise<T>): Promise<T> => {
    const opening = session(key, signal, timeoutMs);
    const current = await opening;
    try { return await work(current); }
    catch (error) {
      if (!(error instanceof McpError) && sessions.get(key) === opening) {
        sessions.delete(key);
        void current.close().catch(() => {});
      }
      throw error;
    }
  };

  return {
    servers: options.launch.connectors.map(connector => ({
      key: connector.key, name: connector.name, serverId: connector.serverId, status: connector.status,
      ...(connector.status === 'unavailable' ? { reason: connector.reason } : {}),
    })),
    // The URL the run was launched with must still be the connection's.
    authorize: (serverId, tool) => options.authority.allowed(serverId, tool, launchedUrls.get(serverId)),
    disabledTools: serverId => options.authority.disabledTools(serverId),
    listTools: (key, signal, timeoutMs) => withSession(key, signal, timeoutMs, s => s.listTools(signal, timeoutMs)),
    callTool: (key, tool, args, signal, timeoutMs) => withSession(key, signal, timeoutMs, s => s.callTool(tool, args, signal, timeoutMs)),
    failureOf: connectorFailure,
    describe: describeConnectorError,
    async dispose() {
      disposed = true;
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map(async opening => (await opening).close()));
      options.authority.close();
    },
  };
}

export function openConnectorRuntime(dbPath: string, launch: ConnectorLaunchSet, fetch?: FetchLike): McpConnectorService {
  return createConnectorRuntime({ launch, authority: openConnectorAuthority(dbPath, launch.orgId, launch.projectId), ...(fetch ? { fetch } : {}) });
}
