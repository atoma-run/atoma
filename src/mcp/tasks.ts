import { randomBytes } from 'node:crypto';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
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
 * RUNS ARE MCP TASKS, in both protocol eras.
 *
 * A run takes minutes. A TASK is the protocol's own name for that shape: the
 * tool call answers with a task id, `tasks/get` reports `working` with a
 * status line, and the terminal state carries the result — the status tool's
 * payload. The three start tools ARE tasks; there is no separate "start, then
 * poll" contract and no long-poll, and the status tools are plain readers.
 *
 * TWO WIRES, ONE MODEL. The 2025-11-25 era carries tasks in the core protocol
 * (`task` on `tools/call`, `tasks/get|result|cancel|list`, `ttl`,
 * `pollInterval`); the 2026-07-28 era moved them to the
 * `io.modelcontextprotocol/tasks` extension (`resultType: 'task'`, `tasks/get`
 * with the result inline, `tasks/cancel`, `ttlMs`, `pollIntervalMs`, no
 * `tasks/result` and no `tasks/list`). The SDK v2 implements neither
 * (`registerToolTask` and its stores were removed), so the model is here —
 * `TaskState`, `CallerTasks` — and `taskWire.ts` speaks it on each wire.
 *
 * WHAT A TASK IS HERE. A start calls the very `startRun` /
 * `startProjectRunFromInput` the HTTP routes call; the run is the same record
 * in `run.ts` or the same row in the tenant store; the result is the status
 * tool's payload; cancelling calls the cancel tools' bodies.
 *
 * A PROJECT RUN'S TASK IS THE RUN. Its id names the run
 * (`project-run:<projectId>:<projectRunId>`), and every read goes to the
 * tenant store, where the run's truth lives. Nothing about it is held in
 * memory, so it answers in any session and after a restart. It is bound to
 * the authorization context that started it — that principal, in the
 * organisation of the token — and answers "not found" to anyone else, as an
 * unknown id does.
 *
 * OPERATOR AND BENCHMARK TASKS, and refusals, live in this process's memory
 * (`MEMORY_TASKS`), bound to the caller that created them: the operator run is
 * a child of this process and dies with it, so a restart forgets those ids and
 * the runs stay reachable through the status tools and the resources. The
 * 2026 era has no session to hang them on, so they belong to the caller, not
 * to a session.
 *
 * WITHOUT TASK AUGMENTATION the start is a synchronous call: it answers with
 * the terminal result when the run ends, and a caller that sent a
 * `progressToken` hears the run's status line at once and every 30s.
 */

/** Retention margin added to the run budget; a finished task is kept one ttl after it ends. */
export const TASK_RESULT_GRACE_MS = 10 * 60 * 1000;
/** The poll interval a task suggests, and how often a synchronous start re-reads its task. */
export const TASK_POLL_INTERVAL_MS = 2_000;
/** The status line is model output; it is bounded like every tail. */
const STATUS_LINE_CHARS = 200;

export function jsonResult(payload: unknown): CallToolResult {
  const structured =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? { structuredContent: payload as Record<string, unknown> } : {};
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...structured };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** A status line for `tasks/get`: bounded, and honest that it is model output. */
function statusLine(prefix: string, tail: string): string {
  const line = tail.replace(/\s+/g, ' ').trim().slice(-STATUS_LINE_CHARS);
  return line.length > 0 ? `${prefix} — untrusted model output: ${line}` : prefix;
}

/* ----------------------------------------------------------------- model */

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/**
 * One task, era-neutral. `ttl` and `pollInterval` are milliseconds; the 2026
 * wire renames them `ttlMs` / `pollIntervalMs`. `progress` is the status line
 * WITHOUT model output, for the progress heartbeat.
 */
export interface TaskState {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttl: number | null;
  readonly pollInterval: number;
  readonly progress?: string;
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Not found, for an id that never existed and for one this caller may not follow alike. */
export class TaskNotFound extends Error {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
  }
}

/** A cancellation the task cannot take: terminal already, or refused by the run's own cancel. */
export class TaskCancelRefused extends Error {}

interface MemoryTask {
  state: TaskState;
  readonly owner: string;
  result?: CallToolResult;
  /** The result of a task cancelled before it stored one: the run's status now. */
  resultNow?: () => CallToolResult;
  onCancel?: () => void;
  sweep?: NodeJS.Timeout;
}

/**
 * How many tasks one caller keeps in memory; past it that caller's oldest
 * finished one goes first, never another caller's (review 2026-09-30, 4). The
 * process-wide backstop does the same across callers.
 */
const MAX_MEMORY_TASKS_PER_OWNER = 1_000;
const MAX_MEMORY_TASKS = 50_000;

/**
 * The in-memory tasks: ids are 32 hex characters (never the project prefix),
 * each bound to its owner (`callerKey`), swept one `ttl` after it ends — the
 * SDK v1 store's rule, which renewed the ttl at the terminal transition.
 */
export class MemoryTasks {
  private readonly tasks = new Map<string, MemoryTask>();

  create(owner: string, options: { readonly ttl: number; readonly pollInterval: number; readonly statusMessage?: string }): TaskState {
    const taskId = randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    const entry: MemoryTask = {
      owner,
      state: {
        taskId, status: 'working', createdAt: now, lastUpdatedAt: now, ttl: options.ttl, pollInterval: options.pollInterval,
        ...(options.statusMessage ? { statusMessage: options.statusMessage, progress: options.statusMessage } : {}),
      },
    };
    this.tasks.set(taskId, entry);
    this.sweepAfter(entry, options.ttl);
    this.bound(owner);
    return entry.state;
  }

  private sweepAfter(entry: MemoryTask, ms: number): void {
    if (entry.sweep) clearTimeout(entry.sweep);
    entry.sweep = setTimeout(() => this.tasks.delete(entry.state.taskId), ms);
    entry.sweep.unref();
  }

  private bound(owner: string): void {
    let mine = 0;
    for (const entry of this.tasks.values()) if (entry.owner === owner) mine += 1;
    for (const [taskId, entry] of this.tasks) {
      if (mine <= MAX_MEMORY_TASKS_PER_OWNER && this.tasks.size <= MAX_MEMORY_TASKS) return;
      const over = mine > MAX_MEMORY_TASKS_PER_OWNER ? entry.owner === owner : true;
      if (!over || !isTerminal(entry.state.status)) continue;
      if (entry.sweep) clearTimeout(entry.sweep);
      this.tasks.delete(taskId);
      if (entry.owner === owner) mine -= 1;
    }
  }

  private entry(owner: string, taskId: string): MemoryTask | null {
    const entry = this.tasks.get(taskId);
    return entry && entry.owner === owner ? entry : null;
  }

  get(owner: string, taskId: string): TaskState | null {
    return this.entry(owner, taskId)?.state ?? null;
  }

  /** A working task's new status line; ignored once the task is terminal. */
  update(taskId: string, statusMessage: string, progress?: string): void {
    const entry = this.tasks.get(taskId);
    if (!entry || isTerminal(entry.state.status)) return;
    entry.state = { ...entry.state, statusMessage, progress: progress ?? statusMessage, lastUpdatedAt: new Date().toISOString() };
  }

  /** The once-only result. A cancelled task keeps its status and takes the result as its last word. */
  finish(taskId: string, status: 'completed' | 'failed', result: CallToolResult): void {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.result) return;
    entry.result = result;
    if (entry.state.status === 'cancelled') return;
    entry.state = { ...entry.state, status, lastUpdatedAt: new Date().toISOString() };
    if (entry.state.ttl !== null) this.sweepAfter(entry, entry.state.ttl);
  }

  onCancel(taskId: string, hook: () => void, resultNow?: () => CallToolResult): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    entry.onCancel = hook;
    if (resultNow) entry.resultNow = resultNow;
  }

  cancel(owner: string, taskId: string): TaskState {
    const entry = this.entry(owner, taskId);
    if (!entry) throw new TaskNotFound(taskId);
    if (isTerminal(entry.state.status)) throw new TaskCancelRefused(`Cannot cancel task in terminal status: ${entry.state.status}`);
    entry.state = { ...entry.state, status: 'cancelled', statusMessage: 'Client cancelled task execution.', lastUpdatedAt: new Date().toISOString() };
    if (entry.state.ttl !== null) this.sweepAfter(entry, entry.state.ttl);
    const hook = entry.onCancel;
    entry.onCancel = undefined;
    hook?.();
    return entry.state;
  }

  /** The final result, or null while the task is working. */
  result(owner: string, taskId: string): CallToolResult | null {
    const entry = this.entry(owner, taskId);
    if (!entry) throw new TaskNotFound(taskId);
    if (!isTerminal(entry.state.status)) return null;
    return entry.result ?? entry.resultNow?.() ?? errorResult('the task was cancelled before it produced a result');
  }

  list(owner: string): TaskState[] {
    return [...this.tasks.values()].filter((entry) => entry.owner === owner).map((entry) => entry.state).reverse();
  }

  forgetAll(): void {
    for (const entry of this.tasks.values()) if (entry.sweep) clearTimeout(entry.sweep);
    this.tasks.clear();
  }
}

export const MEMORY_TASKS = new MemoryTasks();

/** Tests only: a fresh process's task memory. */
export function forgetTasksForTest(): void {
  MEMORY_TASKS.forgetAll();
  CANCEL_REQUESTED.clear();
}

/* ------------------------------------------------------------- heartbeat */

/** How often a caller waiting on a run hears that it is alive. */
export const PROGRESS_HEARTBEAT_MS = 30_000;
const HEARTBEAT_MIN_GAP_MS = 5_000;

/** Where a call's progress goes: its token, its abort signal, its own stream. */
export interface ProgressChannel {
  readonly progressToken?: string | number;
  readonly signal?: AbortSignal;
  readonly notify: (notification: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
}

/** The progress channel of one v2 request, in either era. */
export function progressChannelOf(ctx: ServerContext): ProgressChannel {
  const token = (ctx.mcpReq._meta as { progressToken?: string | number } | undefined)?.progressToken;
  return {
    ...(token !== undefined ? { progressToken: token } : {}),
    signal: ctx.mcpReq.signal,
    notify: (notification) => ctx.mcpReq.notify(notification),
  };
}

/**
 * `notifications/progress` for the caller that asked for them with a
 * `progressToken`. A synchronous start is one response the client waits
 * minutes for: Claude Code gives up on a server that sends "no response or
 * progress for 300s" while the run it started carries on (production
 * 2026-09-26, every run past five minutes). The heartbeat sends the run's
 * current status line at once and every `everyMs`; it stops with the run, when
 * the caller cancels the call, and at the first send that fails — the stream
 * is gone. No token, no notification.
 */
export function requestHeartbeat(
  channel: ProgressChannel,
  everyMs: number
): { readonly note: (message: string) => void; readonly stop: () => void; readonly alive: () => boolean } {
  const token = channel.progressToken;
  if (token === undefined) return { note: () => {}, stop: () => {}, alive: () => false };
  let alive = true;
  let progress = 0;
  let message = '';
  let sentAt = -Infinity;
  const send = (): void => {
    if (!alive) return;
    progress += 1;
    sentAt = Date.now();
    void channel.notify({ method: 'notifications/progress', params: { progressToken: token, progress, ...(message ? { message } : {}) } })
      .catch(() => { stop(); });
  };
  const timer = setInterval(send, everyMs);
  timer.unref();
  const stop = (): void => {
    alive = false;
    clearInterval(timer);
    channel.signal?.removeEventListener('abort', stop);
  };
  // A cancelled call's sends return silently rather than fail, so the
  // failure path alone would keep this timer until the run ended.
  channel.signal?.addEventListener('abort', stop, { once: true });
  // A new status line goes out at once, but never more than one per
  // `HEARTBEAT_MIN_GAP_MS`: an operator run changes its line on every chunk.
  const note = (next: string): void => {
    if (next === message) return;
    message = next;
    if (Date.now() - sentAt >= Math.min(everyMs, HEARTBEAT_MIN_GAP_MS)) send();
  };
  return { note, stop, alive: () => alive };
}

/* ---------------------------------------------------------------- inputs */

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
    'Supervision depth. deep (default): choose an L3 tissue from the task and starting repository, then decompose the goal. short: an L2 cell plans and the run selects an L3 once if it stalls. On a rerun, absent keeps the origin\'s.'
  ),
};

export const BENCHMARK_RUN_INPUT = { registration: retrievalRegistrationSchema };

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
  /** The poll interval a project task suggests; tests shorten it. */
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

export function isProjectRunTaskId(taskId: string): boolean {
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
 * Project run tasks cancelled through `tasks/cancel`, process-wide: the 2025
 * spec wants the task `cancelled` BEFORE the answer and for good, while the run
 * only lands `cancelled` once its abort is through — or lands otherwise, if
 * the abort came too late. Read only after the binding check, bounded, and
 * forgotten by a restart, after which the run's own final status speaks.
 */
const CANCEL_REQUESTED = new Set<string>();
/** Bounded memory, so "for good" means for the last this-many cancels; a run landing after that shows its own status. */
const MAX_CANCEL_REQUESTED = 10_000;

/** How many project run tasks one listing names; runs are serialised per instance, so a principal has few live ones. */
const MAX_LISTED_PROJECT_TASKS = 50;

/**
 * The project run tasks, answered from the tenant store on every read. A task
 * is found only when the run is readable by this caller's viewer AND was
 * started by that principal in that organisation: the spec binds a task to
 * the authorization context that created it, and every other caller — an org
 * member reading the run through `atoma_run_status`, a platform admin reading
 * across organisations — gets the "not found" an unknown id gets. A missing
 * binding field fails closed. Like the SDK's old store, a finished task is
 * kept one `ttl` after it ends and then answers "not found"; the listing names
 * exactly the tasks a read answers.
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

  ttl(): number {
    return this.deps.service.runTaskBudgetMs() + TASK_RESULT_GRACE_MS;
  }

  pollInterval(): number {
    return this.deps.pollMs ?? TASK_POLL_INTERVAL_MS;
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

  private asTask(taskId: string, projectRunId: string, snapshot: ProjectRunSnapshot): TaskState {
    const now = new Date().toISOString();
    const cancelled = CANCEL_REQUESTED.has(taskId) || snapshot.status === 'cancelled';
    const line = cancelled && !PROJECT_TERMINAL.has(snapshot.status)
      ? `run ${projectRunId} cancellation requested, ${snapshot.status}`
      : `run ${projectRunId} ${snapshot.status}`;
    return {
      taskId,
      status: cancelled ? 'cancelled'
        : !PROJECT_TERMINAL.has(snapshot.status) ? 'working'
        : PROJECT_COMPLETED.has(snapshot.status) ? 'completed' : 'failed',
      statusMessage: line,
      progress: line,
      createdAt: typeof snapshot.createdAt === 'string' ? snapshot.createdAt : now,
      lastUpdatedAt: typeof snapshot.updatedAt === 'string' ? snapshot.updatedAt : now,
      ttl: this.ttl(),
      pollInterval: this.pollInterval(),
    };
  }

  task(taskId: string): TaskState | null {
    const found = this.read(taskId);
    return found ? this.asTask(taskId, found.ref.projectRunId, found.snapshot) : null;
  }

  /** The caller's tasks, newest first: the runs it started in its organisation, by the same binding and retention as a read. */
  list(): TaskState[] {
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
   * task's included, whose run may still be winding down; null before that.
   */
  result(taskId: string): CallToolResult | null {
    const found = this.read(taskId);
    if (!found) throw new TaskNotFound(taskId);
    if (this.asTask(taskId, found.ref.projectRunId, found.snapshot).status === 'working') return null;
    return jsonResult(found.snapshot);
  }

  /** `tasks/cancel`: the cancel tool's body, and its refusal in its words; the task is `cancelled` from then on. */
  async cancel(taskId: string): Promise<TaskState> {
    const found = this.read(taskId);
    if (!found) throw new TaskNotFound(taskId);
    const current = this.asTask(taskId, found.ref.projectRunId, found.snapshot);
    if (isTerminal(current.status)) throw new TaskCancelRefused(`Cannot cancel task in terminal status: ${current.status}`);
    try {
      await this.deps.service.cancelProjectRun(found.viewer, found.ref.projectId, found.ref.projectRunId);
    } catch (error) {
      if (error instanceof ProjectHttpError) throw new TaskCancelRefused(`refused (${error.status}): ${error.message}`);
      throw error;
    }
    CANCEL_REQUESTED.add(taskId);
    if (CANCEL_REQUESTED.size > MAX_CANCEL_REQUESTED) CANCEL_REQUESTED.delete(CANCEL_REQUESTED.values().next().value!);
    return this.task(taskId) ?? { ...current, status: 'cancelled' };
  }
}

/* ---------------------------------------------------------- caller facade */

/**
 * Every task one caller can reach: its in-memory tasks (by `owner`, its
 * `callerKey`) and, when it may start project runs, its project run tasks.
 * The wires (`taskWire.ts`) and the synchronous starts read tasks only
 * through this, so the binding is applied in one place.
 */
export class CallerTasks {
  constructor(
    readonly owner: string,
    readonly projectRuns: ProjectRunTasks | null,
    private readonly memory: MemoryTasks = MEMORY_TASKS
  ) {}

  get(taskId: string): TaskState | null {
    if (isProjectRunTaskId(taskId)) return this.projectRuns?.task(taskId) ?? null;
    return this.memory.get(this.owner, taskId);
  }

  /** The terminal result, or null while the task works. Throws `TaskNotFound`. */
  result(taskId: string): CallToolResult | null {
    if (isProjectRunTaskId(taskId)) {
      if (!this.projectRuns) throw new TaskNotFound(taskId);
      return this.projectRuns.result(taskId);
    }
    return this.memory.result(this.owner, taskId);
  }

  /** Throws `TaskNotFound` or `TaskCancelRefused`; answers the task as it now is. */
  async cancel(taskId: string): Promise<TaskState> {
    if (isProjectRunTaskId(taskId)) {
      if (!this.projectRuns) throw new TaskNotFound(taskId);
      return this.projectRuns.cancel(taskId);
    }
    return this.memory.cancel(this.owner, taskId);
  }

  /** The caller's project run tasks, then its in-memory ones, newest first within each. */
  list(): TaskState[] {
    return [...(this.projectRuns?.list() ?? []), ...this.memory.list(this.owner)];
  }

  /** Waits until the task is terminal (re-reading it every `pollInterval`), telling `onState` of each read. */
  async settle(taskId: string, signal: AbortSignal | undefined, onState?: (state: TaskState) => void): Promise<TaskState> {
    for (;;) {
      const state = this.get(taskId);
      if (!state) throw new TaskNotFound(taskId);
      onState?.(state);
      if (isTerminal(state.status)) return state;
      await sleep(state.pollInterval, signal);
    }
  }

  refuse(message: string, ttl: number, pollInterval = TASK_POLL_INTERVAL_MS): TaskState {
    const state = this.memory.create(this.owner, { ttl, pollInterval });
    this.memory.finish(state.taskId, 'failed', errorResult(message));
    return this.memory.get(this.owner, state.taskId)!;
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Request cancelled'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    const aborted = (): void => { clearTimeout(timer); reject(new Error('Request cancelled')); };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/* ---------------------------------------------------------------- starts */

/** What a start tool registers: its argument schema, and the start that answers a task. */
export interface TaskStart<Args> {
  readonly schema: z.ZodType<Args>;
  readonly start: (args: Args) => Promise<TaskState>;
}

/**
 * `atoma_operator_run_start`: the watcher turns each output chunk into the
 * task's status line and the run's end into its result — the
 * `atoma_operator_run_status` payload. `follow` hands the run to the session's
 * log (the 2025 era's `notifications/message`).
 */
export function operatorRunTask(
  tasks: CallerTasks,
  start: (args: StartRunInput) => Promise<RunRecordPublic>,
  follow: (runId: string) => void
): TaskStart<z.infer<z.ZodObject<typeof OPERATOR_RUN_INPUT>>> {
  return {
    schema: z.object(OPERATOR_RUN_INPUT),
    start: async (args) => {
      const ttl = (args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS) + TASK_RESULT_GRACE_MS;
      let record: RunRecordPublic;
      try {
        record = await start(args);
      } catch (error) {
        if (error instanceof RunRejected) return tasks.refuse(`refused: ${error.message}`, ttl);
        throw error;
      }
      const started = `run ${record.runId} started (${record.family})`;
      const task = MEMORY_TASKS.create(tasks.owner, { ttl, pollInterval: TASK_POLL_INTERVAL_MS, statusMessage: started });
      follow(record.runId);
      const current = () => jsonResult(runStatus({ runId: record.runId }));
      MEMORY_TASKS.onCancel(task.taskId, () => void cancelOperatorRun({ runId: record.runId }), current);
      const unhookOutput = onRunOutput((update) => {
        if (update.runId !== record.runId) return;
        // The progress line carries the chunk count only: the tail is model output.
        const prefix = `run ${record.runId} running, ${update.chunks} chunks`;
        MEMORY_TASKS.update(task.taskId, statusLine(prefix, update.tail), prefix);
      });
      const settle = (status: string): void => {
        unhookOutput();
        unhookFinish();
        MEMORY_TASKS.finish(task.taskId, status === 'finished' ? 'completed' : 'failed', current());
      };
      const unhookFinish = onRunFinished((finished) => {
        if (finished.runId === record.runId) settle(finished.status);
      });
      // A run that ended before the hooks were in place — a driver settled at
      // once, a host that cannot run — finished in an earlier microtask and
      // will never be heard of again: read its end now (review 2026-09-30, 1).
      const now = (runStatus({ runId: record.runId }) as { status?: string }).status;
      if (now !== undefined && now !== 'running' && now !== 'cancelling') settle(now);
      return MEMORY_TASKS.get(tasks.owner, task.taskId) ?? task;
    },
  };
}

/** `atoma_benchmark_start`: a registered campaign, with the same task and cancellation protocol as a run. */
export function benchmarkRunTask(
  tasks: CallerTasks,
  start: RetrievalCampaignStart
): TaskStart<z.infer<z.ZodObject<typeof BENCHMARK_RUN_INPUT>>> {
  return {
    schema: z.object(BENCHMARK_RUN_INPUT),
    start: async (args) => {
      const task = MEMORY_TASKS.create(tasks.owner, {
        ttl: args.registration.spec.maxWallMs + TASK_RESULT_GRACE_MS,
        pollInterval: TASK_POLL_INTERVAL_MS,
        statusMessage: `campaign ${args.registration.spec.id} validating`,
      });
      const abort = new AbortController();
      MEMORY_TASKS.onCancel(task.taskId, () => abort.abort());
      const progress = (message: string) => MEMORY_TASKS.update(task.taskId, message);
      void Promise.resolve().then(() => start(args.registration, abort.signal, progress)).then(
        (report) => MEMORY_TASKS.finish(task.taskId, report.reason === 'completed' ? 'completed' : 'failed', jsonResult(report)),
        (error) => MEMORY_TASKS.finish(task.taskId, 'failed', errorResult(`campaign refused or aborted: ${String(error).slice(0, 1000)}`))
      );
      return task;
    },
  };
}

/**
 * `atoma_run_start`: the start, then a task that IS the run
 * (`ProjectRunTasks`). A refusal before any run exists — a criterion that does
 * not parse, a service refusal — is an in-memory task that fails at once.
 */
export function projectRunTask(
  tasks: CallerTasks,
  deps: ProjectRunTaskDeps
): TaskStart<z.infer<z.ZodObject<typeof PROJECT_RUN_INPUT>>> {
  return {
    schema: z.object(PROJECT_RUN_INPUT),
    start: async (args) => {
      const runs = tasks.projectRuns;
      const ttl = deps.service.runTaskBudgetMs() + TASK_RESULT_GRACE_MS;
      const refuse = (message: string) => tasks.refuse(message, ttl, deps.pollMs ?? TASK_POLL_INTERVAL_MS);
      if (!runs) return refuse('refused: project runs are not available to this caller');
      const viewer = deps.viewer();
      // The same line grammar as the console and the CLI: one parser, and a
      // criterion that does not parse refuses the call rather than vanishing.
      const parsed = args.acceptanceCriteria?.map((entry) => parseChecklistLines(entry));
      const invalid = (parsed ?? []).flatMap((entry, index) => entry.errors.length > 0 || entry.items.length !== 1
        ? [`entry ${index + 1}: ${entry.errors[0]?.message ?? 'must hold exactly one criterion'}`] : []);
      if (invalid.length > 0) return refuse(`refused (400): invalid acceptance criteria — ${invalid.join('; ')}`);
      const criteria = parsed ? { items: parsed.flatMap((entry) => entry.items) } : null;
      let started: { projectRunId: string };
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
        })) as { projectRunId: string };
      } catch (error) {
        if (error instanceof ProjectHttpError) return refuse(`refused (${error.status}): ${error.message}`);
        throw error;
      }
      const task = runs.task(projectRunTaskId(args.projectId, started.projectRunId));
      // The run this viewer just started is readable by it; were it not, the task could never be followed.
      return task ?? refuse(`run ${started.projectRunId} started but is not readable by this caller`);
    },
  };
}

/**
 * A start without task augmentation: the task runs to its end and the call
 * answers with its result, the heartbeat telling a caller that sent a
 * `progressToken` the run is alive. A call the client cancels stops waiting;
 * its run goes on.
 */
export async function runSynchronously(
  tasks: CallerTasks,
  task: TaskState,
  channel: ProgressChannel,
  heartbeatMs: number = PROGRESS_HEARTBEAT_MS
): Promise<CallToolResult> {
  const heartbeat = requestHeartbeat(channel, heartbeatMs);
  try {
    const settled = await tasks.settle(task.taskId, channel.signal, (state) => {
      if (state.progress) heartbeat.note(state.progress);
    });
    return tasks.result(settled.taskId) ?? errorResult(`task ${settled.taskId} ended without a result`);
  } finally {
    heartbeat.stop();
  }
}

/* --------------------------------------------------------------- logging */

/**
 * `notifications/message` for the runs a 2025-era session started. The
 * session's client sets the level it wants (`logging/setLevel`) and the SDK
 * filters by it; without a level, everything at `info` and above goes out.
 * Each chunk is one message under the logger `atoma.run.<runId>`, and the
 * run's end is one `notice`. Only runs THIS session started are followed. The
 * 2026 era deprecates logging and has no session stream to carry it: there
 * the task's status line is the run's voice.
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
