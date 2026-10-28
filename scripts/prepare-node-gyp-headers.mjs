// Runs before npm ci: use only Node built-ins and the runner's curl/tar.
// Avoid node-gyp's intermittent streamed download/extraction hang on Windows.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function download(url, target) {
  await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '2',
    '--connect-timeout', '15', '--max-time', '45', '--retry-max-time', '100',
    '--max-filesize', '67108864', '--output', target, url,
  ], { timeout: 120_000 });
}

function checksum(manifest, name) {
  const rows = manifest.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line))
    .filter(row => row?.[2] === name);
  if (rows.length !== 1) throw new Error(`Expected one official checksum for ${name}`);
  return rows[0][1];
}

/** Download first, verify complete bytes, extract from disk, then expose the local build inputs. */
export async function prepareNodeGypHeaders({ version, architecture, directory, envFile,
  baseUrl = `https://nodejs.org/download/release/v${version}` }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !['x64', 'arm64'].includes(architecture)) {
    throw new Error('Invalid pinned Node version or architecture');
  }
  if (version !== process.versions.node) throw new Error('Pinned Node version differs from the executing runtime');
  const staging = await mkdtemp(join(directory, 'atoma-node-headers-'));
  try {
    const sums = join(staging, 'SHASUMS256.txt');
    await download(`${baseUrl}/SHASUMS256.txt`, sums);
    const manifest = await readFile(sums, 'utf8');
    const archiveName = `node-v${version}-headers.tar.gz`;
    const archive = join(staging, archiveName);
    const library = join(staging, 'node.lib');
    for (const [name, target] of [[archiveName, archive], [`win-${architecture}/node.lib`, library]]) {
      const expected = checksum(manifest, name);
      await download(`${baseUrl}/${name}`, target);
      const actual = createHash('sha256').update(await readFile(target)).digest('hex');
      if (actual !== expected) throw new Error(`Node build input checksum mismatch: ${name}`);
    }
    const headers = join(staging, 'headers');
    await mkdir(headers);
    await run('tar', ['-xzf', archive, '--strip-components=1', '-C', headers], { timeout: 30_000 });
    const header = await readFile(join(headers, 'include', 'node', 'node_version.h'), 'utf8');
    const observed = ['MAJOR', 'MINOR', 'PATCH'].map(part =>
      new RegExp(`^#define NODE_${part}_VERSION\\s+(\\d+)\\s*$`, 'm').exec(header)?.[1]).join('.');
    if (observed !== version) throw new Error('Extracted Node headers have the wrong version');
    await readFile(join(headers, 'include', 'node', 'common.gypi'));
    await readFile(join(headers, 'include', 'node', 'config.gypi'));
    await mkdir(join(headers, 'Release'));
    await rename(library, join(headers, 'Release', 'node.lib'));
    // node-gyp's documented package-config option; no global npm setting or cache mutation.
    await appendFile(envFile, `npm_package_config_node_gyp_nodedir=${headers}\n`);
    console.log(`Prepared verified Node ${version} ${architecture} headers and import library`);
    return headers;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = (await readFile(new URL('../.nvmrc', import.meta.url), 'utf8')).trim();
  if (!process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) throw new Error('GitHub runner paths are required');
  await prepareNodeGypHeaders({ version, architecture: process.arch,
    directory: process.env.RUNNER_TEMP, envFile: process.env.GITHUB_ENV });
}
