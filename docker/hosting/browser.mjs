import { spawn } from 'node:child_process';
import { mkdirSync, unlinkSync } from 'node:fs';
import { createServer, request } from 'node:http';

// Only this fixed broker exposes the application and desktop. CDP stays loopback-only.
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000);
}
function start(command, args, extra = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, DISPLAY: ':99', ...extra } });
  children.push(child);
  child.on('error', () => stop(1));
  child.on('exit', () => { if (!stopping) stop(1); });
  return child;
}
async function ready(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (stopping) throw Error('Runtime stopped');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error('Browser startup timed out');
}
process.once('SIGTERM', () => stop());
process.once('SIGINT', () => stop());
try {
  mkdirSync('/data/browser-profile', { recursive: true, mode: 0o700 });
  // The launcher/store enforce one writer per project, and this process owns the
  // only Chromium. Container recreation changes hostname/PID; stale singleton
  // symlinks must not make the preserved profile look owned by another machine.
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { unlinkSync(`/data/browser-profile/${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  start('Xvfb', [':99', '-screen', '0', '1280x900x24', '-nolisten', 'tcp']);
  await new Promise(resolve => setTimeout(resolve, 500));
  start('openbox', []);
  start('x11vnc', ['-display', ':99', '-localhost', '-nopw', '-forever', '-shared', '-rfbport', '5900']);
  start('websockify', ['--web=/usr/share/novnc', '127.0.0.1:6080', '127.0.0.1:5900']);
  start('chromium', ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-quic', '--password-store=basic', '--use-mock-keychain',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', '--user-data-dir=/data/browser-profile',
    `--proxy-server=${process.env.ATOMA_BROWSER_PROXY}`, 'about:blank']);
  await ready('http://127.0.0.1:9222/json/version');
  await ready('http://127.0.0.1:6080/vnc.html');
  start('node', [process.argv[2]]);
  const server = createServer((req, res) => {
    const desktop = req.url?.startsWith('/.atoma/browser/');
    if (req.url?.startsWith('/.atoma/') && !desktop) { res.writeHead(404).end(); return; }
    const upstream = request({ host: '127.0.0.1', port: desktop ? 6080 : 8082,
      path: desktop ? req.url.slice('/.atoma/browser'.length) : req.url, method: req.method, headers: req.headers }, incoming => {
      res.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/.atoma/browser/websockify') { socket.destroy(); return; }
    const upstream = request({ host: '127.0.0.1', port: 6080, path: '/websockify', headers: req.headers });
    upstream.on('upgrade', (res, remote, remoteHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(res.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote).pipe(socket);
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
    });
    upstream.on('response', () => socket.destroy()); upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy()); upstream.end();
  });
  server.listen(8080, '0.0.0.0');
} catch { stop(1); }
