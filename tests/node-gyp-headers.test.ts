import { afterEach, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(options: { corrupt?: boolean; corruptLibrary?: boolean; wrongVersion?: boolean; duplicateChecksum?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'node-gyp-headers-')); roots.push(root);
  const version = process.versions.node;
  const name = `node-v${version}-headers.tar.gz`;
  const source = join(root, `node-v${version}`);
  mkdirSync(join(source, 'include', 'node'), { recursive: true });
  const numbers = (options.wrongVersion ? '1.2.3' : version).split('.');
  writeFileSync(join(source, 'include', 'node', 'node_version.h'),
    ['MAJOR', 'MINOR', 'PATCH'].map((part, i) => `#define NODE_${part}_VERSION ${numbers[i]}\n`).join(''));
  for (const file of ['common.gypi', 'config.gypi']) writeFileSync(join(source, 'include', 'node', file), '{}');
  const archive = join(root, name);
  execFileSync('tar', ['-czf', archive, '-C', root, `node-v${version}`]);
  const bytes = readFileSync(archive);
  const library = Buffer.from('fixture Windows import library');
  const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const line = `${digest(bytes)}  ${name}\n`;
  const sums = Buffer.from(line + `${digest(library)}  win-x64/node.lib\n` + (options.duplicateChecksum ? line : ''));
  const files = new Map([['/SHASUMS256.txt', sums], [`/${name}`, options.corrupt ? Buffer.from('truncated archive') : bytes],
    ['/win-x64/node.lib', options.corruptLibrary ? Buffer.from('corrupt import library') : library]]);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    const body = files.get(req.url!);
    res.writeHead(body ? 200 : 404);
    res.end(body ?? 'Not found');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const envFile = join(root, 'github-env');
  const script = pathToFileURL(resolve('scripts/prepare-node-gyp-headers.mjs')).href;
  const code = `import {prepareNodeGypHeaders} from ${JSON.stringify(script)};
    await prepareNodeGypHeaders(${JSON.stringify({ version, architecture: 'x64', directory: root, envFile,
      baseUrl: `http://127.0.0.1:${address.port}` })});`;
  return { root, envFile, requests, name, library,
    launch: () => run(process.execPath, ['--input-type=module', '-e', code], { cwd: root, timeout: 15_000 }) };
}

it('prepares verified local node-gyp inputs in a cold process without installed dependencies', async () => {
  const f = await fixture();
  const result = await f.launch();
  expect(result.stdout).toContain(`Prepared verified Node ${process.versions.node} x64`);
  expect(f.requests).toEqual(['/SHASUMS256.txt', `/${f.name}`, '/win-x64/node.lib']);
  const entry = readFileSync(f.envFile, 'utf8').trim();
  expect(entry).toMatch(/^npm_package_config_node_gyp_nodedir=/);
  const headers = entry.slice(entry.indexOf('=') + 1);
  expect(readFileSync(join(headers, 'Release', 'node.lib'))).toEqual(f.library);
  expect(readFileSync(join(headers, 'include', 'node', 'node_version.h'), 'utf8')).toContain('#define NODE_MAJOR_VERSION');
  expect(existsSync(join(f.root, 'node_modules'))).toBe(false);
  // Exercise the actual node-gyp option parser the npm lifecycle uses.
  const gypModule = resolve('node_modules/node-gyp/lib/node-gyp.js');
  const parsed = await run(process.execPath, ['-e', `const gyp=require(${JSON.stringify(gypModule)})();
    gyp.parseArgv(['node','node-gyp','configure']); console.log(gyp.opts.nodedir);`], {
    cwd: f.root, env: { ...process.env, npm_package_config_node_gyp_nodedir: headers },
  });
  expect(parsed.stdout.trim()).toBe(headers);
});

it.each([
  { corrupt: true, error: 'checksum mismatch' },
  { corruptLibrary: true, error: 'checksum mismatch' },
  { wrongVersion: true, error: 'wrong version' },
  { duplicateChecksum: true, error: 'Expected one official checksum' },
])('refuses invalid build inputs before exposing a node-gyp directory: $error', async ({ error, ...options }) => {
  const f = await fixture(options);
  await expect(f.launch()).rejects.toThrow(error);
  expect(existsSync(f.envFile)).toBe(false);
});
