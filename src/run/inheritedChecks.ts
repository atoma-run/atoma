import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolExecutor } from '../core/types.js';
import { PROBE_MANIFEST_FILENAME } from '../contracts/probeManifest.js';
import { classifyDeliveredWorkspace } from '../preview/descriptor.js';
import {
  HOST_REPLAY_ARG,
  inheritedWebChecks,
  judgeReplay,
  minimumReplayMs,
  type InheritedBaseline,
  type InheritedChecksReport,
  type InheritedChecksRuntime,
  type InheritedWebCheck,
  type ListedCheck,
  type ReplayStop,
  type ReplayVerdict,
} from '../contracts/inheritedChecks.js';

/**
 * THE HOST'S REPLAY OF THE CHECKS EARLIER RUNS RECORDED
 * (docs/inherited-checks-replay-2026-10-01.md, owner decision 2026-10-01).
 *
 * When a seeded static-page run starts, its workspace is the page an earlier
 * run delivered, and its `.atoma-probes.json` holds the browser checks earlier
 * runs recorded. The host replays each check twice on that untouched page,
 * while the root plans, and keeps the ones that passed both times: they held,
 * reliably, when this run began. `gatedExecutor` makes every tool call of the
 * run wait until then, so no molecule changes the page under the replay.
 * Root acceptance replays the kept checks on the delivered page (`compare`).
 *
 * The replay is an EXCEPTION to "supervisors never replay model-authored
 * scripts": an inherited smoke is JavaScript a molecule wrote. It runs only in
 * `validate_html`'s host mode (a fresh browser context, the page's own origin
 * only, no stuck tracker), it goes through the backend's base executor and is
 * never attested, and what it finds only informs the acceptor.
 *
 * Nothing here writes into the workspace: the review of the first design
 * (2026-10-01) broke a staged copy of the starting page, which the host would
 * have written into a tree the run's own processes could still change.
 */

export interface InheritedReplayLimits {
  /** Checks taken from the manifest, from its end. */
  readonly maxChecks: number;
  /** One `validate_html` call, raced by the host; a call past it is that check's `cannot-run`. */
  readonly perCallMs: number;
  /** The first call, which may launch the browser, outside the per-call cap. */
  readonly warmUpMs: number;
  /** A check whose own waits and holds need more than this is skipped: it would time out on every run. */
  readonly slowestCheckMs: number;
  /** Calls past their cap before the replay stops. */
  readonly maxAbandoned: number;
  /** The run-start replay, which every molecule's first tool call waits for. */
  readonly baselineWallMs: number;
  /** One acceptance's replay. */
  readonly acceptanceWallMs: number;
  /** Left before the run deadline for the acceptor's own verdict. */
  readonly verdictReserveMs: number;
}

export const DEFAULT_INHERITED_REPLAY_LIMITS: InheritedReplayLimits = Object.freeze({
  maxChecks: 40,
  perCallMs: 10_000,
  warmUpMs: 30_000,
  slowestCheckMs: 8_000,
  maxAbandoned: 3,
  baselineWallMs: 60_000,
  acceptanceWallMs: 60_000,
  verdictReserveMs: 90_000,
});

/** Every tool call waits for `ready` first, so the run-start replay sees the workspace untouched. */
export function gatedExecutor(executor: ToolExecutor, ready: Promise<void>): ToolExecutor {
  return {
    has: (name: string) => executor.has(name),
    async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
      await ready;
      return executor.execute(name, args);
    },
  };
}

/** A regular file of the workspace, reached through no symlink and no special file. */
export function regularWorkspaceFile(root: string, relative: string): boolean {
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) return false;
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return false;
  }
  return true;
}

const TIMED_OUT = Symbol('timed out');

/** The call's outcome, or TIMED_OUT once `ms` passed; the call itself cannot be cancelled. */
async function raced(call: Promise<unknown>, ms: number): Promise<{ value: unknown } | { error: unknown } | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([call.then((value) => ({ value }), (error: unknown) => ({ error })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function pageUrl(origin: string, file: string): string {
  return `${origin}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The run's replay, or undefined when there is nothing to replay: no
 * inherited manifest, a workspace that is not a static page (a Node app's
 * smoke can change its server's data), no check whose page is a regular file,
 * or a backend without the two tools. Call it right after seeding, before any
 * tool call: the run-start replay begins at once.
 */
export function inheritedChecksFor(args: {
  readonly workspaceRoot: string;
  /** The backend's executor as it stands now: a deepening replaces the backend. */
  readonly executor: () => ToolExecutor;
  readonly signal?: AbortSignal;
  /** The run deadline: the start replay never eats into the acceptor's reserve. */
  readonly deadlineAt?: number;
  readonly log: (line: string) => void;
  readonly limits?: Partial<InheritedReplayLimits>;
  readonly now?: () => number;
}): InheritedChecksRuntime | undefined {
  const limits: InheritedReplayLimits = { ...DEFAULT_INHERITED_REPLAY_LIMITS, ...args.limits };
  const now = args.now ?? Date.now;
  let raw: string;
  try {
    const manifest = join(args.workspaceRoot, PROBE_MANIFEST_FILENAME);
    if (!lstatSync(manifest).isFile()) return undefined;
    raw = readFileSync(manifest, 'utf8');
  } catch {
    return undefined;
  }
  const inherited = inheritedWebChecks(raw);
  if (inherited.length === 0) return undefined;
  const classification = classifyDeliveredWorkspace(args.workspaceRoot);
  if (classification.kind !== 'static') {
    args.log(`inherited checks: ${inherited.length} not replayed, the workspace is not a static page (${classification.kind ?? classification.unavailableReason ?? 'unknown'})`);
    return undefined;
  }
  const checks = inherited.filter((check) => regularWorkspaceFile(args.workspaceRoot, check.file)).slice(0, limits.maxChecks);
  const tools = args.executor();
  if (checks.length === 0 || !tools.has('start_static_server') || !tools.has('validate_html')) return undefined;

  // ONE static server per backend, reused by the run-start replay and every
  // acceptance. A deepening replaces the backend, and with it the server.
  let server: { readonly executor: ToolExecutor; readonly origin: string } | undefined;
  const origin = async (): Promise<string | undefined> => {
    const executor = args.executor();
    if (server?.executor === executor) return server.origin;
    const started = await raced(executor.execute('start_static_server', {}), limits.perCallMs);
    if (started === TIMED_OUT || 'error' in started || !isRecord(started.value) || typeof started.value['url'] !== 'string') return undefined;
    try {
      server = { executor, origin: new URL(started.value['url']).origin };
    } catch {
      return undefined;
    }
    return server.origin;
  };

  // A check that cannot answer within the cap would time out on every run.
  const tooSlow = (check: InheritedWebCheck): boolean => minimumReplayMs(check) > limits.slowestCheckMs;
  const replay = async (check: InheritedWebCheck, at: string): Promise<ReplayVerdict | 'abandoned'> => {
    const outcome = await raced(args.executor().execute('validate_html', {
      url: pageUrl(at, check.file),
      [HOST_REPLAY_ARG]: true,
      smoke: check.smoke,
      interactions: check.interactions,
      ...(check.viewport ? { viewport: check.viewport } : {}),
      ...(check.waitMs !== undefined ? { waitMs: check.waitMs } : {}),
    }), limits.perCallMs);
    if (outcome === TIMED_OUT) return 'abandoned';
    if ('error' in outcome) {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      return { outcome: 'cannot-run', detail: `validate_html threw: ${message}`.slice(0, 240) };
    }
    return judgeReplay(check, outcome.value);
  };

  // Each kept check carries the requests the host refused at the start: a
  // delivered failure beside a NEW one says the delivery added a dependency
  // the replay cannot serve, and nothing about the check.
  const kept: Array<{ readonly check: InheritedWebCheck; readonly pageErrors: boolean; readonly blocked: ReadonlySet<string> }> = [];
  let baseline: InheritedBaseline = { considered: 0, kept: 0, cannotRun: 0 };
  const ready: Promise<void> = (async () => {
    const started = now();
    let stopped: ReplayStop | undefined;
    let considered = 0;
    let cannotRun = 0;
    let abandoned = 0;
    let note: string | undefined;
    const at = await origin();
    if (at === undefined) stopped = 'server';
    else {
      // The first call may launch the browser: it is not any check's.
      await raced(args.executor().execute('validate_html', { url: pageUrl(at, checks[0]!.file), [HOST_REPLAY_ARG]: true }), limits.warmUpMs);
    }
    for (const check of at === undefined ? [] : checks) {
      if (args.signal?.aborted) { stopped = 'aborted'; break; }
      if (args.deadlineAt !== undefined && now() + 2 * limits.perCallMs + limits.verdictReserveMs > args.deadlineAt) { stopped = 'deadline'; break; }
      if (now() - started > limits.baselineWallMs) { stopped = 'budget'; break; }
      considered += 1;
      if (tooSlow(check)) { cannotRun += 1; note ??= `a check needs ${minimumReplayMs(check)} ms, past the ${limits.slowestCheckMs} ms a check may take`; continue; }
      // A failed start replay is a stale check; one that could not run says
      // nothing either way, and is counted apart.
      let passes = 0;
      let startErrors = false;
      const startBlocked = new Set<string>();
      for (let pass = 0; pass < 2; pass += 1) {
        const outcome = await replay(check, at!);
        if (outcome === 'abandoned') { abandoned += 1; cannotRun += 1; note ??= `a call passed the ${limits.perCallMs} ms cap`; break; }
        if (outcome.outcome === 'cannot-run') { cannotRun += 1; note ??= outcome.detail; break; }
        if (outcome.outcome !== 'passed') break;
        passes += 1;
        startErrors ||= outcome.pageErrors.length > 0;
        for (const url of outcome.blocked) startBlocked.add(url);
      }
      if (passes === 2) kept.push({ check, pageErrors: startErrors, blocked: startBlocked });
      if (abandoned >= limits.maxAbandoned) { stopped = 'abandoned'; break; }
    }
    baseline = { considered, kept: kept.length, cannotRun, ...(stopped ? { stopped } : {}), ...(note ? { note } : {}) };
    args.log(`inherited checks: ${kept.length} of ${checks.length} passed twice on the starting page` +
      `${stopped ? ` (stopped: ${stopped})` : ''}, in ${Math.round((now() - started) / 1000)} s`);
  })().catch((error: unknown) => {
    args.log(`inherited checks: the run-start replay failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  return {
    ready,
    async baseline(): Promise<InheritedBaseline> {
      await ready;
      return baseline;
    },
    async compare(options): Promise<InheritedChecksReport> {
      await ready;
      const started = now();
      const listed: ListedCheck[] = [];
      let stillPassing = 0;
      let flaky = 0;
      let abandoned = 0;
      let stopped: ReplayStop | undefined;
      let newPageError: string | undefined;
      const at = kept.length === 0 ? undefined : await origin();
      if (kept.length > 0 && at === undefined) stopped = 'server';
      for (const { check, pageErrors: startLogged, blocked: startBlocked } of at === undefined ? [] : kept) {
        const addsBlocked = (verdict: ReplayVerdict): boolean =>
          verdict.outcome === 'failed' && verdict.blocked.some((url) => !startBlocked.has(url));
        if (options.signal?.aborted || args.signal?.aborted) { stopped = 'aborted'; break; }
        // Room for the check's two calls and the acceptor's own verdict.
        if (options.deadlineAt !== undefined && now() + 2 * limits.perCallMs + limits.verdictReserveMs > options.deadlineAt) { stopped = 'deadline'; break; }
        if (now() - started > limits.acceptanceWallMs) { stopped = 'budget'; break; }
        const first = await replay(check, at!);
        if (first === 'abandoned') {
          abandoned += 1;
          if (abandoned >= limits.maxAbandoned) { stopped = 'abandoned'; break; }
          continue;
        }
        if (first.outcome === 'cannot-run' || addsBlocked(first)) continue;
        if (!startLogged && first.pageErrors.length > 0) newPageError ??= first.pageErrors[0];
        if (first.outcome === 'passed') { stillPassing += 1; continue; }
        const second = await replay(check, at!);
        if (second === 'abandoned') {
          abandoned += 1;
          if (abandoned >= limits.maxAbandoned) { stopped = 'abandoned'; break; }
          continue;
        }
        // Twice failed is listed, by its second cause; a pass is flakiness;
        // a replay that could not run leaves the check unreplayed.
        if (second.outcome === 'passed') flaky += 1;
        else if (second.outcome === 'failed' && !addsBlocked(second)) listed.push({ check, cause: second.cause, detail: second.detail });
      }
      const replayed = stillPassing + flaky + listed.length;
      return {
        baseline, replayed, stillPassing, flaky, notReplayed: kept.length - replayed,
        ...(stopped ? { stopped } : {}), listed, ...(newPageError ? { newPageError } : {}),
      };
    },
  };
}
