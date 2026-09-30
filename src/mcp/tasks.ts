import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import type { CreateTaskOptions, TaskRequestHandlerExtra, TaskStore, ToolTaskHandler } from '@modelcontextprotocol/sdk/experimental/tasks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, Request, RequestId, Result, Task } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { retrievalRegistrationSchema } from '../contracts/retrievalCampaign.js';
import { MAX_CHECKLIST_ITEMS, parseChecklistLines } from '../contracts/acceptanceChecklist.js';
import type { RetrievalCampaignStart } from '../cli/retrievalCampaignHost.js';
import { ProjectHttpError } from '../projects/service.js';
import type { Viewer } from '../auth/store.js';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  RunRejected,
  MAX_GOAL_CHARS,
  cancelRun as cancelOperatorRun,
  onRunFinished,
  onRunOutput,
  runStatus,
  type RunRecordPublic,
  type StartRunInput,
} from './run.js';

/**
 * RUNS ARE MCP TASKS (spec 2025-11-25, SDK experimental).
 *
 * A run takes minutes. A TASK is the protocol's own name for that shape: the
 * tool call answers with a task id, `tasks/get` reports `working` with a
 * status line, `tasks/result` blocks until the terminal result, `tasks/cancel`
 * stops the work. Both start tools ARE tasks; there is no separate "start,
 * then poll" contract and no long-poll — a host that speaks tasks needs no
 * atoma-specific polling logic, and the status tools are plain readers.
 *
 * WHAT A TASK IS HERE. `createTask` calls the very `startRun` /
 * `startProjectRunFromInput` the HTTP routes call, the run is the same record
 * in `run.ts` or the same row in the tenant store, and the result is the same
 * status payload the status tool answers. Cancelling the task cancels the run
 * through the same `cancelRun` / `cancelProjectRun` the cancel tools use.
 *
 * A PROJECT RUN'S TASK IS THE RUN. Its id names the run
 * (`project-run:<projectId>:<projectRunId>`), and `tasks/get`, `tasks/result`
 * and `tasks/cancel` read and cancel it through the tenant store, where the
 * run's truth lives. Nothing about it is held in memory, so the id outlives
 * the session that minted it: a new session, a restart, an evicted or swept
 * session all answer it. It is bound to its authorization context — the
 * principal that started the run, in the organisation of the token — and
 * answers "not found" to anyone else, exactly as for an id that never existed.
 *
 * OPERATOR AND BENCHMARK TASKS LIVE WITH THE SESSION. Their store is in
 * memory and per session: the operator run is a child of this process and
 * dies with it, so a restart forgets the task ids and the runs stay
 * reachable by run id through the status tools and the resources. A task's
 * `ttl` is the run's timeout plus a margin, so a host that comes back late
 * still finds the result.
 *
 * THE SDK'S CANCEL ONLY FLIPS THE STORE. `tasks/cancel` marks the task
 * cancelled and nothing more; the store here intercepts that transition and
 * cancels the run behind it. A cancelled task has no result by the SDK's own
 * rule (results are stored once, never on a terminal task), so its final
 * word is `tasks/get`, and the run's own final status stays readable through
 * the status tool.
 *
 * `taskSupport: 'optional'` is the SPEC'S fallback, not a second contract: a
 * host that does not augment the call gets the SDK's own drive and the
 * terminal result when the run ends — a synchronous run, minutes long, over a
 * stream that keeps alive and replays.
 */

/** Retention margin added to the run budget; the SDK renews the full TTL at terminal. */
export const TASK_RESULT_GRACE_MS = 10 * 60 * 1000;
/** How often `tasks/result` re-checks a working task, and how often the project watcher reads the store. */
export const TASK_POLL_INTERVAL_MS = 2_000;
/** The status line is model output; it is bounded like every tail. */
const STATUS_LINE_CHARS = 200;

/**
 * The SDK's in-memory store with TWO additions: a hook on the transition to
 * `cancelled`, so `tasks/cancel` reaches the run; and the project run tasks,
 * which are not stored here at all but answered by `ProjectRunTasks` from the
 * tenant store. Everything else is the reference behaviour — ids, ttl sweeps,
 * the once-only result. The SDK's ids are 32 hex characters, so they never
 * carry the project prefix and the two kinds cannot collide.
 */
export class SessionTaskStore implements TaskStore {
  private readonly inner = new InMemoryTaskStore();
  private readonly cancelHooks = new Map<string, () => void>();
  private projectRuns: ProjectRunTasks | null = null;

  onCancel(taskId: string, hook: () => void): void {
    this.cancelHooks.set(taskId, hook);
  }

  /** Set by `atoma_run_start`'s registration: a session without it answers no project run task. */
  answerProjectRuns(source: ProjectRunTasks): void {
    this.projectRuns = source;
  }

  createTask(taskParams: CreateTaskOptions, requestId: RequestId, request: Request, sessionId?: string): Promise<Task> {
    return this.inner.createTask(taskParams, requestId, request, sessionId);
  }

  async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    if (isProjectRunTaskId(taskId)) return this.projectRuns?.task(taskId) ?? null;
    return this.inner.getTask(taskId, sessionId);
  }

  async storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result, sessionId?: string): Promise<void> {
    if (isProjectRunTaskId(taskId)) throw new Error(`Task ${taskId} follows its run; its result is the run's status`);
    await this.inner.storeTaskResult(taskId, status, result, sessionId);
    this.cancelHooks.delete(taskId);
  }

  async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    if (isProjectRunTaskId(taskId)) {
      if (!this.projectRuns) throw new Error(`Task with ID ${taskId} not found`);
      return this.projectRuns.result(taskId);
    }
    return this.inner.getTaskResult(taskId, sessionId);
  }

  async updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string, sessionId?: string): Promise<void> {
    if (isProjectRunTaskId(taskId)) {
      if (!this.projectRuns) throw new Error(`Task with ID ${taskId} not found`);
      if (status !== 'cancelled') throw new Error(`Task ${taskId} follows its run; only cancellation reaches it`);
      await this.projectRuns.cancel(taskId);
      return;
    }
    await this.inner.updateTaskStatus(taskId, status, statusMessage, sessionId);
    if (status === 'cancelled') {
      const hook = this.cancelHooks.get(taskId);
      this.cancelHooks.delete(taskId);
      hook?.();
    }
  }

  /** The caller's project run tasks lead the first page; the memory store's pages follow under its own cursor. */
  async listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const page = await this.inner.listTasks(cursor, sessionId);
    if (cursor !== undefined || !this.projectRuns) return page;
    return { ...page, tasks: [...this.projectRuns.list(), ...page.tasks] };
  }

  /** Clears the ttl timers; called when the session's server closes. */
  close(): void {
    this.inner.cleanup();
    this.cancelHooks.clear();
  }
}

/** The capability a server declares to accept task-augmented `tools/call`, and to list and cancel. */
export const TASKS_CAPABILITY = { list: {}, cancel: {}, requests: { tools: { call: {} } } } as const;

type ToolResult = CallToolResult;

function jsonResult(payload: unknown): ToolResult {
  const structured =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? { structuredContent: payload as Record<string, unknown> } : {};
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...structured };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** A status line for `tasks/get`: bounded, and honest that it is model output. */
function statusLine(prefix: string, tail: string): string {
  const line = tail.replace(/\s+/g, ' ').trim().slice(-STATUS_LINE_CHARS);
  return line.length > 0 ? `${prefix} — untrusted model output: ${line}` : prefix;
}

/** Fire-and-forget store updates: a task that vanished (ttl, cancel) must never throw into a listener. */
function quietly(work: () => Promise<unknown>): void {
  void work().catch(() => {});
}

/** How often a caller waiting on a run hears that it is alive. */
export const PROGRESS_HEARTBEAT_MS = 30_000;

/**
 * `notifications/progress` for the caller that asked for them with a
 * `progressToken`. A call WITHOUT task augmentation is one response the
 * client waits minutes for, and the SDK's automatic polling says nothing
 * meanwhile: Claude Code gives up on a server that sends "no response or
 * progress for 300s" while the run it started carries on (production
 * 2026-09-26, every run past five minutes). The heartbeat sends the run's
 * current status line at once and every `everyMs`; it stops with the run,
 * with the session, when the caller cancels the call, and at the first send
 * that fails — the stream is gone.
 *
 * NOT for a task-augmented call: its tools/call is answered at once with the
 * task, the SDK then drops that request's stream, and a later heartbeat has
 * nowhere to go. Such a host follows `tasks/get` / `tasks/result`; carrying
 * progress on the `tasks/result` stream is not built.
 */
export function requestHeartbeat(
  extra: {
    readonly _meta?: { readonly progressToken?: string | number };
    readonly taskRequestedTtl?: number | null;
    readonly signal?: AbortSignal;
    readonly sendNotification: (notification: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
  },
  everyMs: number
): { readonly note: (message: string) => void; readonly stop: () => void; readonly alive: () => boolean } {
  const token = extra._meta?.progressToken;
  if (token === undefined || extra.taskRequestedTtl !== undefined) return { note: () => {}, stop: () => {}, alive: () => false };
  let alive = true;
  let progress = 0;
  let message = '';
  let sentAt = -Infinity;
  const send = (): void => {
    if (!alive) return;
    progress += 1;
    sentAt = Date.now();
    void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, ...(message ? { message } : {}) } })
      .catch(() => { stop(); });
  };
  const timer = setInterval(send, everyMs);
  timer.unref();
  const stop = (): void => {
    alive = false;
    clearInterval(timer);
    extra.signal?.removeEventListener('abort', stop);
  };
  // A cancelled call's sends return silently rather than fail, so the
  // failure path alone would keep this timer until the run ended.
  extra.signal?.addEventListener('abort', stop, { once: true });
  // A new status line goes out at once, but never more than one per
  // `HEARTBEAT_MIN_GAP_MS`: an operator run changes its line on every chunk.
  const note = (next: string): void => {
    if (next === message) return;
    message = next;
    if (Date.now() - sentAt >= Math.min(everyMs, HEARTBEAT_MIN_GAP_MS)) send();
  };
  return { note, stop, alive: () => alive };
}

const HEARTBEAT_MIN_GAP_MS = 5_000;

/**
 * Shared skeleton: `getTask` and `getTaskResult` read the store, and every
 * handler's `createTask` is the start followed by a lifecycle watcher. A
 * domain refusal becomes a task that is created and fails at once with an
 * `isError` result, so a host drives one path.
 */
function handlerWith<Args extends z.ZodRawShape>(createTask: ToolTaskHandler<Args>['createTask']): ToolTaskHandler<Args> {
  const getTask = async (_args: unknown, extra: TaskRequestHandlerExtra) => ({ ...(await extra.taskStore.getTask(extra.taskId)) });
  const getTaskResult = async (_args: unknown, extra: TaskRequestHandlerExtra) => (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult;
  return { createTask, getTask, getTaskResult } as ToolTaskHandler<Args>;
}

export interface RunTaskHost {
  readonly store: SessionTaskStore;
  /** Told when a run started here should be followed by the session's logging. */
  readonly follow: (runId: string) => void;
  /** Registered cleanups run when the session's server closes. */
  readonly cleanups: (() => void)[];
}

export const BENCHMARK_RUN_INPUT = { registration: retrievalRegistrationSchema };

/** Registered campaigns use the same task/cancellation protocol as runs. */
export function benchmarkRunTaskHandler(host: RunTaskHost, start: RetrievalCampaignStart): ToolTaskHandler<typeof BENCHMARK_RUN_INPUT> {
  return handlerWith<typeof BENCHMARK_RUN_INPUT>(async (args, extra) => {
    const task = await extra.taskStore.createTask({
      ttl: args.registration.spec.maxWallMs + TASK_RESULT_GRACE_MS, pollInterval: TASK_POLL_INTERVAL_MS,
    });
    const abort = new AbortController();
    host.store.onCancel(task.taskId, () => abort.abort());
    await extra.taskStore.updateTaskStatus(task.taskId, 'working', `campaign ${args.registration.spec.id} validating`);
    // A disconnected session stops observing; it does not cancel the campaign.
    let observing = true;
    host.cleanups.push(() => { observing = false; });
    const progress = (message: string) => {
      if (observing) quietly(() => extra.taskStore.updateTaskStatus(task.taskId, 'working', message));
    };
    void Promise.resolve().then(() => start(args.registration, abort.signal, progress)).then(
      report => { if (observing) quietly(() => extra.taskStore.storeTaskResult(task.taskId,
        report.reason === 'completed' ? 'completed' : 'failed', jsonResult(report))); },
      error => { if (observing) quietly(() => extra.taskStore.storeTaskResult(task.taskId, 'failed',
        errorResult(`campaign refused or aborted: ${String(error).slice(0, 1000)}`))); }
    );
    return { task: await extra.taskStore.getTask(task.taskId) };
  });
}

/* -------------------------------------------------------------- operator */

/** The start tools' arguments, defined once here and imported by the catalogue. */
export const OPERATOR_RUN_INPUT = {
  goal: z.string().min(1).max(MAX_GOAL_CHARS),
  family: z.string().optional(),
  timeoutMs: z.number().int().positive().optional().describe(`Default ${DEFAULT_RUN_TIMEOUT_MS}.`),
  keepWorkspace: z.boolean().optional(),
  learnSkills: z.boolean().optional(),
  promoteSkills: z.boolean().optional(),
  directSkills: z.boolean().optional(),
  container: z.boolean().optional(),
  egress: z.boolean().optional(),
};

export const PROJECT_RUN_INPUT = {
  projectId: z.string().min(1),
  goal: z.string().min(1).max(MAX_GOAL_CHARS).optional().describe('Required for a new run; omitted for a rerun, which re-asks its origin’s goal.'),
  idempotencyKey: z.string().min(1).max(200).optional().describe('Idempotency key; the same key returns the same run.'),
  acceptanceCriteria: z.array(z.string().min(1).max(400)).min(1).max(MAX_CHECKLIST_ITEMS).optional().describe(
    'Acceptance criteria you approve for this run, one per entry. "GET /api/notes/:id 404 — unknown id is refused" is an HTTP criterion (status optional, any 2xx without one); any other text is judged by review. The run is checked against exactly these; one malformed entry refuses the call.'
  ),
  rerunOf: z.string().min(1).optional().describe(
    'A COMPARISON RERUN of this delivered or partial run of the same project: same goal, same acceptance list, same starting workspace, on the models you pass. It is never published and never seeds a later run.'
  ),
  models: z.object({ l1: z.string().min(1), l2: z.string().min(1), l3: z.string().min(1) }).optional().describe(
    'With rerunOf, required: the full model selector for each tier (<api|sub|own>:<vendor>:<model>).'
  ),
  depth: z.enum(['short', 'deep']).optional().describe(
    'Supervision depth. short (default): an L2 cell plans and the run deepens once if it stalls. deep: an L3 tissue decomposes the goal from the start — for goals spanning several parts (API, pages, docs). On a rerun, absent keeps the origin\'s.'
  ),
};

/**
 * `atoma_operator_run_start`: the watcher turns each output chunk into the
 * task's status line and the run's end into the task's result — the
 * `atoma_operator_run_status` payload.
 */
export function operatorRunTaskHandler(
  host: RunTaskHost,
  start: (args: StartRunInput) => Promise<RunRecordPublic>,
  heartbeatMs: number = PROGRESS_HEARTBEAT_MS
): ToolTaskHandler<typeof OPERATOR_RUN_INPUT> {
  return handlerWith<typeof OPERATOR_RUN_INPUT>(async (args, extra) => {
    const timeoutMs = args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const task = await extra.taskStore.createTask({ ttl: timeoutMs + TASK_RESULT_GRACE_MS, pollInterval: TASK_POLL_INTERVAL_MS });
    let record: RunRecordPublic;
    try {
      record = await start(args);
    } catch (error) {
      if (error instanceof RunRejected) {
        await extra.taskStore.storeTaskResult(task.taskId, 'failed', errorResult(`refused: ${error.message}`));
        return { task: await extra.taskStore.getTask(task.taskId) };
      }
      throw error;
    }
    host.follow(record.runId);
    host.store.onCancel(task.taskId, () => void cancelOperatorRun({ runId: record.runId }));
    const heartbeat = requestHeartbeat(extra, heartbeatMs);
    const unhookOutput = onRunOutput((update) => {
      if (update.runId !== record.runId) return;
      // The chunk count only: the tail is model output, and a progress line is not the place for it.
      heartbeat.note(`run ${record.runId} running, ${update.chunks} chunks`);
      quietly(() => extra.taskStore.updateTaskStatus(task.taskId, 'working', statusLine(`run ${record.runId} running, ${update.chunks} chunks`, update.tail)));
    });
    const unhookFinish = onRunFinished((finished) => {
      if (finished.runId !== record.runId) return;
      unhookOutput();
      unhookFinish();
      heartbeat.stop();
      const status = finished.status === 'finished' ? 'completed' : 'failed';
      quietly(() => extra.taskStore.storeTaskResult(task.taskId, status, jsonResult(runStatus({ runId: record.runId }))));
    });
    host.cleanups.push(unhookOutput, unhookFinish, heartbeat.stop);
    heartbeat.note(`run ${record.runId} started (${record.family})`);
    await extra.taskStore.updateTaskStatus(task.taskId, 'working', `run ${record.runId} started (${record.family})`);
    return { task: await extra.taskStore.getTask(task.taskId) };
  });
}

/* --------------------------------------------------------------- project */

export interface ProjectRunTaskDeps {
  readonly viewer: () => Viewer;
  readonly service: {
    runTaskBudgetMs(): number;
    startProjectRunFromInput(viewer: Viewer, projectId: string, body: unknown): Promise<unknown>;
    projectRunStatus(viewer: Viewer, projectId: string, projectRunId: string): unknown;
    cancelProjectRun(viewer: Viewer, projectId: string, projectRunId: string): Promise<unknown>;
    runsRequestedBy(viewer: Viewer, endedSince: string, limit: number): unknown[];
  };
  /** Injectable clock for the poller; production uses `setTimeout`. */
  readonly pollMs?: number;
  /** How often a waiting caller that sent a progressToken hears from the run. */
  readonly heartbeatMs?: number;
}

const PROJECT_TERMINAL = new Set(['delivered', 'partial', 'failed', 'cancelled']);

/**
 * Which terminal statuses are a task COMPLETION rather than a failure.
 * `'partial'` is a completion: the run ran to its budget and produced a real
 * deliverable, just not a complete one, and the status travels in the payload
 * where the caller reads it. Reporting it as `failed` would tell an MCP client
 * to discard exactly the work the landing preserved.
 */
const PROJECT_COMPLETED = new Set(['delivered', 'partial']);

const PROJECT_TASK_PREFIX = 'project-run:';

/** A project run's task id: it names the run, so any session of the same caller can answer it. */
export function projectRunTaskId(projectId: string, projectRunId: string): string {
  return `${PROJECT_TASK_PREFIX}${projectId}:${projectRunId}`;
}

function isProjectRunTaskId(taskId: string): boolean {
  return taskId.startsWith(PROJECT_TASK_PREFIX);
}

/** Both halves are UUIDs, which hold no colon; anything else is not a task this host minted. */
function parseProjectRunTaskId(taskId: string): { projectId: string; projectRunId: string } | null {
  if (!isProjectRunTaskId(taskId)) return null;
  const parts = taskId.slice(PROJECT_TASK_PREFIX.length).split(':');
  return parts.length === 2 && parts[0] && parts[1] ? { projectId: parts[0], projectRunId: parts[1] } : null;
}

interface ProjectRunSnapshot {
  readonly projectId?: unknown;
  readonly projectRunId?: unknown;
  readonly status: string;
  readonly orgId?: unknown;
  readonly requestedByPrincipalId?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly endedAt?: unknown;
}

/**
 * Project run tasks cancelled through `tasks/cancel`, process-wide: the spec
 * wants the task `cancelled` BEFORE the answer and for good, while the run
 * only lands `cancelled` once its abort is through — or lands otherwise, if
 * the abort came too late. Read only after the binding check, bounded, and
 * forgotten by a restart, after which the run's own final status speaks.
 */
const CANCEL_REQUESTED = new Set<string>();
const MAX_CANCEL_REQUESTED = 1_000;

/** How many project run tasks one `tasks/list` names; runs are serialised per instance, so a principal has few live ones. */
const MAX_LISTED_PROJECT_TASKS = 50;

/**
 * The project run tasks, answered from the tenant store on every read. A task
 * is found only when the run is readable by this session's viewer AND was
 * started by that principal in that organisation: the spec binds a task to
 * the authorization context that created it, and every other caller — an org
 * member reading the run through `atoma_run_status`, a platform admin reading
 * across organisations — gets the "not found" an unknown id gets. A missing
 * binding field fails closed. Like the SDK's store, a finished task is kept
 * one `ttl` after it ends and then answers "not found"; `tasks/list` names
 * exactly the tasks `tasks/get` answers.
 */
export class ProjectRunTasks {
  constructor(private readonly deps: ProjectRunTaskDeps) {}

  private viewer(): Viewer | null {
    try {
      return this.deps.viewer();
    } catch {
      return null;
    }
  }

  private ttl(): number {
    return this.deps.service.runTaskBudgetMs() + TASK_RESULT_GRACE_MS;
  }

  /** Still running, or ended within one `ttl`: the one retention rule, for a read and for the listing. */
  private retained(snapshot: ProjectRunSnapshot): boolean {
    if (!PROJECT_TERMINAL.has(snapshot.status)) return true;
    const ended = typeof snapshot.endedAt === 'string' ? snapshot.endedAt : snapshot.updatedAt;
    return typeof ended === 'string' && Date.parse(ended) + this.ttl() >= Date.now();
  }

  private bound(viewer: Viewer, snapshot: ProjectRunSnapshot): boolean {
    return snapshot.orgId === viewer.orgId && snapshot.requestedByPrincipalId === viewer.principalId && this.retained(snapshot);
  }

  /** The run behind a task id, or null for an id this caller may not follow. */
  read(taskId: string): { readonly ref: { projectId: string; projectRunId: string }; readonly viewer: Viewer; readonly snapshot: ProjectRunSnapshot } | null {
    const ref = parseProjectRunTaskId(taskId);
    const viewer = this.viewer();
    if (!ref || !viewer) return null;
    let snapshot: ProjectRunSnapshot;
    try {
      snapshot = this.deps.service.projectRunStatus(viewer, ref.projectId, ref.projectRunId) as ProjectRunSnapshot;
    } catch (error) {
      if (error instanceof ProjectHttpError) return null;
      throw error;
    }
    return this.bound(viewer, snapshot) ? { ref, viewer, snapshot } : null;
  }

  private asTask(taskId: string, projectRunId: string, snapshot: ProjectRunSnapshot): Task {
    const now = new Date().toISOString();
    const cancelled = CANCEL_REQUESTED.has(taskId) || snapshot.status === 'cancelled';
    return {
      taskId,
      status: cancelled ? 'cancelled'
        : !PROJECT_TERMINAL.has(snapshot.status) ? 'working'
        : PROJECT_COMPLETED.has(snapshot.status) ? 'completed' : 'failed',
      statusMessage: cancelled && !PROJECT_TERMINAL.has(snapshot.status)
        ? `run ${projectRunId} cancellation requested, ${snapshot.status}`
        : `run ${projectRunId} ${snapshot.status}`,
      createdAt: typeof snapshot.createdAt === 'string' ? snapshot.createdAt : now,
      lastUpdatedAt: typeof snapshot.updatedAt === 'string' ? snapshot.updatedAt : now,
      ttl: this.ttl(),
      pollInterval: this.deps.pollMs ?? TASK_POLL_INTERVAL_MS,
    };
  }

  task(taskId: string): Task | null {
    const found = this.read(taskId);
    return found ? this.asTask(taskId, found.ref.projectRunId, found.snapshot) : null;
  }

  /**
   * The caller's tasks, newest first: the runs it started in its
   * organisation, by the same binding and retention as a read.
   */
  list(): Task[] {
    const viewer = this.viewer();
    if (!viewer) return [];
    const endedSince = new Date(Date.now() - this.ttl()).toISOString();
    return (this.deps.service.runsRequestedBy(viewer, endedSince, MAX_LISTED_PROJECT_TASKS) as ProjectRunSnapshot[])
      .flatMap((snapshot) => typeof snapshot.projectId === 'string' && typeof snapshot.projectRunId === 'string' && this.bound(viewer, snapshot)
        ? [this.asTask(projectRunTaskId(snapshot.projectId, snapshot.projectRunId), snapshot.projectRunId, snapshot)]
        : []);
  }

  /**
   * The `atoma_run_status` payload once the task is terminal — a cancelled
   * task's included, whose run may still be winding down; before that, the
   * in-memory store's refusal.
   */
  result(taskId: string): CallToolResult {
    const found = this.read(taskId);
    if (!found) throw new Error(`Task with ID ${taskId} not found`);
    if (this.asTask(taskId, found.ref.projectRunId, found.snapshot).status === 'working') throw new Error(`Task ${taskId} has no result stored`);
    return jsonResult(found.snapshot);
  }

  /** `tasks/cancel`: the cancel tool's body, and its refusal in its words; the task is `cancelled` from then on. */
  async cancel(taskId: string): Promise<void> {
    const found = this.read(taskId);
    if (!found) throw new Error(`Task with ID ${taskId} not found`);
    try {
      await this.deps.service.cancelProjectRun(found.viewer, found.ref.projectId, found.ref.projectRunId);
    } catch (error) {
      if (error instanceof ProjectHttpError) throw new Error(`refused (${error.status}): ${error.message}`);
      throw error;
    }
    CANCEL_REQUESTED.add(taskId);
    if (CANCEL_REQUESTED.size > MAX_CANCEL_REQUESTED) CANCEL_REQUESTED.delete(CANCEL_REQUESTED.values().next().value!);
  }
}

/**
 * `atoma_run_start`: the start, then a task that IS the run
 * (`ProjectRunTasks`). A refusal before any run exists — a criterion that
 * does not parse, a service refusal — is an ordinary in-memory task that
 * fails at once. The one thing this handler keeps is the progress heartbeat
 * of a caller waiting without augmentation: it reads the run once every
 * `pollInterval` while that heartbeat lives, and never otherwise.
 */
export function projectRunTaskHandler(host: RunTaskHost, deps: ProjectRunTaskDeps): ToolTaskHandler<typeof PROJECT_RUN_INPUT> {
  const pollMs = deps.pollMs ?? TASK_POLL_INTERVAL_MS;
  const runs = new ProjectRunTasks(deps);
  host.store.answerProjectRuns(runs);
  return handlerWith<typeof PROJECT_RUN_INPUT>(async (args, extra) => {
    const refuse = async (message: string) => {
      const task = await extra.taskStore.createTask({ ttl: deps.service.runTaskBudgetMs() + TASK_RESULT_GRACE_MS, pollInterval: pollMs });
      await extra.taskStore.storeTaskResult(task.taskId, 'failed', errorResult(message));
      return { task: await extra.taskStore.getTask(task.taskId) };
    };
    const viewer = deps.viewer();
    let started: { projectRunId: string; status: string };
    // The same line grammar as the console and the CLI: one parser, and a
    // criterion that does not parse refuses the call rather than vanishing.
    const parsed = args.acceptanceCriteria?.map((entry) => parseChecklistLines(entry));
    const invalid = (parsed ?? []).flatMap((entry, index) => entry.errors.length > 0 || entry.items.length !== 1
      ? [`entry ${index + 1}: ${entry.errors[0]?.message ?? 'must hold exactly one criterion'}`] : []);
    if (invalid.length > 0) return refuse(`refused (400): invalid acceptance criteria — ${invalid.join('; ')}`);
    const criteria = parsed ? { items: parsed.flatMap((entry) => entry.items) } : null;
    try {
      // Forwarded as given: the service's one schema decides which combination
      // is a run and which a rerun, and refuses every other one with 400.
      started = (await deps.service.startProjectRunFromInput(viewer, args.projectId, {
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        idempotencyKey: args.idempotencyKey ?? `mcp-task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        ...(criteria ? { acceptanceChecklist: criteria.items } : {}),
        ...(args.rerunOf !== undefined ? { rerunOf: args.rerunOf } : {}),
        ...(args.models !== undefined ? { models: args.models } : {}),
        ...(args.depth !== undefined ? { depth: args.depth } : {}),
      })) as { projectRunId: string; status: string };
    } catch (error) {
      if (error instanceof ProjectHttpError) return refuse(`refused (${error.status}): ${error.message}`);
      throw error;
    }
    const runId = started.projectRunId;
    const taskId = projectRunTaskId(args.projectId, runId);
    const task = runs.task(taskId);
    // The run this viewer just started is readable by it; were it not, the task could never be followed.
    if (!task) return refuse(`run ${runId} started but is not readable by this caller`);
    const heartbeat = requestHeartbeat(extra, deps.heartbeatMs ?? PROGRESS_HEARTBEAT_MS);
    let timer: NodeJS.Timeout | null = null;
    const stop = (): void => {
      heartbeat.stop();
      if (timer) clearTimeout(timer);
    };
    host.cleanups.push(stop);
    const tick = (): void => {
      const current = heartbeat.alive() ? runs.task(taskId) : null;
      if (!current || current.status !== 'working') return stop();
      heartbeat.note(current.statusMessage ?? `run ${runId}`);
      timer = setTimeout(tick, pollMs);
      timer.unref();
    };
    heartbeat.note(task.statusMessage ?? `run ${runId}`);
    if (heartbeat.alive()) {
      timer = setTimeout(tick, pollMs);
      timer.unref();
    }
    return { task };
  });
}

/* --------------------------------------------------------------- logging */

/**
 * `notifications/message` for the runs a session started. The session's
 * client sets the level it wants (`logging/setLevel`) and the SDK filters by
 * it; without a level, everything at `info` and above goes out. Each chunk is
 * one message under the logger `atoma.run.<runId>`, and the run's end is one
 * `notice`. Only runs THIS session started are followed: a session that never
 * started a run hears nothing about the machine's other runs.
 */
export function attachRunLogging(server: McpServer, cleanups: (() => void)[]): (runId: string) => void {
  const followed = new Set<string>();
  const sessionId = (): string | undefined => server.server.transport?.sessionId;
  cleanups.push(
    onRunOutput((update) => {
      if (!followed.has(update.runId)) return;
      void server
        .sendLoggingMessage(
          { level: 'info', logger: `atoma.run.${update.runId}`, data: { runId: update.runId, chunk: update.chunk, chunks: update.chunks, untrusted: true } },
          sessionId()
        )
        .catch(() => {});
    }),
    onRunFinished((record) => {
      if (!followed.delete(record.runId)) return;
      void server
        .sendLoggingMessage(
          { level: 'notice', logger: `atoma.run.${record.runId}`, data: { runId: record.runId, status: record.status, ...(record.trace ? { trace: record.trace } : {}) } },
          sessionId()
        )
        .catch(() => {});
    })
  );
  return (runId) => followed.add(runId);
}
