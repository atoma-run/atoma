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
 * docs/decisions/registry-reconciliation-2026-10-10.md).
 */
export function scopeTools(parentTools: readonly Tool[], seedToolNames: readonly string[]): Tool[] {
  const asked = new Set(seedToolNames);
  const scoped = parentTools.filter((tool) => asked.has(tool.name));
  return scoped.length > 0 ? scoped : [...parentTools];
}

/**
 * `type` holding the LIVE declaration of every tool it holds that `live`
 * declares, in its own order; a tool `live` does not declare keeps its own.
 * The same object back when nothing differs. For the INSTANCE a run executes
 * and the seeds it hands its children, never for a stored row: a molecule,
 * cell or tissue whose prompt a validator or an author wrote is never refreshed by
 * the bootstrap, so its stored declarations go stale, and every child seeded
 * from them (`scopeTools`) failed the exact match against the template-born
 * family the bootstrap had just refreshed and reverted it through
 * `createOrRefresh`, one version per run (review 2026-10-26).
 */
export function withLiveDeclarations<T extends { tools: Tool[] }>(type: T, live: readonly Tool[]): T {
  const byName = new Map(live.map((tool) => [tool.name, tool]));
  let changed = false;
  const tools = type.tools.map((tool) => {
    const current = byName.get(tool.name);
    if (!current || JSON.stringify(current) === JSON.stringify(tool)) return tool;
    changed = true;
    return current;
  });
  return changed ? { ...type, tools } : type;
}
