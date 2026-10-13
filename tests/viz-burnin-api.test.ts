import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const children: ReturnType<typeof spawn>[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startViz(port: number, root: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/viz/server.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--dir',
      join(root, 'runs'),
      '--db',
      join(root, 'missing.db'),
      '--skills-dir',
      join(root, 'skills'),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  children.push(child);
  return child;
}

async function waitForResponse(url: string, init?: RequestInit): Promise<Response | undefined> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, init);
    } catch {
      // The tsx process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

async function rawRequestStatus(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path, headers },
      (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.once('error', reject);
    req.end();
  });
}

async function rawTrace(port: number, path: string, encoding: string) {
  return await new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: { 'accept-encoding': encoding } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    req.end();
  });
}

describe('GET /api/runs/:id', () => {
  it('streams large traces and deltas across the server process boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-viz-trace-cap-'));
    roots.push(root);
    const runs = join(root, 'runs');
    mkdirSync(runs, { recursive: true });
    const small = join(runs, 'small.json');
    writeFileSync(
      small,
      '{"id":"small","label":"small run","startedAt":"2026-08-27T00:00:00.000Z","events":[]}'
    );
    const huge = join(runs, 'huge.json');
    const events = Array.from({ length: 34 }, (_, index) => ({
      id: `e${index}`, kind: 'tool', ts: index, name: 'fetch_url',
      result: { body: 'α😀'.repeat(180_000) },
    }));
    const trace = { id: 'huge', label: 'huge run', startedAt: '2026-10-13T00:00:00Z', events, endedAt: 'now' };
    writeFileSync(huge, JSON.stringify(trace));
    const port = await freePort();
    startViz(port, root);

    const ok = await waitForResponse(`http://127.0.0.1:${port}/api/runs/small`);
    expect(ok?.status).toBe(200);
    const base = `http://127.0.0.1:${port}/api/runs/huge`;
    const full = await fetch(base);
    expect(full.status).toBe(200);
    expect(await full.text()).toBe(readFileSync(huge, 'utf8'));
    const delta = await fetch(`${base}?after=33`);
    expect(delta.status).toBe(200);
    expect(await delta.json()).toEqual({ ...trace, events: events.slice(33), eventsFrom: 33, eventsTotal: 34 });
    expect(await (await fetch(`${base}?after=34`)).json()).toMatchObject({ events: [], eventsFrom: 34, eventsTotal: 34 });
    expect((await fetch(`${base}?after=-1`)).status).toBe(400);
    for (const [encoding, decode] of [['br', brotliDecompressSync], ['gzip', gunzipSync]] as const) {
      const compressed = await rawTrace(port, '/api/runs/huge', encoding);
      expect(compressed.status).toBe(200);
      expect(compressed.headers['content-encoding']).toBe(encoding);
      expect(compressed.headers['vary']).toBe('Accept-Encoding');
      expect(compressed.headers['content-length']).toBeUndefined();
      expect(compressed.headers['cache-control']).toBe('no-store');
      expect(compressed.body.length).toBeLessThan(statSync(huge).size / 2);
      expect(decode(compressed.body).equals(readFileSync(huge))).toBe(true);
      const tail = await rawTrace(port, '/api/runs/huge?after=33', encoding);
      expect(JSON.parse(decode(tail.body).toString('utf8'))).toEqual({
        ...trace, events: events.slice(33), eventsFrom: 33, eventsTotal: 34,
      });
      const smallDelta = await rawTrace(port, '/api/runs/small?after=0', encoding);
      expect(JSON.parse(decode(smallDelta.body).toString('utf8'))).toMatchObject({ id: 'small', events: [], eventsFrom: 0 });
    }
    const identity = await rawTrace(port, '/api/runs/small', 'br;q=0, gzip;q=0');
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(identity.body).toEqual(readFileSync(small));
    expect((await rawTrace(port, '/api/runs/small', 'identity;q=0, *;q=0')).status).toBe(406);
    expect((await rawTrace(port, '/api/runs/missing', 'br')).status).toBe(404);
    const index = await waitForResponse(`http://127.0.0.1:${port}/api/runs`);
    const rows = (await index!.json()) as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toContain('small');
    expect(rows.map((row) => row.id)).toContain('huge');
  }, 20_000);
});

describe('GET /api/burnin', () => {
  it('defaults the lifecycle counters a short row omits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-viz-burnin-'));
    roots.push(root);
    const csv = join(root, 'results.csv');
    writeFileSync(
      csv,
      [
        'timestamp,task_id,family,outcome,cost_usd,duration_s,llm_calls,opus_calls,sonnet_calls,haiku_calls,deterministic_phases,escalations,learned_skills,promotions,refusals,demotions,dispatch_fallbacks,trace,provider,other_calls,learned_event_skills,compile_errors',
        '2026-08-03T08:47:27.027Z,http-echo,http,delivered,0.2519,211,18,1,0,17,0,0,0,echo.json',
        '2026-08-13T08:25:36.355Z,new-run,files,delivered,0.1574,126,11,0,0,0,1,0,0,1,0,0,0,new.json,ollama+zai+codex,11,0,0',
        '2026-08-13T09:00:00.000Z,no-model,files,error,,,,0,0,0,0,0,0,0,0,0,0,none.json',
      ].join('\n') + '\n'
    );
    const port = await freePort();
    startViz(port, root, { ATOMA_BURNIN_CSV: csv });

    const response = await waitForResponse(`http://127.0.0.1:${port}/api/burnin`);
    expect(response?.ok).toBe(true);
    const payload = (await response!.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(payload.rows).toHaveLength(3);
    expect(payload.rows[0]).toMatchObject({
      taskId: 'http-echo',
      provider: 'unknown',
      otherCalls: 0,
      refusals: 0,
      compileErrors: 0,
    });
    expect(payload.rows[1]).toMatchObject({
      taskId: 'new-run',
      provider: 'ollama+zai+codex',
      otherCalls: 11,
    });
    expect(payload.rows[2]).toMatchObject({
      taskId: 'no-model',
      provider: 'unknown',
    });
    expect(payload.rows.every((row) => row['provider'] !== '')).toBe(true);
  }, 20_000);
});

describe('development UI routing', () => {
  it('redirects the API root to Vite while keeping API routes local', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-viz-dev-root-'));
    roots.push(root);
    const port = await freePort();
    startViz(port, root, {
      ATOMA_BURNIN_CSV: join(root, 'missing.csv'),
      ATOMA_VIZ_DEV_URL: 'http://127.0.0.1:5173',
    });

    const rootResponse = await waitForResponse(
      `http://127.0.0.1:${port}/?lang=fr`,
      { redirect: 'manual' }
    );
    expect(rootResponse?.status).toBe(307);
    expect(rootResponse?.headers.get('location')).toBe('http://127.0.0.1:5173/?lang=fr');

    const apiResponse = await fetch(`http://127.0.0.1:${port}/api/burnin`);
    expect(apiResponse.ok).toBe(true);
    expect(await apiResponse.json()).toMatchObject({ rows: [] });
  }, 20_000);
});

describe('malformed encoded API paths', () => {
  it('returns 400 for every decoded route and keeps serving afterwards', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-viz-uri-'));
    roots.push(root);
    const port = await freePort();
    startViz(port, root, { ATOMA_BURNIN_CSV: join(root, 'missing.csv') });

    const ready = await waitForResponse(`http://127.0.0.1:${port}/api/burnin`);
    expect(ready?.ok).toBe(true);

    // decodeURIComponent('%') throws URIError. Before the guard, the first
    // request escaped createServer's callback and killed the viz process.
    for (const path of ['/api/runs/%', '/api/skills/%', '/api/registry/%']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(response.status, path).toBe(400);
    }

    // These inputs used to throw in `new URL(...)` before route decoding.
    // Host is irrelevant to this loopback server, while an invalid network-
    // path request target is rejected without escaping the request callback.
    expect(await rawRequestStatus(port, '/api/burnin', { host: '%' })).toBe(200);
    expect(await rawRequestStatus(port, '//%')).toBe(400);

    const stillAlive = await fetch(`http://127.0.0.1:${port}/api/burnin`);
    expect(stillAlive.ok).toBe(true);
  }, 20_000);
});
