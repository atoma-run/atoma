import { describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { buildNarrowL1Prompt, SMOKE_DESIGN_GUIDANCE } from '../src/atoms/L2Atom.js';
import { buildNarrowL2Prompt } from '../src/atoms/L3Atom.js';
import { carriesTask, repairTaskBakedPrompts } from '../src/atoms/promptRepair.js';
import { buildProfile } from '../src/run/profiles/build.js';
import { makeTools } from './helpers/factories.js';

/**
 * Production run f793b338 (2026-09-27): molecule Glucose's stored prompt
 * still read "Your current subtask: Create index.html as a small, polished,
 * self-contained static page that clearly confirms completion" — a branch
 * row from before the capability-first reset — and, handed a read-only
 * inspection of a live site, it wrote that page over index.html twenty times.
 */
describe('stored prompts that carry one task', () => {
  const tools = makeTools(['write_file', 'read_file', 'start_static_server', 'validate_html']);
  const diagnosis = '  [RESULT] the L1 result was produced without any successful tool action';
  const baked = buildNarrowL1Prompt('Create index.html as a small page that clearly confirms completion', tools, diagnosis);
  const seed = (systemPrompt: string) => ({ description: 'web builder', systemPrompt, tools, params: {}, createdBy: 'branch' });

  it('lose their task and diagnosis only, keep what a validator appended, once, as a versioned patch', () => {
    const registry = new AtomRegistry(openDb(':memory:'));
    const appended = 'Every final summary embeds a == GROUND TRUTH == block quoting real tool output.';
    const glucose = registry.create(1, seed(`${baked}\n${appended}`));
    const cell = registry.create(2, seed(buildNarrowL2Prompt('Build the dashboard', tools, diagnosis)));
    const legacy = registry.create(1, seed('You are a builder.\nSubtask you were handed: build the minesweeper\nWrite files.'));
    const clean = registry.create(1, seed(buildNarrowL1Prompt('', tools)));
    expect(repairTaskBakedPrompts(registry)).toEqual([glucose.name, legacy.name, cell.name]);
    const repaired = registry.getByName(glucose.name)!;
    expect(repaired.systemPrompt).toBe(`${buildNarrowL1Prompt('', tools)}\n${appended}`);
    expect(repaired.version).toBe(glucose.version + 1);
    expect(registry.getByName(cell.name)!.systemPrompt).toBe(buildNarrowL2Prompt('', tools));
    expect(registry.getByName(legacy.name)!.systemPrompt).toBe('You are a builder.\nWrite files.');
    expect(registry.getByName(clean.name)!.version).toBe(clean.version);
    expect(repairTaskBakedPrompts(registry)).toEqual([]);
  });

  it('never match a capability template, or the bootstrap and the repair would rewrite each other every run', () => {
    const buckets = [['write_file', 'start_static_server', 'validate_html'], ['write_file', 'start_node_server', 'fetch_url'],
      ['write_file', 'start_node_server', 'fetch_url', 'validate_html'], ['write_file', 'read_file']];
    for (const names of buckets) {
      expect(carriesTask(buildNarrowL1Prompt('', makeTools(names)))).toBe(false);
      expect(carriesTask(buildNarrowL2Prompt('', makeTools(names)))).toBe(false);
    }
    const registry = new AtomRegistry(openDb(':memory:'));
    buildProfile.seedCatalog({ registry, toolDecls: tools, log: () => undefined });
    for (const tier of [1, 2, 3] as const) for (const type of registry.listByTier(tier)) expect(carriesTask(type.systemPrompt)).toBe(false);
    expect(carriesTask(SMOKE_DESIGN_GUIDANCE)).toBe(false);
  });

  it('are repaired by the build profile bootstrap every run seeds its catalog through', () => {
    const registry = new AtomRegistry(openDb(':memory:'));
    const glucose = registry.create(1, seed(baked));
    const lines: string[] = [];
    buildProfile.seedCatalog({ registry, toolDecls: tools, log: (line) => lines.push(line) });
    expect(registry.getByName(glucose.name)!.systemPrompt).not.toContain('confirms completion');
    expect(lines).toContain(`stored prompt freed of its task: ${glucose.name}`);
  });
});
