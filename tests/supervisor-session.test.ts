import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/supervisor/session.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('supervisor subprocess ownership', () => {
  it('times out only after the child and its grandchild are gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-session-'));
    roots.push(root);
    const script = join(root, 'parent.mjs');
    writeFileSync(script, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
      process.on('SIGTERM', () => { child.once('exit', () => process.exit(0)); });
      setInterval(() => {}, 1000);
    `);
    await expect(runCommand(script, [], { cwd: root, timeoutMs: 1_000 })).rejects.toThrow('timeout');
    const pids = JSON.parse(readFileSync(join(root, 'pids.json'), 'utf8')) as number[];
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  it('waits for SIGKILL and reap when the command ignores SIGTERM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-session-kill-'));
    roots.push(root);
    const script = join(root, 'resistant.mjs');
    writeFileSync(script, `import {writeFileSync} from 'node:fs';
      writeFileSync('pid', String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
    await expect(runCommand(script, [], { cwd: root, timeoutMs: 1_000 })).rejects.toThrow('timeout');
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  it('aborts on its signal like a timeout: the group is gone before it rejects with the reason', async () => {
    // A member's run preempts the resident analysis through this signal.
    const root = mkdtempSync(join(tmpdir(), 'atoma-session-abort-'));
    roots.push(root);
    const script = join(root, 'long.mjs');
    writeFileSync(script, `import {writeFileSync} from 'node:fs';
      writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const running = runCommand(script, [], { cwd: root, timeoutMs: 60_000, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort(new Error('preempted by a product run'));
    await expect(running).rejects.toThrow('preempted by a product run');
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);
});
