// Frozen external oracle. Not supplied to the builder. All state lives in temp dirs.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const sort = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canon = value => value && typeof value === 'object'
  ? Array.isArray(value) ? '[' + value.map(canon).join(',') + ']'
    : '{' + Object.keys(value).sort(sort).map(k => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}' : JSON.stringify(value);
const reserve = (key, holdId, lines, ttl = 5) => ({ key, type: 'reserve', holdId, ttl, lines });
const line = (sku, qty = 1) => ({ sku, qty });
const command = (key, type, holdId) => ({ key, type, holdId });
const advance = (key, to) => ({ key, type: 'advance', to });
const seed = { items: [{ sku: 'A', capacity: 2 }, { sku: 'B', capacity: 1 }] };

class Oracle {
  constructor(initial) {
    this.state = { clock: 0, revision: 0, items: initial.items.map(i => ({ ...i, available: i.capacity })), holds: [] };
    this.receipts = new Map();
  }
  snapshot() {
    const copy = structuredClone(this.state);
    copy.items.sort((a, b) => sort(a.sku, b.sku)); copy.holds.sort((a, b) => sort(a.id, b.id));
    for (const hold of copy.holds) hold.lines.sort((a, b) => sort(a.sku, b.sku));
    return copy;
  }
  apply(c, invalid = false) {
    if (invalid) return [400, { error: 'invalid' }];
    const { key, ...body } = c, fingerprint = canon(body);
    const cached = this.receipts.get(key);
    if (cached) return cached.fingerprint === fingerprint ? cached.response : [409, { error: 'idempotency_conflict' }];
    const next = structuredClone(this.state);
    const item = sku => next.items.find(i => i.sku === sku);
    const hold = next.holds.find(h => h.id === c.holdId);
    let error;
    if (c.type === 'reserve') {
      const quantities = new Map();
      for (const l of c.lines) quantities.set(l.sku, (quantities.get(l.sku) ?? 0) + l.qty);
      if (hold) error = 'hold_exists';
      else if ([...quantities.keys()].some(sku => !item(sku))) error = 'missing_item';
      else if ([...quantities].some(([sku, qty]) => item(sku).available < qty)) error = 'insufficient_stock';
      else {
        const lines = [...quantities].map(([sku, qty]) => ({ sku, qty }));
        for (const l of lines) item(l.sku).available -= l.qty;
        next.holds.push({ id: c.holdId, expiresAt: next.clock + c.ttl, status: 'held', lines });
      }
    } else if (c.type === 'advance') {
      if (c.to < next.clock) error = 'clock_backwards';
      else {
        next.clock = c.to;
        for (const h of next.holds) if (h.status === 'held' && h.expiresAt <= c.to) {
          h.status = 'expired'; for (const l of h.lines) item(l.sku).available += l.qty;
        }
      }
    } else if (!hold) error = 'missing_hold';
    else if (hold.status !== 'held') error = 'inactive_hold';
    else {
      hold.status = c.type === 'confirm' ? 'confirmed' : 'cancelled';
      if (c.type === 'cancel') for (const l of hold.lines) item(l.sku).available += l.qty;
    }
    if (!error) { next.revision++; this.state = next; }
    const response = error ? [409, { error }] : [200, { ok: true, revision: next.revision }];
    this.receipts.set(key, { fingerprint, response }); return response;
  }
}

const cases = [];
const add = (name, steps, initial = seed) => cases.push({ name, steps, initial });
add('empty and read-only state', [], { items: [] });
add('atomic insufficient second line', [reserve('r', 'h', [line('A'), line('B', 2)])]);
add('atomic missing second item', [reserve('r', 'h', [line('A'), line('absent')])]);
add('repeated lines aggregate and release', [reserve('r', 'h', [line('A'), line('A')]), command('c', 'cancel', 'h')]);
add('repeated lines cannot evade capacity', [reserve('r', 'h', [line('A', 2), line('A')])]);
add('confirm before expiry consumes permanently', [reserve('r', 'h', [line('A', 2)]), command('c', 'confirm', 'h'), advance('a', 5), advance('b', 100)]);
add('expiry before confirm refuses', [reserve('r', 'h', [line('A', 2)]), advance('a', 5), command('c', 'confirm', 'h')]);
add('exact expiry boundary', [reserve('r', 'h', [line('B')]), advance('a', 4), advance('b', 5), advance('c', 5)]);
add('terminal IDs cannot be reused', [reserve('r', 'h', [line('B')]), command('c', 'cancel', 'h'), reserve('r2', 'h', [line('B')]), command('c2', 'cancel', 'h')]);
add('missing hold and backward clock', [command('c', 'confirm', 'missing'), command('x', 'cancel', 'missing'), advance('a', 10), advance('b', 9)]);
const original = reserve('r', 'h', [line('A'), line('B')]);
add('object-key order ignored', [original, { lines: [{ qty: 1, sku: 'A' }, { qty: 1, sku: 'B' }], ttl: 5, holdId: 'h', type: 'reserve', key: 'r' }]);
add('array order significant and original receipt retained', [original, { ...original, lines: [...original.lines].reverse() }, original]);
add('retry uses original revision and bypasses business rules', [reserve('r', 'h', [line('B')]), command('c', 'cancel', 'h'), reserve('r', 'h', [line('B')])]);
add('failed receipt stays refused after stock released', [reserve('r', 'h', [line('B')]), reserve('f', 'second', [line('B')]), command('c', 'cancel', 'h'), reserve('f', 'second', [line('B')]), reserve('new', 'second', [line('B')])]);
add('schema before cache and invalid key is reusable', [reserve('r', 'h', [line('A')]), { invalid: { ...reserve('r', 'h', [line('A')]), extra: true } }, { invalid: { key: 'fresh', type: 'advance', to: '4' } }, advance('fresh', 4)]);
add('literal IDs and code-unit ordering', [reserve('__proto__', '__proto__', [line('__proto__')]), reserve('constructor', 'a', [line('a')]), reserve('k', 'Z', [line('Z')])], { items: [{ sku: '__proto__', capacity: 1 }, { sku: 'a', capacity: 1 }, { sku: 'Z', capacity: 1 }] });
add('multiple expiry batches and confirmed exclusion', [reserve('r1', 'h1', [line('A')], 3), reserve('r2', 'h2', [line('A')], 7), reserve('r3', 'h3', [line('B')], 3), command('c', 'confirm', 'h3'), advance('a', 3), advance('b', 7)]);
const invalids = [null, [], 3, {}, { key: 'x', type: 'unknown' }, { key: 3, type: 'advance', to: 1 }, advance('x', -1), advance('x', 1.5), advance('x', 1000000001),
  reserve('x', 'h', []), reserve('x', 3, [line('A')]), reserve('x', 'h', [line('A')], 0), reserve('x', 'h', [line('A')], 1000001),
  reserve('x', 'h', [line('A', 0)]), reserve('x', 'h', [line('A', '1')]), reserve('x', 'h', [line(['A'])]), reserve('x', 'h', [null]), reserve('x', 'h', [{ sku: 'A', qty: 1, extra: 2 }]),
  { key: '', type: 'advance', to: 1 }, { key: 'x', type: 'confirm' }, { key: 'x', type: 'cancel', holdId: 'h', extra: 2 }];
for (const [i, input] of invalids.entries()) add(`strict schema ${i + 1}`, [{ invalid: input }]);
add('malformed JSON', [{ raw: '{"key":' }]);
add('durable success and refusal receipts', [reserve('r', 'h', [line('B')]), reserve('f', 'h2', [line('B')]), { restart: true }, command('c', 'cancel', 'h'), reserve('r', 'h', [line('B')]), reserve('f', 'h2', [line('B')]), { restart: true }, advance('a', 5)]);
let random = 217;
const next = n => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random >>> 8) % n; };
const sequence = []; let time = 0;
for (let i = 0; i < 100; i++) {
  const kind = next(4), id = `h${next(12)}`, key = `k${i}`;
  sequence.push(kind === 0 ? reserve(key, id, [line(next(2) ? 'A' : 'B', 1 + next(2))], 1 + next(9))
    : kind === 1 ? command(key, 'confirm', id) : kind === 2 ? command(key, 'cancel', id) : advance(key, time += next(4)));
  if (i % 17 === 0) sequence.push({ restart: true });
}
add('fixed-seed mixed transition sequence', sequence);

// Literal sanity checks keep the independent oracle accountable before the run.
const sanity = new Oracle({ items: [{ sku: 'X', capacity: 1 }] });
assert.deepEqual(sanity.apply(reserve('r', 'h', [line('X')])), [200, { ok: true, revision: 1 }]);
sanity.apply(advance('a', 5)); assert.deepEqual(sanity.apply(command('c', 'confirm', 'h')), [409, { error: 'inactive_hold' }]);
assert.deepEqual(sanity.snapshot(), { clock: 5, revision: 2, items: [{ sku: 'X', capacity: 1, available: 1 }], holds: [{ id: 'h', expiresAt: 5, status: 'expired', lines: [line('X')] }] });
const bundle = new Oracle(seed); const before = bundle.snapshot();
assert.deepEqual(bundle.apply(reserve('r', 'h', [line('A'), line('B', 2)])), [409, { error: 'insufficient_stock' }]); assert.deepEqual(bundle.snapshot(), before);
if (process.argv.includes('--plan')) {
  console.log(JSON.stringify({ cases, concurrent: ['distinct last-unit contenders', 'identical key contenders', 'conflicting key contenders'] }, null, 2)); process.exit(0);
}
if (!process.argv[2]) throw Error('Usage: node verify-artifact.mjs <reviewed artifact dir> | --plan');
const entry = resolve(process.argv[2], 'server.js');
let passed = 0, failed = 0;
async function fixture(initial, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-reservation-')), receipts = new Map();
  writeFileSync(join(dir, 'seed.json'), JSON.stringify(initial));
  let child, port, stderr = '';
  const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; } };
  const start = async () => {
    child = spawn(process.execPath, [entry, '--db', join(dir, 'state.db'), '--seed', join(dir, 'seed.json'), '--port', '0'], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, LANG: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-8000); });
    port = await new Promise((resolvePort, reject) => {
      const timeout = setTimeout(() => reject(Error('No port announcement: ' + stderr)), 10000); let text = '';
      const finish = (error, value) => { clearTimeout(timeout); if (error) reject(error); else resolvePort(value); };
      child.once('error', e => finish(e)); child.once('exit', code => finish(Error(`Server exited ${code}: ${stderr}`)));
      child.stdout.on('data', b => { text += b; for (const ln of text.split('\n').slice(0, -1)) { try { const p = JSON.parse(ln).port; if (Number.isInteger(p) && p > 0 && p < 65536) finish(null, p); } catch {} } });
    });
  };
  const get = async () => { const r = await fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(5000) }); assert.equal(r.status, 200); return r.text(); };
  const post = async (body, raw) => { const r = await fetch(`http://127.0.0.1:${port}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ?? JSON.stringify(body), signal: AbortSignal.timeout(5000) }); const text = await r.text(); return { status: r.status, body: JSON.parse(text), text }; };
  try { await start(); await fn({ get, post, restart: async () => { await stop(); await start(); }, receipts }); }
  finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
}
async function check(name, initial, fn) {
  try { await fixture(initial, fn); passed++; console.log(JSON.stringify({ name, passed: true })); }
  catch (error) { failed++; console.log(JSON.stringify({ name, passed: false, error: String(error), actual: error.actual, expected: error.expected })); }
}
for (const c of cases) await check(c.name, c.initial, async api => {
  const oracle = new Oracle(c.initial);
  const state = async () => { const first = await api.get(); assert.deepEqual(JSON.parse(first), oracle.snapshot()); assert.equal(await api.get(), first); return first; };
  await state();
  for (const step of c.steps) {
    if (step.restart) { const before = await state(); await api.restart(); assert.equal(await api.get(), before); continue; }
    const invalid = Object.hasOwn(step, 'invalid') || Object.hasOwn(step, 'raw');
    const input = Object.hasOwn(step, 'invalid') ? step.invalid : step;
    const expected = oracle.apply(input, invalid), actual = await api.post(input, step.raw);
    assert.deepEqual([actual.status, actual.body], expected);
    if (!invalid && actual.body.error !== 'idempotency_conflict') {
      if (api.receipts.has(input.key)) assert.equal(actual.text, api.receipts.get(input.key)); else api.receipts.set(input.key, actual.text);
    }
    await state();
  }
});
for (const mode of ['distinct', 'identical', 'conflicting']) await check(`concurrent ${mode} last-unit contenders`, { items: [{ sku: 'A', capacity: 1 }] }, async api => {
  const a = reserve('k1', 'h1', [line('A')]), b = reserve(mode === 'distinct' ? 'k2' : 'k1', mode === 'identical' ? 'h1' : 'h2', [line('A')]);
  const responses = await Promise.all([api.post(a), api.post(b)]);
  assert.deepEqual(responses.map(r => r.status).sort(), mode === 'identical' ? [200, 200] : [200, 409]);
  if (mode === 'identical') assert.equal(responses[0].text, responses[1].text);
  else assert.equal(responses.find(r => r.status === 409).body.error, mode === 'distinct' ? 'insufficient_stock' : 'idempotency_conflict');
  const winner = responses[0].status === 200 ? a : b;
  const oracle = new Oracle({ items: [{ sku: 'A', capacity: 1 }] }); oracle.apply(winner);
  assert.deepEqual(JSON.parse(await api.get()), oracle.snapshot());
  const before = await api.get(); await api.restart(); assert.equal(await api.get(), before);
  assert.equal((await api.post(winner)).text, responses.find(r => r.status === 200).text);
});
console.log(JSON.stringify({ summary: true, passed, failed, total: passed + failed }));
if (failed) process.exitCode = 1;
