/** Compare delivered Compute content, independently of CI's installer version. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONTENT_ASSET = 'compute-desktop-content.json';
const sha256 = value => createHash('sha256').update(value).digest('hex');

// npm's lock covers all target platforms. Only include the native runtime and
// installer toolchain; bundled JS dependencies are already covered by their bytes.
export function nativeDependencies(lock) {
  const packages = lock.packages;
  const found = new Map();
  function visit(name, parent = '', optional = false) {
    let location = parent;
    let key;
    for (;;) {
      const candidate = location ? `${location}/node_modules/${name}` : `node_modules/${name}`;
      if (packages[candidate]) { key = candidate; break; }
      if (!location) {
        if (optional) return;
        throw new Error(`Missing locked installer dependency: ${name}`);
      }
      location = dirname(location).replaceAll('\\', '/');
      if (location === '.') location = '';
    }
    if (found.has(key)) return;
    const entry = packages[key];
    found.set(key, { version: entry.version, integrity: entry.integrity });
    for (const dependency of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies }).sort()) {
      visit(dependency, key, dependency in (entry.optionalDependencies ?? {}) || dependency in (entry.peerDependencies ?? {}));
    }
  }
  for (const name of ['electron', 'electron-builder']) {
    if (!packages[`node_modules/${name}`]) throw new Error(`Missing locked ${name}`);
    visit(name);
  }
  return Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b, 'en')));
}

export async function desktopContent(root, revision) {
  const directory = join(root, 'dist/compute-desktop');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const files = [];
  async function walk(relative = '') {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(name);
      else {
        let bytes = await readFile(join(directory, name));
        // Only the generated run-number suffix is ignored. An authored version
        // change still affects the installer and remains part of the comparison.
        if (name === 'package.json') {
          const manifest = JSON.parse(bytes.toString());
          bytes = Buffer.from(JSON.stringify({ ...manifest, version: pkg.version }));
        }
        files.push([name, sha256(bytes)]);
      }
    }
  }
  await walk();
  if (!files.some(([name]) => name === 'main.cjs')) throw new Error('Compute desktop bundle is missing');
  const require = createRequire(join(root, 'package.json'));
  const configPath = join(root, 'desktop/electron-builder.cjs');
  delete require.cache[require.resolve(configPath)];
  const config = require(configPath);
  // Every supported architecture has its own manifest, but the content decision
  // is shared across native runners. Architecture is not a source change.
  if (config.publish) config.publish = config.publish.map(feed => ({ ...feed, channel: 'latest-ARCH' }));
  const configuration = JSON.stringify(config, (_key, value) => typeof value === 'function' ? value.toString().replaceAll('\r\n', '\n') : value);
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  return { schema: 1, revision, sha256: sha256(JSON.stringify({ files: files.sort(([a], [b]) => a.localeCompare(b, 'en')), configuration, native: nativeDependencies(lock) })) };
}

export function readContent(value) {
  const record = JSON.parse(value);
  if (record.schema !== 1 || !/^[a-f0-9]{40}$/.test(record.revision) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Invalid Compute content receipt');
  return record;
}

export async function publishedContent(repository, channel, token, request = fetch) {
  const headers = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const response = await request(`https://api.github.com/repos/${repository}/releases/tags/${channel}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Reading Compute release failed: HTTP ${response.status}`);
  const release = await response.json();
  const asset = release.assets.find(item => item.name === CONTENT_ASSET);
  if (asset) {
    const download = await request(`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`, { headers: { ...headers, Accept: 'application/octet-stream' } });
    if (!download.ok) throw new Error(`Reading Compute content failed: HTTP ${download.status}`);
    return readContent(await download.text());
  }
  // One-time migration for existing channels: rebuild the exact source recorded
  // by the old publisher, instead of forcing a release for an unrelated push.
  const revision = /\bfrom ([a-f0-9]{40})\./.exec(release.body ?? '')?.[1];
  if (!revision) throw new Error('Existing Compute release has no source revision');
  return { schema: 1, revision, sha256: null };
}

export function publicationDecision(current, previous, isAncestor, latest = previous) {
  if (current.sha256 === previous?.sha256) return false;
  // Protect both feeds when a signed build also updates the public channel.
  return [previous, latest].every(record => !record || current.revision === record.revision || isAncestor(record.revision, current.revision));
}

async function main() {
  const [command, file] = process.argv.slice(2);
  if (!file) throw new Error('Expected record, compare or publish followed by a receipt path');
  if (command === 'record') {
    const revision = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await writeFile(file, `${JSON.stringify(await desktopContent(process.cwd(), revision))}\n`);
    return;
  }
  const current = readContent(await readFile(file, 'utf8'));
  const previous = command === 'compare-local'
    ? readContent(await readFile(process.argv[4], 'utf8'))
    : await publishedContent(process.env.GITHUB_REPOSITORY, process.env.COMPUTE_CHANNEL, process.env.GH_TOKEN);
  if (command === 'compare' && previous && previous.sha256 === null) {
    await writeFile(process.env.GITHUB_OUTPUT, `baseline=${previous.revision}\n`, { flag: 'a' });
    return;
  }
  if (command === 'compare' || command === 'compare-local') {
    await writeFile(process.env.GITHUB_OUTPUT, `changed=${current.sha256 !== previous?.sha256}\n`, { flag: 'a' });
  } else if (command === 'publish') {
    const isAncestor = (a, b) => {
      try { execFileSync('git', ['merge-base', '--is-ancestor', a, b]); return true; }
      catch (error) { if (error.status === 1) return false; throw error; }
    };
    const latest = process.env.COMPUTE_CHANNEL === 'compute-desktop-stable'
      ? await publishedContent(process.env.GITHUB_REPOSITORY, 'compute-desktop-current', process.env.GH_TOKEN)
      : previous;
    const allowed = isAncestor(current.revision, 'origin/main') && publicationDecision(current, previous, isAncestor, latest);
    await writeFile(process.env.GITHUB_OUTPUT, `publish=${allowed}\n`, { flag: 'a' });
  } else throw new Error('Unknown Compute content command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
