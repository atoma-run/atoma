import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

const ui = process.argv[2] === 'mui' ? 'mui' : 'gpu';
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const result = spawnSync(
  process.execPath,
  [viteCli, 'build', '--config', 'vite.config.ts'],
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'production', ATOMA_VIZ_UI: ui },
    stdio: 'inherit',
  }
);

if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

// LAZY-CHUNK GUARD. The GPU renderer must stay OUT of the entry chunk: one
// innocuous value-import from gpu-renderer.js in GpuApp silently merges the
// chunks, and that regression already shipped once (fixed by ffe6180 —
// metrics moved to renderer/metrics.ts so GpuSurface keeps `import type`
// only). `mark-shell-front` is a mesh label that exists only in renderer
// code, so it discriminates the chunks even after minification.
if (ui === 'gpu') {
  const assets = fileURLToPath(new URL('../dist/viz/client/assets', import.meta.url));
  const names = readdirSync(assets).filter((name) => name.endsWith('.js'));
  const entry = names.filter((name) => name.startsWith('index-'));
  const renderer = names.filter((name) => name.startsWith('gpu-renderer-'));
  if (entry.length !== 1 || renderer.length !== 1) {
    console.error(`viz build: expected one index-*.js and one gpu-renderer-*.js chunk, got ${names.join(', ')}`);
    process.exit(1);
  }
  const marker = 'mark-shell-front';
  if (readFileSync(join(assets, entry[0]), 'utf8').includes(marker)) {
    console.error('viz build: the GPU renderer leaked into the entry chunk — a value import from gpu-renderer.js re-merged the lazy chunk');
    process.exit(1);
  }
  if (!readFileSync(join(assets, renderer[0]), 'utf8').includes(marker)) {
    console.error('viz build: the lazy-chunk marker moved; update the guard in scripts/viz-build.mjs');
    process.exit(1);
  }

  // THE SHOWCASE CRYSTAL, built alone AFTER the app (the app build empties
  // dist/viz/client/). See vite.showcase.config.ts for why it is separate.
  const showcase = spawnSync(
    process.execPath,
    [viteCli, 'build', '--config', 'vite.showcase.config.ts'],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: 'inherit',
    }
  );
  if (showcase.error) throw showcase.error;
  if ((showcase.status ?? 1) !== 0) process.exit(showcase.status ?? 1);
  const markFile = fileURLToPath(new URL('../dist/viz/client/showcase-assets/atoma-mark.js', import.meta.url));
  if (!readFileSync(markFile, 'utf8').includes(marker)) {
    console.error('viz build: the showcase crystal bundle does not carry the crystal (missing mark-shell-front)');
    process.exit(1);
  }
}

// The viz server serves these exact bytes with Content-Encoding: br. Building
// them once avoids compressing a multi-megabyte module on the first request.
const clientDir = fileURLToPath(new URL('../dist/viz/client', import.meta.url));
let compressed = 0;
function precompress(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      precompress(path);
    } else if (entry.isFile() && /\.(?:js|css)$/.test(entry.name)) {
      const bytes = readFileSync(path);
      const brotli = brotliCompressSync(bytes, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
      });
      writeFileSync(`${path}.br`, brotli);
      compressed += 1;
    }
  }
}
precompress(clientDir);
console.log(`viz build: precompressed ${compressed} JS/CSS assets with Brotli`);
process.exit(0);
