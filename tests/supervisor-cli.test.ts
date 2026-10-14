import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two supervisor hosts follow the CLI conventions (`src/cli/AGENTS.md`):
 * `--help` exits zero, an unknown flag is loud and exits non-zero, and the
 * module is safe to import.
 */

function run(entry: string, args: string[], env: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> {
  return spawnSync('npx', ['tsx', entry, ...args], { cwd: process.cwd(), encoding: 'utf8', env, shell: process.platform === 'win32' });
}

describe.each(['src/cli/analyst.ts', 'src/cli/mender.ts'])('%s', (entry) => {
  it('prints help and exits zero', () => {
    const child = run(entry, ['--help']);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toMatch(/usage:/);
    expect(child.stdout).toMatch(/what it (does NOT do|never does)/);
  }, 60_000);

  it('keeps an unknown flag loud', () => {
    const child = run(entry, ['--bogus', '--dry-run']);
    expect(child.status).toBe(1);
    expect(child.stderr).toMatch(/unknown flag: --bogus/);
  }, 60_000);
});

describe('src/cli/analyst.ts', () => {
  // 2026-10-14: `--run` on the production host read only the flag and wrote
  // its verdict under the release directory, where the mender never looks.
  it('keeps verdicts where ATOMA_SUPERVISOR_DIR says, like the mender', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-analyst-cli-'));
    try {
      const child = run('src/cli/analyst.ts', ['--dry-run', '--run', 'absent', '--runs', join(dir, 'runs')], {
        ...process.env,
        ATOMA_SUPERVISOR_DIR: join(dir, 'supervisor'),
        ATOMA_ANALYST_MODEL: 'sub:openai:gpt-5.6-sol',
        ATOMA_DB_PATH: join(dir, 'absent.db'),
      });
      expect(child.stdout, child.stderr).toContain(`verdicts   ${join(dir, 'supervisor', 'verdicts')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
