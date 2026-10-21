import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { computeDesktopVersion } from './compute-desktop-version.mjs';
const root = resolve(import.meta.dirname, '..');
const out = join(root, 'dist/compute-desktop');
const source = join(root, 'src/launcher/desktopApp');
await mkdir(out, { recursive: true });
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = computeDesktopVersion(pkg.version, process.env.ATOMA_COMPUTE_BUILD_NUMBER);
await build({ entryPoints: [join(source, 'main.ts')], outfile: join(out, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24', define: { DESKTOP_SIGNED: JSON.stringify(process.env.ATOMA_COMPUTE_SIGNED === '1') } });
await build({ entryPoints: [join(source, 'preload.ts')], outfile: join(out, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' });
await build({ entryPoints: [join(source, 'runtime.ts')], outfile: join(out, 'runtime.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }, external: ['electron'] });
await build({ entryPoints: [join(source, 'renderer.tsx')], outfile: join(out, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome144', minify: true });
await copyFile(join(root, 'src/viz/public/icons/atoma-512.png'), join(out, 'icon.png'));
for (const file of ['index.html']) await copyFile(join(source, file), join(out, file));
await writeFile(join(out, 'package.json'), JSON.stringify({ name: 'atoma-compute', version, private: true, main: 'main.cjs', description: 'Your computer, connected to Atoma', author: 'Atoma', license: 'AGPL-3.0-only' }, null, 2));
console.log(`Atoma Compute desktop built in ${out}`);
