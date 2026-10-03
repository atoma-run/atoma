import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultBuiltinTools } from '../src/tools/builtin.js';
import { projectRetrievalDeclaration } from '../src/tools/projectRetrieval.js';
import { ToolSandbox } from '../src/tools/sandbox.js';

/**
 * SERVED-MODEL + PARTIAL-USAGE contracts of the claude-cli transport
 * (review 2026-08-14 §1.13).
 *
 * This transport maps tier pins onto CLI aliases (haiku/sonnet/opus), so
 * pricing on the raw pin misattributes tokens — the response now reports
 * the alias it actually invoked as `servedModel`. And the non-success
 * result path computed mapped usage then DISCARDED it on the throw, so a
 * failed call lost tokens that were already billed; the error now carries
 * them as `partialUsage` (the AnthropicLlmClient.raise contract, e15d810).
 */

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  tool: (name: string) => ({ name }),
  createSdkMcpServer: (options: unknown) => options,
}));

const { ClaudeCliLlmClient } = await import('../src/core/llmClaudeCli.js');

it('uses the captured platform login and model even after ambient customer configuration changes', async () => {
  const env = { HOME: '/platform', CLAUDE_CONFIG_DIR: '/platform/claude', ATOMA_PLATFORM_TISSUE_AUTHOR: 'secret envelope' };
  const client = new ClaudeCliLlmClient({ env });
  env.CLAUDE_CONFIG_DIR = '/mutated';
  queryMock.mockImplementationOnce(resultOnlyStream({ type: 'result', subtype: 'success', result: 'authored', usage: { input_tokens: 1, output_tokens: 1 } }));
  const previous = process.env['ATOMA_CLAUDE_MODEL'];
  process.env['ATOMA_CLAUDE_MODEL'] = 'haiku';
  try {
    await client.complete({ model: 'opus', systemPrompt: 's', userContent: 'u', params: { effort: 'high' } });
    const options = queryMock.mock.calls[0]![0].options;
    expect(options).toMatchObject({ model: 'opus', effort: 'high', tools: [], env: { HOME: '/platform', CLAUDE_CONFIG_DIR: '/platform/claude' } });
    expect(options.env).not.toHaveProperty('ATOMA_PLATFORM_TISSUE_AUTHOR');
  } finally {
    if (previous === undefined) delete process.env['ATOMA_CLAUDE_MODEL'];
    else process.env['ATOMA_CLAUDE_MODEL'] = previous;
  }
});

const REQ = {
  model: 'claude-haiku-4-5',
  systemPrompt: 's',
  userContent: 'u',
};

function resultOnlyStream(msg: Record<string, unknown>) {
  return () => ({
    async *[Symbol.asyncIterator]() {
      yield msg;
    },
  });
}

beforeEach(() => {
  queryMock.mockReset();
  delete process.env['ATOMA_CLAUDE_MODEL'];
});

describe('tool-budget finalization', () => {
  const request = () => ({
    ...REQ,
    maxToolIterations: 1,
    tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }],
    executor: { has: () => true, execute: vi.fn(async () => 'observed bytes') },
  });
  const exhausted = () => resultOnlyStream({
    type: 'result', subtype: 'error_max_turns', session_id: 'this-query-session',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
  });

  it('resumes only the exhausted session without any tools and sums both usages', async () => {
    queryMock.mockImplementationOnce(exhausted()).mockImplementationOnce(resultOnlyStream({
      type: 'result', subtype: 'success', result: '{"output":"observed bytes","summary":"done"}',
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 50 },
    }));
    const response = await new ClaudeCliLlmClient().complete(request());
    expect(response.text).toContain('"summary":"done"');
    expect(response).not.toHaveProperty('resumeSessionId');
    expect(response.usage).toEqual({ inputTokens: 13, outputTokens: 9, cacheReadInputTokens: 150, cacheCreationInputTokens: 0 });
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1]![0].options).toMatchObject({
      resume: 'this-query-session', model: 'haiku', maxTurns: 1,
      tools: [], mcpServers: {}, allowedTools: [], strictMcpConfig: true,
      settingSources: [],
    });
  });

  it('keeps the original and finalization usage when finalization fails', async () => {
    queryMock.mockImplementationOnce(exhausted()).mockImplementationOnce(resultOnlyStream({
      type: 'result', subtype: 'error_during_execution',
      usage: { input_tokens: 3, output_tokens: 4 },
    }));
    await expect(new ClaudeCliLlmClient().complete(request())).rejects.toMatchObject({
      partialUsage: { inputTokens: 13, outputTokens: 9, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 },
    });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('does not recursively retry a failed tools-disabled finalization', async () => {
    queryMock.mockImplementationOnce(exhausted()).mockImplementationOnce(resultOnlyStream({
      type: 'result', subtype: 'error_max_turns', session_id: 'this-query-session',
      usage: { input_tokens: 3, output_tokens: 4 },
    }));
    await expect(new ClaudeCliLlmClient().complete(request())).rejects.toThrow('error_max_turns');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe('servedModel — the CLI alias actually invoked, not the pin', () => {
  it('reports the resolved alias on a successful call', async () => {
    queryMock.mockImplementation(
      resultOnlyStream({
        type: 'result',
        subtype: 'success',
        result: 'done',
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 3 },
      })
    );
    const client = new ClaudeCliLlmClient();
    const resp = await client.complete(REQ);
    expect(resp.text).toBe('done');
    expect(resp.servedModel).toBe('haiku');
  });

  it('reports the alias on the salvage path too (non-success result with assistant text)', async () => {
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial payload' }] },
        };
        yield {
          type: 'result',
          subtype: 'error_max_turns',
          usage: { input_tokens: 5, output_tokens: 2 },
        };
      },
    }));
    const client = new ClaudeCliLlmClient();
    const resp = await client.complete({ ...REQ, model: 'claude-sonnet-5' });
    expect(resp.text).toBe('partial payload');
    expect(resp.servedModel).toBe('sonnet');
  });
});

describe('partialUsage — usage computed from the result message is not discarded on throw', () => {
  it('attaches the mapped usage when the query ends without output', async () => {
    queryMock.mockImplementation(
      resultOnlyStream({
        type: 'result',
        subtype: 'error_during_execution',
        usage: { input_tokens: 42, output_tokens: 6, cache_read_input_tokens: 900 },
      })
    );
    const client = new ClaudeCliLlmClient();
    let caught: unknown;
    try {
      await client.complete(REQ);
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toMatch(/ended without output/);
    expect((caught as { partialUsage?: unknown }).partialUsage).toEqual({
      inputTokens: 42,
      outputTokens: 6,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 900,
    });
  });

  it('sums BOTH attempts on the transport-error retry throw — two paid calls, not zero', async () => {
    queryMock.mockImplementation(
      resultOnlyStream({
        type: 'result',
        subtype: 'success',
        result: 'API Error: 529 Overloaded',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 4 },
      })
    );
    const client = new ClaudeCliLlmClient();
    let caught: unknown;
    try {
      await client.complete(REQ);
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toMatch(/transport error \(after 1 retry\)/);
    expect((caught as { partialUsage?: unknown }).partialUsage).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  }, 20000);
});

describe('isolation and schema fidelity of the in-process element bridge', () => {
  const success = () => resultOnlyStream({
    type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 1, output_tokens: 1 },
  });

  it('runs EVERY query with strictMcpConfig, tool-less and tool-bearing alike', async () => {
    queryMock.mockImplementation(success());
    await new ClaudeCliLlmClient().complete(REQ);
    await new ClaudeCliLlmClient().complete({
      ...REQ,
      tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }],
      executor: { has: () => true, execute: vi.fn(async () => 'x') },
    });
    expect(queryMock).toHaveBeenCalledTimes(2);
    for (const call of queryMock.mock.calls) {
      expect(call[0].options).toMatchObject({ strictMcpConfig: true, settingSources: [], tools: [] });
      expect(call[0].options.env).toMatchObject({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
    }
  });

  it('serves every element schema verbatim and hands raw arguments to the executor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-bridge-'));
    try {
      const declarations = [
        ...defaultBuiltinTools({ sandbox: new ToolSandbox(dir) }).map((t) => t.declaration),
        projectRetrievalDeclaration,
      ];
      const execute = vi.fn(async () => 'ok');
      const invoked: string[] = [];
      queryMock.mockImplementation(success());
      await new ClaudeCliLlmClient().complete({
        ...REQ,
        tools: declarations,
        executor: { has: () => true, execute },
        onToolInvocation: (info) => invoked.push(info.name),
      });
      // The instance the Agent SDK connects to (instance.connect(transport)).
      const instance = queryMock.mock.calls[0]![0].options.mcpServers.atoma.instance;
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await instance.connect(serverSide);
      const client = new Client({ name: 'bridge-test', version: '1.0.0' });
      await client.connect(clientSide);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(declarations.map((d) => d.name));
      for (const d of declarations) {
        expect(tools.find((t) => t.name === d.name)!.inputSchema).toEqual(d.inputSchema);
      }
      // A malformed argument the api: path tolerates is no longer refused
      // before the executor: it reaches it unchanged and is traced.
      const result = await client.callTool({ name: 'fetch_url', arguments: { url: 'http://127.0.0.1:1/', timeoutMs: '5000' } });
      expect(result.isError).toBeFalsy();
      expect(execute).toHaveBeenCalledWith('fetch_url', { url: 'http://127.0.0.1:1/', timeoutMs: '5000' });
      expect(invoked).toEqual(['fetch_url']);
      await client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
