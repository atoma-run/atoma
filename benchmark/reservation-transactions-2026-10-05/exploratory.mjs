// Post-inspection checks, explicitly outside the frozen 44-case score.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const entry = resolve(process.argv[2], 'server.js');
let passed = 0, failed = 0;
async function check(name, items, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-reservation-explore-'));
  writeFileSync(join(dir, 'seed.json'), JSON.stringify({ items }));
  const child = spawn(process.execPath, [entry, '--db', join(dir, 'db'), '--seed', join(dir, 'seed.json'), '--port', '0'], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', observed;
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
  try {
    const port = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(Error('No port: ' + stderr)), 5000); let buffer = '';
      child.once('error', reject);
      child.stdout.on('data', b => { buffer += b; for (const s of buffer.split('\n').slice(0, -1)) { try { const p = JSON.parse(s).port; if (p) { clearTimeout(timer); resolvePort(p); } } catch {} } });
    });
    const request = async body => {
      const r = await fetch(`http://127.0.0.1:${port}/${body ? 'commands' : 'state'}`, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
      return { status: r.status, body: await r.json() };
    };
    observed = await fn(request);
    assert.deepEqual(observed.actual, observed.expected); passed++;
    console.log(JSON.stringify({ name, passed: true, ...observed }));
  } catch (e) { failed++; console.log(JSON.stringify({ name, passed: false, ...observed, error: String(e) })); }
  finally {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
    rmSync(dir, { recursive: true, force: true });
  }
}
await check('array-valued command type must not mutate state or claim key', [{ sku: 'A', capacity: 1 }], async request => {
  const before = await request(), invalid = await request({ key: 'k', type: ['advance'], to: 1 }), after = await request();
  const valid = await request({ key: 'k', type: 'advance', to: 1 });
  return { actual: { invalid, unchanged: JSON.stringify(before) === JSON.stringify(after), valid },
    expected: { invalid: { status: 400, body: { error: 'invalid' } }, unchanged: true, valid: { status: 200, body: { ok: true, revision: 1 } } } };
});
await check('ordinary string command positive control', [{ sku: 'A', capacity: 1 }], async request => ({ actual: await request({ key: 'k', type: 'advance', to: 1 }), expected: { status: 200, body: { ok: true, revision: 1 } } }));
await check('numeric command type refusal control', [{ sku: 'A', capacity: 1 }], async request => ({ actual: await request({ key: 'k', type: 1, to: 1 }), expected: { status: 400, body: { error: 'invalid' } } }));
const first = '\u{10000}', second = '\uE000', order = [first, second];
await check('code-unit ordering across BMP and supplementary characters', [{ sku: second, capacity: 3 }, { sku: first, capacity: 3 }], async request => {
  for (const id of [second, first]) {
    const r = await request({ key: id, type: 'reserve', holdId: id, ttl: 5, lines: [{ sku: second, qty: 1 }, { sku: first, qty: 1 }] });
    assert.equal(r.status, 200);
  }
  const state = (await request()).body;
  return { actual: { items: state.items.map(i => i.sku), holds: state.holds.map(h => h.id), lines: state.holds.map(h => h.lines.map(l => l.sku)) }, expected: { items: order, holds: order, lines: [order, order] } };
});
console.log(JSON.stringify({ summary: true, passed, failed, total: passed + failed }));
if (failed) process.exitCode = 1;
