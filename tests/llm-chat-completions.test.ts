import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import {
  CHAT_COMPLETIONS_VENDORS,
  ChatCompletionsLlmClient,
  cachedPromptTokens,
  type ChatCompletionsVendor,
} from '../src/core/llmChatCompletions.js';
import type { LlmCompletionRequest, Tool, ToolExecutor } from '../src/core/types.js';

type Body = Record<string, unknown> & { messages: Array<Record<string, unknown>> };

/** A fake SDK that answers from a script and records every request body verbatim. */
function fakeSdk(answers: Array<Record<string, unknown> | Error>): { client: OpenAI; bodies: Body[] } {
  const bodies: Body[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: Body) => {
          // The loop mutates its message array between rounds: snapshot it.
          bodies.push(structuredClone(body));
          const next = answers.shift();
          if (!next) throw new Error('fake SDK ran out of answers');
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  } as unknown as OpenAI;
  return { client, bodies };
}

function completion(
  message: Record<string, unknown>,
  usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'c1',
    model: 'served-model',
    choices: [{ index: 0, finish_reason: message['tool_calls'] ? 'tool_calls' : 'stop', message }],
    usage,
    ...extra,
  };
}

const READ_TOOL: Tool = {
  name: 'read_file',
  description: 'read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};

function executor(execute: ToolExecutor['execute']): ToolExecutor {
  return { execute, has: (name) => name === READ_TOOL.name };
}

function client(vendor: ChatCompletionsVendor, sdk: OpenAI): ChatCompletionsLlmClient {
  return new ChatCompletionsLlmClient({
    vendor,
    baseUrl: 'https://example.test/v1',
    credentialEnvVar: 'TEST_KEY',
    client: sdk,
  });
}

function request(overrides: Partial<LlmCompletionRequest> = {}): LlmCompletionRequest {
  return { model: 'some-model', systemPrompt: 'sys', userContent: 'hi', ...overrides };
}

describe('ChatCompletionsLlmClient', () => {
  it('serves the seven OpenAI-compatible vendors, and only them', () => {
    expect([...CHAT_COMPLETIONS_VENDORS].sort()).toEqual(
      ['deepseek', 'google', 'meta', 'mistral', 'moonshot', 'qwen', 'xai'].sort()
    );
  });

  it('refuses to construct without a key, naming the variable to set', () => {
    expect(
      () =>
        new ChatCompletionsLlmClient({
          vendor: 'xai',
          baseUrl: 'https://api.x.ai/v1',
          credentialEnvVar: 'XAI_API_KEY',
          apiKey: '  ',
        })
    ).toThrow(/api:xai requires XAI_API_KEY/);
  });

  it('echoes the assistant turn verbatim, reasoning_content and thought signatures included', async () => {
    const assistant = {
      role: 'assistant',
      content: null,
      reasoning_content: 'thinking about the file',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          extra_content: { google: { thought_signature: 'sig-abc' } },
        },
      ],
    };
    const { client: sdk, bodies } = fakeSdk([
      completion(assistant),
      completion({ role: 'assistant', content: 'done' }),
    ]);
    const calls: string[] = [];
    const response = await client('google', sdk).complete(
      request({
        model: 'gemini-3.8-flash',
        tools: [READ_TOOL],
        executor: executor(async (name, args) => { calls.push(`${name}:${String(args['path'])}`); return 'contents'; }),
      })
    );
    expect(response.text).toBe('done');
    expect(calls).toEqual(['read_file:a.txt']);
    const second = bodies[1]!.messages;
    expect(second[2]).toEqual(assistant);
    expect(second[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'contents' });
  });

  it('names the function on tool messages for Mistral only', async () => {
    const toolTurn = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'D681PevKs', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    };
    const { client: sdk, bodies } = fakeSdk([
      completion(toolTurn),
      completion({ role: 'assistant', content: 'ok' }),
    ]);
    await client('mistral', sdk).complete(
      request({ tools: [READ_TOOL], executor: executor(async () => 'x') })
    );
    expect(bodies[1]!.messages[3]).toMatchObject({ role: 'tool', name: 'read_file', tool_call_id: 'D681PevKs' });
  });

  it('refuses an undeclared tool without touching the executor', async () => {
    const { client: sdk, bodies } = fakeSdk([
      completion({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c', type: 'function', function: { name: 'run_shell', arguments: '{"cmd":"rm -rf /"}' } },
          { id: 'd', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      }),
      completion({ role: 'assistant', content: 'fine' }),
    ]);
    const executed: string[] = [];
    await client('qwen', sdk).complete(
      request({ tools: [READ_TOOL], executor: executor(async (name) => { executed.push(name); return 'r'; }) })
    );
    expect(executed).toEqual(['read_file']);
    expect(String(bodies[1]!.messages[3]!['content'])).toMatch(/run_shell/);
  });

  it('finalises with tools disabled when the iteration budget runs out', async () => {
    const toolTurn = completion({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    });
    const { client: sdk, bodies } = fakeSdk([toolTurn, completion({ role: 'assistant', content: 'final' })]);
    const response = await client('deepseek', sdk).complete(
      request({ tools: [READ_TOOL], executor: executor(async () => 'r'), maxToolIterations: 1 })
    );
    expect(response.text).toBe('final');
    expect(bodies[0]!['tool_choice']).toBe('auto');
    expect(bodies[1]!['tool_choice']).toBe('none');
    expect(bodies[1]!.messages.at(-1)).toMatchObject({ role: 'user' });
  });

  it('prices cached input apart under every vendor spelling, and counts unreported thinking as output', async () => {
    expect(cachedPromptTokens({ prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_tokens_details: { cached_tokens: 40 } })).toBe(40);
    expect(cachedPromptTokens({ prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_cache_hit_tokens: 30 } as never)).toBe(30);
    expect(cachedPromptTokens({ prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, cached_tokens: 20 } as never)).toBe(20);
    expect(cachedPromptTokens({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cached_tokens: 99 } as never)).toBe(10);

    const { client: sdk } = fakeSdk([
      completion(
        { role: 'assistant', content: 'x' },
        // 300 thinking tokens billed in the total, absent from completion_tokens.
        { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1350, prompt_tokens_details: { cached_tokens: 600 } }
      ),
    ]);
    const response = await client('google', sdk).complete(request({ model: 'gemini-3.8-flash' }));
    expect(response.usage).toEqual({ inputTokens: 400, outputTokens: 350, cacheReadInputTokens: 600 });
  });

  it('sends sampling and effort only where the vendor accepts them', async () => {
    const run = async (vendor: ChatCompletionsVendor, model: string): Promise<Body> => {
      const { client: sdk, bodies } = fakeSdk([completion({ role: 'assistant', content: 'x' })]);
      await client(vendor, sdk).complete(request({ model, params: { temperature: 0.1, effort: 'medium' } }));
      return bodies[0]!;
    };
    const gemini3 = await run('google', 'gemini-3.8-flash');
    expect(gemini3['temperature']).toBeUndefined();
    expect(gemini3['reasoning_effort']).toBe('medium');

    const mistral = await run('mistral', 'mistral-large-latest');
    expect(mistral['temperature']).toBe(0.1);
    expect(mistral['reasoning_effort']).toBeUndefined();

    const deepseek = await run('deepseek', 'deepseek-v4-pro');
    expect(deepseek['temperature']).toBeUndefined();

    const kimi = await run('moonshot', 'kimi-k3');
    expect(kimi['temperature']).toBeUndefined();

    expect((await run('xai', 'grok-4.7'))['reasoning_effort']).toBe('medium');
    expect((await run('xai', 'grok-build-0.1'))['reasoning_effort']).toBeUndefined();
  });

  it('keeps the paid tokens on an error that leaves the loop', async () => {
    const { client: sdk } = fakeSdk([
      completion(
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
        },
        { prompt_tokens: 70, completion_tokens: 7, total_tokens: 77 }
      ),
      new Error('HTTP 500'),
    ]);
    const error = await client('meta', sdk)
      .complete(request({ tools: [READ_TOOL], executor: executor(async () => 'r') }))
      .then(
        () => null,
        (err: unknown) => err as Error & { partialUsage?: unknown }
      );
    if (!error) throw new Error('expected the loop to fail');
    expect(error.message).toBe('HTTP 500');
    expect(error.partialUsage).toEqual({ inputTokens: 70, outputTokens: 7, cacheReadInputTokens: 0 });
  });

  it('reports the served model, without the Gemini resource prefix', async () => {
    const { client: sdk } = fakeSdk([
      completion({ role: 'assistant', content: 'x' }, undefined, { model: 'models/gemini-3.8-flash' }),
    ]);
    const response = await client('google', sdk).complete(request({ model: 'gemini-3.8-flash' }));
    expect(response.servedModel).toBe('gemini-3.8-flash');
    expect(response.stopReason).toBe('end_turn');
  });
});
