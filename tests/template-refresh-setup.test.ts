import { describe, it, expect } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { buildNarrowL1Prompt } from '../src/atoms/L2Atom.js';
import { GROUND_TRUTH_EVIDENCE_LINES, groundTruthEvidenceLines } from '../src/atoms/capability.js';
import { seedCatalog } from '../src/run/setup.js';
import { defaultBuiltinTools } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
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
});
