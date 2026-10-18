import { build } from 'esbuild';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'dist/compute-retrieval');
mkdirSync(out, { recursive: true });
await build({ entryPoints: [resolve(root, 'dist/projects/computeRetrievalEntry.js')],
  outfile: resolve(out, 'service.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24',
  external: ['better-sqlite3', 'typescript'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
writeFileSync(resolve(out, 'package.json'), JSON.stringify({ private: true, type: 'module',
  dependencies: Object.fromEntries(['better-sqlite3', 'typescript', 'officeparser'].map(name => [name, pkg.dependencies[name]])),
  overrides: pkg.overrides }, null, 2));
for (const name of ['retrieval-haystack.py', 'retrieval-extract.mjs', 'requirements-haystack.txt', 'requirements-haystack-hybrid.txt']) {
  copyFileSync(resolve(root, 'scripts', name), resolve(out, name));
}
