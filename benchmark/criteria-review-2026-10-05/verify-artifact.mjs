// Independent execution of a supplied, reviewed CLI artifact; never changes it.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const entry = resolve(process.argv[2], 'stock-reconcile.js');
const original = JSON.parse(readFileSync(new URL('../stock-reconcile-2026-10-05/independent-checks.json', import.meta.url)));
const cases = original.map(c => ({ ...c, expectedStock: c.name === 'quoted-final-column-followed-by-row'
  ? 'sku,onHand,reserved,available\nA,12,0,12\nB,10,0,10\n'
  : c.name === 'reservation-id-equals-event-id' ? 'sku,onHand,reserved,available\nA,10,2,8\nB,10,0,10\n' : undefined }));
const opening = 'sku,onHand\nA,10\nB,0\n';
const events = 'id,sku,type,quantity,ref\nr1,A,RESERVE,6,R1\nS1,A,SHIP,4,R1\nS1,A,SHIP,4,R1\nl1,A,RELEASE,2,R1\nt1,A,RETURN,3,S1\ne1,B,RECEIVE,7,\nr2,B,RESERVE,2,R2\n';
cases.push(
  { name: 'fixed-example-and-both-files-deterministic', opening, events, expectedSuccess: true, expectedStock: 'sku,onHand,reserved,available\nA,9,0,9\nB,7,2,5\n' },
  { name: 'late-excess-return-preserves-files', opening, events: events + 't2,A,RETURN,2,S1\n', expectedSuccess: false },
  { name: 'late-conflicting-duplicate-preserves-files', opening, events: events + 'e1,B,RECEIVE,8,\n', expectedSuccess: false },
  { name: 'opening-only-including-zero', opening, events: 'id,sku,type,quantity,ref\n', expectedSuccess: true, expectedStock: 'sku,onHand,reserved,available\nA,10,0,10\nB,0,0,0\n' },
);
let failed = 0;
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-independent-'));
  try {
    writeFileSync(join(dir, 'opening.csv'), c.opening);
    writeFileSync(join(dir, 'events.csv'), c.events);
    mkdirSync(join(dir, 'out'));
    const stockPath = join(dir, 'out/stock.csv'), auditPath = join(dir, 'out/audit.json');
    writeFileSync(stockPath, 'existing-stock\n'); writeFileSync(auditPath, 'existing-audit\n');
    const run = () => spawnSync(process.execPath, [entry, '--opening', 'opening.csv', '--events', 'events.csv', '--out', 'out'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
    const result = run();
    assert.ifError(result.error);
    assert.equal(result.status === 0, c.expectedSuccess, `exit=${result.status}: ${result.stderr}`);
    assert.equal(readFileSync(join(dir, 'opening.csv'), 'utf8'), c.opening);
    assert.equal(readFileSync(join(dir, 'events.csv'), 'utf8'), c.events);
    const stock = readFileSync(stockPath), audit = readFileSync(auditPath);
    if (!c.expectedSuccess) {
      assert.equal(stock.toString(), 'existing-stock\n'); assert.equal(audit.toString(), 'existing-audit\n');
      assert.match(result.stderr, /row/i);
    } else {
      assert.equal(stock.toString(), c.expectedStock);
      JSON.parse(audit.toString());
      const second = run(); assert.ifError(second.error); assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(readFileSync(stockPath), stock);
      assert.deepEqual(readFileSync(auditPath), audit);
    }
    console.log(JSON.stringify({ name: c.name, passed: true, exitCode: result.status, stock: stock.toString(), audit: audit.toString(), stderr: result.stderr }));
  } catch (error) { failed++; console.log(JSON.stringify({ name: c.name, passed: false, error: String(error) })); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
if (failed) process.exitCode = 1;
