import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { CodexCliLlmClient, CodexTransportError, cleanupCodexJails } from '../src/core/llmCodexCli.js';
import { buildCodexAppServerArgs, type CodexAppServerSpawn } from '../src/core/codexAppServerToolLoop.js';
import { BUDGET_EXHAUSTED_HINT } from '../src/core/llm.js';
import { PERSONAL_CODEX_PROFILE_ROOT_ENV, tryAcquireCodexHomeLease } from '../src/core/codexHomeLease.js';
import type { LlmCompletionRequest } from '../src/core/types.js';
import { makeTool } from './helpers/factories.js';

const homes: string[] = [];
afterEach(() => {
  cleanupCodexJails();
  for (const home of homes.splice(0)) rmSync(path.dirname(home), { recursive: true, force: true });
});

function codexHome(auth = '{"tokens":{"refresh_token":"r1"}}'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'atoma-app-test-'));
  const home = path.join(root, 'codex');
  mkdirSync(home);
  writeFileSync(path.join(home, 'auth.json'), auth);
  homes.push(home);
  return home;
}

interface FakeServer {
  callTool(tool: string, args: unknown): Promise<{ contentItems: { text: string }[]; success: boolean }>;
  message(text: string): void;
  usage(total: Record<string, number>): void;
  complete(status?: string, error?: unknown): void;
  /** Raw stdout bytes, to split a line wherever a test needs. */
  raw(chunk: Buffer): void;
  stdin: EventEmitter;
  env: NodeJS.ProcessEnv;
}

/** A JSON-RPC double of `codex app-server`: the test scripts the turn. */
function fakeAppServer(onTurn: (server: FakeServer, turn: number) => Promise<void>, opts: { initError?: boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  let spawned: { args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string } | null = null;
  const spawnFn: CodexAppServerSpawn = (args, env, cwd) => {
    spawned = { args, env: { ...env }, cwd };
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let nextId = 100;
    let closed = false;
    let turns = 0;
    const stdin = new EventEmitter();
    const waiting = new Map<number, (result: never) => void>();
    const emit = (message: unknown): void => {
      setImmediate(() => { if (!closed) stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)); });
    };
    const server: FakeServer = {
      callTool: (tool, args) => new Promise((resolve) => {
        const id = nextId++;
        waiting.set(id, resolve);
        emit({ id, method: 'item/tool/call', params: { threadId: 't', turnId: 'u', callId: `c${id}`, namespace: null, tool, arguments: args } });
      }),
      message: (text) => emit({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm', text } } }),
      usage: (total) => emit({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total, last: total } } }),
      complete: (status = 'completed', error = null) => emit({ method: 'turn/completed', params: { turn: { id: 'u', status, error } } }),
      raw: (chunk) => setImmediate(() => { if (!closed) stdout.emit('data', chunk); }),
      stdin,
      env: { ...env },
    };
    Object.assign(child, {
      stdout, stderr, pid: undefined, exitCode: null, signalCode: null,
      stdin: Object.assign(stdin, {
        destroyed: false,
        write: (chunk: string) => {
          for (const line of String(chunk).split('\n').filter(Boolean)) {
            const message = JSON.parse(line) as Record<string, unknown>;
            sent.push(message);
            if (message['method'] === 'initialize') {
              emit(opts.initError ? { id: 1, error: { code: -32603, message: 'boom' } } : { id: 1, result: {} });
            } else if (message['method'] === 'thread/start') {
              emit({ id: 2, result: { thread: { id: 't' }, model: 'gpt-5.6-luna' } });
            } else if (message['method'] === 'turn/start') {
              emit({ id: message['id'], result: { turn: { id: 'u' } } });
              void onTurn(server, turns++);
            } else if (message['method'] === 'turn/interrupt') {
              emit({ id: message['id'], result: {} });
              server.complete('interrupted');
            } else if (typeof message['id'] === 'number' && waiting.has(message['id'])) {
              waiting.get(message['id'])!(message['result'] as never);
              waiting.delete(message['id']);
            }
          }
          return true;
        },
        end: () => undefined,
      }),
      kill: () => {
        if (!closed) { closed = true; setImmediate(() => child.emit('close', null)); }
        return true;
      },
    });
    return child;
  };
  return { spawnFn, sent, spawned: () => spawned };
}

/** An exec-transport double answering one final action. */
function execFinal(text: string) {
  return vi.fn((_args: readonly string[]) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new EventEmitter();
    Object.assign(child, { stdout, stderr: new EventEmitter(), stdin: { end: () => undefined }, pid: undefined, kill: () => true });
    setImmediate(() => {
      stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ type: 'final', name: '', argumentsJson: '{}', content: '', old_string: '', new_string: '', smoke: '', cmd: '', text }) } })}
`));
      stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })}
`));
      child.emit('close', 0);
    });
    return child;
  });
}

function request(over: Partial<LlmCompletionRequest> = {}): LlmCompletionRequest {
  return {
    model: 'gpt-5.6-luna',
    systemPrompt: 'you are an atom',
    userContent: 'do the task',
    tools: [
      makeTool('fetch_url', { inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }),
      makeTool('read_file', { inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }),
    ],
    executor: { has: () => true, execute: vi.fn(async (name: string, args: Record<string, unknown>) => ({ ok: true, name, args })) },
    ...over,
  };
}

describe('Codex app-server tool session', () => {
  it('runs several independent calls from one response through the host executor, in order', async () => {
    const home = codexHome();
    const fake = fakeAppServer(async (server) => {
      await Promise.all([
        server.callTool('fetch_url', { url: 'http://localhost:1/a' }),
        server.callTool('fetch_url', { url: 'http://localhost:1/b' }),
        server.callTool('read_file', { path: 'package.json' }),
      ]);
      server.usage({ inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10 });
      server.message('{"output":1,"summary":"done"}');
      server.complete();
    });
    const observe = vi.fn();
    const req = request({ onToolInvocation: observe, params: { effort: 'low' } });
    const client = new CodexCliLlmClient({ env: { CODEX_HOME: home, PATH: '/bin' }, appServerSpawnFn: fake.spawnFn });
    const response = await client.complete(req);

    expect(response.text).toBe('{"output":1,"summary":"done"}');
    expect(response.servedModel).toBe('gpt-5.6-luna');
    expect(response.usage).toEqual({ inputTokens: 600, outputTokens: 60, cacheReadInputTokens: 400 });
    expect(response.toolBudgetExhausted).toBeUndefined();
    expect(vi.mocked(req.executor!.execute).mock.calls).toEqual([
      ['fetch_url', { url: 'http://localhost:1/a' }],
      ['fetch_url', { url: 'http://localhost:1/b' }],
      ['read_file', { path: 'package.json' }],
    ]);
    expect(observe.mock.calls.map(([info]) => info.name)).toEqual(['fetch_url', 'fetch_url', 'read_file']);

    const thread = fake.sent.find((m) => m['method'] === 'thread/start')!['params'] as Record<string, unknown>;
    expect((thread['dynamicTools'] as { name: string }[]).map((t) => t.name)).toEqual(['fetch_url', 'read_file']);
    expect(thread['baseInstructions']).toContain('you are an atom');
    expect(thread['baseInstructions']).toContain('ATOMA HOST TOOLS');
    expect(thread['ephemeral']).toBe(true);
    const turn = fake.sent.find((m) => m['method'] === 'turn/start')!['params'] as Record<string, unknown>;
    expect(turn['effort']).toBe('low');
    expect(turn['input']).toEqual([{ type: 'text', text: 'do the task' }]);

    // The exec transport's isolation, and a fresh profile rather than the login's home.
    const spawned = fake.spawned()!;
    expect(spawned.args).toEqual(buildCodexAppServerArgs());
    expect(spawned.args.slice(0, 2)).toEqual(['app-server', '--strict-config']);
    expect(spawned.args).toEqual(expect.arrayContaining(['--disable', 'shell_tool', '-c', 'default_permissions="atoma-text-only"']));
    expect(spawned.env['CODEX_HOME']).not.toBe(home);
    expect(spawned.env['CODEX_HOME']).toBe(spawned.env['CODEX_SQLITE_HOME']);
    expect(spawned.env[PERSONAL_CODEX_PROFILE_ROOT_ENV]).toBeUndefined();
    expect(existsSync(spawned.cwd)).toBe(false);
  });

  it('refuses an undeclared tool and non-object arguments without executing them', async () => {
    const home = codexHome();
    const replies: { success: boolean; text: string }[] = [];
    const fake = fakeAppServer(async (server) => {
      for (const [tool, args] of [['run_shell', { cmd: 'ls' }], ['fetch_url', 'http://x'], ['read_file', { path: 'a' }]] as const) {
        const reply = await server.callTool(tool, args);
        replies.push({ success: reply.success, text: reply.contentItems[0]!.text });
      }
      server.message('final');
      server.complete();
    });
    const observe = vi.fn();
    const req = request({ onToolInvocation: observe });
    await new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: fake.spawnFn }).complete(req);
    expect(vi.mocked(req.executor!.execute).mock.calls).toEqual([['read_file', { path: 'a' }]]);
    expect(replies[0]).toMatchObject({ success: false, text: expect.stringContaining('is NOT in your declared tools') });
    expect(replies[1]).toMatchObject({ success: false, text: expect.stringContaining('must be a JSON object') });
    expect(replies[2]!.success).toBe(true);
    expect(observe.mock.calls.map(([info]) => info.error === undefined)).toEqual([false, false, true]);
  });

  it('keeps the tool budget in model responses: the last one says so, a later call is refused, the final is marked', async () => {
    const home = codexHome();
    const replies: { success: boolean; text: string }[] = [];
    const fake = fakeAppServer(async (server) => {
      // One call per model response; Codex reports usage after each response.
      for (const url of ['a', 'b', 'c']) {
        const reply = await server.callTool('fetch_url', { url: `http://localhost:1/${url}` });
        replies.push({ success: reply.success, text: reply.contentItems[0]!.text });
        server.usage({ inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 });
      }
      server.message('final after budget');
      server.complete();
    });
    const req = request({ maxToolIterations: 2 });
    const response = await new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: fake.spawnFn }).complete(req);
    expect(req.executor!.execute).toHaveBeenCalledTimes(2);
    expect(replies[0]!.text).not.toContain(BUDGET_EXHAUSTED_HINT);
    expect(replies[1]!.text).toContain(BUDGET_EXHAUSTED_HINT);
    expect(replies[2]).toEqual({ success: false, text: BUDGET_EXHAUSTED_HINT });
    expect(response).toMatchObject({ text: 'final after budget', toolBudgetExhausted: true });
  });

  it('falls back to the exec loop when the session fails before any tool reached the host', async () => {
    const home = codexHome();
    const fake = fakeAppServer(async () => undefined, { initError: true });
    const execSpawn = execFinal('from exec');
    const req = request();
    const response = await new CodexCliLlmClient({ env: { CODEX_HOME: home }, spawnFn: execSpawn, appServerSpawnFn: fake.spawnFn }).complete(req);
    expect(response.text).toBe('from exec');
    expect(execSpawn).toHaveBeenCalledTimes(1);
    expect(execSpawn.mock.calls[0]![0][0]).toBe('exec');
  });

  it('never falls back once a tool reached the host: the failure is the call\'s', async () => {
    const home = codexHome();
    const fake = fakeAppServer(async (server) => {
      await server.callTool('read_file', { path: 'a' });
      server.usage({ inputTokens: 50, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 });
      server.complete('failed', { message: 'stream error: status 500' });
    });
    const execSpawn = vi.fn();
    const req = request();
    const failure = await new CodexCliLlmClient({ env: { CODEX_HOME: home }, spawnFn: execSpawn, appServerSpawnFn: fake.spawnFn })
      .complete(req).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(CodexTransportError);
    expect((failure as CodexTransportError).code).toBe('service-unavailable');
    expect((failure as { partialUsage?: unknown }).partialUsage).toMatchObject({ inputTokens: 50, outputTokens: 5 });
    expect(execSpawn).not.toHaveBeenCalled();
  });

  it('writes a credential the session rotated back to the login home', async () => {
    const home = codexHome('{"tokens":{"refresh_token":"r1"}}');
    const fake = fakeAppServer(async (server) => {
      writeFileSync(path.join(server.env['CODEX_HOME']!, 'auth.json'), '{"tokens":{"refresh_token":"r2"}}');
      await server.callTool('read_file', { path: 'a' });
      server.message('ok');
      server.complete();
    });
    await new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: fake.spawnFn }).complete(request());
    expect(JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf8'))).toEqual({ tokens: { refresh_token: 'r2' } });
  });

  it('stops on abort, after the host tool in flight has returned', async () => {
    const home = codexHome();
    const controller = new AbortController();
    let toolDone = false;
    const fake = fakeAppServer(async (server) => {
      void server.callTool('read_file', { path: 'slow' });
    });
    const req = request({
      signal: controller.signal,
      executor: {
        has: () => true,
        execute: vi.fn(async () => {
          controller.abort(new Error('run deadline'));
          await new Promise((resolve) => setTimeout(resolve, 20));
          toolDone = true;
          return 'late';
        }),
      },
    });
    await expect(new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: fake.spawnFn }).complete(req))
      .rejects.toThrow('run deadline');
    expect(toolDone).toBe(true);
  });

  it('stays on the exec loop when the operator says so', async () => {
    const home = codexHome();
    const turns = vi.fn(async () => undefined);
    const fake = fakeAppServer(turns);
    const execSpawn = execFinal('exec only');
    const client = new CodexCliLlmClient({
      env: { CODEX_HOME: home, ATOMA_CODEX_TOOL_TRANSPORT: 'exec' }, spawnFn: execSpawn, appServerSpawnFn: fake.spawnFn,
    });
    expect((await client.complete(request())).text).toBe('exec only');
    expect(fake.spawned()).toBeNull();
    expect(execSpawn).toHaveBeenCalledTimes(1);
  });

  it('hands the login home back at the first model response, not at the end of the session', async () => {
    const home = codexHome();
    const held: boolean[] = [];
    const probe = (): void => {
      const release = tryAcquireCodexHomeLease(home);
      held.push(release === null);
      release?.();
    };
    const fake = fakeAppServer(async (server) => {
      probe();
      server.usage({ inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      probe();
      await server.callTool('read_file', { path: 'a' });
      server.message('done');
      server.complete();
    });
    await new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: fake.spawnFn }).complete(request());
    expect(held).toEqual([true, false]);
  });

  it('releases the login home when the session cannot even start', async () => {
    const home = codexHome();
    const execSpawn = execFinal('exec after a failed spawn');
    const throwing = (() => { throw new Error('spawn EACCES'); }) as unknown as CodexAppServerSpawn;
    const client = new CodexCliLlmClient({ env: { CODEX_HOME: home }, spawnFn: execSpawn, appServerSpawnFn: throwing });
    expect((await client.complete(request())).text).toBe('exec after a failed spawn');
    const release = tryAcquireCodexHomeLease(home);
    expect(release).not.toBeNull();
    release?.();
  });

  // Run 96d5c845 (2026-10-04): counted in calls, two batches of 25 HTTP
  // checks spent a budget of 40 before the browser check was reached.
  it('runs a whole batch inside one response of the budget', async () => {
    const home = codexHome();
    let batch: boolean[] = [];
    let after: boolean[] = [];
    const fake = fakeAppServer(async (server) => {
      const replies = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((url) => server.callTool('fetch_url', { url: `http://localhost:1/${url}` })));
      batch = replies.map((reply) => reply.success);
      server.usage({ inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 });
      const next = await Promise.all(['f', 'g'].map((url) => server.callTool('fetch_url', { url: `http://localhost:1/${url}` })));
      after = next.map((reply) => reply.success);
      server.message('final from a batch');
      server.complete();
    });
    const req = request({ maxToolIterations: 1 });
    const response = await new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: fake.spawnFn }).complete(req);
    expect(batch).toEqual([true, true, true, true, true]);
    expect(after).toEqual([false, false]);
    expect(req.executor!.execute).toHaveBeenCalledTimes(5);
    expect(response).toMatchObject({ text: 'final from a batch', toolBudgetExhausted: true });
  });

  it('still bounds the calls one response may batch', async () => {
    const home = codexHome();
    let successes: boolean[] = [];
    const fake = fakeAppServer(async (server) => {
      const replies = await Promise.all(Array.from({ length: 14 }, (_, i) => server.callTool('fetch_url', { url: `http://localhost:1/${i}` })));
      successes = replies.map((reply) => reply.success);
      server.message('bounded');
      server.complete();
    });
    const req = request({ maxToolIterations: 1 });
    await new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: fake.spawnFn }).complete(req);
    expect(req.executor!.execute).toHaveBeenCalledTimes(12);
    expect(successes.filter((ok) => !ok)).toHaveLength(2);
  });

  it('interrupts a model that keeps calling past the budget and finalizes in a tool-free turn', async () => {
    const home = codexHome();
    const fake = fakeAppServer(async (server, turn) => {
      if (turn === 0) {
        server.usage({ inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 });
        for (let i = 0; i < 12; i++) void server.callTool('fetch_url', { url: `http://localhost:1/${i}` });
        return;
      }
      server.message('final in the finalizing turn');
      server.complete();
    });
    const response = await new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: fake.spawnFn }).complete(request({ maxToolIterations: 1 }));
    expect(response).toMatchObject({ text: 'final in the finalizing turn', toolBudgetExhausted: true });
    const turnStarts = fake.sent.filter((m) => m['method'] === 'turn/start');
    expect(turnStarts).toHaveLength(2);
    expect(JSON.stringify(turnStarts[1])).toContain('TOOL BUDGET EXHAUSTED');
    expect(fake.sent.some((m) => m['method'] === 'turn/interrupt')).toBe(true);
  });

  it('decodes a multibyte character split across two stdout chunks', async () => {
    const home = codexHome();
    const fake = fakeAppServer(async (server) => {
      const line = Buffer.from(`${JSON.stringify({ id: 7, method: 'item/tool/call', params: { threadId: 't', turnId: 'u', callId: 'c7', namespace: null, tool: 'read_file', arguments: { path: 'café.txt' } } })}\n`);
      const cut = line.indexOf(Buffer.from('é')) + 1;
      server.raw(line.subarray(0, cut));
      server.raw(line.subarray(cut));
      await new Promise((resolve) => setTimeout(resolve, 20));
      server.message('done');
      server.complete();
    });
    const req = request();
    await new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: fake.spawnFn }).complete(req);
    expect(req.executor!.execute).toHaveBeenCalledWith('read_file', { path: 'café.txt' });
  });

  it('survives a pipe the dying child broke', async () => {
    const home = codexHome();
    let threw = false;
    const fake = fakeAppServer(async (server) => {
      try { server.stdin.emit('error', new Error('write EPIPE')); } catch { threw = true; }
      await server.callTool('read_file', { path: 'a' });
      server.message('done');
      server.complete();
    });
    expect((await new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: fake.spawnFn }).complete(request())).text).toBe('done');
    expect(threw).toBe(false);
  });

  it('keeps a rotation someone else wrote to the login meanwhile', async () => {
    const home = codexHome('{"tokens":{"refresh_token":"r1"}}');
    const fake = fakeAppServer(async (server) => {
      server.usage({ inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // After the hand-back: another caller rotates the login, then this session does.
      writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"refresh_token":"theirs"}}');
      writeFileSync(path.join(server.env['CODEX_HOME']!, 'auth.json'), '{"tokens":{"refresh_token":"mine"}}');
      server.message('ok');
      server.complete();
    });
    await new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: fake.spawnFn }).complete(request());
    expect(JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf8'))).toEqual({ tokens: { refresh_token: 'theirs' } });
  });

});
