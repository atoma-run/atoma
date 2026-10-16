import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConnectorFetchError, connectorFetch, connectorUrl } from '../src/connectors/guardedFetch.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('the one outbound request to a customer server', () => {
  it('accepts only HTTPS URLs without credentials or fragments', () => {
    expect(connectorUrl('https://mcp.example.com:8443/mcp?x=1')).not.toBeNull();
    expect(connectorUrl('http://mcp.example.com/mcp')).toBeNull();
    expect(connectorUrl('https://u:p@mcp.example.com/mcp')).toBeNull();
    expect(connectorUrl('https://mcp.example.com/mcp#f')).toBeNull();
    expect(connectorUrl('http://127.0.0.1:9/mcp')).toBeNull();
  });

  it('refuses IP literals, which never reach the guarded lookup', async () => {
    for (const url of ['https://10.0.0.5:5432/', 'https://[::1]:8443/mcp', 'https://2130706433/mcp', 'https://169.254.169.254/latest']) {
      expect(connectorUrl(url), url).toBeNull();
      await expect(connectorFetch()(url)).rejects.toThrow(ConnectorFetchError);
    }
  });

  it('refuses a name that resolves to a private or loopback address, before connecting', async () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1']) {
      const fetch = connectorFetch({ resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
      await expect(fetch('https://rebinding.example/mcp')).rejects.toThrow(ConnectorFetchError);
    }
  });

  it('refuses a name with one private record among public ones', async () => {
    const fetch = connectorFetch({ resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.1', family: 4 }] });
    await expect(fetch('https://mixed.example/mcp')).rejects.toThrow(ConnectorFetchError);
  });

  it('reports a redirect instead of following it', async () => {
    let followed = false;
    const base = await listen((req, res) => {
      if (req.url === '/elsewhere') { followed = true; res.end('no'); return; }
      res.writeHead(302, { location: '/elsewhere' }); res.end();
    });
    const response = await connectorFetch({ loopbackForTests: true })(`${base}/mcp`, { headers: { authorization: 'Bearer t' } });
    expect(response.status).toBe(302);
    expect(followed).toBe(false);
  });

  it('bounds the response body', async () => {
    const base = await listen((_req, res) => { res.end('x'.repeat(4096)); });
    const response = await connectorFetch({ loopbackForTests: true, maxResponseBytes: 1024 })(`${base}/big`);
    await expect(response.text()).rejects.toThrow();
  });

  it('carries the body and headers the SDK sends', async () => {
    let seen: { method?: string; auth?: string; type?: string; body: string } = { body: '' };
    const base = await listen((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { seen = { method: req.method, auth: req.headers.authorization, type: req.headers['content-type'], body }; res.end('{}'); });
    });
    await connectorFetch({ loopbackForTests: true })(`${base}/token`, {
      method: 'POST', headers: { authorization: 'Bearer abc' }, body: new URLSearchParams({ grant_type: 'refresh_token' }),
    });
    expect(seen).toMatchObject({ method: 'POST', auth: 'Bearer abc', body: 'grant_type=refresh_token' });
    expect(seen.type).toContain('application/x-www-form-urlencoded');
  });
});
