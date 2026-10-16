import { randomBytes } from 'node:crypto';
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SecretEncryptionContext } from '../auth/secretEncryption.js';
import type { ConnectorRow, ConnectorStore } from './store.js';
import type { FetchLike } from './guardedFetch.js';

/**
 * ATOMA AS AN OAUTH CLIENT OF A CUSTOMER'S MCP SERVER.
 * ====================================================
 *
 * The MCP SDK's `auth()` does the protocol (RFC 9728 discovery, RFC 8414
 * metadata, RFC 7591 registration, S256 PKCE, RFC 8707 resource, refresh,
 * issuer binding). This module owns everything around it:
 *
 * - the provider reads and writes the connection's row, encrypted, and every
 *   write is guarded by the URL it was obtained for;
 * - a pending authorization is memory-only, expires, and is bound to the
 *   browser session, principal, organisation and connection that began it;
 * - refreshes of one connection are serialised in this process, which is the
 *   one writer of its rotating refresh token (the run process only ever
 *   receives an access token);
 * - every request goes through the guarded fetch.
 */

export const OAUTH_PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 64;
/** One organisation cannot hold the whole budget of pending authorizations. */
const MAX_PENDING_PER_ORG = 8;

export class ConnectorAuthorizationError extends Error {}

interface StoredTokens extends OAuthTokens { readonly obtained_at?: number }

class RowOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private verifier: string | null;

  constructor(
    private readonly store: ConnectorStore,
    private readonly row: ConnectorRow,
    private readonly encryption: SecretEncryptionContext,
    private readonly redirect: string,
    private readonly options: { readonly state?: string; readonly verifier?: string; readonly ignoreStoredTokens?: boolean; readonly now?: () => number } = {},
  ) { this.verifier = options.verifier ?? null; }

  private now(): number { return (this.options.now ?? Date.now)(); }

  /** Re-read the row, but only while it still names the same URL and kind. */
  private current(): ConnectorRow | null {
    const row = this.store.get(this.row.org_id, this.row.server_id);
    return row && row.url === this.row.url && row.auth_kind === 'oauth' ? row : null;
  }

  get redirectUrl(): string { return this.redirect; }

  get clientMetadata(): OAuthClientMetadata {
    const confidential = this.row.oauth_client_secret !== null;
    return {
      client_name: 'Atoma',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none',
      ...(this.row.oauth_scope ? { scope: this.row.oauth_scope } : {}),
    };
  }

  state(): string { return this.options.state ?? randomBytes(24).toString('base64url'); }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const row = this.current();
    if (!row) return undefined;
    const stored = this.store.open(row, 'client', this.encryption);
    const parsed = stored ? JSON.parse(stored) as OAuthClientInformationMixed : undefined;
    if (row.oauth_client_id) {
      // Pre-registered: the id and secret are the admin's; only the issuer
      // binding the SDK stamps after first use is kept from storage.
      const secret = this.store.open(row, 'client-secret', this.encryption);
      return {
        client_id: row.oauth_client_id,
        ...(secret ? { client_secret: secret } : {}),
        ...(parsed && parsed.client_id === row.oauth_client_id && typeof parsed.issuer === 'string' ? { issuer: parsed.issuer } : {}),
      };
    }
    return parsed;
  }

  saveClientInformation(information: OAuthClientInformationMixed): void {
    const row = this.current();
    if (!row) throw new ConnectorAuthorizationError('the connection changed during authorization');
    // A pre-registered secret is never copied into the registration envelope.
    const { client_secret: _secret, ...rest } = information;
    const kept = row.oauth_client_id ? rest : information;
    this.store.saveOauthClient(row, JSON.stringify(kept), this.encryption);
  }

  tokens(): OAuthTokens | undefined {
    if (this.options.ignoreStoredTokens) return undefined;
    const row = this.current();
    const stored = row ? this.store.open(row, 'tokens', this.encryption) : null;
    if (!stored) return undefined;
    const { obtained_at: _at, ...tokens } = JSON.parse(stored) as StoredTokens;
    return tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const row = this.current();
    if (!row) throw new ConnectorAuthorizationError('the connection changed during authorization');
    const now = this.now();
    const expiresAt = typeof tokens.expires_in === 'number' && tokens.expires_in > 0
      ? new Date(now + tokens.expires_in * 1000).toISOString() : null;
    // A refresh that returns no new refresh token keeps the previous one (RFC 6749 §6).
    const previous = this.tokens();
    const merged: StoredTokens = {
      ...tokens,
      ...(!tokens.refresh_token && previous?.refresh_token ? { refresh_token: previous.refresh_token } : {}),
      obtained_at: now,
    };
    if (!this.store.saveOauthTokens(row, JSON.stringify(merged), expiresAt, this.encryption)) {
      throw new ConnectorAuthorizationError('the connection changed during authorization');
    }
  }

  redirectToAuthorization(url: URL): void { this.authorizationUrl = url; }

  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }

  codeVerifier(): string {
    if (!this.verifier) throw new ConnectorAuthorizationError('no authorization is pending for this connection');
    return this.verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier') { this.verifier = null; return; }
    // An interactive flow never read the stored tokens, so a refusal it meets
    // (an expired code, a registration another admin replaced) says nothing
    // about them: the connection keeps its working credential.
    if (this.options.ignoreStoredTokens) {
      if (scope === 'discovery') { const row = this.current(); if (row) this.store.forgetOauth(row, 'discovery'); }
      return;
    }
    const row = this.current();
    if (row) this.store.forgetOauth(row, scope);
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const row = this.current();
    if (row) this.store.saveOauthDiscovery(row, JSON.stringify(state));
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const row = this.current();
    if (!row?.oauth_discovery) return undefined;
    try { return JSON.parse(row.oauth_discovery) as OAuthDiscoveryState; } catch { return undefined; }
  }
}

interface PendingAuthorization {
  readonly state: string;
  readonly verifier: string;
  readonly orgId: string;
  readonly serverId: string;
  readonly url: string;
  readonly principalId: string;
  readonly sessionKey: string;
  readonly expiresAt: number;
}

export interface ConnectorOAuthOptions {
  readonly store: ConnectorStore;
  readonly encryption: SecretEncryptionContext | null;
  /** `${ATOMA_VIZ_PUBLIC_ORIGIN}/api/org/mcp-servers/oauth/callback`, never a request Host. */
  readonly redirectUrl: string;
  readonly fetch: FetchLike;
  readonly now?: () => number;
  /** Tests only: admit an HTTP loopback authorization endpoint. Never from configuration. */
  readonly loopbackForTests?: boolean;
  /**
   * False in any process but the server: a second process refreshing a
   * rotating token would race the server's refresh and lose the
   * authorization. Such a process hands over a still-valid token or none.
   */
  readonly refreshTokens?: boolean;
}

export type AccessResult =
  | { readonly ok: true; readonly accessToken: string; readonly tokenType: string }
  | { readonly ok: false; readonly reason: 'authorization_required' | 'authorization_failed' | 'secret_unavailable' };

export class ConnectorOAuth {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly options: ConnectorOAuthOptions) {
    this.now = options.now ?? Date.now;
  }

  private encryption(): SecretEncryptionContext {
    if (!this.options.encryption) throw new ConnectorAuthorizationError('Secret storage is not configured on this instance.');
    return this.options.encryption;
  }

  private sweep(): void {
    const now = this.now();
    for (const [state, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(state);
  }

  /**
   * Begin an authorization for a connection. Returns the URL the admin's
   * browser opens. Stored tokens are ignored: "Connect" always asks the
   * person, so a broken refresh token cannot hide behind a silent refresh.
   */
  async start(row: ConnectorRow, actor: { principalId: string; sessionKey: string }): Promise<string> {
    if (row.auth_kind !== 'oauth') throw new ConnectorAuthorizationError('This connection does not use OAuth.');
    const encryption = this.encryption();
    this.sweep();
    const pendingForOrg = [...this.pending.values()].filter(entry => entry.orgId === row.org_id).length;
    if (this.pending.size >= MAX_PENDING || pendingForOrg >= MAX_PENDING_PER_ORG) {
      throw new ConnectorAuthorizationError('Too many authorizations are pending; try again in a few minutes.');
    }
    const state = randomBytes(24).toString('base64url');
    const provider = new RowOAuthProvider(this.options.store, row, encryption, this.options.redirectUrl, { state, ignoreStoredTokens: true, now: this.now });
    let result: string;
    try {
      result = await auth(provider, { serverUrl: row.url, ...(row.oauth_scope ? { scope: row.oauth_scope } : {}), fetchFn: this.options.fetch });
    } catch (error) {
      throw new ConnectorAuthorizationError(describeAuthError(error));
    }
    if (result !== 'REDIRECT' || !provider.authorizationUrl) {
      throw new ConnectorAuthorizationError('The server did not ask for an authorization.');
    }
    // The browser opens it: a scheme other than HTTPS (javascript:, data:) is refused.
    const loopback = this.options.loopbackForTests === true && provider.authorizationUrl.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(provider.authorizationUrl.hostname);
    if (provider.authorizationUrl.protocol !== 'https:' && !loopback) {
      throw new ConnectorAuthorizationError('The server\'s authorization endpoint is not an HTTPS address.');
    }
    this.pending.set(state, {
      state, verifier: provider.codeVerifier(), orgId: row.org_id, serverId: row.server_id, url: row.url,
      principalId: actor.principalId, sessionKey: actor.sessionKey, expiresAt: this.now() + OAUTH_PENDING_TTL_MS,
    });
    return provider.authorizationUrl.href;
  }

  /**
   * The redirect came back. The state is consumed whatever happens next, and
   * it must have been issued to this very browser session and principal.
   * Returns the connection it authorized.
   */
  async finish(input: { state: string; code: string; principalId: string; sessionKey: string },
    load: (orgId: string, serverId: string) => ConnectorRow | null): Promise<ConnectorRow> {
    this.sweep();
    const pending = this.pending.get(input.state);
    if (pending) this.pending.delete(input.state);
    if (!pending || pending.principalId !== input.principalId || pending.sessionKey !== input.sessionKey) {
      throw new ConnectorAuthorizationError('This authorization was not started from this session or has expired. Start it again from Settings.');
    }
    const row = load(pending.orgId, pending.serverId);
    if (!row || row.url !== pending.url || row.auth_kind !== 'oauth') {
      throw new ConnectorAuthorizationError('The connection changed while it was being authorized. Start again from Settings.');
    }
    const provider = new RowOAuthProvider(this.options.store, row, this.encryption(), this.options.redirectUrl,
      { verifier: pending.verifier, ignoreStoredTokens: true, now: this.now });
    try {
      const result = await auth(provider, { serverUrl: row.url, authorizationCode: input.code, fetchFn: this.options.fetch });
      if (result !== 'AUTHORIZED') throw new ConnectorAuthorizationError('The server did not issue tokens.');
    } catch (error) {
      if (error instanceof ConnectorAuthorizationError) throw error;
      throw new ConnectorAuthorizationError(describeAuthError(error));
    }
    return load(pending.orgId, pending.serverId) ?? row;
  }

  /** The pending entry a callback names, for routing its error to the right organisation. */
  pendingFor(state: string): { orgId: string; serverId: string } | null {
    const entry = this.pending.get(state);
    return entry ? { orgId: entry.orgId, serverId: entry.serverId } : null;
  }

  /** An OAuthClientProvider for the MCP transport (Settings' tool refresh), refresh allowed. */
  provider(row: ConnectorRow): OAuthClientProvider {
    return new RowOAuthProvider(this.options.store, row, this.encryption(), this.options.redirectUrl, { now: this.now });
  }

  /**
   * An access token valid until at least `validUntil` (epoch ms), refreshing
   * when needed. Serialised per connection: two runs launching together do
   * not both spend one rotating refresh token.
   */
  accessToken(row: ConnectorRow, validUntil: number): Promise<AccessResult> {
    const id = row.server_id;
    const previous = this.refreshing.get(id) ?? Promise.resolve();
    const next = previous.then(() => this.accessTokenNow(row.org_id, id, validUntil))
      .catch((): AccessResult => ({ ok: false, reason: 'authorization_failed' }));
    const tail = next.then(() => undefined);
    this.refreshing.set(id, tail);
    void tail.then(() => { if (this.refreshing.get(id) === tail) this.refreshing.delete(id); });
    return next;
  }

  /**
   * Best effort past the token's own lifetime: a server whose tokens live an
   * hour cannot cover a two-hour run, so the freshest token still valid now
   * is handed over and an expiry mid-run surfaces as `unavailable` on a call.
   * A token obtained in the last minute is not refreshed again: a second
   * refresh cannot make it last longer, and it spends a rotating token.
   */
  private async accessTokenNow(orgId: string, serverId: string, validUntil: number): Promise<AccessResult> {
    if (!this.options.encryption) return { ok: false, reason: 'secret_unavailable' };
    const encryption = this.options.encryption;
    const row = this.options.store.get(orgId, serverId);
    if (!row || row.auth_kind !== 'oauth') return { ok: false, reason: 'authorization_required' };
    const read = (): { result: AccessResult; expiresAt: number; obtainedAt: number } | null => {
      const fresh = this.options.store.get(orgId, serverId);
      const raw = fresh ? this.options.store.open(fresh, 'tokens', encryption) : null;
      if (!fresh || !raw) return null;
      const tokens = JSON.parse(raw) as StoredTokens;
      if (!tokens.access_token) return null;
      return {
        result: { ok: true, accessToken: tokens.access_token, tokenType: tokens.token_type || 'Bearer' },
        expiresAt: fresh.oauth_tokens_expire_at ? Date.parse(fresh.oauth_tokens_expire_at) : Number.POSITIVE_INFINITY,
        obtainedAt: tokens.obtained_at ?? 0,
      };
    };
    const usableNow = (token: ReturnType<typeof read>) => token !== null && token.expiresAt > this.now() + 60_000;
    const current = read();
    if (current && current.expiresAt >= validUntil) return current.result;
    if (current && usableNow(current) && this.now() - current.obtainedAt < 60_000) return current.result;
    if (!row.oauth_tokens) return { ok: false, reason: 'authorization_required' };
    if (this.options.refreshTokens === false) return current && usableNow(current) ? current.result : { ok: false, reason: 'authorization_required' };
    let refused: AccessResult | null = null;
    try {
      const provider = new RowOAuthProvider(this.options.store, row, encryption, this.options.redirectUrl, { now: this.now });
      // REDIRECT means no refresh was possible: a person must authorize again.
      if (await auth(provider, { serverUrl: row.url, fetchFn: this.options.fetch }) !== 'AUTHORIZED') {
        refused = { ok: false, reason: 'authorization_required' };
      }
    } catch {
      refused = { ok: false, reason: 'authorization_failed' };
    }
    const after = read();
    if (!refused && after && usableNow(after)) return after.result;
    // The refresh failed, but the token the run would have had is still good for now.
    if (current && usableNow(current) && after?.result.ok && current.result.ok &&
        after.result.accessToken === current.result.accessToken) return current.result;
    return refused ?? { ok: false, reason: 'authorization_required' };
  }
}

/** A bounded, secret-free message for Settings. */
export function describeAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Authorization failed: ${message.replace(/[\r\n]+/g, ' ').slice(0, 300)}`;
}
