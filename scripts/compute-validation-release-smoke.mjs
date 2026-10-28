import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ComputeValidationQueue } from '../dist/core/computeValidation.js';
import { COMPUTE_VALIDATION_ENV } from '../dist/contracts/computeValidation.js';

// Exercise the actual packaged CLI, stopping at a later quota-free config error.
// No providers, container, lease or model call can start with this invalid timeout.
const root = mkdtempSync(join(tmpdir(), 'atoma-compute-admission-'));
const dbPath = join(root, 'store.db');
const job = { sourceRunId: randomUUID(), orgId: randomUUID(), projectId: randomUUID() };
const db = new Database(dbPath);
try {
  new ComputeValidationQueue(db);
  db.prepare(`INSERT INTO compute_validation_jobs
    (source_run_id,org_id,project_id,status,created_at,started_at)
    VALUES (?,?,?,'running',?,?)`).run(job.sourceRunId, job.orgId, job.projectId,
    new Date().toISOString(), new Date().toISOString());
  const env = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: root,
    ATOMA_MODEL_L1: 'api:ollama:fixture', ATOMA_MODEL_L2: 'api:ollama:fixture', ATOMA_MODEL_L3: 'api:ollama:fixture',
    ATOMA_DB_PATH: dbPath, ATOMA_LEDGER_DB: dbPath, ATOMA_RUN_ID: randomUUID(),
    ATOMA_BUILD_WORKSPACE: join(root, 'workspace'), ATOMA_RUNS_DIR: join(root, 'runs'),
    ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_REQUIRE_ISOLATION: '0',
    ATOMA_BUILD_TIMEOUT_MS: 'invalid-smoke-timeout',
    [COMPUTE_VALIDATION_ENV]: JSON.stringify(job),
  };
  const run = (flags, overrides = {}) => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli/build-app.js', import.meta.url)), ...flags, 'Quota-free Compute admission smoke'],
      { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000 });
    if (child.error) throw child.error;
    return { status: child.status, text: `${child.stdout}${child.stderr}` };
  };
  const admitted = run(['--container', '--egress']);
  if (admitted.status !== 2 || !admitted.text.includes('expected positive integer in ms')) {
    throw new Error(`Packaged Compute egress did not reach ordinary runner admission: ${JSON.stringify(admitted)}`);
  }
  for (const [flags, overrides] of [
    [[], {}],
    [['--container', '--egress', '--seed', root], {}],
    [['--container', '--egress', '--resume', randomUUID()], {}],
    [['--container', '--egress'], { ATOMA_TENANT_RUN: '1' }],
  ]) {
    const refused = run(flags, overrides);
    if (refused.status !== 2 || !refused.text.includes('Compute validation requires an isolated host run')) {
      throw new Error(`Packaged Compute authority boundary failed: ${JSON.stringify(refused)}`);
    }
  }
  db.prepare('DELETE FROM compute_validation_jobs WHERE source_run_id=?').run(job.sourceRunId);
  const unclaimed = run(['--container', '--egress']);
  if (!unclaimed.status || !unclaimed.text.includes('Compute validation has no active host claim')) {
    throw new Error(`Packaged Compute claim boundary failed: ${JSON.stringify(unclaimed)}`);
  }
  if (existsSync(join(root, 'workspace')) || existsSync(join(root, 'runs'))) {
    throw new Error('Quota-free admission smoke unexpectedly created a run workspace or trace');
  }
  console.log('Compute compiled admission: controlled egress admitted; tenant, replacement inputs, local execution and missing claims refused');
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
