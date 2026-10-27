import { describe, expect, it } from 'vitest';
import { changedCheckSteps } from '../scripts/check-changed.mjs';
import { supervisorCheckReportSchema } from '../src/contracts/supervisorCheck.js';
import { readCheckResult } from '../src/supervisor/menderPolicy.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The mender's harness check (`npm run check:changed`). Measured 2026-09-28 in
 * the mender's container at the production revision: the whole-tree lint
 * aborted at its 1536 MiB heap (3.5 GiB resident unbounded), so the full
 * `npm run check` had never been able to pass there, and the suite alone took
 * 18 minutes on its one worker. This keeps what the harness still runs whole,
 * and what it scopes to the change.
 */
describe('the check scoped to a change', () => {
  const exists = (file: string): boolean => !file.includes('deleted');

  it('runs the docs check and the typecheck whole, then lints and tests the change', () => {
    expect(changedCheckSteps(['src/tools/probe.ts', 'tests/probe.test.ts', 'docs/incidents/x.md'], exists)).toEqual([
      ['npm', ['run', 'docs:check']],
      ['npm', ['run', 'typecheck']],
      ['npx', ['eslint', 'src/tools/probe.ts', 'tests/probe.test.ts']],
      ['npx', ['vitest', 'run', 'tests/probe.test.ts']],
      ['npx', ['vitest', 'related', '--run', '--passWithNoTests', 'src/tools/probe.ts', 'docs/incidents/x.md']],
    ]);
  });

  it('lints a changed test helper without running it as a test', () => {
    expect(changedCheckSteps(['tests/helpers.ts', 'src/a.mjs'], exists)).toEqual([
      ['npm', ['run', 'docs:check']],
      ['npm', ['run', 'typecheck']],
      ['npx', ['eslint', 'tests/helpers.ts', 'src/a.mjs']],
      ['npx', ['vitest', 'related', '--run', '--passWithNoTests', 'tests/helpers.ts', 'src/a.mjs']],
    ]);
  });

  it('skips a deleted path and a repeated one, and keeps the whole-tree steps for an empty change', () => {
    expect(changedCheckSteps(['src/deleted.ts', 'tests/a.test.ts', 'tests/a.test.ts'], exists)).toEqual([
      ['npm', ['run', 'docs:check']],
      ['npm', ['run', 'typecheck']],
      ['npx', ['eslint', 'tests/a.test.ts']],
      ['npx', ['vitest', 'run']],
    ]);
    expect(changedCheckSteps([], exists)).toEqual([
      ['npm', ['run', 'docs:check']],
      ['npm', ['run', 'typecheck']],
    ]);
  });

  it('runs the full suite when its configuration changes', () => {
    expect(changedCheckSteps(['vitest.config.ts'], exists).at(-1)).toEqual(['npx', ['vitest', 'run']]);
  });
});

describe('structured check CLI', () => {
  it('reports failed, truncated and skipped steps and preserves the failure exit code', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-check-json-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const stub = join(bin, 'stub.cjs');
      writeFileSync(stub, `if(process.argv.includes('typecheck')) { process.stderr.write('x'.repeat(30000)); process.exitCode=7; } else { console.log('docs passed'); }`);
      for (const name of ['npm', 'npx']) {
        writeFileSync(join(bin, process.platform === 'win32' ? `${name}.cmd` : name),
          process.platform === 'win32' ? `@"${process.execPath}" "${stub}" %*` : `#!/bin/sh\nexec '${process.execPath}' '${stub}' "$@"\n`, { mode: 0o755 });
      }
      writeFileSync(join(root, 'source.ts'), 'export const value = 1;');
      const run = spawnSync(process.execPath, [resolve('scripts/check-changed.mjs'), '--json', 'source.ts'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env['PATH'] ?? ''}` },
      });
      expect(run.status).toBe(7);
      expect(readCheckResult({ code: run.status, stdout: run.stdout, stderr: run.stderr })).toMatchObject({ passed: false, report: { exitCode: 7 } });
      const report = supervisorCheckReportSchema.parse(JSON.parse(run.stdout));
      expect(report).toMatchObject({ schemaVersion: 1, status: 'failed', exitCode: 7 });
      expect(report.steps.map((step: { status: string }) => step.status)).toEqual(['passed', 'failed', 'skipped', 'skipped']);
      expect(report.steps[0]).toMatchObject({ stdout: expect.stringContaining('docs passed') });
      expect(report.steps[1]).toMatchObject({ exitCode: 7, stderrTruncated: true, stdoutTruncated: false });
      expect(report.steps[1]).toMatchObject({ stderr: 'x'.repeat(24000), durationMs: expect.any(Number) });
      // A fresh process must emit only JSON on success too, without treating
      // --json as a changed file or leaking child logs into the JSON stream.
      writeFileSync(stub, 'console.log("check passed");');
      const success = spawnSync(process.execPath, [resolve('scripts/check-changed.mjs'), '--json', 'source.ts'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env['PATH'] ?? ''}` },
      });
      expect(success.status).toBe(0);
      expect(readCheckResult({ code: success.status, stdout: success.stdout, stderr: success.stderr }).passed).toBe(true);
      const passed = supervisorCheckReportSchema.parse(JSON.parse(success.stdout));
      expect(passed.status).toBe('passed');
      expect(passed.steps.map((step: { status: string }) => step.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
      expect(passed.steps[3]?.args).toEqual(['vitest', 'related', '--run', '--passWithNoTests', 'source.ts']);
      const missingCommand = spawnSync(process.execPath, [resolve('scripts/check-changed.mjs'), '--json'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PATH: root },
      });
      expect(missingCommand.status).not.toBe(0);
      const missing = supervisorCheckReportSchema.parse(JSON.parse(missingCommand.stdout));
      expect(missing.status).toBe('failed');
      expect(missing.steps[0]?.status).toBe('failed');
      expect(missing.steps[1]?.status).toBe('skipped');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it('executes an unchanged transitive test for a source-only change through Vitest related', () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-related-'));
  try {
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'vitest.config.mjs'), 'export default { test: { include: ["*.test.ts"], maxWorkers: 1 } };');
    writeFileSync(join(root, 'source.ts'), 'export const value = 2;');
    writeFileSync(join(root, 'bridge.ts'), 'export { value } from "./source";');
    writeFileSync(join(root, 'consumer.test.ts'), 'import { test, expect } from "vitest"; import { value } from "./bridge"; test("existing regression", () => expect(value).toBe(1));');
    writeFileSync(join(root, 'unrelated.test.ts'), 'throw new Error("unrelated test must not execute");');
    const step = changedCheckSteps(['source.ts'], () => true).at(-1)!;
    const run = (): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), ...step[1].slice(1)], { cwd: root, encoding: 'utf8' });
    const before = run();
    expect(before.status, String(before.stdout) + String(before.stderr)).toBe(1);
    expect(String(before.stdout) + String(before.stderr)).toContain('existing regression');
    expect(String(before.stdout) + String(before.stderr)).not.toContain('unrelated test must not execute');
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;');
    const after = run();
    expect(after.status, String(after.stdout) + String(after.stderr)).toBe(0);
  } finally {
    rmSync(join(root, 'node_modules'), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
