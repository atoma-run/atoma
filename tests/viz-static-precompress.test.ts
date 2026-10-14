import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { PRECOMPRESSED_ASSET, precompressAssets } from '../scripts/viz-precompress.mjs';

const children: ReturnType<typeof spawn>[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Text that compresses well, standing in for a WebAssembly module or a glTF binary.
const compressible = Buffer.from('\0asm\x01\0\0\0'.repeat(4_096) + 'module body '.repeat(4_096));

function tempDir(parent: string, prefix: string): string {
  const dir = mkdtempSync(join(parent, prefix));
  roots.push(dir);
  return dir;
}

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

function rawGet(port: number, path: string, acceptEncoding: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>(
    (resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path, headers: { 'accept-encoding': acceptEncoding } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        }
      );
      req.on('error', reject);
      req.end();
    }
  );
}

describe('static asset precompression', () => {
  it('writes a Brotli sibling for WebAssembly, glTF, fonts and scripts, never for already-compressed formats', () => {
    const dir = tempDir(tmpdir(), 'atoma-precompress-');
    mkdirSync(join(dir, 'models'));
    for (const name of ['app.js', 'worker.mjs', 'legacy.cjs', 'style.css', 'module.wasm', 'models/fire.glb', 'font.ttf', 'mark.svg']) {
      writeFileSync(join(dir, name), compressible);
    }
    writeFileSync(join(dir, 'icon.png'), compressible);
    writeFileSync(join(dir, 'tiny.js'), 'x');

    expect(precompressAssets(dir)).toBe(8);
    for (const name of ['module.wasm', 'models/fire.glb', 'font.ttf', 'legacy.cjs']) {
      const brotli = readFileSync(join(dir, `${name}.br`));
      expect(brotli.length).toBeLessThan(compressible.length / 10);
      expect(brotliDecompressSync(brotli).equals(compressible)).toBe(true);
    }
    expect(existsSync(join(dir, 'icon.png.br'))).toBe(false);
    // A sibling that does not shrink the bytes would only cost a lookup.
    expect(existsSync(join(dir, 'tiny.js.br'))).toBe(false);
    expect(PRECOMPRESSED_ASSET.test('x.bcmap')).toBe(false);
  });

  it('serves the Brotli sibling of a WebAssembly module from the viz server, with identity as the fallback', async () => {
    // The server reads assets beside its own module; a unique directory keeps
    // parallel suites apart and is removed after the test.
    const dir = tempDir(join(process.cwd(), 'src/viz/client'), '.precompress-test-');
    writeFileSync(join(dir, 'module.wasm'), compressible);
    writeFileSync(join(dir, 'plain.wasm'), compressible);
    expect(precompressAssets(dir)).toBe(2);
    rmSync(join(dir, 'plain.wasm.br'));
    const state = tempDir(tmpdir(), 'atoma-precompress-viz-');
    const port = await freePort();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/viz/server.ts', '--host', '127.0.0.1', '--port', String(port),
        '--dir', join(state, 'runs'), '--db', join(state, 'missing.db'), '--skills-dir', join(state, 'skills')],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    children.push(child);
    const path = `/${dir.split('/').at(-1)}/module.wasm`;
    const deadline = Date.now() + 10_000;
    let brotli: Awaited<ReturnType<typeof rawGet>> | undefined;
    while (!brotli && Date.now() < deadline) {
      brotli = await rawGet(port, path, 'gzip, br').catch(() => undefined);
      if (!brotli) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!brotli) throw new Error('viz server did not start');

    expect(brotli.status).toBe(200);
    expect(brotli.headers['content-type']).toBe('application/wasm');
    expect(brotli.headers['content-encoding']).toBe('br');
    expect(brotli.headers['vary']).toBe('Accept-Encoding');
    expect(brotliDecompressSync(brotli.body).equals(compressible)).toBe(true);

    const identity = await rawGet(port, path, 'gzip, br;q=0');
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(identity.headers['vary']).toBe('Accept-Encoding');
    expect(identity.body.equals(compressible)).toBe(true);

    const uncompressed = await rawGet(port, `/${dir.split('/').at(-1)}/plain.wasm`, 'br');
    expect(uncompressed.headers['content-encoding']).toBeUndefined();
    expect(uncompressed.headers['vary']).toBeUndefined();
    expect(uncompressed.body.equals(compressible)).toBe(true);
  }, 20_000);
});
