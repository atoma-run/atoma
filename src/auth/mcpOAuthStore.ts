import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuthStore, Viewer } from './store.js';

export const MCP_OAUTH_SCOPE = 'mcp';
export const MCP_ACCESS_TTL_MS = 60 * 60 * 1000;
export const MCP_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MCP_CODE_TTL_MS = 5 * 60 * 1000;
/**
 * How long a CONSUMED refresh token still answers, with the grant's current
 * pair, instead of revoking the grant. Without it, two client
 * processes renewing one grant together, or a client retrying after a lost
 * response, revoked the grant: production journaled 42 such revocations in
 * October 2026 (38 Codex, 4 Claude Code), and the 21 from 2026-10-19 to
 * 2026-10-31 came 0.3 to 72 seconds after a successful renewal, 18 of them
 * within 23 seconds (docs/mcp-oauth.md). Two minutes covers every one; past
 * it, reuse revokes the grant exactly as before. The grace answers only the
 * network the rotation came from (`coarseNetwork`): racing processes share a
 * machine, a thief elsewhere does not, and its collision still revokes.
 */
export const MCP_REFRESH_REUSE_GRACE_MS = 120 * 1000;
/** A clock stepped back this far still counts as inside the grace; further, as outside it. */
const GRACE_CLOCK_SKEW_MS = 5 * 1000;
/**
 * Rotations a replay may walk to reach the current pair. More inside one grace
 * has no legitimate explanation (a client renews hourly): it revokes, with its
 * own reason, so a burst of rotations cannot leave the rightful client refused
 * while the grant stays live elsewhere (review 2026-11-02).
 */
const MAX_REPLAY_HOPS = 32;

/**
 * The network a request came from, as coarse as a home or office NAT: the
 * IPv4 /24, the IPv6 /64 (an IPv4-mapped IPv6 address is its IPv4). Anything
 * that is not an address is kept whole. Stored only as a hash.
 */
export function coarseNetwork(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(mapped ? mapped[1]! : address);
  if (v4) return `v4:${v4[1]}.${v4[2]}.${v4[3]}`;
  if (address.includes(':')) {
    const [head = '', tail = ''] = address.toLowerCase().split('%')[0]!.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = address.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
    return `v6:${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}`;
  }
  return `raw:${address}`;
}
const CLIENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CLIENTS = 10_000;
/** Metadata clients count apart, so they never crowd out registrations, nor these them. */
const MAX_METADATA_CLIENTS = 2_000;
const METADATA_CLIENT = "client_id LIKE 'https://%'";
const MAX_CODES = 1_024;
export const oauthHash = (value: string): string => createHash('sha256').update(value).digest('hex');
const secret = (): string => randomBytes(32).toString('base64url');

/** These tables extend the primary auth store; API-token rows own grants and revocation. */
export const MCP_OAUTH_DDL = `
CREATE TABLE IF NOT EXISTS auth_mcp_clients (
  client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_mcp_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, resource TEXT NOT NULL,
  principal_id TEXT NOT NULL, org_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
  token_id TEXT
);
CREATE TABLE IF NOT EXISTS auth_mcp_grants (
  token_id TEXT PRIMARY KEY REFERENCES auth_api_tokens(token_id),
  client_id TEXT NOT NULL, resource TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL, refresh_expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_mcp_refresh (
  token_hash TEXT PRIMARY KEY, token_id TEXT NOT NULL REFERENCES auth_mcp_grants(token_id),
  used INTEGER NOT NULL DEFAULT 0, used_at INTEGER, successor TEXT,
  rotated_from TEXT, replays INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS auth_mcp_refresh_grant_idx ON auth_mcp_refresh(token_id);
`;

/**
 * The refresh-grace columns on a store created before them. Additive and
 * idempotent: a refresh consumed before the upgrade has no `used_at`, so it
 * never answers inside the grace and its reuse revokes, as it always did.
 */
export function migrateMcpOAuthRefreshGrace(db: Database.Database): void {
  const columns = new Set((db.prepare('PRAGMA table_info(auth_mcp_refresh)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!columns.has('used_at')) db.exec('ALTER TABLE auth_mcp_refresh ADD COLUMN used_at INTEGER');
  if (!columns.has('successor')) db.exec('ALTER TABLE auth_mcp_refresh ADD COLUMN successor TEXT');
  if (!columns.has('rotated_from')) db.exec('ALTER TABLE auth_mcp_refresh ADD COLUMN rotated_from TEXT');
  if (!columns.has('replays')) db.exec('ALTER TABLE auth_mcp_refresh ADD COLUMN replays INTEGER NOT NULL DEFAULT 0');
}

/**
 * What a rotation issued, sealed under a key only the CONSUMED refresh token
 * derives: the server keeps no credential it could read back, and a copy of
 * the store alone opens nothing, since it holds that token's hash only. With
 * a consumed token of the same chain, a copy taken inside the grace opens what
 * that token could already obtain by replay. The grant id is the authenticated
 * data, so a blob moved to another grant fails.
 */
interface IssuedPair { access: string; refresh: string }
const SUCCESSOR_INFO = 'atoma mcp refresh successor v1';
const successorKey = (refresh: string): Buffer =>
  Buffer.from(hkdfSync('sha256', refresh, Buffer.alloc(0), SUCCESSOR_INFO, 32));
function sealSuccessor(consumed: string, tokenId: string, pair: IssuedPair): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', successorKey(consumed), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(tokenId, 'utf8'));
  const body = Buffer.concat([cipher.update(JSON.stringify(pair), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
function openSuccessor(consumed: string, tokenId: string, sealed: string): IssuedPair | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', successorKey(consumed), raw.subarray(0, 12), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(tokenId, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object') return null;
    const { access, refresh } = value as Record<string, unknown>;
    return typeof access === 'string' && typeof refresh === 'string' ? { access, refresh } : null;
  } catch {
    return null;
  }
}

export interface McpOAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}
interface CodeRow {
  code_hash: string; client_id: string; redirect_uri: string; challenge: string;
  resource: string; principal_id: string; org_id: string; expires_at: number; token_id: string | null;
}
export interface McpOAuthRevocation {
  tokenId: string; principalId: string; orgId: string; clientId: string;
  reason: 'authorization_code_reuse' | 'refresh_token_reuse' | 'refresh_chain_exhausted' | 'client_revocation';
}
type Revoked = (receipt: McpOAuthRevocation) => void;
interface GrantRow {
  token_id: string; client_id: string; resource: string; refresh_expires_at: number;
  principal_id: string; org_id: string; revoked_at: string | null; used: number;
  used_at: number | null; successor: string | null; rotated_from: string | null; replays: number;
}
/** A renewal answered inside the reuse grace, for the journal: no credential, no hash. */
export interface McpOAuthReplay { tokenId: string; principalId: string; orgId: string; clientId: string; secondsAfterRotation: number }
type Replayed = (receipt: McpOAuthReplay) => void;

/** Public clients use authorization code + S256 only; no client secrets or upstream token passthrough. */
export class McpOAuthStore {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {}

  register(clientName: string, redirectUris: string[]): McpOAuthClient {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM auth_mcp_clients WHERE expires_at <= ?').run(this.now());
      const { count } = this.db.prepare(`SELECT count(*) AS count FROM auth_mcp_clients WHERE NOT ${METADATA_CLIENT}`).get() as { count: number };
      if (count >= MAX_CLIENTS) throw new Error('OAuth client capacity reached');
      const client = { client_id: randomUUID(), client_name: clientName, redirect_uris: redirectUris };
      this.db.prepare('INSERT INTO auth_mcp_clients VALUES (?, ?, ?, ?)')
        .run(client.client_id, clientName, JSON.stringify(redirectUris), this.now() + CLIENT_TTL_MS);
      return client;
    })();
  }

  /**
   * A client that named itself by a metadata document, as its document read
   * when a person allowed it: the token, refresh and revocation endpoints then
   * find it like a registered one, for as long as the grant it received can
   * be renewed. The URL id cannot collide with a registered id, which is
   * always a UUID. A withdrawn document takes effect at the next
   * authorization; an issued grant runs its course, as a registered one does.
   */
  rememberMetadataClient(client: McpOAuthClient): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM auth_mcp_clients WHERE expires_at <= ?').run(this.now());
      const known = this.db.prepare('SELECT 1 FROM auth_mcp_clients WHERE client_id = ?').get(client.client_id);
      const { count } = this.db.prepare(`SELECT count(*) AS count FROM auth_mcp_clients WHERE ${METADATA_CLIENT}`).get() as { count: number };
      if (!known && count >= MAX_METADATA_CLIENTS) throw new Error('OAuth client capacity reached');
      this.db.prepare('INSERT OR REPLACE INTO auth_mcp_clients VALUES (?, ?, ?, ?)')
        .run(client.client_id, client.client_name, JSON.stringify(client.redirect_uris),
          this.now() + MCP_REFRESH_TTL_MS + MCP_CODE_TTL_MS);
    })();
  }

  client(id: string): McpOAuthClient | null {
    const row = this.db.prepare('SELECT * FROM auth_mcp_clients WHERE client_id = ? AND expires_at > ?')
      .get(id, this.now()) as { client_id: string; client_name: string; redirect_uris: string } | undefined;
    return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] } : null;
  }

  code(input: { clientId: string; redirectUri: string; challenge: string; resource: string; viewer: Viewer }): string {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM auth_mcp_codes WHERE expires_at <= ?').run(this.now());
      const { count } = this.db.prepare('SELECT count(*) AS count FROM auth_mcp_codes').get() as { count: number };
      if (count >= MAX_CODES) throw new Error('OAuth authorization capacity reached');
      const code = secret();
      this.db.prepare(`INSERT INTO auth_mcp_codes
        (code_hash, client_id, redirect_uri, challenge, resource, principal_id, org_id, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(oauthHash(code), input.clientId, input.redirectUri,
        input.challenge, input.resource, input.viewer.principalId, input.viewer.orgId, this.now() + MCP_CODE_TTL_MS);
      return code;
    })();
  }

  exchange(auth: AuthStore, input: { code: string; clientId: string; redirectUri: string; verifier: string; resource: string }, onRevoked?: Revoked) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM auth_mcp_codes WHERE code_hash = ?')
        .get(oauthHash(input.code)) as CodeRow | undefined;
      if (!row || row.expires_at <= this.now() || row.client_id !== input.clientId ||
        row.redirect_uri !== input.redirectUri || row.resource !== input.resource ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) ||
        createHash('sha256').update(input.verifier).digest('base64url') !== row.challenge) return null;
      // A valid replay revokes the authorization it previously redeemed.
      if (row.token_id) { if (auth.revokeApiToken(row.principal_id, row.token_id)) onRevoked?.({ tokenId: row.token_id, principalId: row.principal_id, orgId: row.org_id, clientId: row.client_id, reason: 'authorization_code_reuse' }); return null; }
      const client = this.client(input.clientId);
      if (!client || !this.member(row.principal_id, row.org_id)) return null;
      const minted = auth.createApiToken({ principalId: row.principal_id, orgId: row.org_id, label: `OAuth: ${client.client_name}` });
      this.db.prepare('INSERT INTO auth_mcp_grants VALUES (?, ?, ?, ?, ?)')
        .run(minted.tokenId, input.clientId, input.resource, this.now() + MCP_ACCESS_TTL_MS, this.now() + MCP_REFRESH_TTL_MS);
      this.db.prepare('UPDATE auth_mcp_codes SET token_id = ? WHERE code_hash = ?').run(minted.tokenId, row.code_hash);
      // A registered client lives at least as long as a grant it received
      // can be renewed, as a metadata client does: its registration expiring
      // (90 days) under a live grant forced a re-registration and consent.
      this.db.prepare('UPDATE auth_mcp_clients SET expires_at = MAX(expires_at, ?) WHERE client_id = ?')
        .run(this.now() + MCP_REFRESH_TTL_MS + MCP_CODE_TTL_MS, input.clientId);
      return { ...this.tokens(minted.tokenId, minted.token), principalId: row.principal_id, orgId: row.org_id };
    })();
  }

  /**
   * One renewal. A refresh token is consumed once: its rotation issues a new
   * access and refresh token, seals them under the consumed one, and notes
   * the network it came from. Presented AGAIN by the same client from the
   * same network within `MCP_REFRESH_REUSE_GRACE_MS`, it answers with the
   * grant's current pair, so racing processes or a retry after a lost response
   * all hold one live pair and none signs another out. Presented later, from
   * elsewhere, or once no current pair can be reached, it revokes the grant.
   */
  refresh(auth: AuthStore, input: { token: string; clientId: string; resource: string; network?: string }, onRevoked?: Revoked, onReplayed?: Replayed) {
    // IMMEDIATE: the read that decides consumption and the write that records
    // it hold one lock, even with a second process on the store.
    return this.db.transaction(() => {
      const presented = oauthHash(input.token);
      const network = input.network === undefined ? null : oauthHash(`network:${input.network}`);
      const row = this.db.prepare(`SELECT g.*, t.principal_id, t.org_id, t.revoked_at, r.used, r.used_at, r.successor,
        r.rotated_from, r.replays
        FROM auth_mcp_refresh r JOIN auth_mcp_grants g ON g.token_id = r.token_id
        JOIN auth_api_tokens t ON t.token_id = g.token_id WHERE r.token_hash = ?`)
        .get(presented) as GrantRow | undefined;
      if (!row || row.client_id !== input.clientId || row.resource !== input.resource || row.revoked_at ||
        row.refresh_expires_at <= this.now() || !this.client(input.clientId)) return null;
      if (row.used) {
        const replay = this.withinGrace(row, network) && this.member(row.principal_id, row.org_id)
          ? this.replay(row.token_id, input.token, row.successor!, network!) : 'reuse';
        if (replay !== 'reuse' && replay !== 'exhausted') {
          this.db.prepare('UPDATE auth_mcp_refresh SET replays = replays + 1 WHERE token_hash = ?').run(presented);
          // One journal row per consumed token, however often it is replayed.
          if (row.replays === 0) onReplayed?.({ tokenId: row.token_id, principalId: row.principal_id, orgId: row.org_id,
            clientId: row.client_id, secondsAfterRotation: Math.round((this.now() - row.used_at!) / 1000) });
          return { ...replay, principalId: row.principal_id, orgId: row.org_id };
        }
        if (auth.revokeApiToken(row.principal_id, row.token_id)) onRevoked?.({ tokenId: row.token_id, principalId: row.principal_id, orgId: row.org_id, clientId: row.client_id,
          reason: replay === 'exhausted' ? 'refresh_chain_exhausted' : 'refresh_token_reuse' });
        return null;
      }
      if (!this.member(row.principal_id, row.org_id)) return null;
      const access = `atoma_${secret()}`;
      this.db.prepare('UPDATE auth_api_tokens SET token_hash = ? WHERE token_id = ?').run(oauthHash(access), row.token_id);
      this.db.prepare('UPDATE auth_mcp_grants SET access_expires_at = ? WHERE token_id = ?')
        .run(Math.min(this.now() + MCP_ACCESS_TTL_MS, row.refresh_expires_at), row.token_id);
      // Absolute 30-day grant lifetime, never extended by a refresh.
      const issued = this.tokens(row.token_id, access);
      this.db.prepare('UPDATE auth_mcp_refresh SET used = 1, used_at = ?, successor = ?, rotated_from = ? WHERE token_hash = ?')
        .run(this.now(), sealSuccessor(input.token, row.token_id, { access, refresh: issued.refresh_token }), network, presented);
      return { ...issued, principalId: row.principal_id, orgId: row.org_id };
    }).immediate();
  }

  /** Inside the grace: a sealed pair, the rotation's own network, and an age the sweep has not reached. */
  private withinGrace(row: GrantRow, network: string | null): boolean {
    if (row.used_at === null || row.successor === null || network === null || row.rotated_from !== network) return false;
    const age = this.now() - row.used_at;
    return age > -GRACE_CLOCK_SKEW_MS && age < MCP_REFRESH_REUSE_GRACE_MS;
  }

  /**
   * The grant's CURRENT pair, reached from a consumed refresh token: its own
   * sealed successor, then, while that successor was itself consumed (which
   * can only have happened later, so inside the same grace), the next one.
   * Every rotation walked must have come from the requesting network: a pair
   * a rotation elsewhere issued is a collision, not a race. `reuse` unless the
   * pair reached is the grant's live one; `exhausted` past the hop bound.
   */
  private replay(tokenId: string, consumed: string, sealed: string, network: string) {
    let pair = openSuccessor(consumed, tokenId, sealed);
    for (let hop = 0; pair; hop += 1) {
      const next = this.db.prepare('SELECT used, successor, rotated_from FROM auth_mcp_refresh WHERE token_hash = ? AND token_id = ?')
        .get(oauthHash(pair.refresh), tokenId) as { used: number; successor: string | null; rotated_from: string | null } | undefined;
      if (!next) return 'reuse' as const;
      if (!next.used) break;
      if (next.rotated_from !== network) return 'reuse' as const;
      if (hop >= MAX_REPLAY_HOPS) return 'exhausted' as const;
      pair = next.successor ? openSuccessor(pair.refresh, tokenId, next.successor) : null;
    }
    if (!pair) return 'reuse' as const;
    const live = this.db.prepare('SELECT 1 FROM auth_api_tokens WHERE token_id = ? AND token_hash = ? AND revoked_at IS NULL')
      .get(tokenId, oauthHash(pair.access));
    return live ? this.answer(tokenId, pair.access, pair.refresh) : 'reuse' as const;
  }

  sweep(): void {
    this.db.prepare('DELETE FROM auth_mcp_codes WHERE expires_at <= ?').run(this.now());
    this.db.prepare(`DELETE FROM auth_mcp_refresh WHERE token_id IN
      (SELECT g.token_id FROM auth_mcp_grants g JOIN auth_api_tokens t ON t.token_id = g.token_id
       WHERE g.refresh_expires_at <= ? OR t.revoked_at IS NOT NULL)`).run(this.now());
    this.db.prepare('DELETE FROM auth_mcp_clients WHERE expires_at <= ?').run(this.now());
    // Past the grace a sealed successor answers nothing; drop it (the same
    // bound `withinGrace` applies: an age of the full grace is outside it).
    this.db.prepare('UPDATE auth_mcp_refresh SET successor = NULL WHERE successor IS NOT NULL AND used_at <= ?')
      .run(this.now() - MCP_REFRESH_REUSE_GRACE_MS);
  }

  accessCurrent(tokenId: string): boolean {
    const row = this.db.prepare('SELECT access_expires_at FROM auth_mcp_grants WHERE token_id = ?')
      .get(tokenId) as { access_expires_at: number } | undefined;
    return !row || row.access_expires_at > this.now();
  }

  revoke(auth: AuthStore, token: string, clientId: string, onRevoked?: Revoked): void {
    const row = this.db.prepare(`SELECT t.token_id, t.principal_id, t.org_id FROM auth_api_tokens t
      JOIN auth_mcp_grants g ON g.token_id = t.token_id
      WHERE g.client_id = ? AND (t.token_hash = ? OR t.token_id IN
        (SELECT token_id FROM auth_mcp_refresh WHERE token_hash = ?))`)
      .get(clientId, oauthHash(token), oauthHash(token)) as { token_id: string; principal_id: string; org_id: string } | undefined;
    if (row && auth.revokeApiToken(row.principal_id, row.token_id)) onRevoked?.({ tokenId: row.token_id, principalId: row.principal_id, orgId: row.org_id, clientId, reason: 'client_revocation' });
    return;
  }

  private member(principalId: string, orgId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM auth_memberships WHERE principal_id = ? AND org_id = ?').get(principalId, orgId);
  }

  private tokens(tokenId: string, access: string) {
    const refresh = secret();
    this.db.prepare('INSERT INTO auth_mcp_refresh (token_hash, token_id) VALUES (?, ?)').run(oauthHash(refresh), tokenId);
    return this.answer(tokenId, access, refresh);
  }

  /** The token response for a pair already stored: `expires_in` counts down the grant's live access expiry. */
  private answer(tokenId: string, access: string, refresh: string) {
    const expiry = this.db.prepare('SELECT access_expires_at FROM auth_mcp_grants WHERE token_id = ?')
      .get(tokenId) as { access_expires_at: number };
    return { tokenId, access_token: access, token_type: 'Bearer' as const,
      expires_in: Math.max(0, Math.floor((expiry.access_expires_at - this.now()) / 1000)), refresh_token: refresh, scope: MCP_OAUTH_SCOPE };
  }
}
