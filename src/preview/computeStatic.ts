import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPreviewServableFile, previewWorkspaceHasFile } from './policy.js';
import { hasVitePreviewSource } from './sourceBuild.js';
import { PREVIEW_CONTENT_TYPES } from './contentTypes.js';

/** Runs only inside the application isolate, after the copier verifies the
 * delivered artifact hash. The source mount is absent. Dependencies are already
 * copied; no installation or package scripts run. Output dies with /data. */
export async function createComputeStaticServer(options: {
  workspace: string; buildRoot: string; buildVite?: boolean;
}) {
  let root = options.workspace;
  if (options.buildVite) {
    const entry = 'node_modules/vite/bin/vite.js';
    if (!hasVitePreviewSource(root) || !previewWorkspaceHasFile(root, entry)) throw new Error('Preview build dependencies unavailable');
    await promisify(execFile)(process.execPath, [resolve(root, entry), 'build', '--base', '/',
      '--outDir', resolve(options.buildRoot), '--emptyOutDir'], {
      cwd: root, timeout: 45_000, maxBuffer: 1024 * 1024,
    });
    root = options.buildRoot;
    if (!readPreviewServableFile(root, 'index.html')) throw new Error('Preview build produced no page');
  }
  // Static bytes stay behind the same path jail. The authenticated gateway
  // supplies browser policy and attribution; no source directory is served.
  return createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    try {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://preview.invalid').pathname);
      const candidate = path === '/' ? 'index.html' : path.replace(/^\//, '');
      const file = readPreviewServableFile(root, candidate);
      if (!file) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': PREVIEW_CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'content-length': file.length });
      res.end(req.method === 'HEAD' ? undefined : file);
    } catch { res.writeHead(404); res.end(); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createComputeStaticServer({ workspace: '/workspace', buildRoot: '/data/site',
    buildVite: process.argv.includes('--build-vite') });
  server.listen(8080, '127.0.0.1', () => process.stdout.write('LISTENING_ON_PORT=8080\n'));
}
