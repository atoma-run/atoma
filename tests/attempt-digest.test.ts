import { describe, it, expect } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { AttemptDigest } from '../src/atoms/attemptDigest.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import type { LlmCompletionRequest, ToolInvocationInfo } from '../src/core/types.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';

const base = { name: 'Water', ordinal: 1, systemPrompt: 'you are water', tools: [], params: { temperature: 0 } };

function call(name: string, args: Record<string, unknown>, result?: unknown, error?: string): ToolInvocationInfo {
  return { name, args, durationMs: 1, startedAt: 1, ...(error === undefined ? { result } : { error }) };
}

/** Run 87e672d7's first attempt, shortened: what the second one had to rediscover. */
const FIRST_ATTEMPT = [
  call('list_files', {}, ['server.js', 'package.json']),
  call('read_file', { path: 'server.js' }, 'source'),
  call('read_file', { path: 'package.json' }, '{}'),
  call('edit_file', { path: 'server.js', old_string: 'a', new_string: 'b' }, { ok: true }),
  call('start_node_server', { entry: 'server.js' }, { url: 'http://localhost:4100/' }),
  call('start_node_server', { entry: 'server.js' }, { url: 'http://localhost:4101/' }),
  call('fetch_url', { url: 'http://localhost:4101/api/books' }, { ok: true, status: 200 }),
  call('fetch_url', { url: 'http://localhost:4101/api/loans', method: 'post' }, { ok: false, status: 409 }),
  call('fetch_url', { url: 'http://localhost:4101/api/loans', method: 'POST' }, { ok: false, status: 409 }),
  call('run_shell', { cmd: 'npm test' }, { exitCode: 1, stdout: '', stderr: 'fail' }),
  call('validate_html', { url: 'http://localhost:4101/' }, { ok: true }),
  call('read_file', { path: 'missing.js' }, undefined, 'ENOENT'),
];

function executeWith(invocations: readonly ToolInvocationInfo[], summary: string) {
  return (request: LlmCompletionRequest) => {
    for (const info of invocations) request.onToolInvocation?.(info);
    return { text: jsonText({ output: 'x', summary }), stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } };
  };
}

describe('previous-attempt digest', () => {
  it('renders only what the transport observed, deduplicated and bounded', () => {
    const digest = new AttemptDigest();
    for (const info of FIRST_ATTEMPT) digest.observe(info);
    const text = digest.render('Loans work; fines unverified.')!;
    expect(text).toContain('== YOUR PREVIOUS ATTEMPT AT THIS TASK ==');
    expect(text).toContain('It made 12 tool call(s)');
    expect(text).toContain('- files written or edited: server.js');
    expect(text).toContain('- files read: server.js, package.json\n');
    expect(text).toContain('- servers started: server.js (×2)');
    expect(text).toContain('- HTTP requests: GET /api/books → 200, POST /api/loans → 409 (×2)');
    expect(text).toContain('- validate_html calls: 1 (last ok)');
    expect(text).toContain('`npm test` → exit 1');
    expect(text).toContain('Its own final report (not evidence): Loans work; fines unverified.');
    expect(new AttemptDigest().render('nothing ran')).toBeNull();
    const long = new AttemptDigest();
    long.observe(call('read_file', { path: 'a' }, 'x'));
    expect(long.render('r'.repeat(5000))!.length).toBeLessThan(1200);
  });

  it('reaches the next execution of the same task only', async () => {
    const ctx = makeCtx();
    const atom = new L1Atom(base);
    ctx.llm.enqueue(executeWith(FIRST_ATTEMPT, 'first'));
    ctx.llm.enqueue(executeWith([call('read_file', { path: 'server.js' }, 'x')], 'second'));
    ctx.llm.enqueue(executeWith([], 'other'));
    await atom.execute({ description: 'Build the library API.' }, makePlan(), ctx);
    await atom.execute({ description: 'Build the library API.' }, makePlan(), ctx);
    await atom.execute({ description: 'Write the README.' }, makePlan(), ctx);
    const [first, second, other] = ctx.llm.calls;
    expect(first!.userContent).not.toContain('PREVIOUS ATTEMPT');
    expect(second!.userContent).toContain('== YOUR PREVIOUS ATTEMPT AT THIS TASK ==');
    expect(second!.userContent).toContain('POST /api/loans → 409 (×2)');
    expect(other!.userContent).not.toContain('PREVIOUS ATTEMPT');
  });

  it('carries nothing out of a read-only phase, whose writes the host puts back', async () => {
    const ctx = makeCtx();
    const atom = new L1Atom(base);
    ctx.llm.enqueue(executeWith(FIRST_ATTEMPT, 'first'));
    ctx.llm.enqueue(executeWith([], 'second'));
    await atom.execute({ description: 'Verify the API.', readOnly: true }, makePlan(), ctx);
    await atom.execute({ description: 'Verify the API.', readOnly: true }, makePlan(), ctx);
    expect(ctx.llm.calls[1]!.userContent).not.toContain('PREVIOUS ATTEMPT');
  });

  it('survives the L2 patch that replaces a rejected molecule with a fresh instance', async () => {
    const registry = new AtomRegistry(openDb(':memory:'));
    const seed = { tools: [], params: {}, createdBy: 'test' };
    registry.create(2, { ...seed, description: 'web orchestrator', systemPrompt: 'You are an L2.' });
    registry.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
    const cell = L2Atom.fromType(registry.getByName('Tracheid')!, registry, []);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
    ctx.llm.enqueue(executeWith(FIRST_ATTEMPT, 'first attempt'));
    ctx.llm.enqueueText(jsonText({
      approved: false, reasoning: 'fines and holds were never verified', scope: 'patch',
      modifications: { systemPromptAppend: 'Verify every rule.' },
    }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r2', proposedAction: 'a2', expectedOutput: 'e2' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
    ctx.llm.enqueue(executeWith([call('fetch_url', { url: 'http://localhost:4101/api/holds' }, { status: 201 })], 'second attempt'));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok now' }));

    await cell.handleDirect({ description: 'Build the library API.' }, ctx);

    const executions = ctx.llm.calls.filter((request) => request.onToolInvocation !== undefined);
    expect(executions).toHaveLength(2);
    expect(executions[0]!.userContent).not.toContain('PREVIOUS ATTEMPT');
    expect(executions[1]!.userContent).toContain('== YOUR PREVIOUS ATTEMPT AT THIS TASK ==');
    expect(executions[1]!.userContent).toContain('Its own final report (not evidence): first attempt');
    expect(executions[1]!.systemPrompt).toContain('Verify every rule.');
  });
});
