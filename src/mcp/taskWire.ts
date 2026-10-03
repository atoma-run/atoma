import { ProtocolError, ProtocolErrorCode, type CallToolResult, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isTerminal, TaskCancelRefused, TaskNotFound, type CallerTasks, type TaskStart, type TaskState } from './tasks.js';

/**
 * THE TASK MODEL ON EACH WIRE (`tasks.ts` holds the model).
 *
 * 2025-11-25 — tasks are core protocol: `tools/call` carries `task: {ttl}`
 * and answers `{task}`; `tasks/get`, `tasks/result` (blocks until terminal),
 * `tasks/cancel` and `tasks/list` are served on the session; the capability is
 * `tasks`, and a start tool lists `execution.taskSupport: 'optional'`.
 *
 * 2026-07-28 — tasks are the `io.modelcontextprotocol/tasks` extension: a
 * client that declares it on a request's capabilities gets `{resultType:
 * 'task', …}` from `tools/call`; `tasks/get` answers the task WITH its result
 * (or error) inline, `tasks/cancel` and `tasks/update` acknowledge, and there
 * is no `tasks/result` or `tasks/list`. Field names become `ttlMs` and
 * `pollIntervalMs`. `failed` is reserved for a JSON-RPC error, so a run that
 * ended — even badly — is a `completed` task whose result says how, exactly
 * what the synchronous call would have answered.
 *
 * WHY SOME OF IT SITS BELOW THE SDK. SDK v2 has no task runtime, the tool
 * callback it hands a call never sees `params.task`, and on a 2026 request it
 * refuses `tasks/get` and `tasks/cancel` with -32601 before any handler runs.
 * So the start tools' task path wraps the server's own `tools/call` handler
 * (`installTaskProtocol`; a release that moves that map fails every server build and `tests/mcp-http.test.ts` first), and
 * the 2026 `tasks/*` requests are answered by the HTTP host through
 * `answerModernTaskRequest` before the SDK sees them.
 */

/** What a 2025-era server declares to accept task-augmented `tools/call`, and to list and cancel. */
export const TASKS_CAPABILITY = { list: {}, cancel: {}, requests: { tools: { call: {} } } } as const;
/** The 2026 extension's identifier, in both servers' and clients' `extensions`. */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const RELATED_TASK_META = 'io.modelcontextprotocol/related-task';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

export type ProtocolEraName = 'legacy' | 'modern';

/** A task on the 2025 wire: `ttl`, `pollInterval`, and nothing of ours beyond the spec's fields. */
export function legacyTask(state: TaskState): Record<string, unknown> {
  return {
    taskId: state.taskId,
    status: state.status,
    ...(state.statusMessage ? { statusMessage: state.statusMessage } : {}),
    createdAt: state.createdAt,
    lastUpdatedAt: state.lastUpdatedAt,
    ttl: state.ttl,
    pollInterval: state.pollInterval,
  };
}

/** A task on the 2026 wire: `ttlMs`, `pollIntervalMs`, and a terminal run's end is `completed`. */
export function modernTask(state: TaskState): Record<string, unknown> {
  return {
    taskId: state.taskId,
    status: state.status === 'failed' ? 'completed' : state.status,
    ...(state.statusMessage ? { statusMessage: state.statusMessage } : {}),
    createdAt: state.createdAt,
    lastUpdatedAt: state.lastUpdatedAt,
    ttlMs: state.ttl,
    pollIntervalMs: state.pollInterval,
  };
}

/** Whether a 2026 request declared the tasks extension on its own capabilities. */
function declaresTasksExtension(ctx: ServerContext): boolean {
  const envelope: unknown = ctx.mcpReq.envelope;
  const capabilities = (envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META] as { extensions?: Record<string, unknown> } | undefined;
  return capabilities?.extensions?.[TASKS_EXTENSION] !== undefined;
}

type RequestHandler = (request: { params?: Record<string, unknown> }, ctx: ServerContext) => Promise<unknown>;

function notFound(): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
}

/**
 * Makes the start tools tasks on `server`, for the era it serves. Called once,
 * after every tool is registered: it wraps the `tools/call` handler the SDK's
 * `McpServer` installed so a task-augmented call to a start tool answers with
 * a task, and every other call goes through untouched. On the 2025 era it also
 * declares the `tasks` capability, lists the start tools as task-capable and
 * serves `tasks/get|result|cancel|list`; on the 2026 era it declares the
 * extension (the HTTP host answers its `tasks/*` requests).
 */
export function installTaskProtocol(
  server: McpServer,
  era: ProtocolEraName,
  tasks: CallerTasks,
  starts: ReadonlyMap<string, TaskStart<unknown>>
): void {
  if (era === 'legacy') {
    server.server.registerCapabilities({ tasks: TASKS_CAPABILITY });
    for (const name of starts.keys()) {
      const registered = (server as unknown as { _registeredTools: Record<string, { execution?: unknown }> })._registeredTools[name];
      if (registered) registered.execution = { taskSupport: 'optional' };
    }
    serveLegacyTaskMethods(server, tasks);
  } else {
    server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION]: {} } });
  }
  if (starts.size === 0) return;
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, RequestHandler> })._requestHandlers;
  const original = handlers?.get('tools/call');
  if (!handlers || !original) throw new Error('installTaskProtocol: the SDK server holds no tools/call handler to wrap');
  handlers.set('tools/call', async (request, ctx) => {
    const params = request.params ?? {};
    const start = typeof params['name'] === 'string' ? starts.get(params['name']) : undefined;
    const augmented = era === 'legacy' ? params['task'] !== undefined : declaresTasksExtension(ctx);
    if (!start || !augmented) return original(request, ctx);
    // As the SDK's own call path answers them: a tool error, not a protocol one (review 2026-09-30, 5).
    const toolError = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
    const parsed = start.schema.safeParse(params['arguments'] ?? {});
    if (!parsed.success) {
      return toolError(`Input validation error: Invalid arguments for tool ${String(params['name'])}: ${z.prettifyError(parsed.error)}`);
    }
    let state: TaskState;
    try {
      state = await start.start(parsed.data);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
    return era === 'legacy' ? { content: [], task: legacyTask(state) } : { resultType: 'task', ...modernTask(state) };
  });
}

const TASK_ID_PARAMS = z.object({ taskId: z.string() }).loose();

function serveLegacyTaskMethods(server: McpServer, tasks: CallerTasks): void {
  const low = server.server as unknown as {
    setRequestHandler(method: string, schemas: { params: z.ZodType }, handler: (params: never, ctx: ServerContext) => unknown): void;
  };
  low.setRequestHandler('tasks/get', { params: TASK_ID_PARAMS }, (params: { taskId: string }) => {
    const state = tasks.get(params.taskId);
    if (!state) throw notFound();
    return legacyTask(state);
  });
  low.setRequestHandler('tasks/result', { params: TASK_ID_PARAMS }, async (params: { taskId: string }, ctx: ServerContext) => {
    try {
      await tasks.settle(params.taskId, ctx.mcpReq.signal);
      const result = tasks.result(params.taskId);
      if (!result) throw notFound();
      return { ...result, _meta: { ...(result._meta ?? {}), [RELATED_TASK_META]: { taskId: params.taskId } } };
    } catch (error) {
      if (error instanceof TaskNotFound) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${params.taskId}`);
      throw error;
    }
  });
  low.setRequestHandler('tasks/cancel', { params: TASK_ID_PARAMS }, async (params: { taskId: string }) => {
    try {
      return legacyTask(await tasks.cancel(params.taskId));
    } catch (error) {
      if (error instanceof TaskNotFound) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${params.taskId}`);
      if (error instanceof TaskCancelRefused) throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
      throw error;
    }
  });
  low.setRequestHandler('tasks/list', { params: z.object({ cursor: z.string().optional() }).loose().optional() }, () => ({
    tasks: tasks.list().map(legacyTask),
  }));
}

/* ------------------------------------------------------------------ 2026 */

/** The 2026 methods the HTTP host answers itself, because the SDK refuses them there. */
export const MODERN_TASK_METHODS = new Set(['tasks/get', 'tasks/cancel', 'tasks/update']);

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: { readonly taskId?: unknown; readonly inputResponses?: unknown; readonly _meta?: Record<string, unknown> };
}

/** Whether `message` is one JSON-RPC request the host answers for the tasks extension. */
export function isModernTaskRequest(message: unknown): message is JsonRpcRequest {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const { method, id } = message as JsonRpcRequest;
  return typeof method === 'string' && MODERN_TASK_METHODS.has(method) && (typeof id === 'string' || typeof id === 'number');
}

/** A 2026 task as `tasks/get` details it: the result of a finished task inline. */
function detailedTask(tasks: CallerTasks, state: TaskState): Record<string, unknown> {
  const detail: Record<string, unknown> = { ...modernTask(state) };
  if (isTerminal(state.status) && state.status !== 'cancelled') {
    const result: CallToolResult | null = tasks.result(state.taskId);
    if (result) detail['result'] = { ...result, resultType: 'complete' };
  }
  return detail;
}

/**
 * The JSON-RPC response to one 2026 `tasks/get`, `tasks/cancel` or
 * `tasks/update` from the caller `tasks` belongs to. Unknown — or someone
 * else's — is -32602. `tasks/update` acknowledges: no task here ever asks for
 * input. `serverInfo` is stamped as the SDK stamps every 2026 result.
 */
export async function answerModernTaskRequest(
  tasks: CallerTasks,
  message: JsonRpcRequest,
  serverInfo: { readonly name: string; readonly version: string }
): Promise<Record<string, unknown>> {
  const meta = { 'io.modelcontextprotocol/serverInfo': serverInfo };
  const error = (code: number, text: string) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  const taskId = message.params?.taskId;
  if (typeof taskId !== 'string') return error(ProtocolErrorCode.InvalidParams, 'Invalid params: taskId is required');
  try {
    if (message.method === 'tasks/get') {
      const state = tasks.get(taskId);
      if (!state) return error(ProtocolErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
      return { jsonrpc: '2.0', id: message.id, result: { ...detailedTask(tasks, state), resultType: 'complete', _meta: meta } };
    }
    if (message.method === 'tasks/cancel') {
      await tasks.cancel(taskId);
      return { jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', _meta: meta } };
    }
    if (!tasks.get(taskId)) return error(ProtocolErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
    return { jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', _meta: meta } };
  } catch (failure) {
    if (failure instanceof TaskNotFound) return error(ProtocolErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
    // SEP-2663: a cancel of a task the caller owns is ACKNOWLEDGED with an
    // empty result even when it already ended (the task keeps its terminal
    // state); -32602 is reserved for an unknown id. The 2025 wire keeps its own rule.
    if (failure instanceof TaskCancelRefused) return { jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', _meta: meta } };
    throw failure;
  }
}
