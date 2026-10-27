import { ollamaContextLength } from './ollamaContext.js';
import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import { MODEL_CATALOG } from './modelCatalog.js';
import { parseModelSelector } from '../contracts/modelSelector.js';

let tokenizer: Tiktoken | undefined;
/** Local reference BPE count; other providers' tokenizers may differ. No remote requests. */
export function estimateTextTokens(text: string): number {
  tokenizer ??= new Tiktoken(o200kBase);
  // Evidence may contain special-token spellings. Count them as ordinary text.
  // Bound BPE's quadratic work on long unbroken tool output. Independent chunks
  // give a local reference estimate; the context reserve covers tokenizer differences.
  let tokens = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 512);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    tokens += tokenizer.encode(text.slice(start, end), [], []).length;
    start = end;
  }
  return tokens;
}

/** Explicit per-selector overrides accommodate custom deployments and provider aliases. */
export function modelContextWindow(model: string, env: NodeJS.ProcessEnv = process.env): {
  tokens: number; source: string; verified: boolean;
} {
  const configured: unknown = env['ATOMA_MODEL_CONTEXT_WINDOWS'] ? JSON.parse(env['ATOMA_MODEL_CONTEXT_WINDOWS']) : {};
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error('ATOMA_MODEL_CONTEXT_WINDOWS must be an object of selector/token capacities');
  const override: unknown = (configured as Record<string, unknown>)[model];
  if (override !== undefined) {
    if (!Number.isSafeInteger(override) || (override as number) < 4096) throw new Error(`Invalid context capacity for ${model}`);
    return { tokens: override as number, source: 'explicit selector configuration', verified: true };
  }
  try {
    const selector = parseModelSelector(model);
    if (selector.vendor === 'ollama') {
      const tokens = ollamaContextLength(env['OLLAMA_CONTEXT_LENGTH'] ?? '');
      return { tokens, source: 'configured Ollama request context', verified: true };
    }
    const entry = MODEL_CATALOG.vendors[selector.vendor].models.find(value => value.id === selector.model || value.aliases?.includes(selector.model));
    const tokens = selector.mode === 'api' ? entry?.contextWindows?.api : entry?.contextWindows?.subscription;
    if (tokens) return { tokens, source: entry!.contextWindows!.source, verified: true };
  } catch {
    // Legacy bare ids and test clients have no transport-qualified capability metadata.
  }
  return { tokens: 32768, source: 'unverified compatibility fallback; configure this selector for its actual capacity', verified: false };
}

/** Output and 15% tokenizer/protocol headroom precede evidence selection. */
export function reviewContextBudget(model: string, system: string, base: string, maxOutputTokens: number, env: NodeJS.ProcessEnv = process.env): {
  inputTokens: number; evidenceTokens: number; capacity: ReturnType<typeof modelContextWindow>;
} {
  const capacity = modelContextWindow(model, env);
  const inputTokens = Math.max(0, capacity.tokens - maxOutputTokens - Math.ceil(capacity.tokens * 0.15));
  return { capacity, inputTokens,
    evidenceTokens: Math.max(0, inputTokens - estimateTextTokens(system) - estimateTextTokens(base)) };
}
