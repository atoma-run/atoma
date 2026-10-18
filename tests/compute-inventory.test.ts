import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ComputeInventory } from '../src/launcher/computeInventory.js';

const roots: string[] = [];
const root = () => { const value = realpathSync(mkdtempSync(join(tmpdir(), 'compute-inventory-'))); roots.push(value); return value; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
it('persists allocations before engine work and fences stale generations until confirmed stop', () => {
  const path = root(), execution = { runId: randomUUID(), generation: 1 };
  const first = new ComputeInventory(path), machineId = first.machineId();
  const allocation = first.reserve(execution); first.active(execution);
  expect(() => first.reserve({ runId: randomUUID(), generation: 1 })).toThrow('reconciliation');
  first.close();
  const resumed = new ComputeInventory(path);
  try {
    expect(resumed.machineId()).toBe(machineId);
    expect(resumed.find(execution)).toMatchObject({ allocationId: allocation.allocationId, state: 'unconfirmed' });
    expect(() => resumed.active(execution)).toThrow('cannot be activated');
    resumed.stopped(execution);
    expect(() => resumed.reserve(execution)).toThrow('new generation');
    expect(resumed.reserve({ ...execution, generation: 2 }).allocationId).not.toBe(allocation.allocationId);
  } finally { resumed.close(); }
});
it('returns independent inventory values and fails closed after owner shutdown', () => {
  const inventory = new ComputeInventory(root()), execution = { runId: randomUUID(), generation: 1 };
  inventory.reserve(execution); const rows = inventory.list(); rows[0]!.state = 'stopped';
  expect(inventory.find(execution)?.state).toBe('allocating');
  inventory.close(); expect(() => inventory.reserve(execution)).toThrow('unavailable');
});
it('excludes a real second launcher and releases ownership on process death without losing its journal', async () => {
  const path = root(), execution = { runId: randomUUID(), generation: 1 };
  const code = `import { ComputeInventory } from './src/launcher/computeInventory.ts';
    const inventory = new ComputeInventory(process.env.INVENTORY);
    inventory.reserve(JSON.parse(process.env.EXECUTION));
    process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { PATH: process.env['PATH'], INVENTORY: path, EXECUTION: JSON.stringify(execution) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'close');
  try {
    await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('Launcher exited before lock'); })]);
    expect(() => new ComputeInventory(path)).toThrow(/locked/i);
    child.kill('SIGKILL'); await exited;
    const recovered = new ComputeInventory(path);
    try { expect(recovered.find(execution)?.state).toBe('unconfirmed'); } finally { recovered.close(); }
  } finally { child.kill('SIGKILL'); await exited; }
});
