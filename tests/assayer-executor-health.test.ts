import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { processFingerprint } from '../src/mcp/runLock.js';
import { executorAssayerHealth, type ResidentAssayerHealth } from '../src/supervisor/residentAssayer.js';

it('keeps the actual assay owner visible across a generation switch, excluding dead and recycled writers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assayer-generations-'));
  const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const next = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const oldExit = once(old, 'exit');
  const nextExit = once(next, 'exit');
  const health: ResidentAssayerHealth = { armed: true, inFlight: null, assayed: 0, failed: 0,
    deferred: 0, preempted: 0, pausedUntil: null, lastResult: null, lastError: null };
  try {
    await Promise.all([once(old, 'spawn'), once(next, 'spawn')]);
    const oldSocket = join(root, `${'a'.repeat(40)}.sock`);
    const nextSocket = join(root, `${'b'.repeat(40)}.sock`);
    const active = join(root, 'active.sock');
    const receipt = (socket: string, pid: number, snapshot: ResidentAssayerHealth, fingerprint = processFingerprint(pid)) => {
      expect(fingerprint).toBeTruthy();
      writeFileSync(socket, '');
      writeFileSync(`${socket}.json`, JSON.stringify({ pid, fingerprint, snapshot: { assayer: snapshot } }));
    };
    receipt(oldSocket, old.pid!, { ...health, inFlight: 'recipe · case 2/2 · with', assayed: 3 });
    receipt(nextSocket, next.pid!, health);
    symlinkSync(oldSocket, active);
    expect(executorAssayerHealth(active)).toMatchObject({ inFlight: 'recipe · case 2/2 · with', assayed: 3, executorRelease: 'a'.repeat(40) });
    unlinkSync(active);
    symlinkSync(nextSocket, active);
    expect(executorAssayerHealth(active)).toMatchObject({ inFlight: 'recipe · case 2/2 · with', executorRelease: 'a'.repeat(40) });
    old.kill();
    await oldExit;
    expect(executorAssayerHealth(active)).toMatchObject({ inFlight: null, assayed: 0, executorRelease: 'b'.repeat(40) });
    receipt(nextSocket, next.pid!, health, 'not-this-process-birth');
    expect(executorAssayerHealth(active)).toBeNull();
  } finally {
    old.kill(); next.kill();
    await Promise.all([oldExit, nextExit]);
    rmSync(root, { recursive: true, force: true });
  }
});
