import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult, type Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { MAX_DISCOVERED_TOOLS, type ConnectorToolSnapshot } from '../contracts/mcpConnectors.js';
import type { FetchLike } from './guardedFetch.js';

/**
 * One MCP client session to a customer's server, over the guarded fetch.
 * Credentials arrive as ready header values: the session never refreshes a
 * token itself, so the one writer of a rotating refresh token stays the
 * server process's `ConnectorOAuth`.
 */

const MAX_LIST_PAGES = 10;

export interface ConnectorTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ConnectorSession {
  listTools(signal: AbortSignal, timeoutMs: number): Promise<{ tools: McpTool[]; truncated: boolean }>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<CallToolResult>;
  close(): Promise<void>;
}

export async function openConnectorSession(target: ConnectorTarget, fetch: FetchLike, signal: AbortSignal, timeoutMs: number): Promise<ConnectorSession> {
  const client = new Client({ name: 'atoma', version: '1' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: { headers: { ...target.headers }, redirect: 'manual' },
    fetch: (input, init) => fetch(input, init),
  });
  try {
    await client.connect(transport, { signal, timeout: timeoutMs });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return {
    async listTools(callSignal, callTimeout) {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, { signal: callSignal, timeout: callTimeout });
        tools.push(...result.tools);
        if (tools.length >= MAX_DISCOVERED_TOOLS) return { tools: tools.slice(0, MAX_DISCOVERED_TOOLS), truncated: true };
        cursor = result.nextCursor;
        if (!cursor) return { tools, truncated: false };
      }
      return { tools, truncated: true };
    },
    async callTool(name, args, callSignal, callTimeout) {
      const result = await client.callTool({ name, arguments: args }, CallToolResultSchema,
        { signal: callSignal, timeout: callTimeout, maxTotalTimeout: callTimeout });
      return CallToolResultSchema.parse(result);
    },
    async close() {
      try { await transport.terminateSession(); } catch { /* the server may not support DELETE */ }
      await client.close().catch(() => {});
    },
  };
}

/** What Settings stores about a discovered tool: no schema, bounded text. */
export function toolSnapshot(tool: McpTool): ConnectorToolSnapshot {
  // Control characters other than tab and line breaks are a server's noise, never copy.
  const printable = (value: string): string => Array.from(value).filter(character => {
    const code = character.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join('');
  const text = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' && value.trim() ? printable(value).slice(0, max) : undefined;
  const title = text(tool.title ?? tool.annotations?.title, 200);
  const description = text(tool.description, 1_000);
  return {
    name: tool.name.slice(0, 128),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(typeof tool.annotations?.readOnlyHint === 'boolean' ? { readOnly: tool.annotations.readOnlyHint } : {}),
    ...(typeof tool.annotations?.destructiveHint === 'boolean' ? { destructive: tool.annotations.destructiveHint } : {}),
  };
}

/** The header a credential becomes. */
export function credentialHeaders(credential:
  | { kind: 'none' }
  | { kind: 'header'; name: string; value: string }
  | { kind: 'bearer'; token: string; tokenType: string }): Record<string, string> {
  if (credential.kind === 'header') return { [credential.name]: credential.value };
  if (credential.kind === 'bearer') {
    // RFC 6750: the scheme is "Bearer" whatever case the server reported it in.
    const scheme = credential.tokenType.toLowerCase() === 'bearer' ? 'Bearer' : credential.tokenType;
    return { Authorization: `${scheme} ${credential.token}` };
  }
  return {};
}
