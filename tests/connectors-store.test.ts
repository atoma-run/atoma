import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createSecretKey, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorConflict, ConnectorInputError, ConnectorStore, connectorView, openConnectorAuthority } from '../src/connectors/store.js';
import type { SecretEncryptionContext } from '../src/auth/secretEncryption.js';

const encryption = (): SecretEncryptionContext => ({ key: createSecretKey(randomBytes(32)), keyId: 'test-key' });

/** The two parent tables the connection tables reference, reduced to their keys. */
function parents(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS auth_organisations (org_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, UNIQUE(project_id, org_id));
    INSERT OR IGNORE INTO auth_organisations VALUES ('org'), ('org-a'), ('org-b'), ('other');
    INSERT OR IGNORE INTO projects VALUES ('proj', 'org'), ('other', 'org');`);
}

function store(): { store: ConnectorStore; db: Database.Database } {
  const db = new Database(':memory:');
  parents(db);
  return { store: new ConnectorStore(db), db };
}

describe('organisation MCP connections', () => {
  it('stores a header secret encrypted and never lists it', () => {
    const { store: connectors, db } = store();
    const enc = encryption();
    const row = connectors.create('org-a', 'p1', {
      key: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', authKind: 'header',
      headerName: 'Authorization', headerValue: 'Bearer lin_secret_value',
    }, enc);
    const raw = db.prepare('SELECT header_secret FROM org_mcp_servers').get() as { header_secret: string };
    expect(raw.header_secret).not.toContain('lin_secret_value');
    expect(connectors.open(row, 'header', enc)).toBe('Bearer lin_secret_value');
    const view = connectorView(row, true, enc);
    expect(JSON.stringify(view)).not.toContain('lin_secret_value');
    expect(view).toMatchObject({ key: 'linear', host: 'mcp.linear.app', hasHeaderSecret: true, status: 'ready' });
    // A member sees neither the URL (a path may be a credential) nor the header name.
    const reader = connectorView(row, false, enc);
    expect(reader.url).toBeUndefined();
    expect(reader.headerName).toBeUndefined();
  });

  it('binds an envelope to its organisation, connection and URL', () => {
    const { store: connectors, db } = store();
    const enc = encryption();
    const a = connectors.create('org-a', 'p1', { key: 'one', name: 'One', url: 'https://one.example/mcp', authKind: 'header', headerValue: 'tok-a' }, enc);
    const b = connectors.create('org-b', 'p2', { key: 'one', name: 'One', url: 'https://one.example/mcp', authKind: 'header', headerValue: 'tok-b' }, enc);
    // Copy org A's envelope onto org B's row: authentication fails, nothing is presented.
    db.prepare('UPDATE org_mcp_servers SET header_secret = ? WHERE server_id = ?').run(a.header_secret, b.server_id);
    expect(connectors.open(connectors.get('org-b', b.server_id)!, 'header', enc)).toBeNull();
    // Point A's row at another host behind the store's back: the envelope no longer opens.
    db.prepare('UPDATE org_mcp_servers SET url = ? WHERE server_id = ?').run('https://attacker.example/mcp', a.server_id);
    expect(connectors.open(connectors.get('org-a', a.server_id)!, 'header', enc)).toBeNull();
  });

  it('refuses URLs that are not plain HTTPS', () => {
    const { store: connectors } = store();
    for (const url of ['http://example.com/mcp', 'https://user:pw@example.com/mcp', 'file:///etc/passwd', 'https://example.com/mcp#x']) {
      expect(() => connectors.create('org', 'p', { key: 'srv', name: 'S', url, authKind: 'none' }, null)).toThrow(ConnectorInputError);
    }
  });

  it('refuses transport headers and a secret without an encryption key', () => {
    const { store: connectors } = store();
    expect(() => connectors.create('org', 'p', { key: 'srv', name: 'S', url: 'https://x.example/mcp', authKind: 'header', headerName: 'Host', headerValue: 'v' }, encryption()))
      .toThrow(ConnectorInputError);
    expect(() => connectors.create('org', 'p', { key: 'srv', name: 'S', url: 'https://x.example/mcp', authKind: 'header', headerValue: 'v' }, null))
      .toThrow(/ATOMA_SECRET_ENCRYPTION_KEY/);
  });

  it('keeps identifiers unique per organisation only', () => {
    const { store: connectors } = store();
    connectors.create('org-a', 'p', { key: 'srv', name: 'S', url: 'https://x.example/mcp', authKind: 'none' }, null);
    expect(() => connectors.create('org-a', 'p', { key: 'srv', name: 'T', url: 'https://y.example/mcp', authKind: 'none' }, null)).toThrow(ConnectorConflict);
    expect(() => connectors.create('org-b', 'p', { key: 'srv', name: 'S', url: 'https://x.example/mcp', authKind: 'none' }, null)).not.toThrow();
  });

  it('guards edits by revision and forgets credentials when the URL changes', () => {
    const { store: connectors } = store();
    const enc = encryption();
    const row = connectors.create('org', 'p', { key: 'srv', name: 'S', url: 'https://x.example/mcp', authKind: 'oauth' }, enc);
    expect(connectors.saveOauthTokens(row, JSON.stringify({ access_token: 'a', token_type: 'Bearer', refresh_token: 'r' }), null, enc)).toBe(true);
    connectors.setTools('org', row.server_id, [{ name: 'search' }, { name: 'create_issue' }], null);
    const renamed = connectors.update('org', row.server_id, { expectedRevision: 1, name: 'Renamed', disabledTools: ['create_issue'] }, enc)!;
    expect(renamed.after.oauth_tokens).not.toBeNull();
    expect(JSON.parse(renamed.after.disabled_tools)).toEqual(['create_issue']);
    expect(() => connectors.update('org', row.server_id, { expectedRevision: 1, name: 'Stale' }, enc)).toThrow(ConnectorConflict);
    const moved = connectors.update('org', row.server_id, { expectedRevision: 2, url: 'https://elsewhere.example/mcp' }, enc)!;
    expect(moved.after.oauth_tokens).toBeNull();
    expect(moved.after.oauth_client).toBeNull();
    expect(moved.after.tools).toBe('[]');
    expect(moved.after.disabled_tools).toBe('[]');
    // A token written for the old URL after the move changes nothing.
    expect(connectors.saveOauthTokens(row, JSON.stringify({ access_token: 'late', token_type: 'Bearer' }), null, enc)).toBe(false);
  });

  it('replaces a project\'s enabled set with a compare-and-set, within one organisation', () => {
    const { store: connectors } = store();
    const a = connectors.create('org', 'p', { key: 'one', name: 'One', url: 'https://one.example/mcp', authKind: 'none' }, null);
    const foreign = connectors.create('other', 'p', { key: 'two', name: 'Two', url: 'https://two.example/mcp', authKind: 'none' }, null);
    expect(connectors.setProjectServers('org', 'proj', 'p', { serverIds: [a.server_id], expectedServerIds: [] }).after).toEqual([a.server_id]);
    expect(() => connectors.setProjectServers('org', 'proj', 'p', { serverIds: [], expectedServerIds: [] })).toThrow(ConnectorConflict);
    expect(() => connectors.setProjectServers('org', 'proj', 'p', { serverIds: [foreign.server_id], expectedServerIds: [a.server_id] })).toThrow(ConnectorInputError);
    // Removing the connection removes its availability everywhere.
    connectors.remove('org', a.server_id);
    expect(connectors.projectServerIds('org', 'proj')).toEqual([]);
  });

  it('answers the run process read-only, live, per tool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-connectors-'));
    try {
      const file = join(dir, 'atoma.db');
      const seed = new Database(file);
      parents(seed);
      seed.close();
      const connectors = ConnectorStore.open(file);
      const row = connectors.create('org', 'p', { key: 'one', name: 'One', url: 'https://one.example/mcp', authKind: 'none' }, null);
      connectors.setTools('org', row.server_id, [{ name: 'read' }, { name: 'write' }], null);
      connectors.setProjectServers('org', 'proj', 'p', { serverIds: [row.server_id], expectedServerIds: [] });
      const authority = openConnectorAuthority(file, 'org', 'proj');
      expect(authority.allowed(row.server_id, 'write')).toBe('allowed');
      connectors.update('org', row.server_id, { expectedRevision: 1, disabledTools: ['write'] }, null);
      expect(authority.allowed(row.server_id, 'write')).toBe('tool_disabled');
      expect(authority.allowed(row.server_id, 'read')).toBe('allowed');
      // Another project of the same organisation was never given it.
      expect(openConnectorAuthority(file, 'org', 'other').allowed(row.server_id)).toBe('denied');
      connectors.setProjectServers('org', 'proj', 'p', { serverIds: [], expectedServerIds: [row.server_id] });
      expect(authority.allowed(row.server_id, 'read')).toBe('denied');
      authority.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
