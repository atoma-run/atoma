export const OLLAMA_DEFAULT_CONTEXT_LENGTH = 32_768;

/** Atoma's real prompts exceed Ollama's 4096 server default before tool use. */
export function ollamaContextLength(
  raw: string | undefined = process.env['OLLAMA_CONTEXT_LENGTH']
): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 8_192
    ? parsed
    : OLLAMA_DEFAULT_CONTEXT_LENGTH;
}
