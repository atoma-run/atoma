import Database from 'better-sqlite3';
import { withStoreMutex } from '../platform/storeMutex.js';
import { createHash, randomUUID } from 'node:crypto';
import { openStoreHandle } from '../core/stores.js';
import { decryptBoundSecret, encryptBoundSecret } from '../core/secretCrypto.js';
import type { SecretEncryptionContext } from '../auth/secretEncryption.js';
import {
  MAX_DISCOVERED_TOOLS, MAX_ORG_MCP_SERVERS, connectorCreateInputSchema, connectorToolSnapshotSchema,
  connectorUpdateInputSchema, projectConnectorsInputSchema,
  type ConnectorAuthKind, type ConnectorCreateInput, type ConnectorToolSnapshot, type ConnectorUpdateInput,
  type ConnectorView, type ProjectConnectorsInput,
} from '../contracts/mcpConnectors.js';
import { connectorUrl } from './guardedFetch.js';

/**
 * ORGANISATION MCP CONNECTIONS AND THEIR PROJECT AVAILABILITY.
 * ============================================================
 *
 * Two tables in the primary product store. Secret material (a header value,
 * an OAuth client secret, a dynamic registration, tokens) is an AES-256-GCM
 * envelope under the operator's secret-encryption key, bound by its AAD to
 * the organisation, the connection, the field, the URL and the key id: a row
 * copied to another organisation or edited to point at another URL fails
 * authentication instead of presenting one server's credential to another.
 *
 * The references are enforced (better-sqlite3 enables foreign keys): a
 * connection belongs to an existing organisation, a project's availability
 * to an existing project of the SAME organisation. `remove` still deletes
 * the availability rows itself, so the cascade does not depend on a pragma.
 */

export const CONNECTORS_DDL = `CREATE TABLE IF NOT EXISTS org_mcp_servers (
 server_id TEXT PRIMARY KEY,
 org_id TEXT NOT NULL REFERENCES auth_organisations(org_id),
 server_key TEXT NOT NULL,
 name TEXT NOT NULL,
 url TEXT NOT NULL,
 auth_kind TEXT NOT NULL CHECK(auth_kind IN ('none','header','oauth')),
 header_name TEXT,
 header_secret TEXT,
 oauth_client_id TEXT,
 oauth_client_secret TEXT,
 oauth_scope TEXT,
 oauth_client TEXT,
 oauth_tokens TEXT,
 oauth_tokens_expire_at TEXT,
 oauth_discovery TEXT CHECK(oauth_discovery IS NULL OR json_valid(oauth_discovery)),
 tools TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tools)),
 tools_refreshed_at TEXT,
 tools_error TEXT,
 disabled_tools TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(disabled_tools)),
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 created_by TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(org_id, server_key)
);
CREATE TABLE IF NOT EXISTS project_mcp_servers (
 project_id TEXT NOT NULL,
 org_id TEXT NOT NULL,
 server_id TEXT NOT NULL REFERENCES org_mcp_servers(server_id) ON DELETE CASCADE,
 enabled_at TEXT NOT NULL,
 enabled_by TEXT NOT NULL,
 PRIMARY KEY(project_id, server_id),
 FOREIGN KEY(project_id, org_id) REFERENCES projects(project_id, org_id)
);
CREATE INDEX IF NOT EXISTS project_mcp_servers_server ON project_mcp_servers(server_id);`;

export class ConnectorInputError extends Error {}
export class ConnectorConflict extends Error {}

type SecretField = 'header' | 'client-secret' | 'client' | 'tokens';

export interface ConnectorRow {
  readonly server_id: string;
  readonly org_id: string;
  readonly server_key: string;
  readonly name: string;
  readonly url: string;
  readonly auth_kind: ConnectorAuthKind;
  readonly header_name: string | null;
  readonly header_secret: string | null;
  readonly oauth_client_id: string | null;
  readonly oauth_client_secret: string | null;
  readonly oauth_scope: string | null;
  readonly oauth_client: string | null;
  readonly oauth_tokens: string | null;
  readonly oauth_tokens_expire_at: string | null;
  readonly oauth_discovery: string | null;
  readonly tools: string;
  readonly tools_refreshed_at: string | null;
  readonly tools_error: string | null;
  readonly disabled_tools: string;
  readonly revision: number;
  readonly created_at: string;
  readonly created_by: string;
  readonly updated_at: string;
}

/** The ADDITIONAL AUTHENTICATED DATA sentence for one secret field of one connection. */
export function connectorSecretAad(input: {
  readonly orgId: string; readonly serverId: string; readonly field: SecretField;
  readonly url: string; readonly keyId: string;
}): string {
  const urlDigest = createHash('sha256').update(input.url, 'utf8').digest('base64url');
  const parts = [input.orgId, input.serverId, input.field, urlDigest, input.keyId];
  if (parts.some(part => !part || part.length > 255 || /[\s:]/.test(part))) {
    throw new Error('connector secret binding has an invalid value');
  }
  return `atoma:mcp-connector:v1:${parts.join(':')}`;
}

function parseJsonArray<T>(raw: string, parse: (value: unknown) => T | null): T[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.map(parse).filter((item): item is T => item !== null);
  } catch { return []; }
}

export function rowTools(row: ConnectorRow): ConnectorToolSnapshot[] {
  return parseJsonArray(row.tools, value => {
    const parsed = connectorToolSnapshotSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
}

export function rowDisabledTools(row: ConnectorRow): string[] {
  return parseJsonArray(row.disabled_tools, value => typeof value === 'string' ? value : null);
}

/** The hostname alone: a path or query may itself be a credential. */
export function connectorHost(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

export function connectorStatus(row: ConnectorRow, encryption: SecretEncryptionContext | null): ConnectorView['status'] {
  if (row.auth_kind === 'header') return encryption && row.header_secret ? 'ready' : 'secret_unavailable';
  if (row.auth_kind === 'oauth') {
    if (!encryption) return 'secret_unavailable';
    return row.oauth_tokens ? 'ready' : 'authorization_required';
  }
  return 'ready';
}

/** Settings' projection. Only a manager sees the URL, the header name and the OAuth client id. */
export function connectorView(row: ConnectorRow, manage: boolean, encryption: SecretEncryptionContext | null): ConnectorView {
  return {
    id: row.server_id,
    key: row.server_key,
    name: row.name,
    host: connectorHost(row.url),
    ...(manage ? { url: row.url } : {}),
    authKind: row.auth_kind,
    ...(manage && row.header_name ? { headerName: row.header_name } : {}),
    hasHeaderSecret: row.header_secret !== null,
    ...(manage && row.oauth_client_id ? { oauthClientId: row.oauth_client_id } : {}),
    hasOauthClientSecret: row.oauth_client_secret !== null,
    ...(manage && row.oauth_scope ? { oauthScope: row.oauth_scope } : {}),
    oauthConnected: row.oauth_tokens !== null,
    status: connectorStatus(row, encryption),
    tools: rowTools(row),
    toolsRefreshedAt: row.tools_refreshed_at,
    toolsError: row.tools_error,
    disabledTools: rowDisabledTools(row),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ConnectorStoreOptions {
  /** Tests only: admit plain-HTTP loopback URLs. Never read from configuration. */
  readonly loopbackForTests?: boolean;
  readonly now?: () => Date;
}

export class ConnectorStore {
  private readonly now: () => Date;
  constructor(private readonly db: Database.Database, private readonly options: ConnectorStoreOptions = {}) {
    db.exec(CONNECTORS_DDL);
    this.now = options.now ?? (() => new Date());
  }

  static open(file: string, options: ConnectorStoreOptions = {}): ConnectorStore {
    return new ConnectorStore(openStoreHandle(file, CONNECTORS_DDL), options);
  }

  private stamp(): string { return this.now().toISOString(); }
  serializeOAuth<T>(orgId: string, serverId: string, work: () => Promise<T>): Promise<T> {
    return withStoreMutex(this.db, `connector:${orgId}:${serverId}`, work);
  }

  private validUrl(raw: string): string {
    const url = connectorUrl(raw, { loopbackForTests: this.options.loopbackForTests === true });
    if (!url) throw new ConnectorInputError('The server URL must be an HTTPS address without a user name, password or fragment.');
    return url.href;
  }

  list(orgId: string): ConnectorRow[] {
    return this.db.prepare('SELECT * FROM org_mcp_servers WHERE org_id = ? ORDER BY name COLLATE NOCASE, server_id').all(orgId) as ConnectorRow[];
  }

  get(orgId: string, serverId: string): ConnectorRow | null {
    return (this.db.prepare('SELECT * FROM org_mcp_servers WHERE org_id = ? AND server_id = ?').get(orgId, serverId) as ConnectorRow | undefined) ?? null;
  }

  private seal(row: { org_id: string; server_id: string; url: string }, field: SecretField, plaintext: string, encryption: SecretEncryptionContext): string {
    return JSON.stringify(encryptBoundSecret({
      plaintext, key: encryption.key, keyId: encryption.keyId,
      aad: connectorSecretAad({ orgId: row.org_id, serverId: row.server_id, field, url: row.url, keyId: encryption.keyId }),
    }));
  }

  /** `null` when absent, undecryptable or tampered with: fail closed, warn once on stderr. */
  open(row: ConnectorRow, field: SecretField, encryption: SecretEncryptionContext | null): string | null {
    const column = { header: row.header_secret, 'client-secret': row.oauth_client_secret, client: row.oauth_client, tokens: row.oauth_tokens }[field];
    if (!column || !encryption) return null;
    try {
      return decryptBoundSecret({
        envelope: column, key: encryption.key, keyId: encryption.keyId,
        aad: connectorSecretAad({ orgId: row.org_id, serverId: row.server_id, field, url: row.url, keyId: encryption.keyId }),
      });
    } catch {
      process.stderr.write(`[atoma connectors] stored ${field} of connection ${row.server_id} could not be decrypted\n`);
      return null;
    }
  }

  create(orgId: string, actorId: string, raw: ConnectorCreateInput, encryption: SecretEncryptionContext | null): ConnectorRow {
    const parsed = connectorCreateInputSchema.safeParse(raw);
    if (!parsed.success) throw new ConnectorInputError(parsed.error.issues[0]?.message ?? 'invalid connection');
    const input = parsed.data;
    const url = this.validUrl(input.url);
    const needsSecret = (input.authKind === 'header' && input.headerValue !== undefined) || input.oauthClientSecret !== undefined;
    if (input.authKind === 'header' && (input.headerValue === undefined)) {
      throw new ConnectorInputError('A header connection needs the header value.');
    }
    if (needsSecret && !encryption) {
      throw new ConnectorInputError('Secret storage is not configured on this instance; ask the operator to set ATOMA_SECRET_ENCRYPTION_KEY.');
    }
    const serverId = randomUUID();
    const at = this.stamp();
    const base = { org_id: orgId, server_id: serverId, url };
    return this.db.transaction(() => {
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM org_mcp_servers WHERE org_id = ?').get(orgId) as { n: number }).n;
      if (count >= MAX_ORG_MCP_SERVERS) throw new ConnectorConflict(`An organisation can connect at most ${MAX_ORG_MCP_SERVERS} MCP servers.`);
      if (this.db.prepare('SELECT 1 FROM org_mcp_servers WHERE org_id = ? AND server_key = ?').get(orgId, input.key)) {
        throw new ConnectorConflict(`Another connection already uses the identifier "${input.key}".`);
      }
      this.db.prepare(`INSERT INTO org_mcp_servers (server_id, org_id, server_key, name, url, auth_kind, header_name, header_secret,
        oauth_client_id, oauth_client_secret, oauth_scope, created_at, created_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        serverId, orgId, input.key, input.name, url, input.authKind,
        input.authKind === 'header' ? (input.headerName ?? 'Authorization') : null,
        input.authKind === 'header' && input.headerValue !== undefined ? this.seal(base, 'header', input.headerValue, encryption!) : null,
        input.authKind === 'oauth' ? (input.oauthClientId ?? null) : null,
        input.authKind === 'oauth' && input.oauthClientSecret !== undefined ? this.seal(base, 'client-secret', input.oauthClientSecret, encryption!) : null,
        input.authKind === 'oauth' ? (input.oauthScope || null) : null,
        at, actorId, at);
      return this.get(orgId, serverId)!;
    }).immediate();
  }

  /**
   * Edit with a revision guard. A new URL or auth kind forgets every stored
   * credential, registration and discovery: a token minted for one server is
   * never presented to another, and its envelopes would not decrypt anyway.
   */
  update(orgId: string, serverId: string, raw: ConnectorUpdateInput, encryption: SecretEncryptionContext | null): { before: ConnectorRow; after: ConnectorRow } | null {
    const parsed = connectorUpdateInputSchema.safeParse(raw);
    if (!parsed.success) throw new ConnectorInputError(parsed.error.issues[0]?.message ?? 'invalid connection');
    const input = parsed.data;
    return this.db.transaction(() => {
      const before = this.get(orgId, serverId);
      if (!before) return null;
      if (before.revision !== input.expectedRevision) throw new ConnectorConflict('This connection changed; reload before saving.');
      const url = input.url !== undefined ? this.validUrl(input.url) : before.url;
      const authKind = input.authKind ?? before.auth_kind;
      const reset = url !== before.url || authKind !== before.auth_kind;
      const base = { org_id: orgId, server_id: serverId, url };
      const wantsSecret = input.headerValue !== undefined || input.oauthClientSecret !== undefined;
      if (wantsSecret && !encryption) throw new ConnectorInputError('Secret storage is not configured on this instance.');
      // A kept envelope is bound to the URL; a reset drops it whatever the caller sent.
      let headerSecret = reset ? null : before.header_secret;
      if (authKind === 'header' && input.headerValue !== undefined) headerSecret = this.seal(base, 'header', input.headerValue, encryption!);
      if (authKind !== 'header') headerSecret = null;
      if (authKind === 'header' && headerSecret === null) throw new ConnectorInputError('A header connection needs the header value.');
      const clientIdChanged = input.oauthClientId !== undefined && (input.oauthClientId || null) !== before.oauth_client_id;
      let clientSecret = reset || clientIdChanged ? null : before.oauth_client_secret;
      if (authKind === 'oauth' && input.oauthClientSecret !== undefined) clientSecret = this.seal(base, 'client-secret', input.oauthClientSecret, encryption!);
      if (authKind !== 'oauth') clientSecret = null;
      // A different client identity invalidates the registration and the tokens issued to it.
      const forgetOauth = reset || clientIdChanged || authKind !== 'oauth';
      // Any name may be switched off, listed or not: a tool the server adds after
      // the last discovery, or one of a server whose discovery failed.
      const disabled = input.disabledTools !== undefined
        ? [...new Set(input.disabledTools)].slice(0, MAX_DISCOVERED_TOOLS)
        : rowDisabledTools(before);
      this.db.prepare(`UPDATE org_mcp_servers SET name = ?, url = ?, auth_kind = ?, header_name = ?, header_secret = ?,
        oauth_client_id = ?, oauth_client_secret = ?, oauth_scope = ?,
        oauth_client = ?, oauth_tokens = ?, oauth_tokens_expire_at = ?, oauth_discovery = ?,
        tools = ?, tools_refreshed_at = ?, tools_error = ?, disabled_tools = ?,
        revision = revision + 1, updated_at = ? WHERE org_id = ? AND server_id = ?`).run(
        input.name ?? before.name, url, authKind,
        authKind === 'header' ? (input.headerName ?? before.header_name ?? 'Authorization') : null,
        headerSecret,
        authKind === 'oauth' ? (input.oauthClientId !== undefined ? (input.oauthClientId || null) : before.oauth_client_id) : null,
        clientSecret,
        authKind === 'oauth' ? (input.oauthScope !== undefined ? (input.oauthScope || null) : before.oauth_scope) : null,
        forgetOauth ? null : before.oauth_client,
        forgetOauth ? null : before.oauth_tokens,
        forgetOauth ? null : before.oauth_tokens_expire_at,
        forgetOauth ? null : before.oauth_discovery,
        reset ? '[]' : before.tools,
        reset ? null : before.tools_refreshed_at,
        reset ? null : before.tools_error,
        JSON.stringify(reset ? [] : disabled),
        this.stamp(), orgId, serverId);
      return { before, after: this.get(orgId, serverId)! };
    }).immediate();
  }

  /** Removes the connection and every project's availability of it, in one transaction. */
  remove(orgId: string, serverId: string): ConnectorRow | null {
    return this.db.transaction(() => {
      const before = this.get(orgId, serverId);
      if (!before) return null;
      this.db.prepare('DELETE FROM project_mcp_servers WHERE org_id = ? AND server_id = ?').run(orgId, serverId);
      this.db.prepare('DELETE FROM org_mcp_servers WHERE org_id = ? AND server_id = ?').run(orgId, serverId);
      return before;
    }).immediate();
  }

  /** The discovered list. Disabled names that no longer exist are kept: a tool may come back. */
  setTools(orgId: string, serverId: string, tools: readonly ConnectorToolSnapshot[] | null, error: string | null): void {
    const at = this.stamp();
    if (tools) {
      const bounded = tools.slice(0, MAX_DISCOVERED_TOOLS).map(tool => connectorToolSnapshotSchema.parse(tool));
      this.db.prepare('UPDATE org_mcp_servers SET tools = ?, tools_refreshed_at = ?, tools_error = NULL WHERE org_id = ? AND server_id = ?')
        .run(JSON.stringify(bounded), at, orgId, serverId);
    } else {
      this.db.prepare('UPDATE org_mcp_servers SET tools_error = ? WHERE org_id = ? AND server_id = ?')
        .run((error ?? 'unavailable').slice(0, 500), orgId, serverId);
    }
  }

  /* ------------------------------------------------------------ OAuth */

  /**
   * Every OAuth write is guarded by the URL it was obtained for: a write that
   * lands after an admin pointed the connection elsewhere changes nothing.
   */
  saveOauthClient(row: ConnectorRow, clientJson: string, encryption: SecretEncryptionContext): boolean {
    return this.db.prepare('UPDATE org_mcp_servers SET oauth_client = ? WHERE org_id = ? AND server_id = ? AND url = ? AND auth_kind = ?')
      .run(this.seal(row, 'client', clientJson, encryption), row.org_id, row.server_id, row.url, 'oauth').changes === 1;
  }

  saveOauthTokens(row: ConnectorRow, tokensJson: string, expiresAt: string | null, encryption: SecretEncryptionContext): boolean {
    return this.db.prepare('UPDATE org_mcp_servers SET oauth_tokens = ?, oauth_tokens_expire_at = ? WHERE org_id = ? AND server_id = ? AND url = ? AND auth_kind = ?')
      .run(this.seal(row, 'tokens', tokensJson, encryption), expiresAt, row.org_id, row.server_id, row.url, 'oauth').changes === 1;
  }

  saveOauthDiscovery(row: ConnectorRow, discoveryJson: string | null): void {
    this.db.prepare('UPDATE org_mcp_servers SET oauth_discovery = ? WHERE org_id = ? AND server_id = ? AND url = ?')
      .run(discoveryJson, row.org_id, row.server_id, row.url);
  }

  /** `scope` mirrors the SDK's invalidation vocabulary. */
  forgetOauth(row: ConnectorRow, scope: 'all' | 'client' | 'tokens' | 'discovery'): void {
    const sets = {
      all: 'oauth_client = NULL, oauth_tokens = NULL, oauth_tokens_expire_at = NULL, oauth_discovery = NULL',
      client: 'oauth_client = NULL, oauth_tokens = NULL, oauth_tokens_expire_at = NULL',
      tokens: 'oauth_tokens = NULL, oauth_tokens_expire_at = NULL',
      discovery: 'oauth_discovery = NULL',
    }[scope];
    this.db.prepare(`UPDATE org_mcp_servers SET ${sets} WHERE org_id = ? AND server_id = ? AND url = ?`).run(row.org_id, row.server_id, row.url);
  }

  /* --------------------------------------------------- project availability */

  projectServerIds(orgId: string, projectId: string): string[] {
    return (this.db.prepare(`SELECT p.server_id FROM project_mcp_servers p JOIN org_mcp_servers s
      ON s.server_id = p.server_id AND s.org_id = p.org_id WHERE p.org_id = ? AND p.project_id = ? ORDER BY p.server_id`)
      .all(orgId, projectId) as { server_id: string }[]).map(row => row.server_id);
  }

  /**
   * Replace the project's enabled set, compare-and-set on the set the editor
   * saw. Every id must name a connection of the SAME organisation.
   */
  setProjectServers(orgId: string, projectId: string, actorId: string, raw: ProjectConnectorsInput): { before: string[]; after: string[] } {
    const parsed = projectConnectorsInputSchema.safeParse(raw);
    if (!parsed.success) throw new ConnectorInputError(parsed.error.issues[0]?.message ?? 'invalid selection');
    const wanted = [...new Set(parsed.data.serverIds)].sort();
    const expected = [...new Set(parsed.data.expectedServerIds)].sort();
    return this.db.transaction(() => {
      const before = this.projectServerIds(orgId, projectId);
      if (before.join(',') !== expected.join(',')) throw new ConnectorConflict('The project\'s MCP servers changed; reload before saving.');
      for (const id of wanted) {
        if (!this.get(orgId, id)) throw new ConnectorInputError('Unknown MCP server for this organisation.');
      }
      const at = this.stamp();
      const remove = this.db.prepare('DELETE FROM project_mcp_servers WHERE org_id = ? AND project_id = ? AND server_id = ?');
      const add = this.db.prepare('INSERT OR IGNORE INTO project_mcp_servers (project_id, org_id, server_id, enabled_at, enabled_by) VALUES (?,?,?,?,?)');
      for (const id of before) if (!wanted.includes(id)) remove.run(orgId, projectId, id);
      for (const id of wanted) if (!before.includes(id)) add.run(projectId, orgId, id, at, actorId);
      return { before, after: this.projectServerIds(orgId, projectId) };
    }).immediate();
  }
}

/**
 * THE RUN PROCESS'S ONE QUESTION, read-only, on the same product file: may
 * this run call this tool of this connection right now? Asked before and
 * after every call, so an admin who switches a server or a tool off stops
 * the next call of a run in flight. No DDL, no write, no secret column read.
 */
export interface ConnectorAuthority {
  /** `url`, when given, must still be the connection's: an edited connection is another server. */
  allowed(serverId: string, tool?: string, url?: string): 'allowed' | 'denied' | 'tool_disabled';
  disabledTools(serverId: string): ReadonlySet<string>;
  close(): void;
}

export function openConnectorAuthority(dbPath: string, orgId: string, projectId: string): ConnectorAuthority {
  let db: Database.Database | null = null;
  const handle = (): Database.Database => {
    if (!db) {
      db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
      db.pragma('busy_timeout = 1000');
    }
    return db;
  };
  const row = (serverId: string): { disabled_tools: string; url: string } | null => {
    try {
      return (handle().prepare(`SELECT s.disabled_tools, s.url FROM project_mcp_servers p JOIN org_mcp_servers s
        ON s.server_id = p.server_id AND s.org_id = p.org_id
        WHERE p.org_id = ? AND p.project_id = ? AND p.server_id = ?`).get(orgId, projectId, serverId) as { disabled_tools: string; url: string } | undefined) ?? null;
    } catch { return null; }
  };
  const disabled = (raw: string): Set<string> => new Set(parseJsonArray(raw, value => typeof value === 'string' ? value : null));
  return {
    allowed(serverId, tool, url) {
      const found = row(serverId);
      if (!found || (url !== undefined && found.url !== url)) return 'denied';
      return tool !== undefined && disabled(found.disabled_tools).has(tool) ? 'tool_disabled' : 'allowed';
    },
    disabledTools(serverId) {
      const found = row(serverId);
      return found ? disabled(found.disabled_tools) : new Set();
    },
    close() { if (db) { db.close(); db = null; } },
  };
}
