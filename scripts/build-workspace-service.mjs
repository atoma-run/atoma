import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'dist/workspace-service');
mkdirSync(out, { recursive: true });
// Package the compiled import closure, not a second implementation of the service.
await build({ entryPoints: [resolve(root, 'dist/run/workspaceService.js')],
  outfile: resolve(out, 'service.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' });
