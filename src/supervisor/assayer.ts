/**
 * THE ASSAYER — stage 4 of the supervisor (owner decision 2026-10-15,
 * docs/skill-assay-2026-10-15.md): a recipe is judged by EXECUTION.
 *
 * The trigger evaluation (`src/skills/triggerEval.ts`) judges whether a
 * recipe is PICKED. Nothing judged whether a picked recipe HELPS: the only
 * outcome evidence was the credit counters, earned on customers' runs. The
 * skill-creator method Anthropic publishes closes that with a with/without
 * comparison run by a person; Atoma runs it by itself, off the path of every
 * product run, under the same idle predicate and lease as the analyst.
 *
 * One assay = one recipe surface (kind, when_to_use, body), a few of the
 * tasks it was credited on (`skill_trigger_samples`), and for each task two
 * ORDINARY runs through the shared runner: one on a copy of the catalog
 * holding the recipe, one on a copy without it. Each run gets its own copy
 * of the store, its own workspace and its own runs directory, with learning,
 * promotion and the trigger evaluation off: an assay must change nothing in
 * the commons but the one decision it records. The judge is the runner's own
 * outcome, read from its machine epilogue — delivered or not — the same
 * root acceptance every product run gets; "matched" is a runtime skill event
 * in the arm's trace, never prose.
 *
 * The decision rule is PRE-REGISTERED here, not tuned after the fact:
 *  - cases where the `with` arm never matched the recipe say nothing about
 *    it (`not-reached`): a line the trigger evaluation passed and a real run
 *    never picked is itself the finding;
 *  - over matched cases, more deliveries with the recipe is `helpful`, fewer
 *    is `harmful`, equal is `neutral` (costs recorded beside);
 *  - RETIRE only when harmful AND at least two matched cases AND the recipe
 *    delivered on none of them. Anything less is recorded and the recipe
 *    kept: two runs are a small sample and a retirement is the one power
 *    this stage holds over the commons.
 *
 * Spend: `2 × cases` ordinary runs per assay, bounded by `ASSAY_MAX_CASES`
 * and the per-run wall clock; authorised by the owner on 2026-10-15.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PlatformEventSink } from '../contracts/platformEvents.js';
import {
  skillAssayRecordSchema,
  type AssayArm,
  type AssayArmResult,
  type AssayCaseResult,
  type AssayJudgement,
  type SkillAssayRecord,
} from '../contracts/skillAssay.js';
import { parseRunStatsEpilogue, type RunStats } from '../contracts/runStats.js';
import { snapshotSqliteStore } from '../core/sqliteBackup.js';
import { acquireRunLeaseWithoutRecovery, reclaimedLine, RunLockBusyError } from '../mcp/runLock.js';
import { readBoundedJson } from '../sentinel/sources.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { Skill } from '../skills/types.js';
import { anyRunActive } from './activity.js';
import { assayEvent, safeSink } from './journal.js';

/** Credited tasks per assay; two arms each. */
export const ASSAY_MAX_CASES = 2;
/** Wall clock per arm run. */
export const ASSAY_DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** The resident host's poll. */
export const ASSAYER_DEFAULT_POLL_MS = 60_000;
/** After an assay FAILED (not a verdict), the resident host waits this long: a broken launch must not be retried every minute. */
export const ASSAYER_FAILURE_PAUSE_MS = 60 * 60_000;

export interface AssayTarget {
  readonly namespace: string;
  readonly skillId: string;
  readonly kind: Skill['kind'];
  readonly surfaceDigest: string;
  /** The recipe's provenance stamp, for ordering: newest surfaces first. */
  readonly surfaceAt: string;
}

export interface AssayCase {
  readonly task: string;
  readonly sampledAt: string;
}

/** What the arm launcher is handed; the default builds on `spawnRun`. */
export interface ArmLaunch {
  readonly arm: AssayArm;
  readonly caseIndex: number;
  readonly goal: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logPath: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** The run's isolation: the runner's `--container --egress`, or the host's own tools. */
  readonly isolation: ArmIsolation;
  readonly signal?: AbortSignal;
}

/**
 * `container-egress` is what every project run on a shared host gets, and
 * what the resident host uses: an arm executes model-authored commands and
 * must not do so on the deployment's own filesystem. `host` is the CLI's
 * default on a developer machine without Docker.
 */
export type ArmIsolation = 'host' | 'container-egress';

/** Resolves to the run's log text; rejects on a spawn failure. */
export type ArmLauncher = (launch: ArmLaunch) => Promise<string>;

export interface AssayerOptions {
  /** The checkout the arm runs execute in (`npm run run:build`). */
  readonly repoRoot: string;
  /** The LIVE store and catalog: snapshotted for the arms, written only by the decision. */
  readonly dbPath: string;
  readonly skillsDir: string;
  readonly skills: SkillRegistry;
  readonly runsDir: string;
  readonly supervisorDir: string;
  readonly leasePath: string;
  readonly timeoutMs: number;
  readonly maxCases: number;
  readonly isolation: ArmIsolation;
  readonly dryRun: boolean;
  readonly journal: PlatformEventSink | null;
  readonly launch?: ArmLauncher;
  readonly signal?: AbortSignal;
  readonly log: (line: string) => void;
  readonly warn: (line: string) => void;
}

export type AssayOutcome = 'assayed' | 'dry-run' | 'nothing-pending' | 'refused-active' | 'preempted' | 'failed';

export interface AssayResult {
  readonly outcome: AssayOutcome;
  readonly target: AssayTarget | null;
  readonly recordPath: string | null;
  readonly judgement: AssayJudgement | null;
  readonly detail?: string;
}

/** The surface an assay judges: kind, matching line and body. A revision re-opens the assay. */
export function surfaceDigestOf(skill: Pick<Skill, 'kind' | 'whenToUse' | 'body'>): string {
  return createHash('sha256').update(`${skill.kind}\n${skill.whenToUse}\n${skill.body}`).digest('hex');
}

/**
 * Recipes whose current surface has no assay row and which have at least
 * one credited task to run. Event recipes are guidance, never assayed.
 * Newest surfaces first: a recipe learned today is the one whose value is
 * least known.
 */
export function pendingAssays(skills: SkillRegistry, opts: { readonly max?: number; readonly only?: { namespace: string; skillId: string } } = {}): AssayTarget[] {
  const out: AssayTarget[] = [];
  for (const namespace of skills.listNamespaces()) {
    for (const skill of skills.loadFor(namespace)) {
      if (skill.trigger) continue;
      if (opts.only && (opts.only.namespace !== namespace || opts.only.skillId !== skill.id)) continue;
      const surfaceDigest = surfaceDigestOf(skill);
      if (!opts.only && skills.assayFor(namespace, skill.id, surfaceDigest)) continue;
      if (assayCases(skills, namespace, skill.id, 1).length === 0) continue;
      out.push({ namespace, skillId: skill.id, kind: skill.kind, surfaceDigest, surfaceAt: skill.provenance?.at ?? '' });
    }
  }
  out.sort((a, b) => (a.surfaceAt < b.surfaceAt ? 1 : a.surfaceAt > b.surfaceAt ? -1 : a.skillId.localeCompare(b.skillId)));
  return opts.max !== undefined ? out.slice(0, Math.max(0, opts.max)) : out;
}

/** The newest credited tasks of the recipe, distinct, up to `max`. */
export function assayCases(skills: SkillRegistry, namespace: string, skillId: string, max: number): AssayCase[] {
  const seen = new Set<string>();
  const out: AssayCase[] = [];
  for (const sample of skills.triggerSamples([namespace]).filter((s) => s.skillId === skillId && s.outcome === 'success')) {
    if (seen.has(sample.task)) continue;
    seen.add(sample.task);
    out.push({ task: sample.task, sampledAt: sample.at });
    if (out.length >= max) break;
  }
  return out;
}

/** THE PRE-REGISTERED RULE. Pure. */
export function judgeAssay(cases: readonly AssayCaseResult[]): AssayJudgement {
  const matched = cases.filter((c) => c.with.matched);
  const delivered = (results: readonly AssayArmResult[]) => results.filter((r) => r.outcome === 'delivered').length;
  const cost = (results: readonly AssayArmResult[]) =>
    results.some((r) => r.costUsd === null) || results.length === 0 ? null : results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const withArm = matched.map((c) => c.with);
  const withoutArm = matched.map((c) => c.without);
  const deliveries = { with: delivered(withArm), without: delivered(withoutArm) };
  const costUsd = { with: cost(withArm), without: cost(withoutArm) };
  if (matched.length === 0) {
    return { verdict: 'not-reached', decision: 'keep', matchedCases: 0, deliveries, costUsd };
  }
  const verdict = deliveries.with > deliveries.without ? 'helpful' : deliveries.with < deliveries.without ? 'harmful' : 'neutral';
  const decision = verdict === 'harmful' && matched.length >= 2 && deliveries.with === 0 ? 'retire' : 'keep';
  return { verdict, decision, matchedCases: matched.length, deliveries, costUsd };
}

/** The runner's epilogue, or a failed stats shape when the log has none (a hard reap, a config refusal). */
function statsOf(log: string): RunStats | null {
  return parseRunStatsEpilogue(log);
}

/**
 * Did an arm's run match or dispatch the recipe? Read from the runtime skill
 * events of the newest trace in the arm's own runs directory, never from the
 * log text, which the goal is echoed into.
 */
export function armMatchedRecipe(runsDir: string, skillId: string): { matched: boolean; traceId: string | null } {
  let newest: { path: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(runsDir)) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      const path = join(runsDir, name);
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    }
  } catch {
    return { matched: false, traceId: null };
  }
  if (!newest) return { matched: false, traceId: null };
  const trace = readBoundedJson<{ id?: unknown; events?: unknown }>(newest.path);
  if (!trace || typeof trace !== 'object') return { matched: false, traceId: null };
  const traceId = typeof trace.id === 'string' ? trace.id : null;
  const events = Array.isArray(trace.events) ? (trace.events as Array<Record<string, unknown>>) : [];
  const matched = events.some((event) =>
    event && event['kind'] === 'skill' && (event['op'] === 'match' || event['op'] === 'direct') && event['skillId'] === skillId);
  return { matched, traceId };
}

function assayDirName(target: AssayTarget): string {
  return `${target.namespace}__${target.skillId}__${target.surfaceDigest.slice(0, 12)}`;
}

/** Everything an arm run must NOT do to the commons, and where it does its work instead. */
export function armEnvironment(input: {
  readonly dbPath: string;
  readonly skillsDir: string;
  readonly runsDir: string;
  readonly workspace: string;
}): Record<string, string> {
  return {
    ATOMA_DB_PATH: input.dbPath,
    ATOMA_SKILLS_DIR: input.skillsDir,
    ATOMA_RUNS_DIR: input.runsDir,
    ATOMA_BUILD_WORKSPACE: input.workspace,
    // The arm measures the recipe as it is: it learns, compiles and evaluates nothing.
    ATOMA_SKILL_LEARN: '0',
    ATOMA_SKILL_PROMOTE: '0',
    ATOMA_EVENT_SKILLS: '0',
    ATOMA_SKILL_TRIGGER_EVAL: '0',
    ATOMA_DEFER_LEARNING: '0',
  };
}

/**
 * One assay, end to end, under the caller's lease. Never throws for a run's
 * own failure: a run that could not be launched or produced no epilogue is a
 * `failed` outcome for that arm and the assay records it.
 */
export async function runAssay(target: AssayTarget, cases: readonly AssayCase[], options: AssayerOptions): Promise<AssayResult> {
  const startedAt = new Date().toISOString();
  const assaysDir = join(options.supervisorDir, 'assays');
  const assayDir = join(assaysDir, assayDirName(target));
  const launch = options.launch ?? defaultLauncher;
  if (options.dryRun) {
    options.log(`dry-run: would assay ${target.namespace}/${target.skillId} on ${cases.length} case(s), ${cases.length * 2} run(s) (${options.isolation}) under ${relative(options.repoRoot, assayDir) || assayDir}`);
    for (const [index, c] of cases.entries()) options.log(`dry-run: case ${index}: ${c.task.slice(0, 160)}`);
    return { outcome: 'dry-run', target, recordPath: null, judgement: null };
  }
  rmSync(assayDir, { recursive: true, force: true });
  mkdirSync(join(assayDir, 'runs'), { recursive: true });
  const scratch = join(assayDir, 'scratch');
  mkdirSync(scratch, { recursive: true });
  try {
    // The arms read COPIES. The store is snapshotted once through SQLite's
    // online backup (settled to rollback mode: one file to copy per arm), the
    // catalog is copied twice, and the `without` copy loses the recipe's
    // folder — an orphan row is invisible to every reader, which walk folders.
    const baseStore = join(scratch, 'store.db');
    await snapshotSqliteStore(options.dbPath, baseStore);
    const catalogWith = join(scratch, 'catalog-with');
    const catalogWithout = join(scratch, 'catalog-without');
    cpSync(options.skillsDir, catalogWith, { recursive: true });
    cpSync(options.skillsDir, catalogWithout, { recursive: true });
    rmSync(join(catalogWithout, target.namespace, target.skillId), { recursive: true, force: true });
    if (!existsSync(join(catalogWith, target.namespace, target.skillId, 'SKILL.md'))) {
      return { outcome: 'failed', target, recordPath: null, judgement: null, detail: 'the recipe has no body in the catalog copy' };
    }
    const results: AssayCaseResult[] = [];
    for (const [index, c] of cases.entries()) {
      const arms: Partial<Record<AssayArm, AssayArmResult>> = {};
      for (const arm of ['with', 'without'] as const) {
        if (options.signal?.aborted) return { outcome: 'preempted', target, recordPath: null, judgement: null };
        const armStore = join(scratch, `${index}-${arm}.db`);
        copyFileSync(baseStore, armStore);
        const runsDir = join(assayDir, 'runs', `${index}-${arm}`);
        mkdirSync(runsDir, { recursive: true });
        const logPath = join(assayDir, 'runs', `${index}-${arm}.log`);
        const env = armEnvironment({ dbPath: armStore, skillsDir: arm === 'with' ? catalogWith : catalogWithout, runsDir, workspace: join(scratch, `ws-${index}-${arm}`) });
        options.log(`assay ${target.skillId}: case ${index} arm ${arm} starting (${options.timeoutMs / 1000}s ceiling)`);
        let stats: RunStats | null = null;
        try {
          const log = await launch({ arm, caseIndex: index, goal: c.task, env, logPath, cwd: options.repoRoot, timeoutMs: options.timeoutMs,
            isolation: options.isolation, ...(options.signal ? { signal: options.signal } : {}) });
          stats = statsOf(log);
        } catch (error) {
          if (options.signal?.aborted) return { outcome: 'preempted', target, recordPath: null, judgement: null };
          options.warn(`assay ${target.skillId}: case ${index} arm ${arm} could not run: ${error instanceof Error ? error.message : String(error)}`);
        }
        const matched = armMatchedRecipe(runsDir, target.skillId);
        arms[arm] = {
          arm,
          outcome: stats?.outcome ?? 'error',
          costUsd: stats?.costUsd ?? null,
          durationS: null,
          llmCalls: stats?.llmCalls ?? null,
          matched: matched.matched,
          traceId: matched.traceId,
          logPath: relative(assayDir, logPath),
        };
        options.log(`assay ${target.skillId}: case ${index} arm ${arm} ${arms[arm].outcome}${arms[arm].matched ? ', recipe matched' : ''}${stats?.costUsd !== null && stats?.costUsd !== undefined ? ` ($${stats.costUsd.toFixed(2)})` : ''}`);
      }
      results.push({ task: c.task, sampledAt: c.sampledAt, with: arms.with!, without: arms.without! });
    }
    const judgement = judgeAssay(results);
    const costs = results.flatMap((r) => [r.with.costUsd, r.without.costUsd]);
    const totalCostUsd = costs.some((v) => v === null) ? null : costs.reduce<number>((sum, v) => sum + (v ?? 0), 0);
    let applied = false;
    if (judgement.decision === 'retire') {
      // THE ONE POWER: the recipe leaves the live catalog, folder then row,
      // through the registry's own drop (a `skill-drop` ledger event).
      applied = options.skills.drop(target.namespace, target.skillId);
      options.warn(`assay ${target.skillId}: ${judgement.verdict} on ${judgement.matchedCases} matched case(s), delivered ${judgement.deliveries.with} vs ${judgement.deliveries.without} without — ${applied ? 'RETIRED from the catalog' : 'retirement did not apply (recipe already gone)'}`);
    } else {
      options.log(`assay ${target.skillId}: ${judgement.verdict} (${judgement.matchedCases} matched case(s), delivered ${judgement.deliveries.with} vs ${judgement.deliveries.without}); kept`);
    }
    const record: SkillAssayRecord = skillAssayRecordSchema.parse({
      schema: 'atoma.supervisor.assay/v1',
      namespace: target.namespace,
      skillId: target.skillId,
      surfaceDigest: target.surfaceDigest,
      kind: target.kind,
      startedAt,
      endedAt: new Date().toISOString(),
      cases: results,
      judgement,
      applied: judgement.decision === 'keep' ? true : applied,
      totalCostUsd,
    });
    const recordPath = join(assayDir, 'assay.json');
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    // The row makes the surface "judged"; a retired recipe keeps its row as
    // the fact that it was, under the digest it had.
    options.skills.recordAssay({ namespace: target.namespace, skillId: target.skillId, surfaceDigest: target.surfaceDigest,
      at: record.endedAt, verdict: judgement.verdict, decision: judgement.decision, recordPath, costUsd: totalCostUsd });
    safeSink(options.journal, options.warn)(assayEvent({
      namespace: target.namespace, skillId: target.skillId, surfaceDigest: target.surfaceDigest,
      verdict: judgement.verdict, decision: judgement.decision, applied: record.applied,
      cases: results.length, matchedCases: judgement.matchedCases, deliveries: judgement.deliveries,
      totalCostUsd, recordPath,
    }));
    return { outcome: 'assayed', target, recordPath, judgement };
  } catch (error) {
    if (options.signal?.aborted) return { outcome: 'preempted', target, recordPath: null, judgement: null };
    const detail = error instanceof Error ? error.message : String(error);
    options.warn(`assay ${target.skillId} failed: ${detail}`);
    return { outcome: 'failed', target, recordPath: null, judgement: null, detail };
  } finally {
    // Stores, catalog copies and workspaces are scratch; logs and traces are evidence.
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Take the next pending recipe, under the shared idle predicate and the
 * machine-global lease: an assay spends the operator's quota and its arms own
 * the machine for minutes, so it never starts beside a run or a deployment,
 * and a product run that starts meanwhile is refused behind it like behind
 * the analyst — or preempts it through `options.signal`.
 */
export async function assayNext(options: AssayerOptions, pick: { readonly only?: { namespace: string; skillId: string } } = {}): Promise<AssayResult> {
  const [target] = pendingAssays(options.skills, { max: 1, ...(pick.only ? { only: pick.only } : {}) });
  if (!target) return { outcome: 'nothing-pending', target: null, recordPath: null, judgement: null };
  const cases = assayCases(options.skills, target.namespace, target.skillId, options.maxCases);
  if (options.dryRun) return runAssay(target, cases, options);
  if (anyRunActive({ runsDir: options.runsDir, leasePath: options.leasePath })) {
    options.warn('a run is active right now; refusing to assay beside it');
    return { outcome: 'refused-active', target, recordPath: null, judgement: null };
  }
  let lease;
  try {
    lease = acquireRunLeaseWithoutRecovery(`assayer:${target.skillId}`, options.leasePath);
    if (lease.reclaimed) options.warn(reclaimedLine(lease.reclaimed));
  } catch (error) {
    if (error instanceof RunLockBusyError) return { outcome: 'refused-active', target, recordPath: null, judgement: null };
    throw error;
  }
  try {
    return await runAssay(target, cases, options);
  } finally {
    lease.release();
  }
}

/** The production launcher: one ordinary operator run through the shared runner, in its own process group. */
const defaultLauncher: ArmLauncher = async (launch) => {
  const { spawnRun } = await import('../cli/burnin.js');
  const source = import.meta.url.endsWith('.ts');
  return spawnRun({
    goal: launch.goal,
    timeoutMs: launch.timeoutMs,
    logPath: launch.logPath,
    extraEnv: launch.env,
    ...(launch.isolation === 'container-egress' ? { extraArgs: ['--container', '--egress'] } : {}),
    cwd: launch.cwd,
    npmScript: source ? 'run:build:dev' : 'run:build',
    // The arm's learning is off, so there is nothing to wait for; the flag keeps the runner's accounting inside the run.
    waitForLearning: true,
    ...(launch.signal ? { signal: launch.signal } : {}),
  });
};
