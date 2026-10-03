import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { CONNECTION_FAILURE_RE, fetchUrlTool, isSpeculativeFaviconRequest, startNodeServerTool, type ServedOrigins } from '../src/tools/builtin.js';

/**
 * "Listen on PORT, default 3000" compiles to `Number(process.env.PORT) ||
 * 3000`, and the tool used to inject PORT=0: falsy, so the server bound 3000
 * and the next start in the same run died on EADDRINUSE against the first.
 * Production run 811782c2 (2026-09-26) rewrote the delivered server to
 * `PORT ?? 0`, breaking its own default, to get past the tool.
 */
const DEFAULT_3000 = [
  "import { createServer } from 'node:http';",
  'const port = Number(process.env.PORT) || 3000;',
  "const server = createServer((_req, res) => { res.end('ok'); });",
  "server.listen(port, () => console.log('LISTENING_ON_PORT=' + server.address().port));",
].join('\n');

const sandboxes: ToolSandbox[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.cleanup().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('start_node_server port', () => {
  it('gives a "default 3000" server a real port, so a restart in the same run does not collide', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-node-port-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'server.mjs'), DEFAULT_3000);
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    const origins: ServedOrigins = new Map();
    const tool = startNodeServerTool({ sandbox, servedOrigins: origins });
    const first = (await tool.execute({ entry: 'server.mjs' })) as { ok: boolean; port: number; error?: string };
    const second = (await tool.execute({ entry: 'server.mjs' })) as { ok: boolean; port: number; error?: string };
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(first.port).not.toBe(3000);
    expect(second.port).not.toBe(first.port);
    const answered = await fetch(`http://127.0.0.1:${second.port}/`).then((res) => res.text());
    expect(answered).toBe('ok');
  }, 30_000);

  // Production run 1d42ac2a (2026-10-03): the delivered server streamed static
  // files with no error handler, so Chrome's /favicon.ico request crashed it;
  // the favicon filter and a detached exit listener hid the crash, and every
  // reader saw only "connection refused" on the page's next API call.
  it('names a server that crashed after boot in every later probe of its port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-node-crash-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title><p>hello</p><script>setTimeout(() => fetch("/favicon.ico").catch(() => {}), 300); setTimeout(() => fetch("/api/members"), 1000);</script>');
    writeFileSync(join(dir, 'server.mjs'), [
      "import { createServer } from 'node:http';",
      "import { createReadStream } from 'node:fs';",
      "const server = createServer((req, res) => {",
      "  const file = req.url === '/' ? 'index.html' : req.url.slice(1);",
      "  res.writeHead(200, { 'content-type': 'text/html' });",
      "  createReadStream(file).pipe(res);",
      "});",
      "server.listen(Number(process.env.PORT) || 0, () => console.log('LISTENING_ON_PORT=' + server.address().port));",
    ].join('\n'));
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    const origins: ServedOrigins = new Map();
    const started = (await startNodeServerTool({ sandbox, servedOrigins: origins }).execute({ entry: 'server.mjs' })) as { ok: boolean; url: string };
    expect(started.ok, JSON.stringify(started)).toBe(true);
    // The first request crashes it (no file, no stream error handler).
    await fetch(started.url + "favicon.ico").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const probe = (await fetchUrlTool({ sandbox, servedOrigins: origins }).execute({ url: `${started.url}api/members` })) as { ok: boolean; error?: string };
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('EXITED after it started');
    expect(probe.error).toContain('ENOENT');
  }, 60_000);

  it('keeps a favicon request whose connection broke: that is a server that died answering it', () => {
    expect(isSpeculativeFaviconRequest('http://localhost:1/favicon.ico', 'http://localhost:1/', false)).toBe(true);
    expect(CONNECTION_FAILURE_RE.test('net::ERR_CONNECTION_RESET')).toBe(true);
    expect(CONNECTION_FAILURE_RE.test('net::ERR_EMPTY_RESPONSE')).toBe(true);
    expect(CONNECTION_FAILURE_RE.test('net::ERR_ABORTED')).toBe(false);
  });
});
