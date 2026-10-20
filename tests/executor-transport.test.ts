import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type Server } from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { callExecutor, openExecutorStream, serveExecutor } from '../src/projects/executorTransport.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function socket() {
  const root = mkdtempSync(join(tmpdir(), 'exe-'));
  roots.push(root); chmodSync(root, 0o700);
  return join(root, 'host.sock');
}

it('refuses a shared socket directory and never steals an existing listener', async () => {
  const path = socket();
  chmodSync(join(path, '..'), 0o755);
  await expect(serveExecutor(path, async () => null)).rejects.toThrow('private directory');
  chmodSync(join(path, '..'), 0o700);
  servers.push(await serveExecutor(path, async () => 'original'));
  await expect(serveExecutor(path, async () => 'replacement')).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(await callExecutor(path, { method: 'health' })).toBe('original');
});

it('rejects unknown capabilities before dispatch and preserves typed policy refusals', async () => {
  const path = socket(), dispatch = vi.fn(async () => { throw Object.assign(new Error('older publication'), { name: 'PublicationSupersededError' }); });
  servers.push(await serveExecutor(path, dispatch));
  const code = await new Promise<number | undefined>((resolve, reject) => {
    const req = request({ socketPath: path, method: 'POST', path: '/', agent: false }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject); req.end(JSON.stringify({ method: 'run-shell', command: 'never execute' }));
  });
  expect(code).toBe(400); expect(dispatch).not.toHaveBeenCalled();
  await expect(callExecutor(path, { method: 'health' })).rejects.toMatchObject({ name: 'PublicationSupersededError', message: 'older publication' });
});

it('carries bidirectional preview bytes through the private executor without a new workload', async () => {
  const path = socket();
  servers.push(await serveExecutor(path, async () => null, async () => new PassThrough()));
  const stream = await openExecutorStream(path, '11111111-1111-4111-8111-111111111111');
  try {
    const reply = once(stream, 'data'); stream.write('preview bytes');
    expect(String((await reply)[0])).toBe('preview bytes');
  } finally { stream.destroy(); }
});
