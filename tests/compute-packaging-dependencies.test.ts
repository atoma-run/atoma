import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const run = promisify(execFile);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('ships exactly the reviewed adapter sources in the integrity-locked npm archive', () => {
  const archive = 'scripts/compat/atoma-legacy-glob-1.0.0.tgz';
  expect(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/).sort())
    .toEqual(['package/index.cjs', 'package/package.json']);
  for (const name of ['index.cjs', 'package.json']) {
    expect(execFileSync('tar', ['-xOf', archive, `package/${name}`]))
      .toEqual(readFileSync(join('scripts/compat/legacy-glob', name)));
  }
});

it('packs and reads native-unpacked archives through the actual builder and Windows dependency paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-packaging-dependencies-'));
  roots.push(root);
  const result = await run(process.execPath, ['--input-type=commonjs', '-e', String.raw`
    const assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    const { execFileSync } = require('node:child_process');
    const fs = require('node:fs');
    const path = require('node:path');
    const { pathToFileURL } = require('node:url');
    (async () => {
      const listing = ['ls', 'glob', 'glob-modern', '@atoma/legacy-glob', '--all', '--json'];
      execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'npm',
        process.platform === 'win32' ? ['/d', '/s', '/c', 'npm ' + listing.join(' ')] : listing,
        { stdio: 'pipe' });
      const root = process.argv[1];
      const source = path.join(root, 'app');
      fs.mkdirSync(path.join(source, 'native'), { recursive: true });
      fs.writeFileSync(path.join(source, 'main.js'), 'module.exports = 42;');
      fs.writeFileSync(path.join(source, 'native', 'addon.node'), Buffer.from([0, 255, 42]));
      fs.writeFileSync(path.join(source, 'native', 'keep.js'), 'retained');
      const builder = createRequire(require.resolve('app-builder-lib/package.json'));
      const windows = createRequire(require.resolve('electron-winstaller/package.json'));
      // Builder loads ESM dynamically; electron-winstaller still requires it.
      const modules = [await import(pathToFileURL(builder.resolve('@electron/asar')).href),
        windows('@electron/asar')];
      for (const [index, asar] of modules.entries()) {
        const archive = path.join(root, 'app-' + index + '.asar');
        await asar.createPackageWithOptions(source, archive, { unpack: '**/*.node' });
        assert.equal(asar.extractFile(archive, 'main.js').toString(), 'module.exports = 42;');
        assert.equal(asar.extractFile(archive, 'native/keep.js').toString(), 'retained');
        assert.equal(asar.statFile(archive, 'native/addon.node').unpacked, true);
        assert.deepEqual(fs.readFileSync(path.join(archive + '.unpacked', 'native', 'addon.node')),
          Buffer.from([0, 255, 42]));
      }
      assert.equal(typeof (await import(pathToFileURL(builder.resolve('@electron/universal')).href)).makeUniversalApp,
        'function');
      assert.equal(typeof require('electron-winstaller').createWindowsInstaller, 'function');
      // Rimraf needs callback/sync glob; FileList needs minimatch.match.
      // Exercise both instead of blindly replacing their dependencies.
      const tempRequire = createRequire(windows.resolve('temp'));
      const rimrafRequire = createRequire(tempRequire.resolve('rimraf'));
      const glob = rimrafRequire('glob');
      assert.deepEqual(glob.sync('**/*.{js,node}', { cwd: source }).map(file => file.replaceAll('\\', '/')).sort(),
        ['main.js', 'native/addon.node', 'native/keep.js']);
      const asyncFiles = await new Promise((resolve, reject) => glob('**/*.js', { cwd: source },
        (error, files) => error ? reject(error) : resolve(files)));
      assert.deepEqual(asyncFiles.map(file => file.replaceAll('\\', '/')).sort(), ['main.js', 'native/keep.js']);
      const jakeRequire = createRequire(createRequire(builder.resolve('ejs')).resolve('jake'));
      const { FileList } = jakeRequire('filelist');
      const files = new FileList(path.join(source, '**', '*.js').replaceAll('\\', '/'));
      files.exclude(path.join(source, 'native', '**').replaceAll('\\', '/'));
      assert.deepEqual(files.toArray().map(file => path.resolve(file)), [path.join(source, 'main.js')]);
      await new Promise((resolve, reject) => tempRequire('rimraf')(
        path.join(source, 'native', '*.js'),
        error => error ? reject(error) : resolve()));
      assert.equal(fs.existsSync(path.join(source, 'native', 'keep.js')), false);
      assert.equal(fs.existsSync(path.join(source, 'main.js')), true);
      // Exercise legacy cleanup too, confined to this test's own fixture.
      await new Promise((resolve, reject) => tempRequire('rimraf')(source,
        error => error ? reject(error) : resolve()));
      assert.equal(fs.existsSync(source), false);
      console.log('builder, Windows, archive matching, legacy glob/FileList and cleanup passed');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, root], { cwd: process.cwd(), timeout: 30_000 });
  expect(result.stdout).toContain('archive matching, legacy glob/FileList and cleanup passed');
});
