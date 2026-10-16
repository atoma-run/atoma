import { roleAtLeast, type OrgRole } from '../auth/store.js';
import type { SecretEncryptionContext } from '../auth/secretEncryption.js';
import type { PlatformEventSink } from '../contracts/platformEvents.js';
import {
  DEFAULT_MCP_CONNECTOR_LIMITS, connectorLaunchSchema,
  type ConnectorCreateInput, type ConnectorLaunch, type ConnectorLaunchSet, type ConnectorUpdateInput,
  type ConnectorView, type ProjectConnectorsInput,
} from '../contracts/mcpConnectors.js';
import { credentialHeaders, openConnectorSession, toolSnapshot } from './client.js';
import { describeConnectorError } from './runtime.js';
import type { FetchLike } from './guardedFetch.js';
import { ConnectorAuthorizationError, ConnectorOAuth } from './oauth.js';
import {
  ConnectorConflict, ConnectorInputError, connectorHost, connectorView,
  type ConnectorRow, type ConnectorStore,
} from './store.js';

/**
 * ONE BODY FOR EVERY DOOR onto an organisation's MCP connections. The HTTP
 * routes resolve their actor and call this; the authority check, the
 * organisation scoping and the journal row live here and nowhere else, so a
 * second door cannot grow a looser rule (src/auth's delegation precedent).
 */

export interface ConnectorActor {
  readonly principalId: string;
  readonly orgId: string;
  readonly role: OrgRole;
  readonly platformAdmin: boolean;
}

export class ConnectorHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface ConnectorServiceOptions {
  readonly store: ConnectorStore;
  readonly encryption: SecretEncryptionContext | null;
  readonly fetch: FetchLike;
  readonly redirectUrl: string;
  readonly events: PlatformEventSink;
  /** Is this project one of this organisation's? Asked before every project read or write. */
  readonly projectInOrg: (orgId: string, projectId: string) => boolean;
  readonly now?: () => number;
  /** Tests only: loopback HTTP servers. Never from configuration. */
  readonly loopbackForTests?: boolean;
  /** False outside the server process: see `ConnectorOAuthOptions.refreshTokens`. */
  readonly refreshTokens?: boolean;
}

/** A launch credential must outlive the run by this much. */
const LAUNCH_MARGIN_MS = 5 * 60_000;
/** Every connection of a launch is resolved within this, together. */
const LAUNCH_RESOLVE_TIMEOUT_MS = 30_000;

export class ConnectorService {
  readonly oauth: ConnectorOAuth;
  private readonly now: () => number;

  constructor(private readonly options: ConnectorServiceOptions) {
    this.now = options.now ?? Date.now;
    this.oauth = new ConnectorOAuth({
      store: options.store, encryption: options.encryption, redirectUrl: options.redirectUrl, fetch: options.fetch, now: this.now,
      ...(options.loopbackForTests ? { loopbackForTests: true } : {}),
      ...(options.refreshTokens === false ? { refreshTokens: false } : {}),
    });
  }

  get encryptionReady(): boolean { return this.options.encryption !== null; }

  canManage(actor: ConnectorActor): boolean {
    return actor.platformAdmin || roleAtLeast(actor.role, 'org:admin');
  }

  private requireRead(actor: ConnectorActor): void {
    if (!actor.platformAdmin && !roleAtLeast(actor.role, 'org:viewer')) throw new ConnectorHttpError(403, 'forbidden');
  }

  private requireManage(actor: ConnectorActor): void {
    if (!this.canManage(actor)) throw new ConnectorHttpError(403, 'Only an organisation owner or admin can manage MCP servers.');
  }

  private row(actor: ConnectorActor, serverId: string): ConnectorRow {
    const row = this.options.store.get(actor.orgId, serverId);
    if (!row) throw new ConnectorHttpError(404, 'MCP server not found');
    return row;
  }

  private view(row: ConnectorRow, actor: ConnectorActor): ConnectorView {
    return connectorView(row, this.canManage(actor), this.options.encryption);
  }

  private guarded<T>(work: () => T): T {
    try { return work(); }
    catch (error) {
      if (error instanceof ConnectorInputError) throw new ConnectorHttpError(400, error.message);
      if (error instanceof ConnectorConflict) throw new ConnectorHttpError(409, error.message);
      throw error;
    }
  }

  private journal(kind: 'org.mcp_server_added' | 'org.mcp_server_updated' | 'org.mcp_server_removed' | 'org.mcp_server_authorized',
    actor: ConnectorActor, row: ConnectorRow, summary: string, detail: Record<string, unknown> = {}): void {
    this.options.events({
      kind, actorType: 'principal', actorId: actor.principalId, orgId: actor.orgId, summary,
      detail: { serverId: row.server_id, key: row.server_key, host: connectorHost(row.url), authKind: row.auth_kind, ...detail },
    });
  }

  list(actor: ConnectorActor): ConnectorView[] {
    this.requireRead(actor);
    return this.options.store.list(actor.orgId).map(row => this.view(row, actor));
  }

  create(actor: ConnectorActor, input: ConnectorCreateInput): ConnectorView {
    this.requireManage(actor);
    const row = this.guarded(() => this.options.store.create(actor.orgId, actor.principalId, input, this.options.encryption));
    this.journal('org.mcp_server_added', actor, row, `MCP server ${row.name} connected`);
    return this.view(row, actor);
  }

  update(actor: ConnectorActor, serverId: string, input: ConnectorUpdateInput): ConnectorView {
    this.requireManage(actor);
    const result = this.guarded(() => this.options.store.update(actor.orgId, serverId, input, this.options.encryption));
    if (!result) throw new ConnectorHttpError(404, 'MCP server not found');
    const { before, after } = result;
    const changed = [
      before.name !== after.name && 'name', before.url !== after.url && 'url', before.auth_kind !== after.auth_kind && 'authKind',
      before.header_secret !== after.header_secret && 'headerSecret', before.header_name !== after.header_name && 'headerName',
      before.oauth_client_id !== after.oauth_client_id && 'oauthClientId', before.oauth_client_secret !== after.oauth_client_secret && 'oauthClientSecret',
      before.oauth_scope !== after.oauth_scope && 'oauthScope', before.disabled_tools !== after.disabled_tools && 'disabledTools',
    ].filter((field): field is string => typeof field === 'string');
    if (changed.length > 0) {
      this.journal('org.mcp_server_updated', actor, after, `MCP server ${after.name} changed`, {
        changed, ...(before.url !== after.url ? { previousHost: connectorHost(before.url) } : {}),
      });
    }
    return this.view(after, actor);
  }

  remove(actor: ConnectorActor, serverId: string): void {
    this.requireManage(actor);
    const removed = this.options.store.remove(actor.orgId, serverId);
    if (!removed) throw new ConnectorHttpError(404, 'MCP server not found');
    this.journal('org.mcp_server_removed', actor, removed, `MCP server ${removed.name} removed`);
  }

  /** The headers a connection needs now, or why it cannot have them. */
  async credential(row: ConnectorRow, validUntil: number): Promise<
    { ok: true; headers: Record<string, string> } | { ok: false; reason: Extract<ConnectorLaunch, { status: 'unavailable' }>['reason'] }> {
    if (row.auth_kind === 'none') return { ok: true, headers: {} };
    if (row.auth_kind === 'header') {
      const value = this.options.store.open(row, 'header', this.options.encryption);
      return value ? { ok: true, headers: credentialHeaders({ kind: 'header', name: row.header_name ?? 'Authorization', value }) }
        : { ok: false, reason: 'secret_unavailable' };
    }
    const access = await this.oauth.accessToken(row, validUntil);
    return access.ok
      ? { ok: true, headers: credentialHeaders({ kind: 'bearer', token: access.accessToken, tokenType: access.tokenType }) }
      : { ok: false, reason: access.reason };
  }

  /** Discover the tool list for Settings. Never throws for a server's own failure: it is recorded. */
  async refreshTools(actor: ConnectorActor, serverId: string): Promise<ConnectorView> {
    this.requireManage(actor);
    const row = this.row(actor, serverId);
    await this.discover(row);
    return this.view(this.row(actor, serverId), actor);
  }

  private async discover(row: ConnectorRow): Promise<void> {
    const credential = await this.credential(row, this.now() + 60_000);
    if (!credential.ok) {
      this.options.store.setTools(row.org_id, row.server_id, null, {
        authorization_required: 'Authorization required: connect this server first.',
        authorization_failed: 'Authorization failed: connect this server again.',
        secret_unavailable: 'The stored secret is unavailable on this instance.',
        unreachable: 'The server could not be reached.',
      }[credential.reason]);
      return;
    }
    const timeout = DEFAULT_MCP_CONNECTOR_LIMITS.listTimeoutMs;
    const signal = AbortSignal.timeout(timeout);
    try {
      const session = await openConnectorSession({ url: row.url, headers: credential.headers }, this.options.fetch, signal, timeout);
      try {
        const { tools } = await session.listTools(signal, timeout);
        this.options.store.setTools(row.org_id, row.server_id, tools.map(toolSnapshot), null);
      } finally { await session.close(); }
    } catch (error) {
      // Members read this line: no path or response body, which may carry a secret.
      this.options.store.setTools(row.org_id, row.server_id, null, `Could not list tools: ${describeConnectorError(error)}`);
    }
  }

  async startAuthorization(actor: ConnectorActor, serverId: string, sessionKey: string): Promise<string> {
    this.requireManage(actor);
    const row = this.row(actor, serverId);
    try {
      return await this.oauth.start(row, { principalId: actor.principalId, sessionKey });
    } catch (error) {
      if (error instanceof ConnectorAuthorizationError) throw new ConnectorHttpError(502, error.message);
      throw error;
    }
  }

  /**
   * The callback. The pending state decides the organisation, not the
   * session's ACTIVE one, but the actor must still manage that organisation.
   */
  async finishAuthorization(input: { state: string; code: string; sessionKey: string },
    actorFor: (orgId: string) => ConnectorActor | null): Promise<ConnectorView> {
    const target = this.oauth.pendingFor(input.state);
    const actor = target ? actorFor(target.orgId) : null;
    if (!target || !actor || !this.canManage(actor)) {
      throw new ConnectorHttpError(403, 'This authorization was not started from this session or has expired. Start it again from Settings.');
    }
    let row: ConnectorRow;
    try {
      row = await this.oauth.finish({ ...input, principalId: actor.principalId },
        (orgId, serverId) => orgId === actor.orgId ? this.options.store.get(orgId, serverId) : null);
    } catch (error) {
      if (error instanceof ConnectorAuthorizationError) throw new ConnectorHttpError(400, error.message);
      throw error;
    }
    this.journal('org.mcp_server_authorized', actor, row, `MCP server ${row.name} authorized`);
    await this.discover(row);
    return this.view(this.options.store.get(row.org_id, row.server_id) ?? row, actor);
  }

  /* ---------------------------------------------------------------- projects */

  projectServers(actor: ConnectorActor, projectId: string): { servers: ConnectorView[]; enabled: string[]; canEdit: boolean } {
    this.requireRead(actor);
    if (!this.options.projectInOrg(actor.orgId, projectId)) throw new ConnectorHttpError(404, 'project not found');
    // Project settings never need a URL: the projection is the reader's even for an admin.
    return {
      servers: this.options.store.list(actor.orgId).map(row => connectorView(row, false, this.options.encryption)),
      enabled: this.options.store.projectServerIds(actor.orgId, projectId),
      canEdit: this.canManage(actor),
    };
  }

  setProjectServers(actor: ConnectorActor, projectId: string, input: ProjectConnectorsInput): string[] {
    if (!this.canManage(actor)) throw new ConnectorHttpError(403, 'Only an organisation owner or admin can choose a project\'s MCP servers.');
    if (!this.options.projectInOrg(actor.orgId, projectId)) throw new ConnectorHttpError(404, 'project not found');
    const { before, after } = this.guarded(() => this.options.store.setProjectServers(actor.orgId, projectId, actor.principalId, input));
    if (before.join(',') !== after.join(',')) {
      const keys = (ids: string[]) => ids.map(id => this.options.store.get(actor.orgId, id)?.server_key ?? id);
      this.options.events({
        kind: 'project.mcp_servers_changed', actorType: 'principal', actorId: actor.principalId, orgId: actor.orgId, projectId,
        summary: `Project MCP servers: ${keys(after).join(', ') || 'none'}`,
        detail: { added: keys(after.filter(id => !before.includes(id))), removed: keys(before.filter(id => !after.includes(id))) },
      });
    }
    return after;
  }

  /**
   * THE LAUNCH HAND-OFF. Called by the coordinator in the server process for
   * one run: every connection the project enables, each with a credential
   * that outlives the run's deadline or the reason it has none. `null` when
   * the project enables nothing, so a run without connectors carries no
   * environment and no elements.
   */
  async launchFor(orgId: string, projectId: string, validUntil: number, signal?: AbortSignal): Promise<ConnectorLaunchSet | null> {
    const ids = this.options.store.projectServerIds(orgId, projectId);
    if (ids.length === 0) return null;
    // Resolved together and bounded: launch holds the organisation's run slot.
    const bound = AbortSignal.any([AbortSignal.timeout(LAUNCH_RESOLVE_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    const resolve = async (id: string): Promise<ConnectorLaunch | null> => {
      const row = this.options.store.get(orgId, id);
      if (!row) return null;
      const unavailable = (reason: Extract<ConnectorLaunch, { status: 'unavailable' }>['reason']): ConnectorLaunch =>
        ({ status: 'unavailable', serverId: row.server_id, key: row.server_key, name: row.name, reason });
      let onAbort: () => void = () => {};
      try {
        const credential = await Promise.race([
          this.credential(row, validUntil + LAUNCH_MARGIN_MS),
          new Promise<null>(settle => {
            onAbort = () => settle(null);
            if (bound.aborted) settle(null); else bound.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
        if (!credential) return unavailable('unreachable');
        if (!credential.ok) return unavailable(credential.reason);
        // One connection that cannot cross the boundary (an oversized token) is
        // that connection's problem, never the whole set's.
        const ready = connectorLaunchSchema.safeParse({ status: 'ready', serverId: row.server_id, key: row.server_key, name: row.name, url: row.url, headers: credential.headers });
        return ready.success ? ready.data : unavailable('secret_unavailable');
      } catch {
        return unavailable('unreachable');
      } finally { bound.removeEventListener('abort', onAbort); }
    };
    const connectors = (await Promise.all(ids.map(resolve))).filter((entry): entry is ConnectorLaunch => entry !== null);
    return connectors.length > 0 ? { version: 1, orgId, projectId, connectors } : null;
  }
}
