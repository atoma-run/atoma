import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CONTENT_ASSET, desktopContent, nativeDependencies, publicationDecision, publishedContent, readContent } from '../scripts/compute-desktop-content.mjs';

const repository = resolve(import.meta.dirname, '..');
const revision = 'a'.repeat(40);
const receipt = { schema: 1, revision, installerVersion: '0.5.200', sha256: 'b'.repeat(64) };
let root: string;
function write(name: string, value: string) { mkdirSync(resolve(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), value); }
function lock(runtime = '44.9.0', builderDependency = '1.0.0', unused = '1.0.0') {
  return { lockfileVersion: 3, packages: {
    'node_modules/electron': { version: runtime, integrity: `sha512-${runtime}` },
    'node_modules/electron-builder': { version: '26.15.3', dependencies: { 'builder-dependency': '^1' } },
    'node_modules/builder-dependency': { version: builderDependency },
    'node_modules/unused-server-dependency': { version: unused },
  } };
}
function bundle(buildNumber = '42') {
  execFileSync(process.execPath, ['scripts/build-compute-desktop.mjs'], { cwd: root, env: { ...process.env, ATOMA_COMPUTE_SIGNED: '0', ATOMA_COMPUTE_BUILD_NUMBER: buildNumber }, stdio: 'pipe' });
}
const fingerprint = async () => (await desktopContent(root, revision)).sha256;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'compute-content-')));
  write('package.json', JSON.stringify({ name: 'content-regression', version: '0.4.0', type: 'module' }));
  write('package-lock.json', JSON.stringify(lock()));
  for (const file of ['scripts/build-compute-desktop.mjs', 'scripts/compute-desktop-version.mjs', 'scripts/compute-desktop-content.mjs', 'desktop/electron-builder.cjs']) {
    mkdirSync(resolve(root, file, '..'), { recursive: true }); cpSync(join(repository, file), join(root, file));
  }
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(join(repository, 'node_modules/esbuild'), join(root, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  write('node_modules/fixture-runtime/package.json', '{"main":"index.js"}');
  write('node_modules/fixture-runtime/index.js', 'exports.value = "bundled dependency v1";');
  write('src/contracts/shared.ts', 'export const shared = "shared contract v1";');
  write('src/launcher/desktopApp/main.ts', 'import { shared } from "../../contracts/shared"; import { value } from "fixture-runtime"; console.log(shared, value);');
  write('src/launcher/desktopApp/runtime.ts', 'import { shared } from "../../contracts/shared"; console.log(shared);');
  write('src/launcher/desktopApp/preload.ts', 'console.log("preload");');
  write('src/launcher/desktopApp/renderer.tsx', 'import "./style.css"; console.log("renderer");');
  write('src/launcher/desktopApp/style.css', 'body { color: red; }');
  write('src/launcher/desktopApp/index.html', '<body>Hello</body>');
  write('src/viz/public/icons/atoma-512.png', 'icon v1');
  bundle();
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it('crosses the production bundler and CLI: server changes and CI version increments do not publish', async () => {
  const before = await desktopContent(root, revision);
  write('before.json', JSON.stringify(before));
  write('src/viz/server.ts', 'console.log("unrelated server change");');
  write('package.json', JSON.stringify({ name: 'content-regression', version: '0.4.0', type: 'module', scripts: { server: 'new-server-command' } }));
  write('package-lock.json', JSON.stringify(lock('44.9.0', '1.0.0', '2.0.0')));
  bundle('43');
  expect(await fingerprint()).toBe(before.sha256);
  expect((await desktopContent(root, revision)).installerVersion).not.toBe(before.installerVersion);
  execFileSync(process.execPath, ['scripts/compute-desktop-content.mjs', 'record', 'after.json'], { cwd: root, env: { ...process.env, GITHUB_SHA: revision } });
  execFileSync(process.execPath, ['scripts/compute-desktop-content.mjs', 'compare-local', 'after.json', 'before.json'], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: join(root, 'decision') } });
  expect(readFileSync(join(root, 'decision'), 'utf8')).toBe('changed=false\n');
});

it('includes shared imports and the actual bytes of bundled transitive dependencies', async () => {
  const original = await fingerprint();
  write('src/contracts/shared.ts', 'export const shared = "shared contract v2";'); bundle();
  const shared = await fingerprint(); expect(shared).not.toBe(original);
  write('node_modules/fixture-runtime/index.js', 'exports.value = "bundled dependency v2";'); bundle();
  expect(await fingerprint()).not.toBe(shared);
});

it('includes CSS, HTML and the copied icon', async () => {
  let previous = await fingerprint();
  for (const [path, bytes] of [['src/launcher/desktopApp/style.css', 'body { color: blue; }'], ['src/launcher/desktopApp/index.html', '<body>Changed</body>'], ['src/viz/public/icons/atoma-512.png', 'icon v2']]) {
    write(path!, bytes!); bundle();
    const current = await fingerprint(); expect(current).not.toBe(previous); previous = current;
  }
});

it('includes Electron, nested installer dependencies, authored versions and installer configuration', async () => {
  let previous = await fingerprint();
  for (const value of [lock('45.0.0'), lock('45.0.0', '2.0.0')]) {
    write('package-lock.json', JSON.stringify(value));
    const current = await fingerprint(); expect(current).not.toBe(previous); previous = current;
  }
  write('package.json', '{"version":"0.5.0","type":"module"}'); bundle();
  const version = await fingerprint(); expect(version).not.toBe(previous);
  write('desktop/electron-builder.cjs', 'module.exports = { appId: "run.atoma.compute", nsis: { oneClick: true } };');
  expect(await fingerprint()).not.toBe(version);
});

it('normalizes architecture suffixes without hiding changes to the updater channel', async () => {
  write('desktop/electron-builder.cjs', "module.exports = { publish: [{ channel: 'latest-' + process.env.ATOMA_COMPUTE_ARCH }] };");
  try {
    vi.stubEnv('ATOMA_COMPUTE_ARCH', 'arm64'); const arm = await fingerprint();
    vi.stubEnv('ATOMA_COMPUTE_ARCH', 'x64'); expect(await fingerprint()).toBe(arm);
    write('desktop/electron-builder.cjs', "module.exports = { publish: [{ channel: 'beta-' + process.env.ATOMA_COMPUTE_ARCH }] };");
    expect(await fingerprint()).not.toBe(arm);
  } finally { vi.unstubAllEnvs(); }
});

it('resolves nested and hoisted lock dependencies, including optional dependencies', () => {
  const dependencies = nativeDependencies({ packages: {
    'node_modules/electron': { version: '1' },
    'node_modules/electron-builder': { version: '1', dependencies: { a: '1' }, optionalDependencies: { absent: '1' } },
    'node_modules/electron-builder/node_modules/a': { version: '2', dependencies: { b: '1' } },
    'node_modules/a': { version: 'unused' },
    'node_modules/b': { version: '3', dependencies: { 'electron-builder': '1' } },
  } });
  expect(() => nativeDependencies({ packages: { 'node_modules/electron': { version: '1' }, 'node_modules/electron-builder': { dependencies: { missing: '1' } } } })).toThrow('Missing locked installer dependency');
  expect(Object.keys(dependencies)).toEqual(['node_modules/b', 'node_modules/electron', 'node_modules/electron-builder', 'node_modules/electron-builder/node_modules/a']);
});

it('reads a published receipt and bootstraps the exact revision of legacy channels', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ assets: [{ name: CONTENT_ASSET, id: 123 }] }))
    .mockResolvedValueOnce(Response.json(receipt));
  expect(await publishedContent('atoma-run/atoma', 'compute-desktop-stable', 'test', request)).toEqual(receipt);
  expect(request.mock.calls[1]?.[0]).toBe('https://api.github.com/repos/atoma-run/atoma/releases/assets/123');
  const legacy = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ assets: [], body: `Unsigned preview from ${revision}. Docker Desktop is required.` }));
  expect(await publishedContent('atoma-run/atoma', 'compute-desktop-current', 'test', legacy)).toEqual({ schema: 1, revision, sha256: null });
});

it('allows first publication but refuses broken release metadata or GitHub errors', async () => {
  expect(await publishedContent('a/b', 'channel', 'test', vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 })))).toBeNull();
  for (const status of [401, 403, 429, 500]) {
    await expect(publishedContent('a/b', 'channel', 'test', vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status })))).rejects.toThrow(`HTTP ${status}`);
  }
  await expect(publishedContent('a/b', 'channel', 'test', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ assets: [], body: 'no revision' })))).rejects.toThrow('no source revision');
  for (const record of [{ ...receipt, schema: 2 }, { ...receipt, revision: 'bad' }, { ...receipt, sha256: 'bad' }]) expect(() => readContent(JSON.stringify(record))).toThrow();
});

it('rechecks concurrent publications, suppresses duplicates and never replaces a newer release', () => {
  const ancestor = vi.fn(() => false);
  expect(publicationDecision(receipt, null, ancestor)).toBe(true);
  expect(publicationDecision(receipt, { ...receipt, revision: 'c'.repeat(40) }, ancestor)).toBe(false);
  expect(ancestor).not.toHaveBeenCalled();
  expect(publicationDecision(receipt, { ...receipt, revision: 'c'.repeat(40), sha256: 'd'.repeat(64) }, ancestor)).toBe(false);
  expect(publicationDecision(receipt, { ...receipt, sha256: 'd'.repeat(64) }, ancestor)).toBe(true);
  expect(publicationDecision(receipt, { ...receipt, revision: 'c'.repeat(40), sha256: 'd'.repeat(64) }, () => true)).toBe(true);
  expect(publicationDecision(receipt, null, () => false, { ...receipt, revision: 'c'.repeat(40) })).toBe(false);
  expect(publicationDecision(receipt, receipt, ancestor, receipt, true)).toBe(true);
  const newerBuild = { ...receipt, installerVersion: '0.5.201' };
  expect(publicationDecision(receipt, newerBuild, ancestor, newerBuild, true)).toBe(false);
  expect(publicationDecision(newerBuild, receipt, ancestor, receipt, true)).toBe(true);
  expect(publicationDecision(receipt, null, ancestor, newerBuild, true)).toBe(false);
  expect(publicationDecision({ ...receipt, installerVersion: undefined }, newerBuild, ancestor)).toBe(false);
  expect(publicationDecision(receipt, receipt, ancestor, { ...receipt, revision: 'c'.repeat(40) }, true)).toBe(false);
});

it('uses real Git ancestry and the production publication CLI when later pushes arrive', () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  write('history.txt', 'old application'); git('add', 'history.txt'); git('commit', '-qm', 'first'); const older = git('rev-parse', 'HEAD');
  write('history.txt', 'new application'); git('commit', '-qam', 'second'); const newer = git('rev-parse', 'HEAD');
  write('history.txt', 'unrelated server push'); git('commit', '-qam', 'third'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  write('fake-release-fetch.mjs', `import { readFileSync } from 'node:fs'; globalThis.fetch = async url => Response.json(url.includes('/releases/assets/') ? JSON.parse(readFileSync('published.json')) : { assets: [{ name: '${CONTENT_ASSET}', id: 123 }] });`);
  function decision(current: object, published: object, republish = false) {
    write('candidate.json', JSON.stringify(current)); write('published.json', JSON.stringify(published)); write('publish-decision', '');
    execFileSync(process.execPath, ['--import', './fake-release-fetch.mjs', 'scripts/compute-desktop-content.mjs', 'publish', 'candidate.json'], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: join(root, 'publish-decision'), GITHUB_REPOSITORY: 'test/repo', COMPUTE_CHANNEL: 'current', GH_TOKEN: 'test', COMPUTE_REPUBLISH: String(republish) } });
    return readFileSync(join(root, 'publish-decision'), 'utf8');
  }
  expect(decision({ ...receipt, revision: newer }, { ...receipt, revision: older, sha256: 'c'.repeat(64) })).toBe('publish=true\n');
  expect(decision({ ...receipt, revision: older }, { ...receipt, revision: newer, sha256: 'c'.repeat(64) })).toBe('publish=false\n');
  expect(decision({ ...receipt, revision: newer }, { ...receipt, revision: older })).toBe('publish=false\n');
  expect(decision({ ...receipt, revision: newer }, { ...receipt, revision: older }, true)).toBe('publish=true\n');
  expect(decision({ ...receipt, revision: newer }, { ...receipt, revision: newer, installerVersion: '0.5.201' }, true)).toBe('publish=false\n');
  expect(decision({ ...receipt, revision: newer, installerVersion: '0.5.201' }, { ...receipt, revision: newer }, true)).toBe('publish=true\n');
  expect(decision({ ...receipt, revision: older }, { ...receipt, revision: newer }, true)).toBe('publish=false\n');
  write('history.txt', 'unreleased branch'); git('checkout', '-qb', 'unreleased'); git('commit', '-qam', 'unreleased');
  expect(decision({ ...receipt, revision: git('rev-parse', 'HEAD') }, { ...receipt, revision: newer }, true)).toBe('publish=false\n');
});
