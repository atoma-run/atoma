import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { packageVersion } from '../src/mcp/server.js';

/**
 * `server.json` is what the MCP Registry lists: it names the ONE `/mcp` route
 * of the deployed server. Nothing reads it at runtime, so nothing but this
 * suite notices when it drifts from the server it describes.
 */

interface ServerJson {
  $schema: string;
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  repository: { url: string; source: string; id: string };
  icons: Array<{ src: string; mimeType: string; sizes: string[] }>;
  remotes: Array<{
    type: string;
    url: string;
    headers: Array<{ name: string; isRequired: boolean; isSecret: boolean }>;
  }>;
}

const server = JSON.parse(readFileSync('server.json', 'utf8')) as ServerJson;
const homepage = new URL((JSON.parse(readFileSync('package.json', 'utf8')) as { homepage: string }).homepage);

describe('server.json, the registry entry for the MCP', () => {
  it('stays inside the limits of the schema it names', () => {
    expect(server.$schema).toBe('https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title.length).toBeLessThanOrEqual(100);
  });

  it('carries the version the server reports in serverInfo', () => {
    expect(server.version).toBe(packageVersion());
  });

  it('names the deployed origin: its namespace, its site and its one route', () => {
    // A domain namespace is proved by the domain itself (DNS or HTTP), so it
    // must be the reversed host the remote is served from.
    expect(server.name.split('/')[0]).toBe(homepage.hostname.split('.').reverse().join('.'));
    expect(server.websiteUrl).toBe(homepage.origin);
    expect(server.remotes).toEqual([
      expect.objectContaining({ type: 'streamable-http', url: new URL('/mcp', homepage).href }),
    ]);
  });

  it('offers the API token as optional, because /mcp also signs clients in through OAuth', () => {
    expect(server.remotes[0]!.headers).toEqual([
      expect.objectContaining({ name: 'Authorization', isRequired: false, isSecret: true }),
    ]);
  });

  it('points its icons at files the server actually serves', () => {
    for (const icon of server.icons) {
      const url = new URL(icon.src);
      expect(url.origin).toBe(homepage.origin);
      expect(existsSync(`src/viz/public${url.pathname}`), icon.src).toBe(true);
    }
  });
});
