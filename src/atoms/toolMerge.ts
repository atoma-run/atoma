import type { Tool } from '../core/types.js';

/**
 * Merge the parent atom's tool declarations with any the LLM seed supplied.
 * Parent tools win on name collision so that system-provided tools (e.g. the
 * real file/shell/server executors) can't be shadowed by LLM-hallucinated
 * declarations.
 *
 * Kept as a public export; automatic creation no longer uses it — a union
 * gave every created child its parent's whole signature (see `scopeTools`).
 */
export function mergeTools(parentTools: readonly Tool[], seedTools: Tool[]): Tool[] {
  const byName = new Map<string, Tool>();
  for (const t of seedTools) byName.set(t.name, t);
  for (const t of parentTools) byName.set(t.name, t);
  return [...byName.values()];
}

/**
 * The tools a created child holds: the parent's declarations for the names
 * the seed asked for, or the parent's whole set when it named none (or none
 * the parent holds). A seed can narrow, never add — the planner prompt has
 * said so since 2026-09-07, and until 2026-10-10 the code unioned anyway, so
 * every created molecule carried its creator's full signature (six
 * full-stack clones, three eleven-tool molecules under eleven-tool cells;
 * docs/registry-reconciliation-2026-10-10.md).
 */
export function scopeTools(parentTools: readonly Tool[], seedToolNames: readonly string[]): Tool[] {
  const asked = new Set(seedToolNames);
  const scoped = parentTools.filter((tool) => asked.has(tool.name));
  return scoped.length > 0 ? scoped : [...parentTools];
}
