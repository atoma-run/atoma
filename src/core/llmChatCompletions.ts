import { withPartialUsage } from './metrics.js';
import OpenAI from 'openai';
import {
  BUDGET_EXHAUSTED_HINT,
  DEFAULT_MAX_TOOL_ITERATIONS,
  coercePseudoFinalToolCall,
  offScopeToolMessage,
  truncateToolResultContent,
} from './llm.js';
import { notifyToolInvocation, parseToolArgumentsJson } from './llmOpenAi.js';
import type { ModelSelectorVendor } from '../contracts/modelSelector.js';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse, Tool } from './types.js';

/**
 * OPENAI-COMPATIBLE CHAT COMPLETIONS — the transport of seven `api:` vendors.
 *
 * Google (Gemini API), xAI, Meta, Mistral, Alibaba Qwen (Model Studio),
 * DeepSeek and Moonshot all serve `POST <base>/chat/completions` with
 * function tools. One class hosts atoma's tool loop for all of them, built
 * ONCE PER VENDOR (`run/providers.ts`): a transport is one key and one
 * endpoint, and routing to the wrong vendor is a cost and privacy bug.
 *
 * Same loop contract as `OpenAiLlmClient` and `AnthropicLlmClient`: the
 * declared-tools scope gate (#8a), head/tail truncation of tool results, one
 * tools-disabled finalisation round when the iteration budget runs out, and
 * the usage aggregated so far attached to any error leaving the loop.
 *
 * THE ASSISTANT TURN IS ECHOED VERBATIM. The API is stateless, so every round
 * resends the conversation, and the assistant message goes back exactly as
 * the vendor returned it — which is what each vendor's own tool-calling
 * guide does. That is not convenience: DeepSeek and Kimi thinking models
 * require their `reasoning_content` back inside a tool loop, and Gemini 3
 * requires the `thought_signature` it attaches to each tool call. A
 * reconstructed message drops both and the next round is refused.
 *
 * ACCOUNTING follows the Anthropic shape the rest of the system prices.
 * `prompt_tokens` INCLUDES cached tokens on every one of these APIs, so the
 * cached share is moved into `cacheReadInputTokens`; vendors report it under
 * three spellings, read in `cachedPromptTokens`. Output is the larger of
 * `completion_tokens` and `total_tokens − prompt_tokens`: a vendor that bills
 * thinking tokens without counting them in `completion_tokens` still shows
 * them in the total, and an unpriced billed token is the flattering error this
 * repository refuses.
 */

export const CHAT_COMPLETIONS_VENDORS = [
  'google',
  'xai',
  'meta',
  'mistral',
  'qwen',
  'deepseek',
  'moonshot',
] as const satisfies readonly ModelSelectorVendor[];
export type ChatCompletionsVendor = (typeof CHAT_COMPLETIONS_VENDORS)[number];

export function isChatCompletionsVendor(vendor: string): vendor is ChatCompletionsVendor {
  return (CHAT_COMPLETIONS_VENDORS as readonly string[]).includes(vendor);
}

/**
 * What differs between the seven endpoints, stated per vendor and nowhere
 * else. Everything not named here is the common OpenAI shape.
 */
export interface ChatCompletionsDialect {
  /**
   * May `temperature`/`top_p` be sent to this model? Reasoning models on
   * several vendors fix their own sampling and either reject the parameter or
   * degrade with a low value (Gemini 3 documents looping below its default).
   */
  readonly acceptsSampling: (model: string) => boolean;
  /** May atoma's effort hint travel as `reasoning_effort`? */
  readonly acceptsReasoningEffort: (model: string) => boolean;
  /** Mistral's tool messages carry the function `name` beside `tool_call_id`. */
  readonly toolMessageName: boolean;
}

const ALWAYS = (): boolean => true;
const NEVER = (): boolean => false;

export const CHAT_COMPLETIONS_DIALECTS: Readonly<Record<ChatCompletionsVendor, ChatCompletionsDialect>> = {
  // Gemini 2.5+ maps reasoning_effort onto its thinking budget; Gemini 3
  // asks to keep temperature at its default of 1.0.
  google: {
    acceptsSampling: (model) => !/^gemini-(?:[3-9]|\d{2,})/i.test(model),
    acceptsReasoningEffort: (model) => /^gemini-(?:2\.5|[3-9]|\d{2,})/i.test(model),
    toolMessageName: false,
  },
  // Grok 4.3 and later take reasoning_effort (low…xhigh); grok-4.20 and the
  // build models document none. Sampling is accepted; the penalties and
  // `stop` are refused by reasoning models, and atoma sends neither.
  xai: {
    acceptsSampling: ALWAYS,
    acceptsReasoningEffort: (model) => /^grok-(?:4\.[3-9](?!\d)|[5-9])/i.test(model),
    toolMessageName: false,
  },
  // Muse Spark refuses only reasoning_effort "none", which atoma never sends.
  meta: { acceptsSampling: ALWAYS, acceptsReasoningEffort: ALWAYS, toolMessageName: false },
  mistral: { acceptsSampling: ALWAYS, acceptsReasoningEffort: NEVER, toolMessageName: true },
  qwen: { acceptsSampling: ALWAYS, acceptsReasoningEffort: NEVER, toolMessageName: false },
  // Thinking is ON by default on V4 and refuses temperature and the
  // penalties; the effort hint maps onto its thinking depth.
  deepseek: { acceptsSampling: NEVER, acceptsReasoningEffort: ALWAYS, toolMessageName: false },
  // Kimi K2.5 and later fix temperature per mode and refuse other values.
  moonshot: {
    acceptsSampling: (model) => !/^kimi-(?:k2\.[5-9]|k[3-9]|k2-thinking)/i.test(model),
    acceptsReasoningEffort: NEVER,
    toolMessageName: false,
  },
};

export const CHAT_COMPLETIONS_DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

export interface ChatCompletionsLlmClientOptions {
  readonly vendor: ChatCompletionsVendor;
  readonly apiKey?: string | undefined;
  readonly baseUrl: string;
  /** The env var the key comes from, named in the missing-key error. */
  readonly credentialEnvVar: string;
  /** Test seam: a pre-built SDK client. */
  readonly client?: OpenAI;
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type FunctionToolCall = OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;

/** The cached share of `prompt_tokens`, under whichever name the vendor uses. */
export function cachedPromptTokens(usage: ChatCompletion['usage']): number {
  if (!usage) return 0;
  const extra = usage as typeof usage & {
    prompt_cache_hit_tokens?: number;
    cached_tokens?: number;
  };
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    extra.prompt_cache_hit_tokens ??
    extra.cached_tokens ??
    0;
  return Number.isFinite(cached) && cached > 0 ? Math.min(cached, usage.prompt_tokens) : 0;
}

export class ChatCompletionsLlmClient implements LlmClient {
  private readonly client: OpenAI;
  private readonly dialect: ChatCompletionsDialect;

  constructor(private readonly opts: ChatCompletionsLlmClientOptions) {
    this.dialect = CHAT_COMPLETIONS_DIALECTS[opts.vendor];
    if (opts.client) {
      this.client = opts.client;
      return;
    }
    const apiKey = opts.apiKey?.trim();
    if (!apiKey) {
      throw new Error(
        `api:${opts.vendor} requires ${opts.credentialEnvVar} — export it ` +
          `(the endpoint defaults to ${opts.baseUrl})`
      );
    }
    this.client = new OpenAI({ apiKey, baseURL: opts.baseUrl });
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const tools = toChatTools(req.tools ?? []);
    const sampling = this.dialect.acceptsSampling(req.model);
    const effort =
      req.params?.effort !== undefined && this.dialect.acceptsReasoningEffort(req.model)
        ? req.params.effort
        : undefined;
    const agg = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
    const raise = (err: unknown): never => {
      throw withPartialUsage(err, agg);
    };
    const accumulate = (completion: ChatCompletion): void => {
      const usage = completion.usage;
      if (!usage) return;
      const cached = cachedPromptTokens(usage);
      agg.inputTokens += Math.max(0, usage.prompt_tokens - cached);
      agg.cacheReadInputTokens += cached;
      agg.outputTokens += Math.max(
        usage.completion_tokens,
        (usage.total_tokens ?? 0) - usage.prompt_tokens
      );
    };

    const send = async (messages: ChatMessage[], disableTools: boolean): Promise<ChatCompletion> => {
      if (req.signal?.aborted) raise(req.signal.reason ?? new Error('aborted'));
      try {
        return await this.client.chat.completions.create(
          {
            model: req.model,
            messages,
            max_tokens: req.params?.maxTokens ?? CHAT_COMPLETIONS_DEFAULT_MAX_OUTPUT_TOKENS,
            ...(tools.length > 0
              ? { tools, tool_choice: disableTools ? ('none' as const) : ('auto' as const) }
              : {}),
            ...(sampling
              ? {
                  temperature: req.params?.temperature ?? 0.2,
                  ...(req.params?.topP !== undefined ? { top_p: req.params.topP } : {}),
                }
              : {}),
            ...(effort !== undefined ? { reasoning_effort: effort } : {}),
          },
          req.signal ? { signal: req.signal } : {}
        );
      } catch (err) {
        return raise(err);
      }
    };

    const budget = Math.max(1, req.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS);
    const declaredToolNames =
      req.tools && req.tools.length > 0 ? new Set(req.tools.map((t) => t.name)) : null;
    const messages: ChatMessage[] = [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.userContent },
    ];
    let finalCompletion: ChatCompletion | null = null;
    let syntheticFinalText: string | null = null;

    for (let iter = 0; iter < budget; iter++) {
      const completion = await send(messages, false);
      accumulate(completion);
      const message = firstMessage(completion, raise);

      const calls = (message.tool_calls ?? []).filter(
        (call): call is FunctionToolCall => call.type === 'function'
      );
      if (calls.length === 0 || req.executor === undefined) {
        finalCompletion = completion;
        break;
      }

      if (calls.length === 1 && declaredToolNames && !declaredToolNames.has(calls[0]!.function.name)) {
        const pseudoFinal = coercePseudoFinalToolCall(
          calls[0]!.function.name,
          parseToolArgumentsJson(calls[0]!.function.arguments)
        );
        if (pseudoFinal) {
          syntheticFinalText = pseudoFinal;
          finalCompletion = completion;
          break;
        }
      }

      // Verbatim: the vendor's own fields (reasoning_content, a Gemini
      // thought_signature on each call) must travel back unchanged.
      messages.push(message);
      for (const call of calls) {
        messages.push(await this.runTool(req, declaredToolNames, call));
      }

      if (iter === budget - 1) {
        // Graceful finalisation: the last slot went to tool execution, so
        // one tools-disabled round coaxes a text answer instead of throwing.
        messages.push({ role: 'user', content: BUDGET_EXHAUSTED_HINT });
        const finalResp = await send(messages, true);
        accumulate(finalResp);
        finalCompletion = finalResp;
        break;
      }
    }

    if (!finalCompletion) {
      throw new Error(
        `ChatCompletionsLlmClient(${this.opts.vendor}): tool loop exited without a final response (budget=${budget})`
      );
    }
    const finalMessage = firstMessage(finalCompletion, raise);
    return {
      text: syntheticFinalText ?? finalMessage.content ?? '',
      stopReason: syntheticFinalText ? 'end_turn' : stopReasonOf(finalCompletion),
      usage: {
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        cacheReadInputTokens: agg.cacheReadInputTokens || undefined,
      },
      // Gemini's compatibility layer may answer with the resource name.
      servedModel: finalCompletion.model.replace(/^models\//, ''),
    };
  }

  private async runTool(
    req: LlmCompletionRequest,
    declaredToolNames: ReadonlySet<string> | null,
    call: FunctionToolCall
  ): Promise<ChatMessage> {
    const name = call.function.name;
    const args = parseToolArgumentsJson(call.function.arguments);
    const startedAt = Date.now();
    const reply = (content: string): ChatMessage => ({
      role: 'tool',
      tool_call_id: call.id,
      content,
      ...(this.dialect.toolMessageName ? { name } : {}),
    });
    if (declaredToolNames && !declaredToolNames.has(name)) {
      const errMsg = offScopeToolMessage(declaredToolNames, name);
      notifyToolInvocation(req.onToolInvocation, {
        name,
        args,
        error: errMsg,
        durationMs: Date.now() - startedAt,
        startedAt,
      });
      return reply(errMsg);
    }
    try {
      const result = await req.executor!.execute(name, args);
      notifyToolInvocation(req.onToolInvocation, {
        name,
        args,
        result,
        durationMs: Date.now() - startedAt,
        startedAt,
      });
      return reply(
        truncateToolResultContent(typeof result === 'string' ? result : JSON.stringify(result))
      );
    } catch (err) {
      const errMsg = (err as Error).message;
      notifyToolInvocation(req.onToolInvocation, {
        name,
        args,
        error: errMsg,
        durationMs: Date.now() - startedAt,
        startedAt,
      });
      return reply(truncateToolResultContent(`tool "${name}" failed: ${errMsg}`));
    }
  }
}

function firstMessage(
  completion: ChatCompletion,
  raise: (err: unknown) => never
): OpenAI.Chat.Completions.ChatCompletionMessage {
  const message = completion.choices[0]?.message;
  return message ?? raise(new Error('chat completion returned no choice'));
}

/** The vocabulary the rest of the system reads (`Anthropic.Messages.Message['stop_reason']`). */
function stopReasonOf(completion: ChatCompletion): string {
  const choice = completion.choices[0];
  if (choice?.finish_reason === 'length') return 'max_tokens';
  if ((choice?.message.tool_calls ?? []).length > 0) return 'tool_use';
  return 'end_turn';
}

function toChatTools(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}
