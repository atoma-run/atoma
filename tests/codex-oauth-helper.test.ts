import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const supported = process.platform !== 'win32' && python.status === 0;

it.skipIf(!supported)('serializes OAuth refresh across real processes and refuses uncertain replay', () => {
  const output = execFileSync('python3', [fileURLToPath(new URL('./test_atoma_codex_auth.py', import.meta.url))],
    { encoding: 'utf8', timeout: 20_000 });
  expect(output).toBe('');
}, 25_000);
