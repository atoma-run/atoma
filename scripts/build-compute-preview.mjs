import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const sourceMode = process.argv.includes('--source');
const out = resolve(root, 'dist/compute-preview');
mkdirSync(out, { recursive: true });
for (const [source, name] of [['computeCopy', 'copy'], ['computeStatic', 'static'], ['computeRelay', 'relay']]) {
  await build({ entryPoints: [resolve(root, `${sourceMode ? 'src' : 'dist'}/preview/${source}.${sourceMode ? 'ts' : 'js'}`)], outfile: resolve(out, `${name}.mjs`),
    bundle: true, platform: 'node', format: 'esm', target: 'node24' });
}
