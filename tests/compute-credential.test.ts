import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ComputeCredential } from '../src/launcher/computeCredential.js';
it('refuses unsupported credential stores and malformed account identities', () => {
  expect(() => new ComputeCredential('/unused', 'https://atoma.example', randomUUID(), 'linux')).toThrow('macOS and Windows');
  expect(() => new ComputeCredential('/unused', 'https://atoma.example', 'bad account', 'darwin')).toThrow();
});
it.skipIf(process.env['ATOMA_TEST_SYSTEM_KEYCHAIN'] !== '1')('round-trips a temporary credential through the native OS store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'compute-credential-'));
  const store = new ComputeCredential(root, `https://${randomUUID()}.invalid`, randomUUID());
  const value = randomBytes(32).toString('base64url');
  try { await store.save(value); expect(await store.read()).toBe(value); }
  finally { await store.remove().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
}, 90_000);
