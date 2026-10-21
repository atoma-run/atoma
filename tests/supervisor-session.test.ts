import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMAND_OUTPUT_LIMIT, runCommand } from '../src/supervisor/session.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('supervisor subprocess ownership', () => {
  it('retains bounded tails and reports truncation while a noisy command completes', async () => {
    const result = await runCommand(process.execPath, ['-e', `
      process.stdout.write('x'.repeat(${COMMAND_OUTPUT_LIMIT * 3}) + 'OUT-END');
      process.stderr.write('é'.repeat(${COMMAND_OUTPUT_LIMIT * 3}) + 'ERR-END');
    `], { cwd: process.cwd(), timeoutMs: 10_000, outputMode: 'tail' });
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(COMMAND_OUTPUT_LIMIT);
    expect(result.stderr).toHaveLength(COMMAND_OUTPUT_LIMIT);
    expect(result.stdout.endsWith('OUT-END')).toBe(true);
    expect(result.stderr.endsWith('ERR-END')).toBe(true);
    expect(result.stderr).not.toContain('\uFFFD');
    expect(result).toMatchObject({ stdoutTruncated: true, stderrTruncated: true });
  });

  it.each(['stdout', 'stderr'] as const)('rejects incomplete control-command %s and reaps the producer', async (stream) => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-output-limit-'));
    roots.push(root);
    const script = join(root, 'noisy.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';
      writeFileSync('pid', String(process.pid));
      process.${stream}.write('x'.repeat(${COMMAND_OUTPUT_LIMIT + 1}));
      setInterval(() => {}, 1000);`);
    await expect(runCommand(script, [], { cwd: root, timeoutMs: 10_000 })).rejects.toThrow(`command ${stream} exceeded`);
    expect(() => process.kill(Number(readFileSync(join(root, 'pid'), 'utf8')), 0)).toThrow();
  });

  it('delivers every complete protocol message even when the captured transcript is truncated', async () => {
    let received = 0;
    const line = JSON.stringify({ text: 'x'.repeat(4096) });
    const result = await runCommand(process.execPath, ['-e', `
      process.stdout.write((${JSON.stringify(line)} + '\\n').repeat(1024));
    `], { cwd: process.cwd(), timeoutMs: 10_000, outputMode: 'tail', onLine(value) {
      expect(JSON.parse(value)).toEqual({ text: 'x'.repeat(4096) });
      received++;
    } });
    expect(received).toBe(1024);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toHaveLength(COMMAND_OUTPUT_LIMIT);
  });

  it.each(['', '\n'])('rejects an oversized protocol line (suffix %j) and reaps its producer', async (suffix) => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-protocol-limit-'));
    roots.push(root);
    const script = join(root, 'protocol.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';
      writeFileSync('pid', String(process.pid));
      process.stdout.write('x'.repeat(${COMMAND_OUTPUT_LIMIT + 1}) + ${JSON.stringify(suffix)});
      setInterval(() => {}, 1000);`);
    let received = 0;
    await expect(runCommand(script, [], { cwd: root, timeoutMs: 10_000, outputMode: 'tail',
      onLine() { received++; },
    })).rejects.toThrow('command protocol line exceeded');
    expect(received).toBe(0);
    expect(() => process.kill(Number(readFileSync(join(root, 'pid'), 'utf8')), 0)).toThrow();
  });

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
