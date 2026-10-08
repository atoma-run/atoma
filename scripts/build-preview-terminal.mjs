import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'dist/preview-terminal');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({ entryPoints: [resolve(root, 'src/preview/terminal/server.ts')], outfile: resolve(out, 'server.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' });
await build({ entryPoints: [resolve(root, 'src/preview/terminal/client.ts')], outfile: resolve(out, 'client.js'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true });
for (const file of ['pty.py', 'index.html']) cpSync(resolve(root, 'src/preview/terminal', file), resolve(out, file));
const catalogRoot = resolve(root, 'src/viz/client/locales');
const catalogs = {};
for (const name of readdirSync(catalogRoot).filter((name) => name.endsWith('.json'))) {
  const entries = JSON.parse(readFileSync(resolve(catalogRoot, name), 'utf8'));
  catalogs[name.slice(0, -5)] = Object.fromEntries(Object.entries(entries)
    .filter(([key]) => key.startsWith('preview.terminal.ui.'))
    .map(([key, value]) => [key.slice('preview.terminal.ui.'.length), value]));
}
writeFileSync(resolve(out, 'labels.json'), JSON.stringify(catalogs));
