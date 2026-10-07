#!/usr/bin/env node
/**
 * Quota-free deployment drain.
 *
 * A deployment may replace code and the mutable worker tag only after every
 * run and preview has stopped. In hold mode this process also occupies the
 * machine-global run lease, so no run can enter after the check and before
 * systemd stops the old server.
 *
 * With `--wait-ms` the hold WAITS instead of refusing: it announces the
 * deployment in the lease store, so nothing new takes the slot or opens a
 * preview, lets whatever is already running finish, and refuses only at its
 * deadline. It never interrupts work.
 */
import Database from 'better-sqlite3';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeDbPath } from '../core/stores.js';
import {
  acquireRunLeaseWithoutRecovery,
  mcpRunLockPath,
  peekRunLease,
  recordedProcessLive,
  processFingerprint,
  reclaimedLine,
  registerDeploymentPending,
  RunLockBusyError,
  runLeaseOwnerGone,
  type RunLease,
  type RunLockOwner,
} from '../mcp/runLock.js';
import { DEPLOYMENT_MARKER_PREFIX } from '../viz/deployment.js';

export interface DeploymentPreflightOptions {
  readonly dbPath?: string;
  readonly runLockPath?: string;
  /** The caller already owns the lease, so do not report that row as a blocker. */
  readonly ignoreRunLease?: boolean;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(table)
  );
}

/** What makes replacing the running generation unsafe, counted. */
export interface DeploymentBlockerFacts {
  /** The lease row, unless the caller owns it (`ignoreRunLease`). */
  readonly lease: RunLockOwner | null;
  readonly projectRuns: number;
  readonly previews: number;
  /** A publication in flight runs without the lease, and a restart fails it. */
  readonly publications: number;
}

/** Read-only facts that make replacing the running generation unsafe. */
export function deploymentBlockerFacts(options: DeploymentPreflightOptions = {}): DeploymentBlockerFacts {
  const lockPath = resolve(options.runLockPath ?? mcpRunLockPath());
  const lease = options.ignoreRunLease ? null : peekRunLease(lockPath);
  const facts = { lease, projectRuns: 0, previews: 0, publications: 0 };

  const dbPath = resolve(options.dbPath ?? storeDbPath());
  if (!existsSync(dbPath)) return facts;

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const count = (sql: string): number => (db.prepare(sql).get() as { count: number }).count;
  try {
    if (tableExists(db, 'project_runs')) {
      facts.projectRuns = count("SELECT COUNT(*) AS count FROM project_runs WHERE status = 'running'");
    }
    if (tableExists(db, 'project_run_preview_instances')) {
      facts.previews = count(
        `SELECT COUNT(*) AS count
         FROM project_run_preview_instances
         WHERE state IN ('starting','ready','stopping')`
      );
    }
    if (tableExists(db, 'project_publications')) {
      facts.publications = count("SELECT COUNT(*) AS count FROM project_publications WHERE status = 'publishing'");
    }
  } finally {
    db.close();
  }
  return facts;
}

function blockerLines(facts: DeploymentBlockerFacts): string[] {
  const lines: string[] = [];
  if (facts.lease) {
    lines.push(`run lease ${facts.lease.runId} is held by pid ${facts.lease.ownerPid} since ${facts.lease.acquiredAt}`);
  }
  if (facts.projectRuns > 0) lines.push(`${facts.projectRuns} project run(s) are running`);
  if (facts.previews > 0) lines.push(`${facts.previews} result preview(s) still own runtime`);
  if (facts.publications > 0) lines.push(`${facts.publications} publication(s) are uploading`);
  return lines;
}

/** Read-only facts that make replacing the running generation unsafe, as lines. */
export function deploymentBlockers(options: DeploymentPreflightOptions = {}): string[] {
  return blockerLines(deploymentBlockerFacts(options));
}

export interface DeploymentWaitPlan {
  readonly runLockPath: string;
  readonly dbPath?: string;
  /** Refuse once this long has passed without the slot coming free. */
  readonly waitMs: number;
  /** The write-freeze marker (`ATOMA_DEPLOY_LOCK_PATH`), placed only once the slot is clear. */
  readonly admissionMarker: string;
  readonly parentPid: number;
  /** The activator gives up by writing this file (a cancelled job, a dropped channel). */
  readonly releaseFile?: string;
  /** How long requests admitted just before the marker get to land before the re-check. */
  readonly settleMs?: number;
  readonly pollMs?: number;
  readonly progressMs?: number;
}

export interface DeploymentWaitHooks {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly facts?: () => DeploymentBlockerFacts;
  readonly parentAlive?: () => boolean;
  readonly progress?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export type DeploymentWaitResult =
  | { readonly kind: 'ready'; readonly lease: RunLease }
  | { readonly kind: 'refused'; readonly reason: string };

export const DEPLOYMENT_SETTLE_MS = 1_500;

/**
 * Holders whose work outlasts any deployment wait: a retrieval campaign holds
 * the slot for hours, so waiting for one only keeps everyone else out.
 */
const LONG_HOLDERS = ['retrieval:'] as const;

/**
 * WAIT FOR THE SLOT, NEVER TAKE WORK FROM IT.
 *
 * Refusing whenever the slot was busy made a deployment a lottery ticket on a
 * gap: the mender chained mends with none and two deployments in a row were
 * refused on 2026-09-27; runs started back to back leave none either. So the
 * deployment first ANNOUNCES itself (`registerDeploymentPending`): no run,
 * analysis, mend, maintenance or campaign may take the slot after that, no new
 * preview may start and open ones are no longer kept alive, while whatever
 * already holds or serves finishes as it would have. It takes the slot the
 * moment it frees, waits for the last previews and publications to end, and
 * only then freezes writes — a freeze held for the whole wait would have
 * turned every login and setting into a 503.
 *
 * The freeze is re-read after it settles: a request admitted just before it
 * (a publication retry, a preview whose start lost the race — see
 * `PreviewManager.openDelivered`) lifts it again and is waited for. Once ready
 * the announcement is withdrawn: the lease now keeps takers out, and the
 * freeze keeps previews out until the activator lifts it after health.
 *
 * It refuses at the deadline, when its parent is gone or gave up (the release
 * file), when interrupted — and AT ONCE when waiting cannot end well: a slot
 * held by a gone owner whose recorded process group still exists (only a run
 * start's recovery may reap it, which the announcement forbids; a gone owner
 * with nothing behind is taken over instead), a campaign that runs for hours,
 * or project rows marked live while nothing holds the slot (no driver exists
 * for them; only a server start reconciles them).
 */
export async function waitForDeploymentSlot(
  plan: DeploymentWaitPlan,
  hooks: DeploymentWaitHooks = {}
): Promise<DeploymentWaitResult> {
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => {
    // One listener per sleep, removed when the sleep ends either way: a full
    // wait polls some eighteen hundred times.
    const done = (): void => {
      clearTimeout(timer);
      hooks.signal?.removeEventListener('abort', done);
      resolveSleep();
    };
    const timer = setTimeout(done, ms);
    hooks.signal?.addEventListener('abort', done, { once: true });
  }));
  const facts = hooks.facts ?? (() =>
    deploymentBlockerFacts({ dbPath: plan.dbPath, runLockPath: plan.runLockPath, ignoreRunLease: true }));
  const parentAlive = hooks.parentAlive ?? watchDeploymentParent(plan.parentPid);
  const progress = hooks.progress ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const pollMs = plan.pollMs ?? 1_000;
  const progressMs = plan.progressMs ?? 60_000;
  const settleMs = plan.settleMs ?? DEPLOYMENT_SETTLE_MS;
  const runId = `deployment:${process.pid}`;

  const pending = registerDeploymentPending(runId, plan.runLockPath);
  // The freeze names its writer, so a marker a killed guard or a reboot left
  // behind stops freezing writes by itself (`deploymentPaused`). Written to a
  // sibling and renamed: a reader must never see half a name, which would
  // read as a dead writer and let that one request through.
  const stamp = `${DEPLOYMENT_MARKER_PREFIX} ${process.pid} ${processFingerprint(process.pid) ?? ''}\n`;
  const freeze = (): void => {
    const partial = `${plan.admissionMarker}.${process.pid}.partial`;
    writeFileSync(partial, stamp);
    renameSync(partial, plan.admissionMarker);
  };
  let lease: RunLease | undefined;
  let frozen = false;
  const unfreeze = (): void => {
    if (!frozen) return;
    rmSync(plan.admissionMarker, { force: true });
    frozen = false;
  };
  const refuse = (reason: string): DeploymentWaitResult => {
    unfreeze();
    lease?.release();
    pending.release();
    return { kind: 'refused', reason };
  };
  const started = now();
  let lastProgress = started;
  let waitingFor = '';
  try {
    for (;;) {
      if (hooks.signal?.aborted) return refuse('interrupted while waiting for the run slot');
      if (!parentAlive()) return refuse('the deployment that started this guard is gone');
      if (plan.releaseFile && existsSync(plan.releaseFile)) {
        return refuse('the deployment that started this guard gave up waiting');
      }
      let current = '';
      if (!lease) {
        try {
          lease = acquireRunLeaseWithoutRecovery(runId, plan.runLockPath, { pendingToken: pending.token });
          if (lease.reclaimed) progress(reclaimedLine(lease.reclaimed));
        } catch (error) {
          if (!(error instanceof RunLockBusyError)) throw error;
          const holder = error.owner?.runId ?? 'a row';
          // Refused although its owner is gone: the row recorded a process
          // group, so a run may survive behind it (a no-group row is
          // reclaimed by the acquisition above).
          if (runLeaseOwnerGone(plan.runLockPath)) {
            return refuse(
              `the run slot is held by ${holder} whose owner process is gone but whose run may survive; ` +
                'the next run start recovers it, a deployment never does'
            );
          }
          if (LONG_HOLDERS.some((prefix) => holder.startsWith(prefix))) {
            return refuse(`${holder} holds the run slot and runs for hours; deploy once it has ended`);
          }
          current = error.owner ? `${holder} (holding the run slot since ${error.owner.acquiredAt})` : 'the run slot';
        }
      }
      if (lease) {
        const found = facts();
        if (found.projectRuns > 0) {
          return refuse(
            `${found.projectRuns} project run(s) are marked running while no run holds the slot; ` +
              'nothing drives them and only a server start reconciles them — restart the service, then deploy'
          );
        }
        const waitingOn = blockerLines(found);
        if (waitingOn.length === 0) {
          if (frozen) {
            pending.release();
            return { kind: 'ready', lease };
          }
          freeze();
          frozen = true;
          await sleep(settleMs);
          continue;
        }
        unfreeze();
        current = waitingOn.join('; ');
      }
      const elapsed = now() - started;
      if (current !== waitingFor || now() - lastProgress >= progressMs) {
        progress(`deployment waiting ${Math.round(elapsed / 1000)}s for ${current}; nothing new may start meanwhile`);
        lastProgress = now();
        waitingFor = current;
      }
      if (elapsed >= plan.waitMs) {
        return refuse(`waited ${Math.round(elapsed / 1000)}s and ${current} is still there`);
      }
      await sleep(pollMs);
    }
  } catch (error) {
    refuse('failed');
    throw error;
  }
}

interface CliOptions extends DeploymentPreflightOptions {
  readonly help: boolean;
  readonly hold: boolean;
  readonly parentPid?: number;
  readonly readyFile?: string;
  readonly releaseFile?: string;
  readonly admissionMarker?: string;
  readonly waitMs?: number;
}

const USAGE = `atoma deploy preflight — refuse activation while runtime work is live

usage:
  npm run deploy:preflight
  npm run deploy:preflight -- --hold --parent-pid <pid> --ready-file <path> --release-file <path> --admission-marker <path> [--wait-ms <ms>]
  npm run deploy:preflight -- --db <path> --run-lock <path>

--hold claims the existing machine-global run slot without stale recovery,
then waits until the release file appears or the parent process exits.

--wait-ms <ms> makes --hold WAIT for busy work instead of refusing it: nothing
new may take the slot or open a preview meanwhile, whatever runs finishes, and
the admission marker is written only once the slot is clear. It refuses (75)
at the deadline, or at once when a gone owner's run may survive behind the slot.
`;

function parseArgs(argv: readonly string[]): CliOptions {
  let dbPath: string | undefined;
  let runLockPath: string | undefined;
  let parentPid: number | undefined;
  let readyFile: string | undefined;
  let releaseFile: string | undefined;
  let admissionMarker: string | undefined;
  let waitMs: number | undefined;
  let hold = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const take = (): string => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--hold') hold = true;
    else if (arg === '--db') dbPath = take();
    else if (arg === '--run-lock') runLockPath = take();
    else if (arg === '--parent-pid') {
      const raw = take();
      if (!/^\d+$/.test(raw) || Number(raw) <= 1) throw new Error('--parent-pid must be an integer above 1');
      parentPid = Number(raw);
    } else if (arg === '--ready-file') readyFile = take();
    else if (arg === '--release-file') releaseFile = take();
    else if (arg === '--admission-marker') admissionMarker = take();
    else if (arg === '--wait-ms') {
      const raw = take();
      // Four hours: past the longest project run budget and its backstops.
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 14_400_000) {
        throw new Error('--wait-ms must be an integer between 1 and 14400000');
      }
      waitMs = Number(raw);
    } else throw new Error(`unknown deploy preflight argument: ${arg}`);
  }
  if (admissionMarker && !hold) {
    throw new Error('--admission-marker requires --hold');
  }
  if (waitMs !== undefined && !hold) {
    throw new Error('--wait-ms requires --hold');
  }
  return {
    help,
    hold,
    ...(dbPath ? { dbPath } : {}),
    ...(runLockPath ? { runLockPath } : {}),
    ...(parentPid ? { parentPid } : {}),
    ...(readyFile ? { readyFile } : {}),
    ...(releaseFile ? { releaseFile } : {}),
    ...(admissionMarker ? { admissionMarker } : {}),
    ...(waitMs !== undefined ? { waitMs } : {}),
  };
}

/** Capture the birth identity once, before waiting or holding the deployment slot. */
export function watchDeploymentParent(parentPid: number): () => boolean {
  const fingerprint = processFingerprint(parentPid);
  if (!fingerprint) throw new Error('cannot identify the deployment parent');
  return () => recordedProcessLive(parentPid, fingerprint);
}

async function waitForRelease(parentAlive: () => boolean, releaseFile: string): Promise<void> {
  await new Promise<void>((resolveWait) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolveWait();
    };
    const timer = setInterval(() => {
      if (existsSync(releaseFile) || !parentAlive()) finish();
    }, 250);
    // A hangup too: dying on it would skip the lease release and leave a
    // dead `deployment:` row that only a run start's recovery ever clears.
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    process.once('SIGHUP', finish);
  });
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${String(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  let lease: RunLease | undefined;
  try {
    const parentAlive = options.hold && options.parentPid ? watchDeploymentParent(options.parentPid) : undefined;
    if (options.hold && options.waitMs !== undefined) {
      if (!options.parentPid || !options.readyFile || !options.releaseFile || !options.admissionMarker) {
        throw new Error(
          '--hold requires --parent-pid, --ready-file, --release-file and --admission-marker'
        );
      }
      // A dropped SSH channel hangs up; a cancelled job terminates. Either way
      // the wait ends and the announcement is withdrawn at once, not at the
      // deadline.
      const interrupted = new AbortController();
      const interrupt = (): void => interrupted.abort();
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
      for (const signal of signals) process.once(signal, interrupt);
      const result = await waitForDeploymentSlot(
        {
          runLockPath: resolve(options.runLockPath ?? mcpRunLockPath()),
          ...(options.dbPath ? { dbPath: resolve(options.dbPath) } : {}),
          waitMs: options.waitMs,
          admissionMarker: resolve(options.admissionMarker),
          parentPid: options.parentPid,
          releaseFile: resolve(options.releaseFile),
        },
        { signal: interrupted.signal, ...(parentAlive ? { parentAlive } : {}) }
      );
      for (const signal of signals) process.removeListener(signal, interrupt);
      if (result.kind === 'refused') {
        process.stderr.write(`deployment blocked: ${result.reason}\n`);
        process.exitCode = 75;
        return;
      }
      lease = result.lease;
      writeFileSync(resolve(options.readyFile), 'ready\n', { flag: 'wx' });
      process.stdout.write('deployment lease acquired\n');
      await waitForRelease(parentAlive!, resolve(options.releaseFile));
      return;
    }
    if (options.hold) {
      if (
        !options.parentPid ||
        !options.readyFile ||
        !options.releaseFile ||
        !options.admissionMarker
      ) {
        throw new Error(
          '--hold requires --parent-pid, --ready-file, --release-file and --admission-marker'
        );
      }
      lease = acquireRunLeaseWithoutRecovery(
        `deployment:${process.pid}`,
        resolve(options.runLockPath ?? mcpRunLockPath())
      );
      if (lease.reclaimed) process.stdout.write(`${reclaimedLine(lease.reclaimed)}\n`);
    }
    const blockers = deploymentBlockers({ ...options, ignoreRunLease: options.hold });
    if (blockers.length > 0) {
      for (const blocker of blockers) process.stderr.write(`deployment blocked: ${blocker}\n`);
      process.exitCode = 75;
      return;
    }
    if (!options.hold) {
      process.stdout.write('deployment preflight clear\n');
      return;
    }

    writeFileSync(resolve(options.readyFile!), 'ready\n', { flag: 'wx' });
    process.stdout.write('deployment lease acquired\n');
    await waitForRelease(parentAlive!, resolve(options.releaseFile!));
  } catch (error) {
    process.stderr.write(`deployment preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
    // 75 means busy work, and the activator tells the operator to run the
    // deployment again later; a broken guard (a marker it cannot write, an
    // identity it cannot read) is not that, and says so.
    process.exitCode = error instanceof RunLockBusyError ? 75 : 1;
  } finally {
    lease?.release();
    if (options.hold && options.admissionMarker) {
      try {
        rmSync(resolve(options.admissionMarker), { force: true });
      } catch (error) {
        process.stderr.write(
          `deployment marker cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) await main();
