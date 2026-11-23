import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { hasVitePreviewSource } from '../src/preview/sourceBuild.js';
import { createComputeStaticServer } from '../src/preview/computeStatic.js';
import { copyComputePreview } from '../src/preview/computeCopy.js';
import { artifactManifestHash, buildWorkspaceArtifactManifest } from '../src/projects/artifacts.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'preview-source-')); roots.push(base);
  const source = join(base, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vite: '*' },
    scripts: { build: 'node must-not-run.js', prebuild: 'node must-not-run.js' } }));
  writeFileSync(join(source, 'index.html'), '<main id="app"></main><script type="module" src="/src/main.ts"></script>');
  mkdirSync(join(source, 'src'));
  writeFileSync(join(source, 'src/main.ts'), 'const value: string = "DVF compiled"; document.querySelector("#app")!.textContent = value;');
  writeFileSync(join(source, 'vite.config.js'), 'export default { base: "/published-repository/", build: { outDir: "dist" } };');
  // Use the repository's installed Vite in a real child process, without an
  // install in this test. Only this test shim reaches outside the copied tree.
  mkdirSync(join(source, 'node_modules/vite/bin'), { recursive: true });
  writeFileSync(join(source, 'node_modules/vite/package.json'), '{"type":"module"}');
  const viteBin = join(dirname(fileURLToPath(import.meta.resolve('vite/package.json'))), 'bin/vite.js');
  writeFileSync(join(source, 'node_modules/vite/bin/vite.js'), `import ${JSON.stringify(pathToFileURL(viteBin).href)};`);
  return { base, source, copy: join(base, 'copy'), output: join(base, 'output') };
}
function command(source: string) {
  return { method: 'start', source: 'delivered', mode: 'app', build: 'vite',
    artifactHash: artifactManifestHash(buildWorkspaceArtifactManifest({ workspaceRoot: source }).manifest),
    copyMaxBytes: 1024 * 1024, allowedHosts: [], attribution: false, hardMs: 60_000 };
}
it('builds verified Vite sources without dist in a separate process and serves compiled assets, preserving the delivery', async () => {
  const f = fixture(); const input = command(f.source);
  expect(copyComputePreview(input, f.source, f.copy)).toEqual({ kind: 'static', entry: 'index.html' });
  expect(existsSync(f.output)).toBe(false); // Copier never executes project code.
  const server = await createComputeStaticServer({ workspace: f.copy, buildRoot: f.output, buildVite: true });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const html = await (await fetch(url)).text();
    expect(html).not.toContain('/src/main.ts');
    const asset = html.match(/src="([^"]+\.js)"/)?.[1]; expect(asset).toMatch(/^\/assets\//);
    expect(await (await fetch(url + asset!)).text()).toContain('DVF compiled');
    expect((await fetch(url + '/src/main.ts')).status).toBe(404);
    expect((await fetch(url + '/node_modules/vite/package.json')).status).toBe(404);
    expect((await fetch(url, { method: 'POST' })).status).toBe(405);
    expect(existsSync(join(f.source, 'dist'))).toBe(false);
    expect(existsSync(join(f.copy, 'dist'))).toBe(false);
    expect(artifactManifestHash(buildWorkspaceArtifactManifest({ workspaceRoot: f.source }).manifest)).toBe(input.artifactHash);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
it('refuses changed delivery bytes before building and requires a delivered source', () => {
  const f = fixture(); const input = command(f.source);
  writeFileSync(join(f.source, 'src/main.ts'), 'changed');
  expect(() => copyComputePreview(input, f.source, f.copy)).toThrow('differs');
  rmSync(f.copy, { recursive: true, force: true });
  expect(() => copyComputePreview({ ...input, source: 'in-flight', artifactHash: undefined }, f.source, f.copy)).toThrow('source unavailable');
});
it('fails closed on absent dependencies or a failed build, with no raw source fallback', async () => {
  const f = fixture();
  rmSync(join(f.source, 'node_modules'), { recursive: true });
  await expect(createComputeStaticServer({ workspace: f.source, buildRoot: f.output, buildVite: true })).rejects.toThrow('dependencies unavailable');
  const broken = fixture();
  writeFileSync(join(broken.source, 'src/main.ts'), 'this is not valid TypeScript');
  await expect(createComputeStaticServer({ workspace: broken.source, buildRoot: broken.output, buildVite: true })).rejects.toThrow();
  expect(readFileSync(join(broken.source, 'src/main.ts'), 'utf8')).toBe('this is not valid TypeScript');
});
it('recognizes supported build inputs without executing package scripts or guessing from a README', () => {
  const f = fixture(); expect(hasVitePreviewSource(f.source)).toBe(true);
  writeFileSync(join(f.source, 'package.json'), '{"scripts":{"build":"vite build"}}');
  expect(hasVitePreviewSource(f.source)).toBe(false);
  writeFileSync(join(f.source, 'package.json'), 'invalid'); expect(hasVitePreviewSource(f.source)).toBe(false);
});
