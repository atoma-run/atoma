/**
 * The checkpoint fixture: a disposable root holding a store, skills, runs and
 * a workspace, and a `run` that restarts the REAL runner in a child process
 * (tests/fixtures/checkpoint-run-child.ts) so a SIGKILL, a pause and a resume
 * cross the process boundary the production path crosses. Every child pays
 * a 2–5 s tsx cold start, which is why the suites that use it are split
 * across three files (run-checkpoint*.test.ts): vitest parallelises between
 * files only, and one file holding all 43 tests was the whole suite's
 * critical path (93 s on 2026-10-23, against a 98 s wall).
 */
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { closeStoreHandles } from '../../src/core/stores.js';
import { OLLAMA_PINS } from '../tier-pins.js';

/** Roots removed by `cleanupCheckpointFixtures`; a test that builds its own pushes here. */
export const checkpointRoots: string[] = [];
const roots = checkpointRoots;

/** Register as `afterEach` in every file that calls `fixture()`. */
export function cleanupCheckpointFixtures(): void {
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function fixture(workspaceProcess = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-checkpoint-')));
  roots.push(root);
  const db = join(root, 'store.db');
  const env = { ...process.env, ...OLLAMA_PINS, CHECKPOINT_TEST_ROOT: root,
    CHECKPOINT_TEST_WORKSPACE_PROCESS: workspaceProcess ? '1' : '0',
    ATOMA_DB_PATH: db, ATOMA_LEDGER_DB: db, ATOMA_SKILLS_DIR: join(root, 'skills'),
    ATOMA_RUNS_DIR: join(root, 'runs'), ATOMA_BUILD_WORKSPACE: join(root, 'workspace'),
    ATOMA_BUILD_TIMEOUT_MS: '600000', ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0',
    ATOMA_PREFILTER_CACHE: '0', ATOMA_SKILL_LEARN: '0', ATOMA_SKILL_PROMOTE: '0', ATOMA_SKILL_DIRECT: '0', ATOMA_JEV: '0',
  };
  // Fixtures never inherit a tenant receipt, seed, fixed trace id or criteria.
  for (const key of ['ATOMA_TENANT_RUN', 'ATOMA_RUN_ID', 'ATOMA_SEED', 'ATOMA_ACCEPTANCE_SPEC', 'ATOMA_ARTIFACT_MANIFEST_PATH']) delete (env as NodeJS.ProcessEnv)[key];
  const run = (args: string[], crash = '', overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    ['--experimental-test-module-mocks', '--import', 'tsx', resolve('tests/fixtures/checkpoint-run-child.ts'), ...args],
    { env: { ...env, CHECKPOINT_TEST_CRASH: crash, ...overrides }, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  const report = () => JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) as {
    outcome: string; checkpointId: string; calls: string[]; rootReviews: number;
  };
  /** The calls of a run that exited 2 before writing its report. */
  const errorReport = () => JSON.parse(readFileSync(join(root, 'error-report.json'), 'utf8')) as { calls: string[]; rootReviews: number };
  /** Edit the saved checkpoint payload as an older binary or a tamperer would leave it. */
  const editPayload = (id: string, sql: string) => {
    const handle = new Database(db);
    try { handle.prepare(`UPDATE run_checkpoints SET payload=${sql} WHERE id=?`).run(id); } finally { handle.close(); }
  };
  const counters = () => {
    const handle = new Database(db, { readonly: true });
    try { return {
      atoms: handle.prepare('SELECT sum(successes) AS n FROM atom_types').get() as { n: number },
      skills: handle.prepare('SELECT sum(successes) AS n FROM skill_meta').get() as { n: number },
    }; } finally { handle.close(); }
  };
  return { root, db, run, report, errorReport, editPayload, counters };
}
