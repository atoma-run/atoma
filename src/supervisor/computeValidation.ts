import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { COMPUTE_VALIDATION, COMPUTE_VALIDATION_ENV } from '../contracts/computeValidation.js';
import { ACCEPTANCE_SOURCE_ENV, ACCEPTANCE_SPEC_ENV } from '../contracts/acceptanceChecklist.js';
import { PROJECT_CONTEXT_ENV, encodeProjectContext } from '../contracts/projectContext.js';
import { readTraceTopLevelFields } from '../contracts/traceFields.js';
import { ComputeValidationQueue } from '../core/computeValidation.js';
import { openLedgerHandle } from '../core/ledger.js';
import { acquireRunLeaseWithoutRecovery, RunLockBusyError } from '../mcp/runLock.js';
import { resolveRerunOrigin } from '../projects/rerun.js';
import type { ProjectStore } from '../projects/store.js';
import { encodeAcceptanceSpec } from '../run/acceptanceSpec.js';
import { readBoundedJson } from '../sentinel/sources.js';
import type { VizRunIndexEntry } from '../viz/trace.js';
import { anyRunActive } from './activity.js';
import { armEnvironment, defaultLauncher, type ArmLauncher, type AssayResult } from './assayer.js';

export interface ComputeValidationOptions {
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly skillsDir: string;
  readonly runsDir: string;
  readonly supervisorDir: string;
  readonly leasePath: string;
  readonly store: ProjectStore;
  readonly allowed: (principalId: string, orgId: string) => boolean;
  readonly launch?: ArmLauncher;
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly onProgress?: (label: string) => void;
}
const result = (outcome: AssayResult['outcome'], detail?: string): AssayResult => ({
  outcome, target: null, recordPath: null, judgement: null, ...(detail ? { detail } : {}),
});

/** One independent ordinary run, never replayed device credits or a recipe verdict. */
export async function validateComputeNext(options: ComputeValidationOptions): Promise<AssayResult | null> {
  const db = openLedgerHandle(options.dbPath);
  const queue = new ComputeValidationQueue(db);
  queue.discover();
  if (anyRunActive(options)) return result('refused-active');
  let lease;
  try { lease = acquireRunLeaseWithoutRecovery('assayer:compute-validation', options.leasePath); }
  catch (error) {
    if (error instanceof RunLockBusyError) return result('refused-active');
    throw error;
  }
  try {
    queue.interruptAbandoned();
    const job = queue.pending();
    if (!job) return null;
    options.signal?.throwIfAborted();
    // Preflight is read-only and precedes admission: unavailable starting states spend nothing.
    let prepared;
    try {
      const project = options.store.getProject(job.orgId, job.projectId);
      const source = options.store.getProjectRun(job.orgId, job.sourceRunId);
      if (!project || project.status !== 'active' || !source || source.executionTarget.kind !== 'customer-device' ||
        !options.allowed(source.requestedByPrincipalId, job.orgId)) throw new Error('Source project access is unavailable');
      if (source.bytesExpiredAt || source.resumeOf || (source.readRunIds?.length ?? 0) > 0 ||
        options.store.getRepositorySync(job.orgId, job.sourceRunId)?.materialised) {
        throw new Error('The exact starting state cannot be reproduced by automatic verification');
      }
      const origin = resolveRerunOrigin({ store: options.store, project, orgId: job.orgId,
        rerunOf: job.sourceRunId, purpose: 'compute-validation', recordedSourceRunId: () => undefined });
      const context = source.contextVersion === undefined ? null : options.store.getProjectContext(job.orgId, job.projectId, source.contextVersion);
      if (source.contextVersion !== undefined && !context) throw new Error('The recorded project context is unavailable');
      if (origin.seedRun) {
        // Publication inventories omit inherited proof/configuration and previous-result context.
        // Until the original launch snapshot is retained, never call that a comparable seed.
        throw new Error('The complete original seed and inherited context are not available for automatic verification');
      }
      prepared = { ...origin, context };
    } catch (error) {
      queue.finish(job, 'blocked', { reason: (error as Error).message, countersChanged: false, costUsd: 0 });
      return result('compute-validated', 'Compute verification blocked before spending');
    }
    if (!queue.claim(job)) return null; // Daily allowance does not starve ordinary recipe assays.
    const validationRunId = randomUUID();
    const directory = join(options.supervisorDir, 'compute-validation', job.sourceRunId);
    const runsDir = join(directory, 'runs');
    const workspace = join(directory, 'workspace');
    const logPath = join(directory, 'run.log');
    const env = armEnvironment({ dbPath: options.dbPath, skillsDir: options.skillsDir, runsDir, workspace }, options.hostEnv);
    // Normal host learning policy, charged through this run's one budget meter. Never borrow device pins or credentials.
    for (const key of ['ATOMA_SKILL_LEARN', 'ATOMA_SKILL_PROMOTE', 'ATOMA_EVENT_SKILLS', 'ATOMA_SKILL_TRIGGER_EVAL']) {
      delete env[key];
      const value = (options.hostEnv ?? process.env)[key];
      if (value !== undefined) env[key] = value;
    }
    env[COMPUTE_VALIDATION_ENV] = JSON.stringify({ sourceRunId: job.sourceRunId, orgId: job.orgId, projectId: job.projectId });
    env['ATOMA_RUN_ID'] = validationRunId;
    if (prepared.acceptance) {
      env[ACCEPTANCE_SPEC_ENV] = encodeAcceptanceSpec(prepared.acceptance.spec);
      if (prepared.acceptance.source === 'drafted') env[ACCEPTANCE_SOURCE_ENV] = 'drafted';
    } else env[ACCEPTANCE_SOURCE_ENV] = 'none';
    if (prepared.context) env[PROJECT_CONTEXT_ENV] = encodeProjectContext(prepared.context);
    options.onProgress?.(`Compute verification ${job.sourceRunId}`);
    let failure: string | undefined;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      options.signal?.throwIfAborted();
      await (options.launch ?? defaultLauncher)({ arm: 'with', caseIndex: 0, goal: prepared.origin.goal,
        env, cwd: options.repoRoot, timeoutMs: COMPUTE_VALIDATION.timeoutMs, logPath,
        isolation: 'container', onSpawn: pid => lease.attachChild(pid), ...(prepared.origin.depth ? { depth: prepared.origin.depth } : {}),
        ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) { failure = (error as Error).message; }
    // Logs can echo a model-authored epilogue. Only host trace metadata establishes completion and cost.
    const index = readBoundedJson<VizRunIndexEntry[]>(join(runsDir, 'index.json'));
    const entry = Array.isArray(index) ? index.find(row => row.id === validationRunId) : undefined;
    let completed = false;
    try {
      const trace = readTraceTopLevelFields(join(runsDir, `${validationRunId}.json`), {
        values: ['id', 'endedAt', 'cancelled'], shapes: ['result', 'error'],
      });
      completed = !failure && trace.values['id'] === validationRunId && typeof trace.values['endedAt'] === 'string' &&
        trace.shapes['result'] === 'object' && trace.shapes['error'] === undefined && trace.values['cancelled'] !== true &&
        !!entry?.endedAt && !entry.inFlight && !entry.hasError && !entry.cancelled && !entry.landed && !entry.degraded;
    } catch { /* Missing or unreadable proof is inconclusive. */ }
    const counts = db.prepare(`SELECT kind, count(*) AS n FROM lifecycle_events WHERE run_id=? AND org_id=? AND project_id=? GROUP BY kind`)
      .all(validationRunId, job.orgId, job.projectId) as { kind: string; n: number }[];
    const countersChanged = counts.some(row => ['type-success', 'type-failure', 'skill-success', 'skill-failure', 'direct-failure'].includes(row.kind));
    const recipesChanged = counts.some(row => ['skill-save', 'promote', 'demote', 'type-patch'].includes(row.kind));
    const status = options.signal?.aborted ? 'interrupted' : completed ? 'completed' : 'inconclusive';
    queue.finish(job, status, { validationRunId, countersChanged, recipesChanged,
      costUsd: typeof entry?.costUsd === 'number' && Number.isFinite(entry.costUsd) ? entry.costUsd : null,
      ...(failure ? { reason: failure } : {}) });
    return result(status === 'interrupted' ? 'preempted' : failure ? 'failed' : 'compute-validated', `Compute verification ${status}`);
  } finally { lease.release(); }
}
