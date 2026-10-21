import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDiagnosticLog } from '../src/launcher/computeDiagnosticLog.js';
import { computeErrorCode } from '../src/contracts/computeDiagnostics.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('persists private logs across logger recreation and rotates at one MiB', () => {
  const root = mkdtempSync(join(tmpdir(), 'compute-diagnostic-')); roots.push(root);
  const log = join(root, 'connection.log');
  computeDiagnosticLog(root)('first\n');
  computeDiagnosticLog(root)('second\n');
  expect(readFileSync(log, 'utf8')).toBe('first\nsecond\n');
  if (process.platform !== 'win32') expect(statSync(log).mode & 0o777).toBe(0o600);
  writeFileSync(log, 'x'.repeat(1024 * 1024));
  computeDiagnosticLog(root)('next\n');
  expect(readFileSync(log, 'utf8')).toBe('next\n');
  expect(statSync(log + '.1').size).toBe(1024 * 1024);
});
it.skipIf(process.platform === 'win32')('refuses a symlink and leaves unrelated bytes untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'compute-diagnostic-')); roots.push(root);
  const target = join(root, 'unrelated'); writeFileSync(target, 'unchanged');
  symlinkSync(target, join(root, 'connection.log'));
  computeDiagnosticLog(root)('must not append');
  expect(readFileSync(target, 'utf8')).toBe('unchanged');
});
it('allows only known transport codes, never exception messages or arbitrary codes', () => {
  expect(computeErrorCode({ code: 'ECONNRESET', message: 'private' })).toBe('ECONNRESET');
  expect(computeErrorCode({ code: 'PRIVATE_SECRET' })).toBeUndefined();
  expect(computeErrorCode(new Error('private'))).toBeUndefined();
});
