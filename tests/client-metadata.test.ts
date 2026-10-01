import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  cacheLifetimeMs, ClientMetadataError, ClientMetadataResolver, fetchClientMetadataDocument, guardedLookup,
  isPublicAddress, matchesRegisteredRedirect, metadataClientUrl, parseClientMetadata,
} from '../src/auth/clientMetadata.js';

/**
 * The one fetch of a client-chosen URL (OAuth Client ID Metadata Documents,
 * 2026-09-30). These are the bounds that keep it from reaching anything a
 * public client could not reach itself.
 */

const ID = 'https://client.example/oauth/metadata.json';

describe('registered callback matching', () => {
  it('ignores only the port of an HTTP loopback callback', () => {
    for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
      expect(matchesRegisteredRedirect(`http://${host}:55661/callback?x=1`, `http://${host}/callback?x=1`)).toBe(true);
      expect(matchesRegisteredRedirect(`http://${host}:55661/callback`, `http://${host}:1234/callback`)).toBe(true);
    }
    expect(matchesRegisteredRedirect('https://client.example/cb', 'https://client.example/cb')).toBe(true);
    for (const candidate of [
      'http://localhost:55661/callback', 'http://[::1]:55661/callback', 'http://127.0.0.2:55661/callback',
      'https://127.0.0.1:55661/callback', 'http://127.0.0.1:55661/other',
      'http://127.0.0.1:55661/callback?x=1', 'http://127.0.0.1:55661/callback#fragment',
      'http://user@127.0.0.1:55661/callback', 'http://127.0.0.1.evil.example:55661/callback',
      'http://127.0.0.1:55661/a/../callback', 'http://127.0.0.1:55661/%63allback',
      'http://2130706433:55661/callback', 'http://127.0.0.1:99999/callback',
    ]) expect(matchesRegisteredRedirect(candidate, 'http://127.0.0.1/callback'), candidate).toBe(false);
    expect(matchesRegisteredRedirect('https://client.example:444/cb', 'https://client.example/cb')).toBe(false);
    expect(matchesRegisteredRedirect('https://127.0.0.1:444/cb', 'https://127.0.0.1/cb')).toBe(false);
  });
});
const document = (changes: Record<string, unknown> = {}) => JSON.stringify({
  client_id: ID, client_name: 'Example client', redirect_uris: ['http://127.0.0.1:3000/callback'], ...changes,
});

describe('a client metadata URL', () => {
  it('is HTTPS on a DNS name, the default port and a real path, already canonical', () => {
    expect(metadataClientUrl(ID)?.href).toBe(ID);
    for (const refused of [
      'http://client.example/metadata.json', 'https://client.example/', 'https://client.example',
      'https://client.example:8443/metadata.json', 'https://127.0.0.1/metadata.json', 'https://[::1]/metadata.json',
      'https://localhost/metadata.json', 'https://client.example/metadata.json?x=1', 'https://client.example/metadata.json#x',
      'https://user:pass@client.example/metadata.json', 'https://client.example/a/../metadata.json',
      'https://client.example/a/%2e%2e/metadata.json', 'https://CLIENT.example/metadata.json',
      'https://atoma.run./metadata.json',
      '0f8fad5b-d9cb-469f-a165-70867728950e',
    ]) expect(metadataClientUrl(refused), refused).toBeNull();
  });
});

describe('the addresses a metadata fetch may connect to', () => {
  it('are public unicast only', () => {
    for (const address of ['93.184.216.34', '46.225.4.14', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      '127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '198.18.0.1', '203.0.113.9', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2001:db8::1', '2002:c000:0204::1', '2001::1', 'ff02::1', 'not-an-ip',
    ]) expect(isPublicAddress(address), address).toBe(false);
  });

  it('refuse a name whose answer holds one private record, as the socket asks', async () => {
    const lookup = (answer: string[]) => guardedLookup(() => Promise.resolve(answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))));
    const ask = (answer: string[], all: boolean) => new Promise<unknown[]>((resolve) => {
      lookup(answer)('client.example', { all }, (...args) => resolve(args));
    });
    expect(await ask(['93.184.216.34'], false)).toEqual([null, '93.184.216.34', 4]);
    expect(await ask(['93.184.216.34', '2606:2800:220:1::1'], true)).toEqual([null, [
      { address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 },
    ]]);
    const [refused] = await ask(['93.184.216.34', '10.0.0.5'], true);
    expect(refused).toBeInstanceOf(ClientMetadataError);
    // This server's own public address is still this server.
    const own = guardedLookup(() => Promise.resolve([{ address: '46.225.4.14', family: 4 }]), () => new Set(['46.225.4.14']));
    const [self] = await new Promise<unknown[]>((done) => { own('client.example', {}, (...args) => done(args)); });
    expect(self).toBeInstanceOf(ClientMetadataError);
  });

  it('call the socket back once, even when the socket callback throws', async () => {
    const lookup = guardedLookup(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]), () => new Set());
    const calls: unknown[][] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    process.on('uncaughtException', onUncaught);
    try {
      lookup('client.example', {}, (...args) => { calls.push(args); throw new Error('socket callback threw'); });
      await new Promise((done) => setTimeout(done, 20));
    } finally { process.off('uncaughtException', onUncaught); }
    expect(calls).toHaveLength(1);
    expect(uncaught).toHaveLength(1);
  });

  it('are checked by the real request before it connects', async () => {
    // The production fetch, with only DNS stubbed: a name resolving to the
    // loopback never reaches a socket.
    const fetchDocument = fetchClientMetadataDocument(() => Promise.resolve([{ address: '127.0.0.1', family: 4 }]));
    await expect(fetchDocument(new URL(ID))).rejects.toThrow(/client.example does not resolve to public addresses only/);
  });

  it('are checked even when the environment names a proxy', async () => {
    // Review 2026-09-30: with the global agent, NODE_USE_ENV_PROXY sends the
    // request to the proxy, which resolves the name itself — the lookup is
    // never called. A child process, because the variable is read at startup.
    const proxy = createServer((socket) => { connections += 1; socket.destroy(); });
    let connections = 0;
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', () => done()));
    const dir = mkdtempSync(join(tmpdir(), 'atoma-cimd-proxy-'));
    try {
      const port = (proxy.address() as { port: number }).port;
      const script = join(dir, 'probe.mts');
      writeFileSync(script, `import { fetchClientMetadataDocument } from ${JSON.stringify(pathToFileURL(resolve('src/auth/clientMetadata.ts')).href)};
const fetchDocument = fetchClientMetadataDocument(() => Promise.resolve([{ address: '127.0.0.1', family: 4 }]));
await fetchDocument(new URL(${JSON.stringify(ID)})).then(() => console.log('fetched'), (error) => console.log('refused: ' + error.message));
`);
      const child = spawnSync(process.execPath, ['--import', 'tsx', script], {
        encoding: 'utf8', timeout: 30_000, cwd: resolve('.'),
        env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: `http://127.0.0.1:${port}`, https_proxy: `http://127.0.0.1:${port}`, NO_PROXY: '' },
      });
      expect(child.stdout, child.stderr).toContain('refused: client.example does not resolve to public addresses only');
      expect(connections).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await new Promise((done) => proxy.close(done));
    }
  });
});

describe('a fetched client metadata document', () => {
  it('must name the id it was fetched for and a public client with allowed redirects', () => {
    expect(parseClientMetadata(ID, document())).toEqual({
      client_id: ID, client_name: 'Example client', redirect_uris: ['http://127.0.0.1:3000/callback'],
    });
    for (const [changes, reason] of [
      [{ client_id: 'https://other.example/oauth/metadata.json' }, /another client_id/],
      [{ client_name: undefined }, /client_name/],
      [{ redirect_uris: ['http://attacker.example/callback'] }, /redirect_uris/],
      [{ redirect_uris: [] }, /redirect_uris/],
      [{ token_endpoint_auth_method: 'private_key_jwt' }, /client_name or redirect_uris/],
      [{ grant_types: ['refresh_token'] }, /client_name or redirect_uris/],
    ] as const) expect(() => parseClientMetadata(ID, document(changes as Record<string, unknown>))).toThrow(reason);
    // Grants it uses with other servers are its business.
    expect(parseClientMetadata(ID, document({ grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'] })).client_name).toBe('Example client');
    expect(() => parseClientMetadata(ID, '<html>')).toThrow(/not JSON/);
  });

  it('is cached within bounds, and a refusal is not refetched at once', async () => {
    expect(cacheLifetimeMs(undefined)).toBe(3_600_000);
    expect(cacheLifetimeMs('public, max-age=60')).toBe(300_000);
    expect(cacheLifetimeMs('max-age=31536000')).toBe(86_400_000);
    expect(cacheLifetimeMs('no-store')).toBe(300_000);
    let now = 0;
    let fetches = 0;
    let body = document();
    const resolver = new ClientMetadataResolver({ ownHost: 'atoma.example', now: () => now,
      fetchDocument: () => { fetches += 1; return Promise.resolve({ body, cacheControl: undefined }); } });
    await resolver.resolve(ID);
    await resolver.resolve(ID);
    expect(fetches).toBe(1);
    // Unreachable past its lifetime: the last verified reading still stands.
    now += 3_600_001;
    let reachable = false;
    const flaky = new ClientMetadataResolver({ ownHost: 'atoma.example', now: () => now,
      fetchDocument: () => reachable ? Promise.resolve({ body, cacheControl: undefined }) : Promise.reject(new Error('ECONNRESET')) });
    reachable = true; body = document();
    await flaky.resolve(ID);
    now += 3_600_001; reachable = false;
    await expect(flaky.resolve(ID)).resolves.toMatchObject({ client_name: 'Example client' });
    // A document that now names another client withdraws the reading.
    now += 3_600_001;
    body = document({ client_id: 'https://other.example/x.json' });
    await expect(resolver.resolve(ID)).rejects.toThrow(/another client_id/);
    await expect(resolver.resolve(ID)).rejects.toThrow(/refused recently/);
    expect(fetches).toBe(2);
    await expect(resolver.resolve('https://atoma.example/oauth/metadata.json')).rejects.toThrow(/this server/);
  });

  it('is fetched five times a minute per address and thirty for the process, once per id in flight', async () => {
    let now = 0;
    let fetches = 0;
    const resolver = new ClientMetadataResolver({ ownHost: 'atoma.example', now: () => now,
      fetchDocument: (url) => { fetches += 1; return Promise.resolve({ body: document({ client_id: url.href }), cacheControl: undefined }); } });
    for (let i = 0; i < 5; i++) await resolver.resolve(`https://client.example/a${i}.json`, '198.51.100.1');
    await expect(resolver.resolve('https://client.example/a5.json', '198.51.100.1')).rejects.toThrow(/for this address/);
    for (let i = 0; i < 25; i++) await resolver.resolve(`https://client.example/b${i}.json`, `198.51.100.${10 + Math.floor(i / 5)}`);
    await expect(resolver.resolve('https://client.example/c.json', '198.51.100.99')).rejects.toThrow(/fetch rate reached$/);
    // Cached readings are served whatever the budget says.
    await expect(resolver.resolve('https://client.example/a0.json', '198.51.100.1')).resolves.toMatchObject({ client_name: 'Example client' });
    now += 60_001;
    fetches = 0;
    const same = await Promise.all([1, 2, 3].map(() => resolver.resolve('https://client.example/same.json', '198.51.100.2')));
    expect(same.map((client) => client.client_id)).toEqual(Array(3).fill('https://client.example/same.json'));
    expect(fetches).toBe(1);
  });
});
