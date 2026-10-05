// Additional regression discovered in the cancelled fourth draft, not part of the frozen 44.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const dir = mkdtempSync(join(tmpdir(), 'atoma-prototype-regression-'));
writeFileSync(join(dir, 'seed.json'), '{"items":[]}');
const child = spawn(process.execPath, [resolve(process.argv[2], 'server.js'), '--db', join(dir, 'db'), '--seed', join(dir, 'seed.json'), '--port', '0'],
  { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
try {
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(Error('No readiness: ' + stderr)), 5000);
    const fail = e => { clearTimeout(timer); reject(e); };
    child.once('error', fail);
    child.once('exit', code => fail(Error('Early exit ' + code + ': ' + stderr)));
    let buffer = '';
    child.stdout.on('data', b => {
      buffer += b;
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        try { const value = JSON.parse(line).port; if (Number.isInteger(value) && value > 0 && value <= 65535) { clearTimeout(timer); resolvePort(value); } } catch { /* Ordinary stdout. */ }
      }
    });
  });
  const request = async command => {
    const res = await fetch(`http://127.0.0.1:${port}/${command ? 'commands' : 'state'}`, { method: command ? 'POST' : 'GET',
      ...(command ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) } : {}), signal: AbortSignal.timeout(5000) });
    return { status: res.status, text: await res.text() };
  };
  let revision = 0;
  for (const type of ['__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'constructor', '__proto__', 'toString']) {
    const before = await request();
    assert.equal(before.status, 200);
    assert.deepEqual(JSON.parse(before.text), { clock: 0, revision, items: [], holds: [] });
    const invalid = await request({ key: type, type });
    assert.equal(invalid.status, 400);
    assert.deepEqual(JSON.parse(invalid.text), { error: 'invalid' });
    assert.deepEqual(await request(), before);
    const valid = { key: type, type: 'advance', to: 0 };
    const applied = await request(valid);
    assert.equal(applied.status, 200);
    assert.deepEqual(JSON.parse(applied.text), { ok: true, revision: ++revision });
    assert.deepEqual(await request(valid), applied);
    console.log(JSON.stringify({ type, passed: true, invalid, applied }));
  }
  assert.deepEqual(JSON.parse((await request()).text), { clock: 0, revision, items: [], holds: [] });
  console.log(JSON.stringify({ summary: true, passed: 7, failed: 0 }));
} catch (error) {
  console.log(JSON.stringify({ summary: true, passed: false, error: String(error), stderr }));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  rmSync(dir, { recursive: true, force: true });
}
