import { HOST_TOOL_NAMES } from '../contracts/toolTaxonomy.js';
import type { AtomType } from '../registry/atomRegistry.js';
import type { ProfileSeedContext } from './profile.js';

/** The existing build tissue is a catalog candidate, never the default route. */
export const MERISTEM_SYSTEM_PROMPT = [
  'You are Meristem, a top-level tissue that builds real apps end-to-end.',
  'DELEGATION DISCIPLINE: you NEVER invoke elements yourself. Decompose the goal into one or more subtasks and choose an L2 cell (reuse or create) for each subtask. Different subtasks may use different L2 cells: sequence dependent work and parallelize independent work, then integrate their results. Each L2 routes focused leaf tasks to L1 molecules; L1 is the ONLY agent tier that invokes elements to write files, run shell commands, start servers and validate artefacts. Use the shared supervision protocol for planning, delegation and validation.',
  'Produce runnable, self-contained artefacts shaped by the task itself: a single index.html for browser pages, a Node entry file for HTTP servers/APIs, plain script/config/doc files for CLI and file deliverables. Never impose one artefact shape on a task of a different nature.',
  'The final output you return must state how the deliverable was verified (which probe ran and its result) and give its entry point: the served URL when a server is part of the deliverable, otherwise the main file path plus the command that runs it.',
].join('\n');

/** Persisted description of the build family's tier-3 tissue. Same edit caution. */
export const MERISTEM_DESCRIPTION =
  'A top-level tissue that orchestrates real application builds by delegating strategy to L2 cells; concrete side-effects happen only in L1 molecules.';

export function seedTissueCatalog({ registry, toolDecls, log }: ProfileSeedContext): AtomType {
  let l3Type = registry.listByTier(3).find((t) => t.createdBy === 'bootstrap-tissue-build'
    || (t.name === 'Meristem' && t.description === MERISTEM_DESCRIPTION));
  if (!l3Type) {
    l3Type = registry.create(3, {
      description: MERISTEM_DESCRIPTION,
      systemPrompt: MERISTEM_SYSTEM_PROMPT,
      tools: [...toolDecls],
      params: { maxTokens: 16384 },
      createdBy: 'bootstrap-tissue-build',
    });
    log(`bootstrapped L3 tissue: ${l3Type.name}`);
  } else {
    // Always refresh the tools (executor set may have changed across
    // runs) and re-align the system prompt with the current seed.
    l3Type = registry.patch(
      l3Type.name,
      {
        addTools: [...toolDecls],
        removeTools: HOST_TOOL_NAMES.filter(name => !toolDecls.some(tool => tool.name === name)),
        ...(l3Type.systemPrompt !== MERISTEM_SYSTEM_PROMPT
          ? { systemPromptReplace: MERISTEM_SYSTEM_PROMPT }
          : {}),
      },
      'run-catalog',
      'refresh system tools + seed prompt'
    );
    log(`catalog L3 tissue: ${l3Type.name} (v${l3Type.version})`);
  }
  return l3Type;
}
