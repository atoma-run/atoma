import type { McpServer } from '@modelcontextprotocol/server';

/**
 * WHAT AN MCP CALL MAY DO WHILE A DEPLOYMENT HOLDS WRITES.
 *
 * The write freeze (`src/viz/deployment.ts`) keeps a new run, preview or
 * durable write out of the gap before the old generation stops. It used to
 * refuse every `/mcp` POST, and every MCP message is a POST — so a client
 * reading a verdict or listing its tools during the minute of an activation
 * was answered 503 like a run start (2026-09-28). Reading is not what the
 * freeze exists to stop.
 *
 * A message passes when it starts nothing: the protocol's own opening, pings,
 * notifications, listings and reads, a task's status or result, and a
 * `tools/call` of a tool this session registered with `readOnlyHint: true` —
 * the very annotation the client is shown, never a second list. Anything else,
 * `tasks/cancel` and a call this host cannot classify included, waits.
 */
const READ_ONLY_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'prompts/list',
  'prompts/get',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
  'completion/complete',
  'logging/setLevel',
  'tasks/get',
  'tasks/list',
  'tasks/result',
  // 2026-07-28: the opening is a discovery, change notifications a listen
  // stream, and `tasks/update` an acknowledgement (no task here asks for input).
  'server/discover',
  'subscriptions/listen',
  'tasks/update',
]);

/** The largest body read to classify it; past it the call simply waits. */
export const FROZEN_BODY_LIMIT_BYTES = 1024 * 1024;

type RegisteredTools = Record<string, { annotations?: { readOnlyHint?: boolean } } | undefined>;

/**
 * The SDK keeps a session's tools in `_registeredTools`, the map its own
 * `tools/list` and `tools/call` read. A release that renames it classifies no
 * tool as read-only — every call then waits, the old behaviour — and
 * `tests/mcp-frozen.test.ts` fails first.
 */
function toolIsReadOnly(server: McpServer, name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const tools = (server as unknown as { _registeredTools?: RegisteredTools })._registeredTools;
  return tools?.[name]?.annotations?.readOnlyHint === true;
}

/** Whether every JSON-RPC message in `body` may be served while writes are frozen. */
export function servableWhileFrozen(server: McpServer, body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return false;
  return messages.every((message) => {
    if (!message || typeof message !== 'object') return false;
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
    // A response the client sends back to a request of ours starts nothing.
    if (method === undefined) return 'result' in message || 'error' in message;
    if (typeof method !== 'string') return false;
    if (method.startsWith('notifications/')) return true;
    if (READ_ONLY_METHODS.has(method)) return true;
    return method === 'tools/call' && toolIsReadOnly(server, params?.name);
  });
}
