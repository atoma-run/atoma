import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { withPartialUsage } from './metrics.js';
import { BUDGET_EXHAUSTED_HINT, DEFAULT_MAX_TOOL_ITERATIONS, offScopeToolMessage, truncateToolResultContent } from './llm.js';
import { acquireCodexHomeLease, PERSONAL_CODEX_PROFILE_ROOT_ENV, tryAcquirePersonalCodexProcessSlot } from './codexHomeLease.js';
import {
  CODEX_TEXT_ONLY_DISABLED_FEATURES,
  CodexTransportError,
  classifyCodexDiagnostic,
  codexChildEnvironment,
  mapCodexUsage,
  type CodexFailureCode,
} from './llmCodexCli.js';
import type { LlmCompletionRequest, LlmCompletionResponse, ToolInvocationInfo } from './types.js';

/**
 * ONE Codex app-server thread per tool-bearing call, the host's declared tools
 * given to it as dynamic tools. `codex exec` cost a new process and a resent
 * transcript for every action, one action per model response: run 87e672d7
 * (2026-10-04) spent ~13 s per action of which ~2 % ran tools. Here the model
 * calls the declared tools natively, several in one response when they are
 * independent, inside one conversation.
 *
 * The tools are still the caller's: every call reaches `req.executor` only,
 * one at a time and in the order Codex sends them; Codex's own tools stay
 * disabled under the same text-only flags and the read-only empty jail as the
 * exec transport. The thread runs in a FRESH profile holding a copy of the
 * principal's auth.json — app-server has no `--ignore-user-config`.
 *
 * THE CODEX_HOME LEASE IS HELD UNTIL THE FIRST MODEL RESPONSE, not for the
 * session. Codex refreshes a stale login before its first request, so by the
 * first usage update or tool call any rotation has happened: the copy is
 * written back then, under the lease, and the lease is released. Holding it
 * for the session would have queued every other lane's and tier's Codex call
 * behind minutes of host tools (adversarial review, 2026-10-04). A rotation
 * later in the session is written back only if the login home still holds
 * what this session last wrote there.
 */

/** Spawn app-server with stdin left open; tests inject a fake. */
export type CodexAppServerSpawn = (
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
  cwd: string
) => ChildProcess;

/**
 * Thrown only before the first tool call reached this host, and only for a
 * failure another transport may not share: nothing ran, so the caller may
 * serve the same request through the exec loop instead.
 */
export class CodexAppServerUnavailable extends Error {
  constructor(readonly code: CodexFailureCode, readonly usage: LlmCompletionResponse['usage']) {
    super(`codex app-server unavailable [${code}]`);
    this.name = 'CodexAppServerUnavailable';
  }
}

export interface CodexAppServerOptions {
  spawnFn: CodexAppServerSpawn;
  /** The construction-time allowlisted environment of the exec transport. */
  childEnv: Readonly<NodeJS.ProcessEnv>;
  /** The CODEX_HOME whose auth.json the thread borrows. */
  home: string;
  /** Set for personal profiles: the bounded process seats live there. */
  profilesRoot?: string;
  model: string;
  effort?: string;
  /** Silence ceiling. A host tool still running is not silence. */
  silenceTimeoutMs: number;
}

const HOST_TOOLS_NOTE = `ATOMA HOST TOOLS:
The declared tools run on the Atoma host, in the task's workspace. Codex built-in tools are disabled and its own working directory is empty and read-only; neither restricts the declared tools.
Only an observed tool result can establish that the workspace denied an operation. Never invent execution or verification.
Independent tool calls (for example several HTTP checks against a server you already started) may be issued together in one response: they run one at a time, in the order given, and you see every result before your next response.
When the work is done, reply with your final response as plain assistant text, with no tool call.`;

/**
 * Calls refused after the budget before the turn is interrupted for a
 * tool-free finalizing turn, and in total before the call fails. Counted in
 * calls, so one response batching several does not end the session at once.
 */
const REFUSALS_BEFORE_FINAL_TURN = 8;
const MAX_REFUSALS = 16;

/**
 * THE BUDGET COUNTS MODEL RESPONSES, as every native tool loop here does
 * (`llm.ts`, the Responses and Chat Completions loops): a response may batch
 * several calls. Counted in calls, run 96d5c845 (2026-10-04) spent its 40 in
 * two responses of 25 HTTP checks each and never reached its browser check.
 * Codex reports usage once per completed model response; that count is the
 * response number. Calls stay bounded too, at this many per allowed response.
 */
const MAX_CALLS_PER_RESPONSE = 12;

/** A failure the exec loop would meet too, or that already cost its wait. */
const NO_FALLBACK = new Set<CodexFailureCode>([
  'timeout', 'rate-limited', 'authentication-required',
  'context-exhausted', 'budget-exhausted', 'policy-blocked',
]);

const liveTemporaries = new Set<string>();
process.on('exit', () => {
  for (const dir of liveTemporaries) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Best effort at exit. */ }
  }
});

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

/** Reduce the app-server's typed error before discarding all provider prose. */
export function classifyCodexAppServerError(raw: unknown, fallback: CodexFailureCode = 'provider-error'): CodexFailureCode {
  const error = record(raw);
  const info = error['codexErrorInfo'];
  switch (info) {
    case 'contextWindowExceeded': return 'context-exhausted';
    case 'sessionBudgetExceeded': return 'budget-exhausted';
    case 'usageLimitExceeded':
    case 'rateLimitExceeded': return 'rate-limited';
    case 'serverOverloaded':
    case 'internalServerError': return 'service-unavailable';
    case 'unauthorized': return 'authentication-required';
    case 'badRequest': return 'request-rejected';
    case 'cyberPolicy':
    case 'misalignmentPolicyViolation': return 'policy-blocked';
  }
  const variants = record(info);
  for (const key of ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']) {
    if (!Object.hasOwn(variants, key)) continue;
    const status = record(variants[key])['httpStatusCode'];
    const category = key === 'httpConnectionFailed' ? 'transport-unavailable' : 'stream-interrupted';
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
      return classifyCodexDiagnostic(`status ${status}`, category);
    }
    return category;
  }
  // Older versions and unrecognised variants keep the existing prose reducer.
  // Neither unknown variant values nor additionalDetails may escape this boundary.
  return classifyCodexDiagnostic(typeof error['message'] === 'string' ? error['message'] : '', fallback);
}

/** TOML inline values for `-c key=value` (JSON objects are not TOML). */
function toml(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return `{${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The exec transport's isolation, spelled as app-server configuration. */
export function codexAppServerConfig(): Record<string, unknown> {
  return {
    cli_auth_credentials_store: 'file',
    approval_policy: 'never',
    allow_login_shell: false,
    web_search: 'disabled',
    'agents.enabled': false,
    'orchestrator.mcp.enabled': false,
    'orchestrator.skills.enabled': false,
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.ignore_default_excludes': false,
    default_permissions: 'atoma-text-only',
    'permissions.atoma-text-only.filesystem': { ':root': 'deny', ':minimal': 'read', ':workspace_roots': { '.': 'read' } },
    'permissions.atoma-text-only.network.enabled': false,
    // Same reason as `buildCodexArgs`: AGENTS.md discovery runs through the
    // fs sandbox helper, which this profile cannot let exec the CLI on macOS.
    project_doc_max_bytes: 0,
  };
}

export function buildCodexAppServerArgs(): string[] {
  return [
    'app-server',
    '--strict-config',
    ...CODEX_TEXT_ONLY_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    ...Object.entries(codexAppServerConfig()).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]),
  ];
}

/** Real app-server, detached so its whole process group can be signalled. */
export function defaultCodexAppServerSpawn(
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
  cwd: string
): ChildProcess {
  return spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, cwd, env });
}

function killGroup(child: ChildProcess): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Not a group leader, or already reaped.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * A credential a login can still use: an object, and a ChatGPT login keeps
 * its refresh token. A torn or foreign file never replaces a working login.
 */
function usableCredential(text: string, before: string): boolean {
  try {
    const value = record(JSON.parse(text));
    const hadRefresh = typeof record(record(JSON.parse(before))['tokens'])['refresh_token'] === 'string';
    return Object.keys(value).length > 0 && (!hadRefresh || typeof record(value['tokens'])['refresh_token'] === 'string');
  } catch {
    return false;
  }
}

/** The login side of the copy: written back atomically, only over what was expected there. */
class BorrowedLogin {
  private persisted: string;
  constructor(private readonly home: string, private readonly copy: string, initial: string) {
    this.persisted = initial;
  }

  private get original(): string {
    return path.join(this.home, 'auth.json');
  }

  /** Caller holds the CODEX_HOME lease. */
  writeBack(): void {
    if (!existsSync(this.copy)) return;
    const current = readFileSync(this.copy, 'utf8');
    if (current === this.persisted || !usableCredential(current, this.persisted)) return;
    // Someone else rotated the login meanwhile: theirs stands.
    if (readFileSync(this.original, 'utf8') !== this.persisted) return;
    const staging = path.join(this.home, 'auth.atoma-refresh.tmp');
    writeFileSync(staging, current, { mode: 0o600 });
    renameSync(staging, this.original);
    this.persisted = current;
  }

  changedSinceWriteBack(): boolean {
    try { return existsSync(this.copy) && readFileSync(this.copy, 'utf8') !== this.persisted; }
    catch { return false; }
  }
}

export async function completeCodexAppServerToolLoop(
  req: LlmCompletionRequest,
  opts: CodexAppServerOptions
): Promise<LlmCompletionResponse> {
  if (!req.executor || !req.tools?.length) {
    throw new Error('Codex tool requests require both declared tools and an executor');
  }
  req.signal?.throwIfAborted();
  const noUsage = { inputTokens: 0, outputTokens: 0 };
  const unavailable = (): CodexAppServerUnavailable => new CodexAppServerUnavailable('transport-unavailable', noUsage);
  const originalAuth = path.join(opts.home, 'auth.json');
  if (!existsSync(originalAuth)) throw unavailable();

  let releaseLease: (() => void) | null;
  try {
    releaseLease = await acquireCodexHomeLease(opts.home, req.signal);
  } catch {
    req.signal?.throwIfAborted();
    throw unavailable();
  }
  let releaseSeat: (() => void) | null = null;
  let temporary: string | null = null;
  let login: BorrowedLogin | null = null;
  // Idempotent: the first model response, or the end of a session that never got one.
  const handBack = (): void => {
    if (!releaseLease) return;
    const release = releaseLease;
    releaseLease = null;
    try { login?.writeBack(); } catch { /* The login keeps what it held. */ }
    release();
  };
  try {
    let profile: string;
    let jail: string;
    try {
      if (opts.profilesRoot) {
        releaseSeat = tryAcquirePersonalCodexProcessSlot(opts.profilesRoot);
        if (!releaseSeat) throw new Error('no personal Codex process seat');
      }
      temporary = mkdtempSync(path.join(tmpdir(), 'atoma-codex-app-'));
      liveTemporaries.add(temporary);
      profile = path.join(temporary, 'profile');
      jail = path.join(temporary, 'jail');
      mkdirSync(profile);
      mkdirSync(jail);
      const authBefore = readFileSync(originalAuth, 'utf8');
      const copy = path.join(profile, 'auth.json');
      writeFileSync(copy, authBefore, { mode: 0o600 });
      login = new BorrowedLogin(opts.home, copy, authBefore);
    } catch {
      throw unavailable();
    }
    try {
      return await runSession(req, opts, { profile, jail, onFirstResponse: handBack });
    } finally {
      handBack();
      if (login?.changedSinceWriteBack()) {
        // A rotation late in the session: back under the lease, bounded so a
        // busy home cannot hold this call open.
        try {
          const release = await acquireCodexHomeLease(opts.home, AbortSignal.timeout(60_000));
          try { login.writeBack(); } finally { release(); }
        } catch {
          // The login keeps what it held.
        }
      }
    }
  } finally {
    // Release first: nothing below may keep another caller waiting.
    const release = releaseLease as (() => void) | null;
    releaseLease = null;
    release?.();
    releaseSeat?.();
    if (temporary) {
      try { rmSync(temporary, { recursive: true, force: true }); } catch { /* Swept at exit. */ }
      liveTemporaries.delete(temporary);
    }
  }
}

interface SessionInputs {
  profile: string;
  jail: string;
  onFirstResponse: () => void;
}

async function runSession(
  req: LlmCompletionRequest,
  opts: CodexAppServerOptions,
  inputs: SessionInputs
): Promise<LlmCompletionResponse> {
  const { profile, jail, onFirstResponse } = inputs;
  const executor = req.executor!;
  const tools = req.tools!;
  const declared = new Set(tools.map((tool) => tool.name));
  const budget = Math.max(1, req.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS);
  if (!Number.isSafeInteger(budget)) throw new Error('Codex tool budget must be a finite integer');
  const env = codexChildEnvironment({ ...opts.childEnv, CODEX_HOME: profile, CODEX_SQLITE_HOME: profile });
  // The seat is held here, not by the exec transport's wrapper.
  delete env[PERSONAL_CODEX_PROFILE_ROOT_ENV];
  const observe = (info: ToolInvocationInfo): void => {
    try { req.onToolInvocation?.(info); } catch { /* Observability cannot replay an action. */ }
  };

  let child: ChildProcess;
  try {
    child = opts.spawnFn(buildCodexAppServerArgs(), env, jail);
  } catch {
    throw new CodexAppServerUnavailable('transport-unavailable', { inputTokens: 0, outputTokens: 0 });
  }
  // A pipe broken by a dying child is reported by 'close'; unheard, it would
  // be an uncaught exception that takes the run process down.
  child.stdin?.on('error', () => undefined);
  child.stdout?.on('error', () => undefined);
  child.stderr?.on('error', () => undefined);

  let text = '';
  let usageTotal: Record<string, unknown> | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let toolCallsSeen = 0;
  let pendingTools = 0;
  let recoveryUsed = false;
  const recoveryAbort = new AbortController();
  let executed = 0;
  let refused = 0;
  // Completed model responses so far: a call belongs to response `responses + 1`.
  let responses = 0;
  const overBudget = (): boolean => responses >= budget || executed >= budget * MAX_CALLS_PER_RESPONSE;
  let finalTurn: 'none' | 'requested' | 'started' = 'none';
  let completed = false;
  let failure: CodexFailureCode | null = null;
  let budgetFailure = false;
  let diagnostic: CodexFailureCode = 'provider-error';
  let timedOut = false;
  let accepting = true;
  let toolRunning = false;
  let pending = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: (() => void) | undefined;
  let closed = false;

  const usage = (): LlmCompletionResponse['usage'] => {
    const total = record(usageTotal);
    const count = (key: string): number => (typeof total[key] === 'number' ? total[key] : 0);
    return mapCodexUsage({
      input_tokens: count('inputTokens'),
      cached_input_tokens: count('cachedInputTokens'),
      cache_write_input_tokens: count('cacheWriteInputTokens'),
      output_tokens: count('outputTokens'),
      reasoning_output_tokens: count('reasoningOutputTokens'),
    });
  };
  const send = (message: unknown): void => {
    if (closed || !child.stdin || child.stdin.destroyed) return;
    try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* The close handler reports it. */ }
  };
  const end = (): void => {
    accepting = false;
    recoveryAbort.abort();
    clearTimeout(timer);
    finish?.();
  };
  const fail = (code: CodexFailureCode): void => {
    if (failure === null) failure = code;
    end();
  };
  // Rearmed by every line; a tool the host is still running is not silence.
  const bump = (): void => {
    clearTimeout(timer);
    if (toolRunning || !accepting) return;
    timer = setTimeout(() => { timedOut = true; end(); }, opts.silenceTimeoutMs);
  };
  const reply = (id: unknown, output: string, success: boolean): void => {
    if (accepting) send({ id, result: { contentItems: [{ type: 'inputText', text: output }], success } });
  };
  const startTurn = (id: number, input: string): void => {
    send({ id, method: 'turn/start', params: {
      threadId, input: [{ type: 'text', text: input }],
      ...(opts.effort ? { effort: opts.effort } : {}),
    } });
  };

  const handleToolCall = async (id: unknown, params: Record<string, unknown>): Promise<void> => {
    if (!accepting) return;
    const name = typeof params['tool'] === 'string' ? params['tool'] : '';
    const raw = params['arguments'];
    const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const startedAt = Date.now();
    try {
      if (overBudget()) {
        refused++;
        observe({ name, args, startedAt, durationMs: 0, error: BUDGET_EXHAUSTED_HINT });
        if (refused > MAX_REFUSALS) { budgetFailure = true; end(); return; }
        reply(id, BUDGET_EXHAUSTED_HINT, false);
        if (refused >= REFUSALS_BEFORE_FINAL_TURN && finalTurn === 'none' && threadId && turnId) {
          // Answered refusals did not stop it: end this turn, and say it in a new one.
          finalTurn = 'requested';
          send({ id: 4, method: 'turn/interrupt', params: { threadId, turnId } });
        }
        return;
      }
      executed++;
      let result: unknown;
      let error: string | undefined;
      if (!declared.has(name)) {
        error = offScopeToolMessage(declared, name);
      } else if (args !== raw) {
        error = 'Invalid Atoma tool arguments: the arguments must be a JSON object. No tool was executed.';
      } else {
        toolRunning = true;
        clearTimeout(timer);
        try { result = await executor.execute(name, args); }
        catch (caught) { error = caught instanceof Error ? caught.message : 'Tool execution failed'; }
        finally { toolRunning = false; }
      }
      observe({ name, args, startedAt, durationMs: Date.now() - startedAt, ...(error === undefined ? { result } : { error }) });
      let content: string;
      try { content = truncateToolResultContent(error ?? (typeof result === 'string' ? result : JSON.stringify(result) ?? 'null')); }
      catch { content = 'The tool result could not be serialized.'; }
      // The last allowed response hears that no tool will run after it.
      const last = responses === budget - 1 || executed >= budget * MAX_CALLS_PER_RESPONSE;
      reply(id, last ? `${content}\n${BUDGET_EXHAUSTED_HINT}` : content, error === undefined);
    } finally {
      bump();
    }
  };

  const onLine = (line: string): void => {
    let message: Record<string, unknown>;
    try { message = record(JSON.parse(line)); } catch { return; }
    const method = typeof message['method'] === 'string' ? message['method'] : null;
    const params = record(message['params']);
    if (method === null) {
      // A response to one of our requests.
      if (message['error'] !== undefined) {
        if (message['id'] === 4) return; // An interrupt that lost a race with the turn's end.
        fail(classifyCodexAppServerError(message['error'], 'request-rejected'));
        return;
      }
      const result = record(message['result']);
      if (message['id'] === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'thread/start', params: {
          model: opts.model, cwd: jail, ephemeral: true, approvalPolicy: 'never',
          baseInstructions: `${req.systemPrompt}\n\n${HOST_TOOLS_NOTE}`,
          config: codexAppServerConfig(),
          dynamicTools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        } });
      } else if (message['id'] === 2) {
        const id = record(result['thread'])['id'];
        threadId = typeof id === 'string' ? id : null;
        if (threadId === null) { fail('provider-error'); return; }
        startTurn(3, req.userContent);
      } else if (message['id'] === 3 || message['id'] === 5 || message['id'] === 6) {
        const id = record(result['turn'])['id'];
        turnId = typeof id === 'string' ? id : turnId;
      }
      return;
    }
    if (method === 'item/tool/call' && message['id'] !== undefined) {
      toolCallsSeen++;
      onFirstResponse();
      // A message before a tool call was commentary, not the final answer.
      text = '';
      const id = message['id'];
      // Strictly one at a time, in arrival order: a server must start
      // before the request that probes it.
      pendingTools++;
      pending = pending.then(() => handleToolCall(id, params)).catch(() => undefined).finally(() => { pendingTools--; });
      return;
    }
    if (message['id'] !== undefined) {
      // Approvals, elicitations, anything else the thread asks of a client.
      send({ id: message['id'], error: { code: -32601, message: 'Atoma grants no approvals and no other tools' } });
      return;
    }
    if (method === 'item/completed') {
      const item = record(params['item']);
      if (item['type'] === 'agentMessage' && typeof item['text'] === 'string' && item['text'].trim()) text = item['text'];
    } else if (method === 'thread/tokenUsage/updated') {
      onFirstResponse();
      responses++;
      usageTotal = record(record(params['tokenUsage'])['total']);
    } else if (method === 'error') {
      if (params['willRetry'] !== true) diagnostic = classifyCodexAppServerError(params['error'] ?? params);
    } else if (method === 'turn/completed') {
      const turn = record(params['turn']);
      if (finalTurn === 'requested') {
        // The interrupted turn ended: finalize in a turn that says why.
        finalTurn = 'started';
        text = '';
        startTurn(5, `${BUDGET_EXHAUSTED_HINT} Give your final response now as plain assistant text.`);
        return;
      }
      if (turn['status'] === 'completed') { completed = true; end(); return; }
      const code = turn['error'] !== undefined && turn['error'] !== null
        ? classifyCodexAppServerError(turn['error']) : diagnostic;
      // A terminal overload may occur AFTER acknowledged host tools. Continue
      // this very thread once; never replay the original request in a new one.
      // An unresolved host action, exhausted budget, cancellation or unknown
      // failure cannot take this path. All counters and cumulative usage stand.
      if (turn['status'] === 'failed' && code === 'service-unavailable' &&
          !recoveryUsed && finalTurn === 'none' && !overBudget() &&
          pendingTools === 0 && !req.signal?.aborted && accepting) {
        recoveryUsed = true;
        text = '';
        diagnostic = 'provider-error';
        process.stderr.write('[atoma] Codex tool session recovery: service-unavailable; one continuation in the same thread, budgets retained.\n');
        pending = pending.then(async () => {
          await delay(3000, undefined, { signal: recoveryAbort.signal });
          if (accepting && !req.signal?.aborted) startTurn(6,
            'The previous turn ended with a temporary provider overload. Continue only unfinished work using the tool results already in this thread. Completed actions remain effective; do not repeat them. If their state is uncertain, inspect it before changing it.');
        }).catch(() => { if (accepting) fail('transport-unavailable'); });
        return;
      }
      fail(code);
    }
  };

  const onAbort = (): void => end();
  const decoder = new StringDecoder('utf8');
  let stdoutBuf = '';
  let stderrTail = '';
  try {
    await new Promise<void>((resolve) => {
      finish = resolve;
      // Decoded across chunks: a multibyte character split at a chunk edge
      // would otherwise reach a written file as U+FFFD.
      child.stdout?.on('data', (data: Buffer | string) => {
        bump();
        stdoutBuf += typeof data === 'string' ? data : decoder.write(data);
        const parts = stdoutBuf.split('\n');
        stdoutBuf = parts.pop() ?? '';
        for (const part of parts) if (part.trim()) onLine(part);
      });
      child.stderr?.on('data', (data: Buffer | string) => {
        bump();
        stderrTail = (stderrTail + data.toString()).slice(-2000);
      });
      child.on('error', () => fail('transport-unavailable'));
      child.on('close', () => {
        closed = true;
        if (!completed && failure === null && !timedOut) {
          fail(stderrTail.trim() ? classifyCodexDiagnostic(stderrTail, 'transport-unavailable') : 'transport-unavailable');
        }
        resolve();
      });
      req.signal?.addEventListener('abort', onAbort, { once: true });
      if (req.signal?.aborted) onAbort();
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'atoma', version: '1' }, capabilities: { experimentalApi: true } } });
      bump();
    });
  } finally {
    accepting = false;
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
    // Never return while a host tool is still running.
    await pending;
    if (!closed) {
      try { child.stdin?.end(); } catch { /* Already closed. */ }
      killGroup(child);
      await new Promise<void>((resolve) => {
        if (closed || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.once('close', () => resolve());
        // A child that never reports close must not hold this call forever.
        setTimeout(resolve, 5_000).unref?.();
      });
    }
  }

  const spent = usage();
  if (req.signal?.aborted) throw withPartialUsage(req.signal.reason ?? new Error('aborted'), spent);
  if (budgetFailure) throw withPartialUsage(new Error('Codex requested a tool after its tool budget was exhausted'), spent);
  if (completed && text.trim()) {
    return {
      text, stopReason: 'end_turn', usage: spent, servedModel: opts.model,
      // A final written after the last allowed response is a finalization, as in exec.
      ...(refused > 0 || responses > budget ? { toolBudgetExhausted: true as const } : {}),
    };
  }
  const code: CodexFailureCode = timedOut ? 'timeout' : completed ? 'empty-response' : failure ?? 'provider-error';
  // Nothing reached the host: the same request can still be served elsewhere.
  if (toolCallsSeen === 0 && !recoveryUsed && !NO_FALLBACK.has(code)) throw new CodexAppServerUnavailable(code, spent);
  throw withPartialUsage(new CodexTransportError(code, recoveryUsed), spent);
}
