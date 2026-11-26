import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { startEgressProxy, type RunningEgressProxy } from '../src/tools/egressProxy.js';
import { egressProxyFor, probeEgressDenial } from '../src/tools/egressDenial.js';
import { fetchUrlTool } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';

/**
 * Behind NODE_USE_ENV_PROXY a proxy refusal reaches fetch as a bare
 * "fetch failed" (cause "Request was cancelled.", no status). Three DVF runs
 * on a Compute device (2026-11-23) retried an official download for 189
 * minutes against an allowlist that never admitted it. These tests drive the
 * REAL proxy: the refusal fetch_url reports is the proxy's own answer.
 */

let proxy: RunningEgressProxy | null = null;
let origin: Server | null = null;
const savedProxy = process.env['HTTPS_PROXY'];
const roots: string[] = [];
const sockets = new Set<Socket>();
/** A test origin whose sockets afterEach can destroy: close() alone waits for them. */
function createServer(handler?: (s: Socket) => void): Server {
  return createNetServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    handler?.(s);
  });
}
afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  await proxy?.close();
  proxy = null;
  await new Promise<void>((r) => (origin ? origin.close(() => r()) : r()));
  origin = null;
  if (savedProxy === undefined) delete process.env['HTTPS_PROXY'];
  else process.env['HTTPS_PROXY'] = savedProxy;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function startProxy(allowlist: string[], allowedPorts?: number[]): Promise<number> {
  proxy = await startEgressProxy({ port: 0, allowlist, ...(allowedPorts ? { allowedPorts } : {}), log: () => {} });
  return proxy.port;
}

describe('probeEgressDenial', () => {
  it('reports a policy refusal with the proxy\'s reason', async () => {
    const port = await startProxy(['registry.npmjs.org']);
    const denial = await probeEgressDenial('https://files.data.gouv.fr/geo-dvf/latest/csv/2024/departements/75.csv',
      { env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } });
    expect(denial).toEqual({ host: 'files.data.gouv.fr', port: 443, reason: 'not in the egress allowlist', kind: 'policy' });
  });

  it('a port outside the set is a policy refusal too', async () => {
    const port = await startProxy(['example.org']);
    const denial = await probeEgressDenial('https://example.org:8443/x', { env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } });
    expect(denial?.kind).toBe('policy');
    expect(denial?.port).toBe(8443);
  });

  it('an allowed destination is not a refusal, and the tunnel is closed', async () => {
    let received = 0;
    let tunnelClosed!: () => void;
    const closed = new Promise<void>((r) => { tunnelClosed = r; });
    origin = createServer((s) => { s.on('data', (b: Buffer) => { received += b.length; }); s.on('close', () => tunnelClosed()); });
    const originPort = await new Promise<number>((r) => origin!.listen(0, '127.0.0.1', () => r((origin!.address() as { port: number }).port)));
    const port = await startProxy(['localhost'], [originPort]);
    const denial = await probeEgressDenial(`https://localhost:${originPort}/`, { env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } });
    expect(denial).toBeUndefined();
    await closed;
    expect(received).toBe(0);
  });

  it('no proxy, NO_PROXY, an unreachable proxy or a foreign answer is undefined', async () => {
    expect(await probeEgressDenial('https://example.org/', { env: {} })).toBeUndefined();
    expect(egressProxyFor(new URL('https://api.example.org/'), { HTTPS_PROXY: 'http://p:3128', NO_PROXY: '.example.org' })).toBeUndefined();
    const closed = createServer();
    const closedPort = await new Promise<number>((r) => closed.listen(0, '127.0.0.1', () => r((closed.address() as { port: number }).port)));
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await probeEgressDenial('https://example.org/', { env: { HTTPS_PROXY: `http://127.0.0.1:${closedPort}` } })).toBeUndefined();
    origin = createServer((s) => s.end('HTTP/1.1 403 Forbidden\r\n\r\nsome other proxy\n'));
    const foreign = await new Promise<number>((r) => origin!.listen(0, '127.0.0.1', () => r((origin!.address() as { port: number }).port)));
    expect(await probeEgressDenial('https://example.org/', { env: { HTTPS_PROXY: `http://127.0.0.1:${foreign}` } })).toBeUndefined();
  });

  it('a proxy that predates the kind header is reported without the host-policy claim', async () => {
    origin = createServer((s) => s.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\negress denied: not in the egress allowlist\n'));
    const old = await new Promise<number>((r) => origin!.listen(0, '127.0.0.1', () => r((origin!.address() as { port: number }).port)));
    const denial = await probeEgressDenial('https://files.data.gouv.fr/', { env: { HTTPS_PROXY: `http://127.0.0.1:${old}` } });
    expect(denial?.kind).toBe('unknown');
  });
});

describe('fetch_url behind a refusing proxy', () => {
  it('returns the typed policy refusal instead of a bare fetch failure', async () => {
    const port = await startProxy(['registry.npmjs.org']);
    process.env['HTTPS_PROXY'] = `http://127.0.0.1:${port}`;
    const root = mkdtempSync(join(tmpdir(), 'atoma-egress-denial-'));
    roots.push(root);
    const fetchUrl = fetchUrlTool({ sandbox: new ToolSandbox(root) });
    // `.invalid` never resolves (RFC 6761): the direct request fails without
    // any network, which is where the proxy is asked.
    const result = await fetchUrl.execute({ url: 'https://data.example.invalid/75.csv' }) as Record<string, unknown>;
    expect(result['ok']).toBe(false);
    expect(result['egressDenied']).toMatchObject({ host: 'data.example.invalid', kind: 'policy' });
    expect(String(result['error'])).toMatch(/^egress denied by this run's host network policy: data\.example\.invalid:443/);
    expect(String(result['error'])).toContain('retrying');
  });
});
