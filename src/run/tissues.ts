import { HOST_TOOL_NAMES } from '../contracts/toolTaxonomy.js';
import type { AtomType } from '../registry/atomRegistry.js';
import type { SeedContext } from './setup.js';

/** The existing build tissue is a catalog candidate, never the default route. */
export const MERISTEM_SYSTEM_PROMPT = [
  'You are Meristem, a top-level tissue that builds real apps end-to-end.',
  'DELEGATION DISCIPLINE: you NEVER invoke elements yourself. Decompose the goal into one or more subtasks and choose an L2 cell (reuse or create) for each subtask. Different subtasks may use different L2 cells: sequence dependent work and parallelize independent work, then integrate their results. Each L2 routes focused leaf tasks to L1 molecules; L1 is the ONLY agent tier that invokes elements to write files, run shell commands, start servers and validate artefacts. Use the shared supervision protocol for planning, delegation and validation.',
  'Produce runnable, self-contained artefacts shaped by the task itself: a single index.html for browser pages, a Node entry file for HTTP servers/APIs, plain script/config/doc files for CLI and file deliverables. Never impose one artefact shape on a task of a different nature.',
  'The final output you return must state how the deliverable was verified (which probe ran and its result) and give its entry point: the served URL when a server is part of the deliverable, otherwise the main file path plus the command that runs it.',
].join('\n');

/** Persisted description of the build tier-3 tissue. Same edit caution. */
export const MERISTEM_DESCRIPTION =
  'A top-level tissue that orchestrates real application builds by delegating strategy to L2 cells; concrete side-effects happen only in L1 molecules.';

export function seedTissueCatalog({ registry, toolDecls, log }: SeedContext): AtomType {
  let l3Type = registry.listByTier(3).find((t) => t.createdBy === 'bootstrap-tissue-build'
    || (t.name === 'Meristem' && t.description === MERISTEM_DESCRIPTION));
  if (!l3Type) {
    l3Type = registry.createTemplate(3, {
      description: MERISTEM_DESCRIPTION,
      systemPrompt: MERISTEM_SYSTEM_PROMPT,
      tools: [...toolDecls],
      params: { maxTokens: 16384 },
      createdBy: 'bootstrap-tissue-build',
    });
    log(`bootstrapped L3 tissue: ${l3Type.name}`);
  } else {
    // Always refresh the tools (executor set may have changed across
    // runs) and re-align the system prompt with the current seed. The tools
    // it holds take their LIVE declarations, as `refreshCanonical` does for
    // the canonicals: adding by name alone kept a stale `record_probe` text.
    // A refresh of declarations alone keeps the streak, as there.
    const existing = l3Type;
    const live = new Map(toolDecls.map((tool) => [tool.name, tool]));
    const removed = new Set<string>(HOST_TOOL_NAMES.filter(name => !live.has(name)));
    const kept = existing.tools.filter((tool) => !removed.has(tool.name)).map((tool) => live.get(tool.name) ?? tool);
    const added = toolDecls.filter((tool) => !existing.tools.some((held) => held.name === tool.name));
    const baseline = registry.templatePrompt(existing);
    const declarationsOnly = (baseline === undefined || baseline === MERISTEM_SYSTEM_PROMPT) &&
      kept.length === existing.tools.length && added.length === 0;
    l3Type = registry.refreshTemplate(
      existing.name,
      {
        removeTools: existing.tools.map((tool) => tool.name),
        addTools: [...kept, ...added],
        systemPromptReplace: MERISTEM_SYSTEM_PROMPT,
      },
      'run-catalog',
      'refresh system tools + seed prompt',
      { keepStreak: declarationsOnly }
    );
    log(`catalog L3 tissue: ${l3Type.name} (v${l3Type.version})`);
  }
  return l3Type;
}
