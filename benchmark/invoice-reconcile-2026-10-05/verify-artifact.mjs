// Frozen before the live run. Executes only the supplied CLI in temporary directories.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, linkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url)));
if (!process.argv[2]) throw new Error('Usage: node verify-artifact.mjs <reviewed artifact directory>');
const entry = resolve(process.argv[2], 'invoice-reconcile.js');
let failed = 0;
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-invoice-check-'));
  let result;
  try {
    const input = join(dir, 'ledger.json');
    const output = c.collision === 'same-file' ? input : join(dir, 'reconciliation.json');
    const original = c.raw ? c.input : JSON.stringify(c.input);
    writeFileSync(input, original);
    if (c.collision === 'symlink') symlinkSync(input, output);
    else if (c.collision === 'hardlink') linkSync(input, output);
    else if (c.outputDirectory) { mkdirSync(output); writeFileSync(join(output, 'keep.txt'), 'keep'); }
    else if (!c.collision) writeFileSync(output, 'existing output: preserve on failure\n');
    const run = () => spawnSync(process.execPath, [entry, '--input', input, '--out', output], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, HOME: dir, LANG: 'C', TZ: 'UTC' },
    });
    result = run();
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(readFileSync(input, 'utf8'), original, 'input bytes changed');
    if (c.expected === null) {
      assert.notEqual(result.status, 0, 'invalid input accepted');
      assert.ok(result.stderr.trim(), 'missing diagnostic stderr');
      if (c.outputDirectory) {
        assert.ok(statSync(output).isDirectory());
        assert.equal(readFileSync(join(output, 'keep.txt'), 'utf8'), 'keep');
      } else assert.equal(readFileSync(output, 'utf8'), c.collision ? original : 'existing output: preserve on failure\n');
    } else {
      assert.equal(result.status, 0, result.stderr);
      const first = readFileSync(output);
      assert.deepEqual(JSON.parse(first), c.expected);
      const second = run();
      assert.ifError(second.error);
      assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(readFileSync(output), first, 'output not byte deterministic');
      assert.equal(readFileSync(input, 'utf8'), original);
    }
    console.log(JSON.stringify({ name: c.name, passed: true, exitCode: result.status, stderr: result.stderr }));
  } catch (error) {
    failed++;
    console.log(JSON.stringify({ name: c.name, passed: false, error: String(error), exitCode: result?.status, stderr: result?.stderr }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (failed) process.exitCode = 1;
