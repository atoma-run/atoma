// Reproduce the independent CLI counterexamples without changing the archived artifact.
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = new URL('.', import.meta.url);
const cases = JSON.parse(readFileSync(new URL('independent-checks.json', root), 'utf8'));
const source = readFileSync(new URL('published/stock-reconcile.js.txt', root), 'utf8');
for (const example of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-stock-counterexample-'));
  try {
    writeFileSync(join(dir, 'stock-reconcile.cjs'), source);
    writeFileSync(join(dir, 'opening.csv'), example.opening);
    writeFileSync(join(dir, 'events.csv'), example.events);
    const result = spawnSync(process.execPath, ['stock-reconcile.cjs', '--opening', 'opening.csv', '--events', 'events.csv', '--out', 'out'], { cwd: dir, encoding: 'utf8' });
    if (result.error) throw result.error;
    const stock = existsSync(join(dir, 'out', 'stock.csv')) ? readFileSync(join(dir, 'out', 'stock.csv'), 'utf8') : null;
    const reproduced = result.status === example.exitCode && stock === example.stock && (result.status === 0) !== example.expectedSuccess;
    console.log(JSON.stringify({ name: example.name, expectedSuccess: example.expectedSuccess, exitCode: result.status, stock, stderr: result.stderr, reproduced }));
    if (!reproduced) process.exitCode = 1;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
