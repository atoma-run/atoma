#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The root-owned deployment helper must ship with every release; importing
// its module verifies packaging without running any retention operation.
import './prune-deploy-releases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vizEntry = resolve(root, 'dist/viz/server.js');
const vizIndex = resolve(root, 'dist/viz/client/index.html');
const mcpTools = resolve(root, 'dist/mcp/tools.js');
const releaseVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
if (!existsSync(vizEntry) || !existsSync(vizIndex)) {
  throw new Error('compiled viz server/client missing (run npm run build first)');
}
if (!existsSync(mcpTools)) {
  throw new Error(`compiled MCP catalogue missing: ${mcpTools} (run npm run build first)`);
}
// Also runs on the production host after npm ci --omit=dev, before activation.
await import('./sqlite-release-smoke.mjs');
await import('./retrieval-project-smoke.mjs');
const smokeRoot = mkdtempSync(join(tmpdir(), 'atoma-release-smoke-'));

const freePort = async () =>
  await new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => (error ? rejectPort(error) : resolvePort(port)));
    });
  });

/**
 * THE MCP, THROUGH THE COMPILED SERVER. One surface for everyone (decision
 * 2026-09-05): on the ungated loopback the caller is the operator and the
 * catalogue is the operator's — operator runs, registry, skills, ledger,
 * traces, friction — with nothing tenant-shaped, since this store has no
 * organisations. SSE responses with replayable event ids, one session, the prompt surface with a
 * completion, and a deliberately refused call.
 */
/**
 * A request's reply travels on an SSE stream (the transport never answers plain
 * JSON: that mode drops progress notifications). The stream carries the
 * response frame and, before it, any notification the tool sent; the response
 * is the frame with an `id`. Each SSE event is stamped with an `id:` line the
 * event store can replay from.
 */
const readResponseFrame = async (response) => {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.startsWith('application/json')) return response.json();
  if (!contentType.startsWith('text/event-stream')) throw new Error(`MCP answered ${contentType || 'no content-type'}, expected an SSE stream`);
  const body = await response.text();
  const frames = body
    .split(/\r?\n\r?\n/)
    .map((event) => event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data));
  const reply = frames.find((frame) => frame.id !== undefined && ('result' in frame || 'error' in frame));
  if (!reply) throw new Error(`MCP SSE stream carried no response frame (${frames.length} frames)`);
  if (!/^id:/m.test(body)) throw new Error('MCP SSE frames carry no event ids; the event store is not wired');
  return reply;
};

/**
 * THE ERA PRODUCTION SPEAKS (2026-07-28: every request of the clients seen
 * since 2026-09-30), against the COMPILED server. Raw fetch, because this
 * script also runs on the host after `npm ci --omit=dev`, where the v2
 * client (a devDependency) is absent. It spends nothing: the start it sends
 * is refused by input validation before any lease or run exists.
 */
const mcpModernSmoke = async (base) => {
  const MODERN = '2026-07-28';
  let nextId = 1000;
  const send = async (method, params = {}, extra = {}) => {
    const name = typeof params.name === 'string' ? params.name : typeof params.taskId === 'string' ? params.taskId : undefined;
    return fetch(`${base}/mcp`, {
      method: 'POST',
      ...(extra.signal ? { signal: extra.signal } : {}),
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientInfo': { name: 'atoma-release-smoke', version: releaseVersion },
        'io.modelcontextprotocol/clientCapabilities': extra.capabilities ?? { extensions: { 'io.modelcontextprotocol/tasks': {} } },
      } } }),
    });
  };
  // The JSON-RPC reply of one exchange, from a JSON or an SSE body: every
  // 2026 call answers as SSE (responseMode 'sse'), errors included.
  const exchange = async (method, params = {}, extra = {}) => {
    const response = await send(method, params, extra);
    if (!response.ok) throw new Error(`MCP 2026 ${method} → HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    const frames = contentType.startsWith('application/json') ? [JSON.parse(text)] : text
      .split(/\r?\n\r?\n/)
      .map((event) => event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
      .filter((data) => data.length > 0)
      .map((data) => JSON.parse(data));
    const reply = frames.find((frame) => frame.id !== undefined && ('result' in frame || 'error' in frame));
    if (!reply) throw new Error(`MCP 2026 ${method} carried no response frame`);
    return reply;
  };
  const call = async (method, params = {}, extra = {}) => {
    const reply = await exchange(method, params, extra);
    if (reply.error) throw new Error(`MCP 2026 ${method} failed: ${JSON.stringify(reply.error)}`);
    return reply.result;
  };
  const discovered = await call('server/discover');
  if (!JSON.stringify(discovered).includes(MODERN)) throw new Error('compiled MCP does not offer protocol 2026-07-28 on server/discover');
  const listed = await call('tools/list');
  if (!listed?.tools?.some((tool) => tool.name === 'atoma_operator_run_start')) throw new Error('compiled MCP 2026 tools/list has no start tool');
  if (typeof listed.ttlMs !== 'number' || typeof listed.cacheScope !== 'string') throw new Error('compiled MCP 2026 tools/list carries no cache hints');
  // A task of the extension, refused by validation before any lease: it
  // fails at once, and on this wire an ended start is `completed` with the
  // payload saying how.
  const created = await call('tools/call', { name: 'atoma_operator_run_start', arguments: { goal: '--release-smoke' } });
  if (created?.resultType !== 'task' || typeof created?.task?.taskId !== 'string' && typeof created?.taskId !== 'string') {
    throw new Error(`compiled MCP 2026 start is not a task: ${JSON.stringify(created).slice(0, 200)}`);
  }
  const taskId = created.task?.taskId ?? created.taskId;
  const got = await call('tasks/get', { taskId });
  if (got?.status !== 'completed' || got?.result?.isError !== true) throw new Error(`compiled MCP 2026 tasks/get: ${JSON.stringify(got).slice(0, 200)}`);
  const unknown = await exchange('tasks/get', { taskId: 'no-such-task' });
  if (unknown.error?.code !== -32602) throw new Error('compiled MCP 2026 tasks/get of an unknown id is not -32602');
  // SEP-2663: an ended task's cancel is acknowledged.
  await call('tasks/cancel', { taskId });
  // A listen stream opens with its acknowledgement; read it and leave.
  const abort = new AbortController();
  const stream = await send('subscriptions/listen', { notifications: { toolsListChanged: true } }, { signal: abort.signal, capabilities: {} });
  if (!stream.ok) throw new Error(`compiled MCP 2026 subscriptions/listen → HTTP ${stream.status}`);
  const reader = stream.body.getReader();
  let opened = '';
  while (!opened.includes('notifications/subscriptions/acknowledged')) {
    const { value, done } = await reader.read();
    if (done) break;
    opened += new TextDecoder().decode(value);
  }
  abort.abort();
  if (!opened.includes('notifications/subscriptions/acknowledged')) throw new Error('compiled MCP 2026 listen sent no acknowledgement');
  const health = await call('tools/call', { name: 'atoma_mcp_health', arguments: {} }, { capabilities: {} });
  if (!Object.keys(health?.structuredContent?.mcp?.clients ?? {}).includes(`${MODERN} atoma-release-smoke`)) {
    throw new Error('atoma_mcp_health did not count the 2026 smoke client');
  }
  return { tools: listed.tools.length };
};

const mcpSmoke = async (base) => {
  const accessResponse = await fetch(`${base}/api/tokens`);
  const access = await accessResponse.json();
  if (!accessResponse.ok || access.mode !== 'operator' || access.mcpUrl !== `${base}/mcp`) {
    throw new Error('compiled MCP access discovery did not publish the operator URL');
  }
  let sessionId = null;
  let nextId = 1;
  const call = async (method, params = {}) => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    if (!response.ok) throw new Error(`MCP ${method} → HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const frame = await readResponseFrame(response);
    if (frame.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(frame.error)}`);
    return frame.result;
  };
  const notify = async (method) => {
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    });
  };
  const initialized = await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'atoma-release-smoke', version: releaseVersion },
  });
  if (!sessionId) throw new Error('compiled MCP returned no session id');
  if (!initialized?.capabilities?.completions) throw new Error('compiled MCP does not advertise the completions capability');
  if (!initialized?.capabilities?.tasks?.requests?.tools?.call) throw new Error('compiled MCP does not advertise task-augmented tools/call');
  if (!initialized?.capabilities?.logging) throw new Error('compiled MCP does not advertise the logging capability');
  if (!initialized?.serverInfo?.icons?.[0]?.src?.startsWith('data:image/svg+xml;base64,')) throw new Error('compiled MCP names no icon');
  await notify('notifications/initialized');
  const { tools } = await call('tools/list');
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('compiled MCP listed no tools');
  const names = tools.map((tool) => tool.name);
  for (const required of ['atoma_operator_run_start', 'atoma_operator_run_cancel', 'atoma_registry_list', 'atoma_run_trace', 'atoma_skills_show', 'atoma_ledger_tail', 'atoma_costs', 'atoma_mcp_health', 'atoma_skill_reset', 'atoma_registry_rollback']) {
    if (!names.includes(required)) throw new Error(`compiled MCP is missing ${required}`);
  }
  const startTool = tools.find((tool) => tool.name === 'atoma_operator_run_start');
  if (startTool?.execution?.taskSupport !== 'optional') throw new Error('atoma_operator_run_start is not a task tool');
  const benchmarkTool = tools.find((tool) => tool.name === 'atoma_benchmark_start');
  if (benchmarkTool?.execution?.taskSupport !== 'optional') throw new Error('atoma_benchmark_start is not a task tool');
  const invalidBenchmark = await call('tools/call', { name: 'atoma_benchmark_start', arguments: { registration: {} } });
  if (!invalidBenchmark.isError) throw new Error('benchmark accepted an unregistered protocol');
  for (const tenantOnly of ['atoma_projects_list', 'atoma_run_start', 'atoma_org_members', 'atoma_journal_tail', 'atoma_notifications', 'atoma_run_preview', 'atoma_jev_calibrate']) {
    if (names.includes(tenantOnly)) throw new Error(`ungated MCP must not expose ${tenantOnly}`);
  }
  const refused = await call('tools/call', { name: 'atoma_run_trace', arguments: { file: '../etc/passwd' } });
  if (!JSON.stringify(refused).includes('refused')) throw new Error('atoma_run_trace did not refuse a traversal');
  for (const section of ['metadata', 'event']) {
    const detail = await call('tools/call', { name: 'atoma_run_trace', arguments: {
      file: 'diagnostic-smoke.json', section, ...(section === 'event' ? { eventId: 'verdict' } : {}),
    } });
    const page = detail.structuredContent;
    if (detail.isError || !page?.snapshot || page.nextTextOffset !== null) throw new Error('compiled MCP detail paging failed');
    const evidence = JSON.parse(page.text);
    if (section === 'metadata' ? evidence.error !== 'exact terminal error' : evidence.reasoning !== 'exact refusal') {
      throw new Error('compiled MCP omitted diagnostic evidence');
    }
  }
  if (!initialized?.capabilities?.resources?.subscribe) throw new Error('compiled MCP does not advertise subscribable resources');
  const resources = (await call('resources/list', {}))?.resources;
  if (!Array.isArray(resources)) throw new Error('compiled MCP resources/list is not a list');
  const templates = (await call('resources/templates/list', {}))?.resourceTemplates ?? [];
  if (!templates.some((template) => template.uriTemplate === 'atoma://runs/{file}')) {
    throw new Error('compiled MCP does not offer the operator trace resource template');
  }
  const listedRuns = await call('tools/call', { name: 'atoma_runs_list', arguments: {} });
  if (!listedRuns?.content?.some((block) => block.type === 'resource_link' && block.uri === 'atoma://runs/diagnostic-smoke.json')) {
    throw new Error('atoma_runs_list does not link the traces it lists');
  }
  const costsResult = await call('tools/call', { name: 'atoma_costs', arguments: {} });
  if (!costsResult?.structuredContent || typeof costsResult.structuredContent.runsScanned !== 'number') {
    throw new Error('atoma_costs returned no structured content');
  }
  // The compiled server wires the host's own counters: this smoke's session is in them.
  const mcpHealth = (await call('tools/call', { name: 'atoma_mcp_health', arguments: {} }))?.structuredContent?.mcp;
  if (!mcpHealth || !Object.keys(mcpHealth.clients ?? {}).some((kind) => kind.endsWith(' atoma-release-smoke'))) {
    throw new Error('atoma_mcp_health did not count the smoke client');
  }
  const { prompts } = await call('prompts/list');
  if (!Array.isArray(prompts) || prompts.length < 4) {
    throw new Error(`expected the compiled MCP prompt surface, got ${Array.isArray(prompts) ? prompts.length : 'none'}`);
  }
  for (const required of ['atoma_goal', 'atoma_inspect_trace', 'atoma_inspect_agent']) {
    if (!prompts.some((prompt) => prompt.name === required)) throw new Error(`compiled MCP is missing prompt ${required}`);
  }
  const completed = await call('completion/complete', {
    ref: { type: 'ref/prompt', name: 'atoma_goal' },
    argument: { name: 'goal', value: '' },
  });
  if (!Array.isArray(completed?.completion?.values) || completed.completion.values.length === 0) {
    throw new Error('compiled MCP returned no goal completions');
  }
  // A caller without a session must be told to initialise, never served.
  const noSession = await fetch(`${base}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream' } });
  if (noSession.status !== 400) throw new Error(`MCP GET without a session answered ${noSession.status}, expected 400`);
  return { tools: tools.length, prompts: prompts.length };
};

try {
  const port = await freePort();
  // EXPLICIT --dir and --db. The compiled server defaults `--dir` from
  // ATOMA_RUNS_DIR and now hosts a resident watch, so an inherited variable
  // would aim this smoke at whatever corpus the machine happens to have.
  const vizRuns = join(smokeRoot, 'runs');
  mkdirSync(vizRuns, { recursive: true });
  writeFileSync(join(vizRuns, 'diagnostic-smoke.json'), JSON.stringify({
    id: 'diagnostic-smoke', label: 'diagnostic smoke', task: { description: 'read evidence' },
    startedAt: '2026-09-24T00:00:00Z', endedAt: '2026-09-24T00:00:01Z', error: 'exact terminal error',
    events: [{ id: 'verdict', kind: 'acceptance', ts: 1, approved: false, reasoning: 'exact refusal' }],
  }));
  const viz = spawn(
    process.execPath,
    [
      vizEntry,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--dir', vizRuns,
      '--db', join(smokeRoot, 'store.db'),
    ],
    { cwd: root, env: { ...process.env, ATOMA_RUNS_DIR: vizRuns }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let vizStderr = '';
  viz.stderr.on('data', (chunk) => {
    vizStderr += chunk.toString();
  });
  const vizExited = new Promise((resolveExit) => viz.once('exit', resolveExit));
  try {
    const deadline = Date.now() + 10_000;
    let response;
    while (Date.now() < deadline) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) break;
      } catch {
        // Server is still starting.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    if (!response?.ok) throw new Error(`compiled viz did not become ready: ${vizStderr.slice(-500)}`);
    const html = await response.text();
    const asset = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    if (!asset) throw new Error('compiled viz index has no module asset');
    const assetResponse = await fetch(`http://127.0.0.1:${port}${asset}`, {
      headers: { 'accept-encoding': 'br' },
    });
    if (!assetResponse.ok) throw new Error(`compiled viz asset failed: ${assetResponse.status}`);
    const originalAsset = readFileSync(resolve(root, 'dist/viz/client', asset.slice(1)));
    if (
      assetResponse.headers.get('content-encoding') !== 'br' ||
      assetResponse.headers.get('vary') !== 'Accept-Encoding' ||
      Number(assetResponse.headers.get('content-length')) >= originalAsset.length ||
      !Buffer.from(await assetResponse.arrayBuffer()).equals(originalAsset)
    ) {
      throw new Error('compiled viz entry asset was not served as valid Brotli');
    }
    const identityAsset = await fetch(`http://127.0.0.1:${port}${asset}`, {
      headers: { 'accept-encoding': 'identity' },
    });
    if (identityAsset.headers.get('content-encoding') || !Buffer.from(await identityAsset.arrayBuffer()).equals(originalAsset)) {
      throw new Error('compiled viz entry asset has no valid identity fallback');
    }
    const manifestResponse = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    const manifest = await manifestResponse.json();
    if (
      !manifestResponse.ok ||
      !manifestResponse.headers.get('content-type')?.startsWith('application/manifest+json') ||
      manifest.short_name !== 'Atoma' ||
      !Array.isArray(manifest.icons) ||
      manifest.icons.length < 3
    ) {
      throw new Error('compiled viz PWA manifest is missing or invalid');
    }
    for (const path of [
      '/favicon.svg',
      '/apple-touch-icon.png',
      '/icons/atoma-192.png',
      '/icons/atoma-512.png',
      '/icons/atoma-maskable-512.png',
      '/og-card.png',
      '/sw.js',
    ]) {
      const staticResponse = await fetch(`http://127.0.0.1:${port}${path}`);
      if (!staticResponse.ok) {
        throw new Error(`compiled viz PWA asset failed: ${path} → ${staticResponse.status}`);
      }
    }
    const mcp = await mcpSmoke(`http://127.0.0.1:${port}`);
    process.stdout.write(`release smoke: MCP over HTTP — ${mcp.tools} operator tools, ${mcp.prompts} prompts\n`);
    const modern = await mcpModernSmoke(`http://127.0.0.1:${port}`);
    process.stdout.write(`release smoke: MCP 2026-07-28 — ${modern.tools} operator tools, a refused start as a task, listen acknowledged\n`);
    const burninResponse = await fetch(`http://127.0.0.1:${port}/api/burnin`);
    const burnin = await burninResponse.json();
    if (!burninResponse.ok || !Array.isArray(burnin.rows)) {
      throw new Error('compiled viz /api/burnin did not return rows');
    }
  } finally {
    if (viz.exitCode === null) viz.kill('SIGTERM');
    await Promise.race([
      vizExited,
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (viz.exitCode === null) {
      viz.kill('SIGKILL');
      await Promise.race([
        vizExited,
        new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
      ]);
    }
  }
  process.stdout.write('release smoke ok: compiled viz UI/API and the MCP through it\n');
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
