import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { forceKillTestProcessTree } from './helpers.js';

it.skipIf(process.platform === 'win32')('reaps server descendants immediately when their owner exits, before sandbox cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-exit-'));
  const sandbox = new ToolSandbox(root);
  const child = spawn(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    worker.on('spawn', () => { console.log(worker.pid); process.exit(1); });
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  sandbox.trackChild(child);
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  try {
    await once(child, 'close');
    const pid = Number(stdout.trim());
    expect(pid).toBeGreaterThan(1);
    await expect.poll(() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }, { timeout: 5000 }).toBe(false);
  } finally {
    forceKillTestProcessTree(child.pid);
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
