import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const ATOMA_RELEASE_VERSION = (JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')
) as { version: string }).version;

/**
 * The public showcase's crystal (`src/viz/client-gl/showcase-mark.ts`), built
 * ALONE into `dist/viz/client/showcase-assets/atoma-mark.js` after the app.
 *
 * A separate build on purpose: as a second input of `vite.config.ts` it would
 * share the crystal module with the lazy renderer chunk, and Rollup would hoist
 * it into a common chunk — exactly what `scripts/viz-build.mjs` refuses. The
 * file name is fixed so the server can find it; the server appends a content
 * hash to the URL, so a deploy never serves a stale crystal from a cache.
 */
export default defineConfig({
  define: {
    __ATOMA_RELEASE_VERSION__: JSON.stringify(ATOMA_RELEASE_VERSION),
    __ATOMA_SW_DEV__: 'false',
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('./dist/viz/client/showcase-assets', import.meta.url)),
    emptyOutDir: true,
    copyPublicDir: false,
    chunkSizeWarningLimit: 1200,
    lib: {
      entry: fileURLToPath(new URL('./src/viz/client-gl/showcase-mark.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'atoma-mark.js',
    },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
