import type { AtomRegistry } from '../registry/atomRegistry.js';
import type { Tool } from '../core/types.js';
import { buildNarrowL1Prompt, isNarrowL1Template } from './L2Atom.js';
import { buildNarrowL2Prompt, isNarrowL2Template } from './L3Atom.js';

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

/**
 * Bring every tier-1 and tier-2 type the TEMPLATES rendered to the current
 * render and the LIVE tool declarations, at every build bootstrap, after the
 * repair above. `createOrRefresh` refreshed a template-born type only when a
 * cell created its exact signature again; a type the prefilter keeps reusing
 * never was. Production molecule Sucrose (run f91cdb19, 2026-10-25) planned
 * its tests "through record_probe", a tool it does not hold, because its
 * stored prompt still taught it, and its stored `write_file` declaration still
 * described a hand-written manifest that tool refuses since 2026-10-11.
 *
 * Per type, never the family elder `createOrRefresh` picks, so two types of
 * one signature are both refreshed. Only a type whose stored prompt IS its
 * recorded host baseline, optionally followed by a learned suffix (kept by
 * `refreshTemplate`), is touched: a validator-written or custom prompt keeps
 * its prompt and its declarations. The streak is kept, as for any template
 * revision (owner decision 2026-10-10). Declarations are replaced by name and
 * keep their order; a tool the live set does not declare keeps its own.
 * Idempotent: `patch`'s no-op guard bumps no version on an unchanged type.
 * Returns the names it actually changed.
 */
export function refreshTemplateBornTypes(registry: AtomRegistry, liveTools: readonly Tool[]): string[] {
  const live = new Map(liveTools.map((tool) => [tool.name, tool]));
  const refreshed: string[] = [];
  for (const tier of [1, 2] as const) {
    const isTemplate = tier === 1 ? isNarrowL1Template : isNarrowL2Template;
    const render = tier === 1 ? buildNarrowL1Prompt : buildNarrowL2Prompt;
    for (const type of registry.listByTier(tier)) {
      const baseline = registry.templatePrompt(type);
      if (baseline === undefined || !isTemplate(baseline)) continue;
      if (type.systemPrompt !== baseline && !type.systemPrompt.startsWith(`${baseline}\n\n`)) continue;
      const tools = type.tools.map((tool) => live.get(tool.name) ?? tool);
      const after = registry.refreshTemplate(type.name, {
        systemPromptReplace: render('', tools),
        removeTools: type.tools.map((tool) => tool.name),
        addTools: tools,
      }, 'build-app-bootstrap', 'template refresh', { keepStreak: true });
      if (after.version !== type.version) refreshed.push(type.name);
    }
  }
  return refreshed;
}
