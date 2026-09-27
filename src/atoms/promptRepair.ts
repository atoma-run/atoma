import type { AtomRegistry } from '../registry/atomRegistry.js';

/**
 * A stored prompt that carries ONE task: the "Your current subtask:" line and
 * the "PRIOR ATTEMPT DIAGNOSIS" block that escalation branches were once
 * created with, and the "Subtask you were handed:" / "Parent task (for context
 * only):" lines of rows created before 2026-09-08. Creation has written
 * capability prompts since, but older rows are still in the registry, and a
 * prefilter picks them for any task their tools fit. Production run f793b338
 * (2026-09-27): molecule Glucose, whose stored prompt read "Your current
 * subtask: Create index.html as a small, polished, self-contained static page
 * that clearly confirms completion", was handed a READ-ONLY inspection of a
 * live site and wrote that page over its index.html twenty times.
 *
 * The operator's `scripts/repair-atom-prompts.mjs` realigns every
 * non-canonical row wholesale, with an archive; this is the narrow automatic
 * half, run at every build bootstrap.
 */
const TASK_LINE = /^(?:Your current subtask: |Subtask you were handed: |Parent task \(for context only\): ).*(?:\r?\n|$)/gm;
// The diagnosis block `buildNarrowL1Prompt` / `buildNarrowL2Prompt` wrote,
// through the fixed closing line each one ends it with, and the blank line after.
const DIAGNOSIS_BLOCK = /^== PRIOR ATTEMPT DIAGNOSIS \(act on this, do NOT ignore\) ==\r?\n[\s\S]*?^(?:cause of that specific failure\.|re-plan the full task from scratch when a targeted fix is the right move\.)\r?\n(?:\r?\n)?/m;
const TASK_BAKED = /^(?:Your current subtask: |Subtask you were handed: |Parent task \(for context only\): |== PRIOR ATTEMPT DIAGNOSIS)/m;

/** Does a stored prompt carry a task? Exported so templates can be pinned against it. */
export function carriesTask(systemPrompt: string): boolean {
  return TASK_BAKED.test(systemPrompt);
}

/**
 * The prompt without its task: only the task lines and the diagnosis block
 * go, so capability text a validator appended since (a reporting discipline,
 * say) is kept.
 */
export function withoutTask(systemPrompt: string): string {
  return systemPrompt.replace(DIAGNOSIS_BLOCK, '').replace(TASK_LINE, '');
}

/**
 * Re-align every tier-1 and tier-2 row whose stored prompt carries a task.
 * A versioned, attributed patch: the changed type re-earns its trust, like
 * any prompt change. Idempotent — a repaired prompt no longer matches.
 * Returns the names it actually changed.
 */
export function repairTaskBakedPrompts(registry: AtomRegistry): string[] {
  const repaired: string[] = [];
  for (const tier of [1, 2] as const) {
    for (const type of registry.listByTier(tier)) {
      if (!carriesTask(type.systemPrompt)) continue;
      const after = registry.patch(type.name, { systemPromptReplace: withoutTask(type.systemPrompt) }, 'build-app-bootstrap',
        'drop the task and diagnosis baked into a stored prompt');
      if (after.version !== type.version) repaired.push(type.name);
    }
  }
  return repaired;
}
