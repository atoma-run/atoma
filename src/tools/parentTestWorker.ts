/** Runs only in the sandboxed child process, never in the control plane. */
import { startVitest } from 'vitest/node';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * Stylesheets never reach Vite's CSS pipeline: that pipeline loads the
 * project's PostCSS config and preprocessors (`postcss.config.js`, the
 * `package.json#postcss` plugins, `sass-embedded`) INTO THIS COORDINATOR, the
 * process that holds `--allow-addons` and writes the report, and
 * `config: false` does not stop it (review 2026-10-16: a forging
 * `postcss.config.js` turned a wrong implementation into `passed`). A
 * stylesheet that resolves loads as an empty stub; one that does not stays
 * Vite's own resolution failure, so a missing file never passes. The virtual
 * id carries no stylesheet extension, or `vite:css` would claim it anyway.
 */
const STYLESHEET = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;
const RAW_OR_URL = /[?&](?:raw|url)\b/;
const STUB = '\0atoma-css-stub:';
const cssStub: Plugin = {
  name: 'atoma:css-stub',
  enforce: 'pre',
  async resolveId(source, importer) {
    if (!STYLESHEET.test(source) || RAW_OR_URL.test(source)) return null;
    const resolved = await this.resolve(source, importer, { skipSelf: true });
    if (!resolved) return null;
    const kind = /\.module\.[a-z]+(?:$|\?)/.test(resolved.id) ? 'module' : 'plain';
    return `${STUB}${kind}:${Buffer.from(resolved.id).toString('hex')}`;
  },
  load(id) {
    if (!id.startsWith(STUB)) return null;
    // Class names are not validated: each key maps to itself.
    return id.startsWith(`${STUB}module:`)
      ? 'export default new Proxy(Object.create(null), { get: (_, key) => typeof key === "string" ? key : undefined });'
      : 'export default "";';
  },
};

const root = process.argv[2]!;
const vitest = await startVitest('test', [], {
  root, config: false, watch: false, include: ['atoma.acceptance.test.ts'],
  reporters: ['json'], outputFile: `${root}/atoma.report.json`,
  pool: 'threads', execArgv: process.execArgv.filter(arg => arg !== '--allow-worker' && arg !== '--allow-addons'), maxWorkers: 1, fileParallelism: false,
  allowOnly: false, passWithNoTests: false, testTimeout: 10_000, hookTimeout: 10_000,
  environment: 'node', isolate: true,
}, {
  // An inline object is never searched for nor executed.
  css: { postcss: {} },
  plugins: [cssStub],
  // Vite 8 reads tsconfig `paths` as data, natively; the project's config never runs.
  resolve: { alias: { vitest: fileURLToPath(import.meta.resolve('vitest')) }, tsconfigPaths: true },
});
await vitest.close();
