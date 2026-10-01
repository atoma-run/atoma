import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { defaultBuiltinTools } from '../src/tools/builtin.js';
import { HOST_REPLAY_ARG } from '../src/contracts/inheritedChecks.js';
import { inheritedChecksFor } from '../src/run/inheritedChecks.js';
import type { ToolExecutor } from '../src/core/types.js';

/**
 * The host's replay across the real boundary: python's static server and
 * Chrome, through the same builtin tools every molecule uses
 * (docs/inherited-checks-replay-2026-10-01.md). The first half pins the host
 * mode of `validate_html`, the second the b9dc4d0b catch end to end.
 */

const sandboxes: ToolSandbox[] = [];
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const s of sandboxes.splice(0)) await s.cleanup().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): { root: string; tools: ToolExecutor } {
  const root = mkdtempSync(join(tmpdir(), 'atoma-inherited-browser-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const sandbox = new ToolSandbox(root);
  sandboxes.push(sandbox);
  const builtins = defaultBuiltinTools({ sandbox });
  const tools: ToolExecutor = {
    has: (name) => builtins.some((tool) => tool.declaration.name === name),
    execute: (name, args) => builtins.find((tool) => tool.declaration.name === name)!.execute(args),
  };
  return { root, tools };
}

async function served(tools: ToolExecutor): Promise<string> {
  const started = await tools.execute('start_static_server', {}) as { ok: boolean; url: string };
  expect(started.ok, JSON.stringify(started)).toBe(true);
  return started.url.replace(/\/$/, '');
}

const replay = (tools: ToolExecutor, url: string, smoke: string, extra: Record<string, unknown> = {}) =>
  tools.execute('validate_html', { url, smoke, [HOST_REPLAY_ARG]: true, ...extra }) as Promise<Record<string, unknown>>;

describe('validate_html in host replay mode', () => {
  it('opens every call in a fresh context: no storage outlives it', async () => {
    const { tools } = workspace({ 'index.html': '<!doctype html><title>t</title><p id="x">x</p>' });
    const origin = await served(tools);
    const write = await replay(tools, `${origin}/index.html`, "(() => { localStorage.setItem('leak', 'yes'); return { ok: true }; })()");
    expect(write['smokeOk']).toBe(true);
    const read = await replay(tools, `${origin}/index.html`, "(() => ({ ok: localStorage.getItem('leak') === null }))()");
    expect(read['smokeOk'], JSON.stringify(read)).toBe(true);
  }, 60_000);

  it('lets the page reach its own origin only', async () => {
    const { tools } = workspace({ 'index.html': '<!doctype html><title>t</title><p>x</p>', 'data.json': '{"ok":true}' });
    const origin = await served(tools);
    const stranger = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end('{"reached":true}'); });
    servers.push(stranger);
    await new Promise<void>((resolve) => stranger.listen(0, '127.0.0.1', () => resolve()));
    const port = (stranger.address() as { port: number }).port;
    const smoke = `(async () => {
      const own = await fetch('/data.json').then((r) => r.json()).then((j) => j.ok === true, () => false);
      const other = await fetch('http://127.0.0.1:${port}/').then(() => 'reached', () => 'blocked');
      return { ok: own && other === 'blocked', own, other };
    })()`;
    const result = await replay(tools, `${origin}/index.html`, smoke);
    expect(result['smokeOk'], JSON.stringify(result['smokeResult'])).toBe(true);
  }, 60_000);

  it('keeps a WebSocket, a popup and a worker off any other origin, with the page APIs intact', async () => {
    // Interception never sees these; the context's dead proxy refuses them
    // (review 2026-10-01: a popup escaped a page-level guard).
    const { tools } = workspace({ 'index.html': '<!doctype html><title>t</title><p>x</p>', 'w.js': 'self.onmessage = () => {};' });
    const origin = await served(tools);
    let upgrades = 0;
    const stranger = createServer((_req, res) => { res.end('x'); });
    stranger.on('upgrade', (_req, socket) => { upgrades += 1; socket.destroy(); });
    servers.push(stranger);
    await new Promise<void>((resolve) => stranger.listen(0, '127.0.0.1', () => resolve()));
    const port = (stranger.address() as { port: number }).port;
    const smoke = `(async () => {
      const intact = 'serviceWorker' in navigator && typeof navigator.serviceWorker.register === 'function' && typeof WebSocket === 'function';
      let worker = 'none'; try { new Worker('w.js'); worker = 'made'; } catch (e) { worker = String(e); }
      const open = (W) => new Promise((resolve) => {
        try { const ws = new W('ws://127.0.0.1:${port}/'); ws.onopen = () => resolve('open'); ws.onerror = () => resolve('error'); setTimeout(() => resolve('timeout'), 2000); }
        catch (e) { resolve('threw'); }
      });
      const socket = await open(WebSocket);
      const popup = window.open('about:blank');
      const popupSocket = popup ? await open(popup.WebSocket) : 'no popup';
      if (popup) popup.close();
      return { ok: intact && worker === 'made' && socket !== 'open' && popupSocket !== 'open', intact, worker, socket, popupSocket };
    })()`;
    const result = await replay(tools, `${origin}/index.html`, smoke);
    expect(result['smokeOk'], JSON.stringify(result['smokeResult'])).toBe(true);
    expect(upgrades).toBe(0);
  }, 60_000);

  it('tells a smoke that threw from one that returned an error on purpose, and reports the response status', async () => {
    const { tools } = workspace({ 'index.html': '<!doctype html><title>t</title><p id="mode">x</p>' });
    const origin = await served(tools);
    const threw = await replay(tools, `${origin}/index.html`, '(() => window.__timer.mode)()');
    expect(threw).toMatchObject({ smokeOk: false, smokeThrew: true, httpStatus: 200 });
    const said = await replay(tools, `${origin}/index.html`, "(() => ({ ok: false, error: 'expected Long break' }))()");
    expect(said).toMatchObject({ smokeOk: false, smokeThrew: false });
    expect(await replay(tools, `${origin}/gone.html`, '(() => ({ ok: true }))()')).toMatchObject({ httpStatus: 404 });
  }, 60_000);

  it('neither reads nor feeds the stuck tracker a molecule answers to', async () => {
    const { tools } = workspace({ 'index.html': '<!doctype html><title>t</title><p id="mode">Mode: Long Break</p>' });
    const origin = await served(tools);
    const smoke = "(() => ({ ok: document.getElementById('mode').textContent === 'Long break' }))()";
    for (let i = 0; i < 4; i++) expect((await replay(tools, `${origin}/index.html`, smoke))['smokeOk']).toBe(false);
    // A molecule re-running the check after the host's four failures is observed, not refused as stuck.
    const molecule = await tools.execute('validate_html', { url: `${origin}/index.html`, smoke }) as { errors: string[] };
    expect(molecule.errors.join(' ')).not.toMatch(/smoke stuck|non-deterministic/);
    expect(molecule.errors.join(' ')).toMatch(/^smoke check failed/);
  }, 90_000);
});

const PAGE = (line: string) => `<!doctype html><html><head><title>Focus Timer</title></head><body>
<button id="break">Break</button><button id="long-break">Long break</button>
<p id="mode">Mode: Pomodoro</p>
<script>
document.getElementById('break').addEventListener('click', () => { document.getElementById('mode').textContent = 'Mode: Short Break'; });
document.getElementById('long-break').addEventListener('click', () => { document.getElementById('mode').textContent = ${JSON.stringify(line)}; });
</script></body></html>`;

const LONG_BREAK_CHECK = {
  probe: 'web', file: 'index.html',
  interactions: [{ type: 'click', selector: '#long-break' }],
  smoke: "(() => ({ ok: document.getElementById('mode').textContent === 'Long break', mode: document.getElementById('mode').textContent }))()",
  expected: '{"ok":true}', consoleErrors: 0,
};
// Written against an implementation the page no longer has: stale before the run.
const STALE_CHECK = { probe: 'web', file: 'index.html', smoke: "(() => ({ ok: window.__timer.mode === 'longBreak' }))()", expected: '{"ok":true}' };

describe('the b9dc4d0b regression, replayed', () => {
  it('keeps the check that held when the run began, and lists it once the delivery changed the line', async () => {
    const { root, tools } = workspace({
      'index.html': PAGE('Long break'),
      '.atoma-probes.json': JSON.stringify({ version: 1, entries: [STALE_CHECK, LONG_BREAK_CHECK] }),
    });
    const lines: string[] = [];
    const runtime = inheritedChecksFor({ workspaceRoot: root, executor: () => tools, log: (line) => lines.push(line) })!;
    expect(runtime).toBeDefined();
    await runtime.ready;
    expect(lines.at(-1)).toMatch(/^inherited checks: 1 of 2 passed twice on the starting page/);
    // The delivery: the label an earlier run asked for is gone.
    writeFileSync(join(root, 'index.html'), PAGE('Mode: Long Break'));
    const report = await runtime.compare({});
    expect(report).toMatchObject({ baseline: { considered: 2, kept: 1 }, replayed: 1, stillPassing: 0 });
    expect(report.listed).toHaveLength(1);
    expect(report.listed[0]).toMatchObject({ cause: 'value-changed' });
    expect(report.listed[0]!.detail).toContain('Mode: Long Break');
    // The host wrote nothing into the workspace.
    expect(readdirSync(root).sort()).toEqual(['.atoma-probes.json', 'index.html']);
  }, 120_000);

  it('lists nothing when the delivery kept the line', async () => {
    const { root, tools } = workspace({
      'index.html': PAGE('Long break'),
      '.atoma-probes.json': JSON.stringify({ version: 1, entries: [LONG_BREAK_CHECK] }),
    });
    const runtime = inheritedChecksFor({ workspaceRoot: root, executor: () => tools, log: () => undefined })!;
    await runtime.ready;
    writeFileSync(join(root, 'index.html'), PAGE('Long break').replace('<title>Focus Timer</title>', '<title>12:00 · Focus Timer</title>'));
    expect(await runtime.compare({})).toMatchObject({ baseline: { kept: 1 }, replayed: 1, stillPassing: 1, listed: [] });
  }, 120_000);
});
