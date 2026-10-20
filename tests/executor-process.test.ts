import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('keeps an old run alive across cutover and frontend replacement, without replay', async () => {
  const result = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'scripts/executor-release-smoke.mjs', '--source'], { timeout: 90_000 });
  expect(result.stdout).toContain('cutover, rollback, reattach, cancellation, no replay, retirement passed');
}, 95_000);
