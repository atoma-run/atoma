import { createServer } from 'node:http';
import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const root = '/workspace';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    let name = decodeURIComponent(new URL(req.url, 'http://app').pathname);
    if (name.endsWith('/')) name += 'index.html';
    const pieces = name.split('/').filter(Boolean);
    if (pieces.some(p => p.startsWith('.') || p === 'node_modules') || name.includes('\\')) throw new Error();
    const file = await realpath(path.join(root, ...pieces));
    if (!file.startsWith(root + '/') || !(await stat(file)).isFile()) throw new Error();
    const bytes = await readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(8080, '0.0.0.0');
