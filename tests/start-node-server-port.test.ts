import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { serverCodeDigest } from '../src/contracts/serverDigest.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { HTTP_STARTUP_GUIDANCE } from '../src/atoms/prompts.js';
import { makeCtx, jsonText } from './helpers.js';
import { makeTools } from './helpers/factories.js';
import { CONNECTION_FAILURE_RE, MAX_LIVE_NODE_SERVERS, fetchUrlTool, isFileLocation, isSpeculativeFaviconRequest, startNodeServerTool, type ServedOrigins } from '../src/tools/builtin.js';

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
  it('updates planning and execution guidance for a stored agent without rewriting its identity', async () => {
    const old = 'The server MUST print LISTENING_ON_PORT and accept no CLI arguments.';
    const child = new L1Atom({ name: 'Methane', ordinal: 2, systemPrompt: old, tools: makeTools(['start_node_server']), params: {} });
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ reasoning: 'Honor CLI', proposedAction: 'start server with args', expectedOutput: 'HTTP evidence' }));
    const task = { description: 'Verify the existing server CLI; preserve JSON stdout.' };
    const plan = await child.plan(task, ctx);
    ctx.llm.enqueueText(jsonText({ output: 'fixture', summary: 'fixture' }));
    await child.execute(task, plan, ctx);
    expect(ctx.llm.calls).toHaveLength(2);
    for (const call of ctx.llm.calls) {
      expect(call.systemPrompt).toContain(old);
      expect(call.userContent).toContain(HTTP_STARTUP_GUIDANCE);
    }
  });

  it('preserves literal CLI arguments and fragmented JSON readiness without rewriting the server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-node-json-'));
    dirs.push(dir);
    const source = [
      "import { createServer } from 'node:http';",
      'const argv = process.argv.slice(2);',
      "if (argv[0] !== '--port') throw Error('CLI required');",
      "const server = createServer((_req, res) => res.end(JSON.stringify(argv)));",
      "server.listen(Number(argv[1]), '127.0.0.1', () => {",
      "  console.log('ordinary startup log');",
      "  console.log(JSON.stringify({port: 0}));",
      "  console.log(JSON.stringify({port: 1234, unrelated: true}));",
      "  const line = JSON.stringify({port: server.address().port});",
      "  process.stdout.write(line.slice(0, -2));",
      "  setTimeout(() => process.stdout.write(line.slice(-2) + '\\n'), 30);",
      '});',
    ].join('\n');
    writeFileSync(join(dir, 'server.mjs'), source);
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    const origins: ServedOrigins = new Map();
    const args = ['--port', '0', '--seed', 'seed with spaces.json', '--literal', '$(touch injected); `false`'];
    const started = await startNodeServerTool({ sandbox, servedOrigins: origins }).execute({ entry: 'server.mjs', args }) as { ok: boolean; port: number; url: string };
    expect(started.ok).toBe(true);
    expect(await fetch(`http://127.0.0.1:${started.port}/`).then(r => r.json())).toEqual(args);
    expect(readFileSync(join(dir, 'server.mjs'), 'utf8')).toBe(source);
    expect(origins.get(started.port)?.codeDigest).toBeUndefined();
    const probe = await fetchUrlTool({ sandbox, servedOrigins: origins }).execute({ url: started.url }) as { servedBy?: { entry?: string; codeDigest?: string } };
    expect(probe.servedBy?.entry).toBe('server.mjs');
    expect(probe.servedBy?.codeDigest).toBeUndefined();
  });

  it.each([null, 'shell string', [1], ['nul\0byte']])('rejects malformed argv before spawning: %j', async args => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-node-argv-'));
    dirs.push(dir);
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    await expect(startNodeServerTool({ sandbox }).execute({ entry: 'missing.mjs', args })).rejects.toThrow('args must be an array');
  });

  it.each(['{"port":1234}', '{"port":"1234"}\n', '{"port":65536}\n', '[{"port":1234}]\n'])('does not accept incomplete or invalid readiness %j', async line => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-node-readiness-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'server.mjs'), `process.stdout.write(${JSON.stringify(line)});`);
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    await expect(startNodeServerTool({ sandbox }).execute({ entry: 'server.mjs' })).rejects.toThrow('exited early');
  });

  it('takes a JSON port line as readiness only from a CLI started with literal args', async () => {
    // Any server may print a JSON object with one `port` field (a config dump,
    // a peer's address); only a task CLI given args announces itself that way.
    const dir = mkdtempSync(join(tmpdir(), 'atoma-node-json-only-cli-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'server.mjs'), "process.stdout.write('{\"port\":1234}\\n');");
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    await expect(startNodeServerTool({ sandbox }).execute({ entry: 'server.mjs' })).rejects.toThrow('exited early');
  });

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

  // Production run 96d5c845 (2026-10-04): every start lived until the run
  // ended; 53 servers held 812 MB and swapped the host until nothing answered.
  it('keeps at most a few servers running, stopping the oldest, and says so to a probe of its port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-node-cap-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'server.mjs'), DEFAULT_3000);
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    const origins: ServedOrigins = new Map();
    const tool = startNodeServerTool({ sandbox, servedOrigins: origins });
    const started: { ok: boolean; port: number; url: string; pid: number }[] = [];
    for (let i = 0; i <= MAX_LIVE_NODE_SERVERS; i++) {
      started.push((await tool.execute({ entry: 'server.mjs' })) as { ok: boolean; port: number; url: string; pid: number });
    }
    expect(started.every((server) => server.ok)).toBe(true);
    const oldest = started[0]!;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(origins.get(oldest.port)?.stoppedByHost).toBe(true);
    const probe = (await fetchUrlTool({ sandbox, servedOrigins: origins }).execute({ url: oldest.url })) as { ok: boolean; error?: string };
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('STOPPED by the host');
    for (const server of started.slice(1)) {
      expect(await fetch(`http://127.0.0.1:${server.port}/`).then((res) => res.text())).toBe('ok');
      expect(origins.get(server.port)?.stoppedByHost).toBeUndefined();
    }
  }, 60_000);

  // Code review 2026-10-09, 1.8: the cap sent ONE group SIGTERM and marked the
  // oldest stopped at once. A server that handles SIGTERM to close cleanly
  // (the shape real long-running servers take) kept answering: 7 starts, 7
  // answering, 3 "stopped by the host". The host now escalates to SIGKILL and
  // marks it stopped only once its exit is confirmed.
  it.each([
    { mode: 'ignores SIGTERM', handler: "process.on('SIGTERM', () => console.error('draining...'));", signal: 'SIGKILL' },
    { mode: 'obeys SIGTERM', handler: '', signal: 'SIGTERM' },
  ])('keeps the cap with a server that $mode, and calls stopped only what exited', async ({ handler, signal }) => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-node-cap-term-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'server.mjs'), [
      "import { createServer } from 'node:http';",
      handler,
      "const server = createServer((_req, res) => res.end('ok'));",
      "server.listen(Number(process.env.PORT) || 0, () => console.log('LISTENING_ON_PORT=' + server.address().port));",
    ].join('\n'));
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    const origins: ServedOrigins = new Map();
    const tool = startNodeServerTool({ sandbox, servedOrigins: origins });
    const started: { ok: boolean; port: number; pid: number }[] = [];
    for (let i = 0; i < MAX_LIVE_NODE_SERVERS + 3; i++) {
      started.push((await tool.execute({ entry: 'server.mjs' })) as { ok: boolean; port: number; pid: number });
    }
    expect(started.every((server) => server.ok)).toBe(true);
    let answering = 0;
    for (const server of started) {
      const text = await fetch(`http://127.0.0.1:${server.port}/`, { signal: AbortSignal.timeout(2000) })
        .then((res) => res.text(), () => undefined);
      if (text === 'ok') answering++;
    }
    expect(answering).toBeLessThanOrEqual(MAX_LIVE_NODE_SERVERS);
    const stopped = started.filter((server) => origins.get(server.port)?.stoppedByHost);
    expect(stopped.map((server) => server.port)).toEqual(started.slice(0, 3).map((server) => server.port));
    for (const server of stopped) {
      // Stopped means EXITED, never a signal merely sent; an obedient server
      // goes on the SIGTERM, before any escalation.
      expect(origins.get(server.port)?.exited?.signal).toBe(signal);
      expect(() => process.kill(server.pid, 0)).toThrow();
    }
  }, 60_000);

  it('stamps the server code digest on what fetch_url observes, as the host records it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-node-digest-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'answer.mjs'), 'export const answer = 42;\n');
    writeFileSync(join(dir, 'server.mjs'), [
      "import { createServer } from 'node:http';",
      "import { answer } from './answer.mjs';",
      "const server = createServer((_req, res) => { res.end(String(answer)); });",
      "server.listen(Number(process.env.PORT) || 0, () => console.log('LISTENING_ON_PORT=' + server.address().port));",
    ].join('\n'));
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    const origins: ServedOrigins = new Map();
    const started = (await startNodeServerTool({ sandbox, servedOrigins: origins }).execute({ entry: 'server.mjs' })) as { ok: boolean; url: string };
    expect(started.ok, JSON.stringify(started)).toBe(true);
    const probe = (await fetchUrlTool({ sandbox, servedOrigins: origins }).execute({ url: started.url })) as { servedBy?: { entry?: string; codeDigest?: string } };
    const read = (path: string) => { try { return readFileSync(join(dir, path), 'utf8'); } catch { return undefined; } };
    expect(probe.servedBy?.entry).toBe('server.mjs');
    expect(probe.servedBy?.codeDigest).toBe(await serverCodeDigest('server.mjs', read));
  }, 60_000);

  // Run 7f7aec0b (2026-10-04): every probe ran against DATA_FILE=<temp> and so
  // recorded no digest. A data location moves state, not code; a flag does not.
  it('digests a server started with only a data location, never one started with a behaviour flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-node-env-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'server.mjs'), DEFAULT_3000);
    const sandbox = new ToolSandbox(dir);
    sandboxes.push(sandbox);
    const origins: ServedOrigins = new Map();
    const tool = startNodeServerTool({ sandbox, servedOrigins: origins });
    const data = (await tool.execute({ entry: 'server.mjs', env: { DATA_FILE: join(dir, 'tmp', 'library.json') } })) as { ok: boolean; port: number };
    const flagged = (await tool.execute({ entry: 'server.mjs', env: { AUTH: 'off' } })) as { ok: boolean; port: number };
    expect(data.ok && flagged.ok).toBe(true);
    expect(origins.get(data.port)?.codeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(origins.get(flagged.port)?.codeDigest).toBeUndefined();
    expect(isFileLocation('/tmp/x.json')).toBe(true);
    expect(isFileLocation('C:\\tmp\\x.json')).toBe(true);
    expect(isFileLocation('production')).toBe(false);
    expect(isFileLocation('https://api.example.com/v1')).toBe(false);
  }, 60_000);

  it('keeps a favicon request whose connection broke: that is a server that died answering it', () => {
    expect(isSpeculativeFaviconRequest('http://localhost:1/favicon.ico', 'http://localhost:1/', false)).toBe(true);
    expect(CONNECTION_FAILURE_RE.test('net::ERR_CONNECTION_RESET')).toBe(true);
    expect(CONNECTION_FAILURE_RE.test('net::ERR_EMPTY_RESPONSE')).toBe(true);
    expect(CONNECTION_FAILURE_RE.test('net::ERR_ABORTED')).toBe(false);
  });
});
