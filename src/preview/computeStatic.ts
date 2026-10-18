import { createServer } from 'node:http';
import { extname } from 'node:path';
import { readPreviewServableFile } from './policy.js';
import { PREVIEW_CONTENT_TYPES } from './contentTypes.js';

/** Static bytes are served inside the client isolate under the same path jail.
 * The authenticated gateway supplies browser policy and attribution. */
createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  try {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://preview.invalid').pathname);
    const candidate = path === '/' ? 'index.html' : path.replace(/^\//, '');
    const file = readPreviewServableFile('/workspace', candidate);
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': PREVIEW_CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      'content-length': file.length });
    res.end(req.method === 'HEAD' ? undefined : file);
  } catch { res.writeHead(404); res.end(); }
}).listen(8080, '127.0.0.1', () => process.stdout.write('LISTENING_ON_PORT=8080\n'));
