import { describe, it, expect } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom, buildNarrowL1Prompt } from '../src/atoms/L2Atom.js';
import { L3Atom, buildNarrowL2Prompt } from '../src/atoms/L3Atom.js';
import { refreshTemplateBornTypes } from '../src/atoms/promptRepair.js';
import { scopeTools } from '../src/atoms/toolMerge.js';
import { GROUND_TRUTH_EVIDENCE_LINES, groundTruthEvidenceLines } from '../src/atoms/capability.js';
import { HOST_TOOL_NAMES } from '../src/contracts/toolTaxonomy.js';
import { seedCatalog } from '../src/run/setup.js';
import { seedTissueCatalog } from '../src/run/tissues.js';
import { tissueForRun, tissuePrompt } from '../src/run/tissueRouting.js';
import { defaultBuiltinTools } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import type { AtomType } from '../src/registry/atomRegistry.js';
import type { Tool } from '../src/core/types.js';

/**
 * Production molecule Sucrose (run f91cdb19, 2026-10-25): a template-born
 * type the prefilter kept reusing, so `createOrRefresh` never refreshed it.
 * Its stored prompt still said "USE record_probe" (a tool it does not hold)
 * and its stored write_file declaration still described the hand-written
 * manifest that write_file refuses since 2026-10-11. The bootstrap every run
 * goes through now brings each template-born type to the current render and
 * the live declarations, on a store shaped like production's.
 */
const SUCROSE = ['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'validate_html', 'start_node_server'];
const STALE_WRITE_FILE = 'Write a file. Writing .atoma-probes.json preserves and merges entries from earlier phases.';

describe('the bootstrap refreshes every template-born type', () => {
  it('to the current render and live declarations, keeping streaks, suffixes and custom prompts, idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-template-refresh-'));
    try {
      const live = defaultBuiltinTools({ sandbox: new ToolSandbox(root) }).map((tool) => tool.declaration);
      const liveSucrose = live.filter((tool) => SUCROSE.includes(tool.name));
      const staleSucrose: Tool[] = liveSucrose.map((tool) =>
        tool.name === 'write_file' ? { ...tool, description: STALE_WRITE_FILE } : tool);
      const current = buildNarrowL1Prompt('', liveSucrose);
      // The render production stored before 2026-10-26: the generic contract, shell block and all.
      const previous = current.replace(groundTruthEvidenceLines(SUCROSE).join('\n'), GROUND_TRUTH_EVIDENCE_LINES.join('\n'));
      expect(previous).toContain('USE record_probe');
      expect(previous).not.toBe(current);

      const original = join(root, 'production.db');
      const db = openDb(original);
      const reg = new AtomRegistry(db);
      const seed = { description: 'HTML writer + headless validator', systemPrompt: previous, tools: staleSucrose, params: {}, createdBy: 'Idioblast' };
      const sucrose = reg.createTemplate(1, seed);
      const twin = reg.createTemplate(1, seed);
      const learned = reg.createTemplate(1, seed);
      reg.patch(learned.name, { systemPromptAppend: 'Learned discipline: run the focused suite before the full one.' }, 'prompt-consolidation');
      const custom = reg.createTemplate(1, seed);
      reg.patch(custom.name, { systemPromptReplace: 'You are a validator-written molecule. Run the suite with record_probe.' }, 'validator');
      for (const name of [sucrose.name, twin.name, learned.name]) {
        reg.recordSuccess(name, 'test');
        reg.recordSuccess(name, 'test');
      }
      db.close();

      const copy = join(root, 'copy.db');
      copyFileSync(original, copy);
      const store = openDb(copy);
      try {
        const registry = new AtomRegistry(store);
        const before = new Map([sucrose, twin, learned, custom].map((type) => [type.name, registry.getByName(type.name)!]));
        const lines: string[] = [];
        seedCatalog({ registry, toolDecls: live, log: (line) => lines.push(line) });

        for (const type of [sucrose, twin]) {
          const after = registry.getByName(type.name)!;
          expect(after.atomId).toBe(type.atomId);
          expect(after.systemPrompt).toBe(current);
          expect(after.tools).toEqual(liveSucrose);
          expect(after).toMatchObject({ successes: 2, failures: 0, consecutiveSuccesses: 2 });
          expect(after.version).toBe(before.get(type.name)!.version + 1);
          expect(lines).toContain(`template-born type refreshed: ${type.name}`);
        }
        const withSuffix = registry.getByName(learned.name)!;
        expect(withSuffix.systemPrompt).toBe(`${current}\n\nLearned discipline: run the focused suite before the full one.`);
        expect(withSuffix.tools).toEqual(liveSucrose);
        expect(withSuffix.consecutiveSuccesses).toBe(2);
        // A validator-written prompt keeps its identity, its text and its declarations.
        const untouched = registry.getByName(custom.name)!;
        expect(untouched).toEqual(before.get(custom.name));
        expect(untouched.tools.find((tool) => tool.name === 'write_file')!.description).toBe(STALE_WRITE_FILE);
        // The old prompt is archived under the version it had.
        expect(registry.listVersions(sucrose.name).at(-1)).toMatchObject({ systemPrompt: previous });

        // A second boot changes nothing: no version, no log line.
        const settled = new Map(registry.listByTier(1).map((type) => [type.name, type.version]));
        const again: string[] = [];
        seedCatalog({ registry, toolDecls: live, log: (line) => again.push(line) });
        for (const type of registry.listByTier(1)) expect(type.version).toBe(settled.get(type.name));
        expect(again.filter((line) => line.startsWith('template-born type refreshed'))).toEqual([]);
      } finally { store.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('replaces a canonical cell\'s stale declarations, so the molecules it creates stop inheriting them', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-canonical-decls-'));
    try {
      const live = defaultBuiltinTools({ sandbox: new ToolSandbox(root) }).map((tool) => tool.declaration);
      const registry = new AtomRegistry(openDb(':memory:'));
      seedCatalog({ registry, toolDecls: live, log: () => undefined });
      const cell = registry.listByTier(2).find((type) => type.createdBy === 'bootstrap-canonical-full-stack')!;
      // Production's Idioblast: the declarations as they were before 2026-10-11.
      registry.patch(cell.name, {
        removeTools: cell.tools.map((tool) => tool.name),
        addTools: cell.tools.map((tool) => tool.name === 'write_file' ? { ...tool, description: STALE_WRITE_FILE } : tool),
      }, 'history');
      registry.recordSuccess(cell.name, 'test');
      const stale = registry.getByName(cell.name)!;
      expect(stale.tools.find((tool) => tool.name === 'write_file')!.description).toBe(STALE_WRITE_FILE);

      seedCatalog({ registry, toolDecls: live, log: () => undefined });
      const refreshed = registry.getByName(cell.name)!;
      expect(refreshed.tools.map((tool) => tool.name)).toEqual(stale.tools.map((tool) => tool.name));
      expect(refreshed.tools.find((tool) => tool.name === 'write_file')).toEqual(live.find((tool) => tool.name === 'write_file'));
      // Declarations only: the code's finding, so the streak stays (owner decision 2026-10-10).
      expect(refreshed.consecutiveSuccesses).toBe(stale.consecutiveSuccesses);
      expect(refreshed.version).toBe(stale.version + 1);
      seedCatalog({ registry, toolDecls: live, log: () => undefined });
      expect(registry.getByName(cell.name)!.version).toBe(refreshed.version);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /*
   * Review 2026-10-26, finding 9: the bootstrap refreshed every cell and
   * molecule, but a run's root tissue kept its STORED declarations, and every
   * cell it created was seeded from them (`scopeTools`). `createOrRefresh`
   * picks a family on tool names, so the in-run creation put the stale
   * `record_probe` text back on the cell the bootstrap had just refreshed,
   * and that cell did the same to its molecule: one version bump per run,
   * and a concurrent run's credit at the bootstrap version no longer grew
   * the streak.
   */
  it('a run\'s tissue seeds its cells and molecules with the live declarations, so no family flips version', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-tissue-decls-'));
    try {
      const live = defaultBuiltinTools({ sandbox: new ToolSandbox(root) }).map((tool) => tool.declaration);
      const stale = live.map((tool) => tool.name === 'record_probe' ? { ...tool, description: STALE_PROBE } : tool);
      const liveProbe = probe(live);
      const registry = new AtomRegistry(openDb(':memory:'));
      const log = () => undefined;
      const createCell = (tissue: AtomType, toolDecls: readonly Tool[]): AtomType =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (L3Atom.fromType(tissueForRun(tissue, toolDecls), registry) as any).createSubtaskL2({ description: 'check' }, CREATE, { description: 'task' });

      // The store before the deploy: every row seeded with the old declaration,
      // and a tissue the platform author wrote, which no bootstrap refreshes.
      const meristemBefore = seedTissueCatalog({ registry, toolDecls: stale, log });
      seedCatalog({ registry, toolDecls: stale, log });
      const authored = registry.createOrReuse(3, {
        description: 'Repository verification orchestrator', systemPrompt: tissuePrompt('Delegate checks to cells.'),
        tools: stale.filter((tool) => !(HOST_TOOL_NAMES as readonly string[]).includes(tool.name)),
        params: { maxTokens: 16384 }, createdBy: 'platform-tissue-author',
      });
      const cell = createCell(meristemBefore, stale);
      const molecule = createMolecule(registry, cell);
      expect(probe(cell.tools)).toBe(STALE_PROBE);
      expect(probe(molecule.tools)).toBe(STALE_PROBE);

      // The deploy's bootstrap.
      const meristem = seedTissueCatalog({ registry, toolDecls: live, log });
      seedCatalog({ registry, toolDecls: live, log });
      expect(probe(meristem.tools)).toBe(liveProbe);
      expect(meristem.tools.map((tool) => tool.name)).toEqual(meristemBefore.tools.map((tool) => tool.name));
      const refreshedCell = registry.getByName(cell.name)!;
      const refreshedMolecule = registry.getByName(molecule.name)!;
      expect(probe(refreshedCell.tools)).toBe(liveProbe);
      expect(probe(refreshedMolecule.tools)).toBe(liveProbe);
      registry.recordSuccess(refreshedCell.name, 'test', refreshedCell.version);
      const streak = registry.getByName(cell.name)!.consecutiveSuccesses;

      // In the run, either tissue creates the same signature again: the exact rows, unchanged.
      for (const tissue of [meristem, registry.getByName(authored.name)!]) {
        const again = createCell(tissue, live);
        expect(again).toMatchObject({ name: cell.name, version: refreshedCell.version, consecutiveSuccesses: streak });
        expect(probe(again.tools)).toBe(liveProbe);
        const moleculeAgain = createMolecule(registry, again);
        expect(moleculeAgain).toMatchObject({ name: molecule.name, version: refreshedMolecule.version });
        expect(probe(moleculeAgain.tools)).toBe(liveProbe);
      }
      // The written tissue's row stays as stored; only the run's root holds the live text.
      expect(probe(registry.getByName(authored.name)!.tools)).toBe(STALE_PROBE);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /*
   * Finding 10: `createOrRefresh` treated a row with no recorded baseline (one
   * created before 2026-10-12) as template-born when the template recognised
   * its prompt, while the bootstrap skipped it; its stale declarations then
   * reverted the molecule family the bootstrap had just refreshed.
   */
  it('refreshes a template-born row older than the baselines, and baselines it', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-legacy-template-'));
    try {
      const live = defaultBuiltinTools({ sandbox: new ToolSandbox(root) }).map((tool) => tool.declaration);
      const stale = live.map((tool) => tool.name === 'record_probe' ? { ...tool, description: STALE_PROBE } : tool);
      const registry = new AtomRegistry(openDb(':memory:'));
      const cellTools = scopeTools(stale, CREATE.seed.tools);
      // Guard-shaped: written by plain `create`, as before the baselines existed.
      const guard = registry.create(2, { description: 'cell', systemPrompt: buildNarrowL2Prompt('', cellTools), tools: cellTools, params: {}, createdBy: 'Meristem' });
      expect(registry.templatePrompt(guard)).toBeUndefined();
      const molecule = createMolecule(registry, guard);
      registry.recordSuccess(guard.name, 'test', guard.version);

      const lines: string[] = [];
      seedCatalog({ registry, toolDecls: live, log: (line) => lines.push(line) });
      const refreshed = registry.getByName(guard.name)!;
      expect(lines).toContain(`template-born type refreshed: ${guard.name}`);
      expect(probe(refreshed.tools)).toBe(probe(live));
      expect(refreshed.consecutiveSuccesses).toBe(1);
      expect(registry.templatePrompt(refreshed)).toBe(buildNarrowL2Prompt('', refreshed.tools));
      const refreshedMolecule = registry.getByName(molecule.name)!;
      expect(probe(refreshedMolecule.tools)).toBe(probe(live));

      const again = createMolecule(registry, refreshed);
      expect(again).toMatchObject({ name: molecule.name, version: refreshedMolecule.version });
      expect(probe(again.tools)).toBe(probe(live));
      const settled = registry.getByName(guard.name)!.version;
      seedCatalog({ registry, toolDecls: live, log: () => undefined });
      expect(registry.getByName(guard.name)!.version).toBe(settled);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /*
   * Finding 11: the refresh derived each type's declarations from a listing
   * taken before its transaction, so a validator patch another process
   * committed in between kept its prompt but got back the tool it removed.
   * Two connections on one file; the validator commits right after the listing.
   */
  it('re-reads each type under the write lock, so a concurrent validator patch keeps the tool it removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-template-race-'));
    try {
      const live = defaultBuiltinTools({ sandbox: new ToolSandbox(root) }).map((tool) => tool.declaration);
      const path = join(root, 'store.db');
      const setupDb = openDb(path);
      const validatorDb = openDb(path);
      try {
        const setup = new AtomRegistry(setupDb);
        const validator = new AtomRegistry(validatorDb);
        const names = ['write_file', 'read_file', 'list_files', 'run_shell', 'record_probe'];
        const tools = live.filter((tool) => names.includes(tool.name))
          .map((tool) => tool.name === 'write_file' ? { ...tool, description: STALE_WRITE_FILE } : tool);
        const type = setup.createTemplate(1, { description: 'molecule', systemPrompt: buildNarrowL1Prompt('', tools), tools, params: {}, createdBy: 'cell' });
        const PROMPT = 'You are a validator-written molecule. Never run shell.';
        const list = setup.listByTier.bind(setup);
        let pending = true;
        setup.listByTier = (tier) => {
          const listed = list(tier);
          if (pending && tier === 1) {
            pending = false;
            validator.patch(type.name, { removeTools: ['run_shell'], systemPromptReplace: PROMPT }, 'Validator', 'remove run_shell');
          }
          return listed;
        };
        expect(refreshTemplateBornTypes(setup, live)).not.toContain(type.name);
        expect(pending).toBe(false);
        const after = setup.getByName(type.name)!;
        expect(after.systemPrompt).toBe(PROMPT);
        expect(after.tools.map((tool) => tool.name)).not.toContain('run_shell');
        expect(setup.listVersions(type.name).map((version) => version.reason)).not.toContain('template refresh (custom prompt preserved)');
        expect(after.version).toBe(validator.getByName(type.name)!.version);
      } finally { setupDb.close(); validatorDb.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

const STALE_PROBE = 'OLD record_probe text: use start_node_server followed by fetch_url';
const CREATE = { action: 'create', seed: { tools: ['read_file', 'list_files', 'run_shell', 'record_probe'], params: {} } };
const probe = (tools: readonly Tool[]): string => tools.find((tool) => tool.name === 'record_probe')!.description;
const createMolecule = (registry: AtomRegistry, cell: AtomType): AtomType =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (L2Atom.fromType(cell, registry) as any).createSubtaskL1({ description: 'check' }, CREATE, { description: 'task' });
