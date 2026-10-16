import { z } from 'zod';
import { HOST_TOOL_NAMES } from './toolTaxonomy.js';

/**
 * CUSTOMER MCP SERVERS ("connectors"): one schema per shape, shared by the
 * organisation store, the HTTP doors, the coordinator's launch hand-off and
 * the run's two host elements. Contract:
 * docs/decisions/customer-mcp-servers-2026-10-16.md.
 */

export const MCP_LIST_TOOL_NAME = HOST_TOOL_NAMES[1];
export const MCP_CALL_TOOL_NAME = HOST_TOOL_NAMES[2];
export const MCP_CONNECTOR_TOOL_NAMES = [MCP_LIST_TOOL_NAME, MCP_CALL_TOOL_NAME] as const;

/** The run process reads its connections here; the coordinator alone writes it. */
export const MCP_CONNECTORS_ENV = 'ATOMA_MCP_CONNECTORS';

export const MAX_ORG_MCP_SERVERS = 20;
export const MAX_DISCOVERED_TOOLS = 200;

/** The handle a run names a server by: stable, short, unique per organisation. */
export const connectorKeySchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'use 2-32 lowercase letters, digits or hyphens, starting with a letter');
export const connectorIdSchema = z.string().uuid();
export const connectorNameSchema = z.string().trim().min(1).max(60)
  .refine(value => Array.from(value).every(character => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  }), 'name has control characters');
export const connectorAuthKindSchema = z.enum(['none', 'header', 'oauth']);
export type ConnectorAuthKind = z.infer<typeof connectorAuthKindSchema>;

/**
 * Header names a connector may set. Protocol and hop-by-hop headers belong
 * to the transport: an organisation that could set `host` or
 * `mcp-session-id` could make the host speak to someone else, or as someone
 * else, on the same connection.
 */
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding', 'te', 'trailer',
  'upgrade', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'mcp-session-id', 'mcp-protocol-version',
  'last-event-id', 'expect', 'user-agent',
]);
export const connectorHeaderNameSchema = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, 'not a valid header name')
  .refine(name => !RESERVED_HEADERS.has(name.toLowerCase()), 'this header is set by the MCP transport');
/** Printable ASCII and spaces, no line breaks: a header value. */
export const connectorSecretSchema = z.string().min(1).max(8_192)
  .refine(value => /^[\x20-\x7e]+$/.test(value) && value.trim() === value, 'secret must be printable ASCII without surrounding spaces');

export const connectorToolSnapshotSchema = z.object({
  name: z.string().min(1).max(128),
  title: z.string().max(200).optional(),
  description: z.string().max(1_000).optional(),
  readOnly: z.boolean().optional(),
  destructive: z.boolean().optional(),
}).strict();
export type ConnectorToolSnapshot = z.infer<typeof connectorToolSnapshotSchema>;

/** Settings write: create. Secrets are write-only and never read back. */
export const connectorCreateInputSchema = z.object({
  key: connectorKeySchema,
  name: connectorNameSchema,
  url: z.string().min(1).max(2_048),
  authKind: connectorAuthKindSchema,
  headerName: connectorHeaderNameSchema.optional(),
  headerValue: connectorSecretSchema.optional(),
  oauthClientId: z.string().trim().min(1).max(512).optional(),
  oauthClientSecret: connectorSecretSchema.optional(),
  oauthScope: z.string().trim().max(1_000).optional(),
}).strict();
export type ConnectorCreateInput = z.infer<typeof connectorCreateInputSchema>;

/**
 * Settings write: edit. `expectedRevision` is the stale-write guard. A
 * changed URL or auth kind forgets every stored credential: a token minted
 * for one server is never presented to another.
 */
export const connectorUpdateInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: connectorNameSchema.optional(),
  url: z.string().min(1).max(2_048).optional(),
  authKind: connectorAuthKindSchema.optional(),
  headerName: connectorHeaderNameSchema.optional(),
  headerValue: connectorSecretSchema.optional(),
  oauthClientId: z.string().trim().max(512).optional(),
  oauthClientSecret: connectorSecretSchema.optional(),
  oauthScope: z.string().trim().max(1_000).optional(),
  disabledTools: z.array(z.string().min(1).max(128)).max(MAX_DISCOVERED_TOOLS).optional(),
}).strict();
export type ConnectorUpdateInput = z.infer<typeof connectorUpdateInputSchema>;

export const connectorStatusSchema = z.enum(['ready', 'authorization_required', 'secret_unavailable']);

/** What Settings shows. `url`/`headerName` only for those who manage connections. */
export const connectorViewSchema = z.object({
  id: connectorIdSchema,
  key: connectorKeySchema,
  name: z.string(),
  host: z.string(),
  url: z.string().optional(),
  authKind: connectorAuthKindSchema,
  headerName: z.string().optional(),
  hasHeaderSecret: z.boolean(),
  oauthClientId: z.string().optional(),
  hasOauthClientSecret: z.boolean(),
  oauthScope: z.string().optional(),
  oauthConnected: z.boolean(),
  status: connectorStatusSchema,
  tools: z.array(connectorToolSnapshotSchema),
  toolsRefreshedAt: z.string().nullable(),
  toolsError: z.string().nullable(),
  disabledTools: z.array(z.string()),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type ConnectorView = z.infer<typeof connectorViewSchema>;

/** Project settings write: the complete enabled set, with its stale-write guard. */
export const projectConnectorsInputSchema = z.object({
  serverIds: z.array(connectorIdSchema).max(MAX_ORG_MCP_SERVERS),
  expectedServerIds: z.array(connectorIdSchema).max(MAX_ORG_MCP_SERVERS),
}).strict();
export type ProjectConnectorsInput = z.infer<typeof projectConnectorsInputSchema>;

export const connectorUnavailableReasonSchema = z.enum([
  'authorization_required', 'authorization_failed', 'secret_unavailable', 'unreachable',
]);
export type ConnectorUnavailableReason = z.infer<typeof connectorUnavailableReasonSchema>;

/**
 * One connection as the run process receives it. Host construction only: no
 * field is a model argument, and `headers` never reaches the worker.
 */
export const connectorLaunchSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    serverId: connectorIdSchema,
    key: connectorKeySchema,
    name: z.string().max(60),
    url: z.string().max(2_048),
    headers: z.record(z.string(), z.string().max(8_192)).refine(h => Object.keys(h).length <= 2),
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    serverId: connectorIdSchema,
    key: connectorKeySchema,
    name: z.string().max(60),
    reason: connectorUnavailableReasonSchema,
  }).strict(),
]);
export type ConnectorLaunch = z.infer<typeof connectorLaunchSchema>;

export const connectorLaunchSetSchema = z.object({
  version: z.literal(1),
  orgId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  connectors: z.array(connectorLaunchSchema).min(1).max(MAX_ORG_MCP_SERVERS),
}).strict();
export type ConnectorLaunchSet = z.infer<typeof connectorLaunchSetSchema>;

export function encodeConnectorLaunch(set: ConnectorLaunchSet): string {
  return JSON.stringify(connectorLaunchSetSchema.parse(set));
}

/** `null` when absent; a present but malformed value throws (fail closed). */
export function decodeConnectorLaunch(raw: string | undefined): ConnectorLaunchSet | null {
  if (raw === undefined || raw === '') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${MCP_CONNECTORS_ENV} is not valid JSON`); }
  const result = connectorLaunchSetSchema.safeParse(parsed);
  if (!result.success) throw new Error(`${MCP_CONNECTORS_ENV} has an invalid shape`);
  const keys = new Set<string>();
  for (const connector of result.data.connectors) {
    if (keys.has(connector.key)) throw new Error(`${MCP_CONNECTORS_ENV} names a server twice`);
    keys.add(connector.key);
  }
  return result.data;
}

/* ---------------------------------------------------------------- elements */

export const mcpListRequestSchema = z.object({
  server: connectorKeySchema.optional(),
}).strict();

export const mcpCallRequestSchema = z.object({
  server: connectorKeySchema,
  tool: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type McpCallRequest = z.infer<typeof mcpCallRequestSchema>;

export const MCP_CALL_FAILURES = [
  'invalid_request', 'unknown_server', 'unknown_tool', 'tool_disabled', 'denied',
  'unavailable', 'timed_out', 'cancelled', 'failed', 'duplicate',
] as const;
export type McpCallFailure = typeof MCP_CALL_FAILURES[number];

export interface McpListedTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly readOnly?: boolean;
}

export type McpListedServer =
  | { readonly server: string; readonly name: string; readonly status: 'ready'; readonly tools: readonly McpListedTool[]; readonly truncated?: true }
  | { readonly server: string; readonly name: string; readonly status: 'unavailable'; readonly reason: string };

export type McpListResponse =
  | { readonly ok: true; readonly servers: readonly McpListedServer[]; readonly changesThisRun?: readonly McpRecordedChange[] }
  | { readonly ok: false; readonly status: McpCallFailure; readonly message?: string };

/** A call this run already made that may have changed the organisation's system. */
export interface McpRecordedChange {
  readonly server: string;
  readonly tool: string;
  readonly at: string;
  readonly arguments: unknown;
}

export type McpCallResponse =
  | {
      readonly ok: true;
      readonly server: string;
      readonly tool: string;
      /** The server's own error flag: the tool ran and reported failure. */
      readonly isError: boolean;
      readonly content: readonly unknown[];
      readonly structuredContent?: unknown;
      readonly truncated?: true;
    }
  | { readonly ok: false; readonly status: McpCallFailure; readonly message?: string; readonly previous?: unknown };

export interface McpConnectorLimits {
  readonly callTimeoutMs: number;
  readonly listTimeoutMs: number;
  readonly maxResultBytes: number;
  readonly maxListBytes: number;
}

export const DEFAULT_MCP_CONNECTOR_LIMITS: McpConnectorLimits = Object.freeze({
  /** One tools/call, connection included. */
  callTimeoutMs: 90_000,
  /** One tools/list per server. */
  listTimeoutMs: 30_000,
  /** The serialised result handed to the model, before transport truncation. */
  maxResultBytes: 60_000,
  /** The whole list_mcp_tools answer. */
  maxListBytes: 60_000,
});
