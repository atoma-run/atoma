import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildArtifactManifest } from '../src/projects/artifacts.js';
import { readHostingManifest } from '../src/projects/hostingManifest.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it('only enables the capability from accepted, unchanged, declared bytes and a published entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosting-manifest-')); roots.push(root);
  writeFileSync(join(root, 'server.js'), '');
  writeFileSync(join(root, 'atoma.hosting.json'), JSON.stringify({ version: 1, runtime: 'node-browser', entry: 'server.js' }));
  const { manifest } = buildArtifactManifest({ workspaceRoot: root, declaredPaths: ['server.js', 'atoma.hosting.json'] });
  expect(readHostingManifest(root, manifest)?.entry).toBe('server.js');
  expect(readHostingManifest(root, null)).toBeNull();
  expect(() => readHostingManifest(root, { ...manifest, files: manifest.files.filter(f => f.path !== 'server.js') })).toThrow('not published');
  writeFileSync(join(root, 'atoma.hosting.json'), '{}');
  expect(() => readHostingManifest(root, manifest)).toThrow('Changed');
});
