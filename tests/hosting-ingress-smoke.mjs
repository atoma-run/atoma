#!/usr/bin/env node
// Real nginx transport regression; no application mutation or public listener.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const templatePath = resolve(args[0] ?? 'deploy/hosting.nginx.conf');
const nginx = args[1] ?? '/usr/sbin/nginx';
const payloadUrl = args[2];
const scratch = mkdtempSync(join(tmpdir(), 'atoma-hosting-ingress-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let payload = Buffer.from(JSON.stringify({ rows: Array.from({ length: 1059 }, (_, i) => ({
  id: `offline-${i}`, price: 100000 + i, surface: 33 + i % 100,
  location: 'Athens (offline fixture)', description: `Retained listing ${i} `.repeat(24),
  valuation: { ratio: (100000 + i) / (33 + i % 100), median: 2345.6789, gap: -12.3456 },
})) }));
if (payloadUrl) {
  const url = new URL(payloadUrl);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/api/status'); assert.equal(url.search, '');
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); payload = Buffer.from(await response.arrayBuffer());
}
const template = readFileSync(templatePath, 'utf8');
const results = [];
const fixture = createServer((req, res) => {
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n'); setTimeout(() => res.end('data: last\n\n'), 100); return;
  }
  const small = req.url === '/small';
  const encoded = req.url === '/encoded';
  const bytes = small ? Buffer.from('{"ok":true}') : encoded ? gzipSync(payload) : payload;
  res.writeHead(req.url === '/range' ? 206 : 200, {
    'content-type': 'application/json', 'cache-control': 'no-store',
    'content-length': bytes.length, ...(encoded ? { 'content-encoding': 'gzip' } : {}),
  }); res.end(bytes);
});
await new Promise(resolveListen => fixture.listen(0, '127.0.0.1', resolveListen));
const upstreamPort = fixture.address().port;
const reservation = createServer();
await new Promise(resolveListen => reservation.listen(0, '127.0.0.1', resolveListen));
const port = reservation.address().port;
await new Promise(resolveClose => reservation.close(resolveClose));
assert.equal((template.match(/listen 443 ssl;/g) ?? []).length, 1);
assert.equal((template.match(/proxy_pass http:\/\/127\.0\.0\.1:4411;/g) ?? []).length, 1);
const server = template.replace('listen 443 ssl;', `listen 127.0.0.1:${port};`)
  .replace(/^\s*ssl_certificate(?:_key)? .*;\s*$/gm, '')
  .replace('proxy_pass http://127.0.0.1:4411;', `proxy_pass http://127.0.0.1:${upstreamPort};`);
const config = join(scratch, 'nginx.conf');
writeFileSync(config, `worker_processes 1;\npid ${scratch}/nginx.pid;\nerror_log ${scratch}/error.log;\nevents {}\nhttp { access_log ${scratch}/access.log; ${server}\n}\n`);
const syntax = spawnSync(nginx, ['-t', '-p', scratch + '/', '-c', config], { encoding: 'utf8' });
if (syntax.status !== 0) {
  await new Promise(resolveClose => fixture.close(resolveClose));
  throw new Error(syntax.stderr || syntax.error?.message || 'nginx configuration refused');
}
const child = spawn(nginx, ['-p', scratch + '/', '-c', config, '-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
let childLog = ''; child.stdout.on('data', b => { childLog += b; }); child.stderr.on('data', b => { childLog += b; });
const childExit = once(child, 'exit');

function read(path = '/', encoding = 'gzip', rate = 0, deadlineMs = 5000, extraHeaders = {}) {
  return new Promise((resolveRead, rejectRead) => {
    const started = Date.now(); let response;
    const req = request({ host: '127.0.0.1', port, path,
      headers: { host: 'offline.app.atoma.run', ...(encoding === null ? {} : { 'accept-encoding': encoding }), ...extraHeaders },
    });
    const timer = setTimeout(() => { response?.destroy(); req.destroy(new Error('body deadline')); }, deadlineMs);
    req.on('error', error => { clearTimeout(timer); rejectRead(error); });
    req.on('response', incoming => { void consume(incoming); });
    async function consume(incoming) {
      response = incoming;
      try {
        const chunks = []; let received = 0;
        for await (const chunk of incoming) {
          chunks.push(chunk); received += chunk.length;
          if (rate) await delay(Math.max(0, received / rate * 1000 - (Date.now() - started)));
        }
        clearTimeout(timer);
        resolveRead({ status: incoming.statusCode, headers: incoming.headers, bytes: Buffer.concat(chunks), ms: Date.now() - started });
      } catch (error) { clearTimeout(timer); rejectRead(error instanceof Error ? error : new Error(String(error))); }
    }
    req.end();
  });
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await read('/small'); ready = true; break; } catch { await delay(20); }
  }
  assert.ok(ready, childLog);
  const identity = await read('/', 'identity');
  assert.equal(identity.status, 200); assert.deepEqual(identity.bytes, payload);
  results.push({ check: 'identity bytes unchanged', bytes: identity.bytes.length });
  const compressed = await read();
  results.push({ check: 'gzip negotiation', encoding: compressed.headers['content-encoding'] ?? 'identity', bytes: compressed.bytes.length });
  let slowIdentityAborted = false;
  try { await read('/', 'identity', 96 * 1024, 3000); } catch { slowIdentityAborted = true; }
  assert.ok(slowIdentityAborted, 'The fixture must reproduce the three-second large-body timeout');
  results.push({ check: 'uncompressed body exceeds three-second deadline at 96 KiB/s', passed: true });
  let slow;
  try { slow = await read('/', 'gzip', 96 * 1024, 3000); }
  catch (error) { results.push({ check: 'negotiated body within three-second deadline', passed: false, error: error.message }); throw error; }
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.match(compressed.headers.vary ?? '', /accept-encoding/i);
  assert.deepEqual(gunzipSync(compressed.bytes), payload);
  assert.deepEqual(gunzipSync(slow.bytes), payload);
  results.push({ check: 'negotiated body within three-second deadline', passed: true, ms: slow.ms, bytes: slow.bytes.length });
  for (const encoding of [null, 'identity', 'gzip;q=0']) {
    const r = await read('/', encoding); assert.equal(r.headers['content-encoding'], undefined); assert.deepEqual(r.bytes, payload);
    results.push({ check: `explicit ${encoding} respected`, passed: true });
  }
  const via = await read('/', 'gzip', 0, 5000, { via: '1.1 offline-proxy' });
  assert.equal(via.headers['content-encoding'], 'gzip'); assert.deepEqual(gunzipSync(via.bytes), payload);
  results.push({ check: 'private no-store JSON also compresses behind a forwarding proxy', passed: true });
  const small = await read('/small'); assert.equal(small.headers['content-encoding'], undefined);
  assert.equal(small.bytes.toString(), '{"ok":true}');
  const stream = await read('/stream'); assert.equal(stream.headers['content-encoding'], undefined);
  assert.equal(stream.bytes.toString(), 'data: first\n\ndata: last\n\n');
  const range = await read('/range'); assert.equal(range.status, 206); assert.equal(range.headers['content-encoding'], undefined); assert.deepEqual(range.bytes, payload);
  const encoded = await read('/encoded'); assert.equal(encoded.headers['content-encoding'], 'gzip'); assert.deepEqual(gunzipSync(encoded.bytes), payload);
  results.push({ check: 'small JSON, event streams, partial and already encoded responses preserved', passed: true });
  console.log(JSON.stringify({ passed: true, scratch, templateSha256: sha(template), payloadSha256: sha(payload), results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ passed: false, scratch, templateSha256: sha(template), payloadSha256: sha(payload), results, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM'); await childExit;
  await new Promise(resolveClose => fixture.close(resolveClose));
  writeFileSync(join(scratch, 'child.log'), childLog);
}
