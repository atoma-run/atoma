import { mockOtherProofReview } from './helpers/delegationReview.js';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTierClients } from '../src/run/providers.js';
import { startTask, resetHostLifecycleSnapshotForTests } from '../src/run/runner.js';
import { SKILL_PREFILTER_SYSTEM_PROMPT } from '../src/atoms/cost.js';
import { buildNarrowL1Prompt } from '../src/atoms/L2Atom.js';
import { buildNarrowL2Prompt } from '../src/atoms/L3Atom.js';
import { scopeTools } from '../src/atoms/toolMerge.js';
import { tissuePrompt } from '../src/run/tissueRouting.js';
import { closeStoreHandles } from '../src/core/stores.js';
import type { AtomRegistry, AtomType } from '../src/registry/atomRegistry.js';
import type { LlmCompletionRequest, Tool } from '../src/core/types.js';
import type { VizRun } from '../src/viz/trace.js';
import { makePlan } from './helpers/factories.js';
import { OLLAMA_PINS } from './tier-pins.js';

vi.mock('../src/run/providers.js', async (original) => ({
  ...await original<typeof import('../src/run/providers.js')>(), buildTierClients: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetHostLifecycleSnapshotForTests();
});

const STALE_PROBE = 'OLD record_probe text: use start_node_server followed by fetch_url with record=true.';
const STALE_WRITE = 'OLD write_file text: writing .atoma-probes.json preserves and merges entries.';
const STALE_MARKER = /OLD (record_probe|write_file) text/;

const staleOf = (live: readonly Tool[]): Tool[] => live.map((tool) =>
  tool.name === 'record_probe' ? { ...tool, description: STALE_PROBE }
    : tool.name === 'write_file' ? { ...tool, description: STALE_WRITE } : tool);

/** A row an L2/L3 validator rewrote: never template-born, so the bootstrap keeps its stale declarations. */
function validatorWritten(registry: AtomRegistry, tier: 1 | 2 | 3, tools: Tool[], prompt: string): AtomType {
  const seedPrompt = tier === 1 ? buildNarrowL1Prompt('', tools) : tier === 2 ? buildNarrowL2Prompt('', tools) : tissuePrompt('Delegate.');
  const row = registry.create(tier, { description: `custom tier ${tier}`, systemPrompt: seedPrompt, tools, params: {}, createdBy: 'test-validator' });
  return registry.patch(row.name, { systemPromptReplace: prompt }, 'test-validator', 'validator patch');
}

/** A template-born molecule of `tools`, written before this release changed two declarations. */
const templateBorn = (registry: AtomRegistry, tools: Tool[]): AtomType => registry.createTemplate(1, {
  description: 'template molecule', systemPrompt: buildNarrowL1Prompt('', tools), tools, params: {}, createdBy: 'test-template',
});

type Row = Pick<AtomType, 'name' | 'version' | 'tools' | 'systemPrompt'>;
const rowsOf = (registry: AtomRegistry): Map<string, Row> => new Map([1, 2, 3].flatMap((tier) =>
  registry.listByTier(tier as 1 | 2 | 3).map(({ name, version, tools, systemPrompt }) => [name, { name, version, tools, systemPrompt }] as const)));

/**
 * THE INVARIANT (review 2026-10-26, third round, findings 3, 5, 6, 7, 8),
 * across the real runner: a store whose tissue, cells and molecules hold
 * STALE declarations of two builtin tools — validator-written rows the
 * bootstrap never refreshes, and template-born rows it does — runs, short
 * and deep, with (a) every model request carrying the LIVE declaration of
 * every builtin tool it declares, and no stale text anywhere in it, and (b)
 * no row's version, declarations or prompt moved by the run: no in-run seed
 * reverts a template-born family, and no validator-written row is rewritten.
 *
 * The routes cover every place an atom or a creation seed is built from a
 * stored row: the root tissue, a reused cell, a short run's entry cell and
 * its mutualized peer, a reused molecule holding a tool its cell lacks, a
 * molecule a cell creates (explicit seed and invented name), and a molecule's
 * escalation branch.
 */
describe('a run executes every stored row on the live declarations and rewrites none of them', () => {
  it.each(['short', 'deep'] as const)('%s', async (depth) => {
    const root = mkdtempSync(join(tmpdir(), `atoma-live-decls-${depth}-`));
    const runs = join(root, 'runs');
    for (const [key, value] of Object.entries({ ...OLLAMA_PINS,
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'), ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: runs,
      ATOMA_BUILD_WORKSPACE: join(root, 'workspace'), ATOMA_BUILD_TIMEOUT_MS: '120000',
      ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0', ATOMA_PREFILTER_CACHE: '0', ATOMA_JEV: '0',
      ATOMA_SKILL_LEARN: '0', ATOMA_SKILL_PROMOTE: '0', ATOMA_DEFER_LEARNING: '1',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    for (const method of ['debug', 'info', 'log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});

    let registry!: AtomRegistry;
    let live: readonly Tool[] = [];
    let before = new Map<string, Row>();
    const custom: AtomType[] = [];
    const names = { tissue: '', cell: '', reused: '', created: '', branchTarget: '', invented: '' };
    const WRITE_TASK = 'Write notes.md';
    const PROBE_TASK = 'Record the notes probe';
    const calls: LlmCompletionRequest[] = [];
    let lastExecutor = '';

    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async (req) => {
      calls.push(req);
      let reply: unknown;
      if (req.actor?.name === 'run-router') reply = { action: 'reuse', name: names.tissue, reasoning: 'Fixture tissue' };
      else if (req.role === 'draft-checklist') reply = { items: [] };
      else if (req.role === 'prefilter' && req.systemPrompt === SKILL_PREFILTER_SYSTEM_PROMPT) reply = { kind: 'none', reasoning: 'No recipe' };
      else if (req.role === 'prefilter') reply = { kind: 'escalate', reasoning: 'Plan it' };
      else if (req.role === 'validate-plan') reply = { approved: true, reasoning: 'Plan approved', ...mockOtherProofReview(req) };
      else if (req.role === 'validate-result') {
        // The reused validator-written molecule is refused until its cell branches it.
        const refuse = req.actor?.tier === 2 && lastExecutor === names.reused && req.userContent.includes(WRITE_TASK);
        reply = refuse
          ? { approved: false, reasoning: 'notes.md lacks the heading', scope: 'ephemeral', modifications: { additionalContext: 'add the heading' } }
          : { approved: true, reasoning: 'Delivery reviewed and accepted' };
      } else if (req.role === 'plan' && req.actor?.tier === 3) reply = [
        { strategy: 'reuse', target: names.cell, reasoning: 'The custom cell' },
        makePlan({ subtasks: [{ description: 'Write and probe the notes', outputs: ['notes.md'] }], aggregation: { mode: 'sequential' } }),
      ];
      else if (req.role === 'plan' && req.actor?.tier === 2 && req.actor.name !== names.cell) reply = [
        { strategy: 'mutualize', target: names.cell, reasoning: 'The peer holds the probe recorder' },
        makePlan({ subtasks: [{ description: 'Write and probe the notes', outputs: ['notes.md'] }], aggregation: { mode: 'sequential' } }),
      ];
      else if (req.role === 'plan' && req.actor?.tier === 2) reply = [
        depth === 'short'
          ? { strategy: 'create', seed: { description: 'probe recorder', tools: ['read_file', 'record_probe'], params: {} }, reasoning: 'A narrow recorder' }
          : { strategy: 'reuse', target: names.reused, reasoning: 'The custom writer' },
        makePlan({
          subtasks: depth === 'short'
            ? [{ description: WRITE_TASK, preferredChild: names.reused, outputs: ['notes.md'] }, { description: PROBE_TASK }]
            : [{ description: WRITE_TASK, outputs: ['notes.md'] }, { description: PROBE_TASK, preferredChild: names.invented }],
          aggregation: { mode: 'sequential' },
        }),
      ];
      else if (req.role === 'plan' || req.role === 'fallback-plan') reply = { reasoning: 'Do it', proposedAction: 'Use the tools', expectedOutput: 'notes.md' };
      else if (req.role === 'execute' || req.role === 'fallback-execute') {
        lastExecutor = req.actor?.name ?? '';
        const writes = req.tools?.some((tool) => tool.name === 'write_file');
        const [name, args] = writes ? ['write_file', { path: 'notes.md', content: '# Notes\n' }] as const : ['read_file', { path: 'notes.md' }] as const;
        const startedAt = Date.now();
        const value = await req.executor!.execute(name, args);
        req.onToolInvocation?.({ name, args, result: value, startedAt, durationMs: Date.now() - startedAt });
        reply = writes ? { output: { files: ['notes.md'] }, summary: 'notes.md written with write_file' }
          : { output: { observed: 'notes.md read back' }, summary: 'notes.md read back with read_file' };
      } else if (req.actor?.name === 'prompt-consolidation') reply = { amendment: null, reason: 'Nothing new.', evidenceIds: [] };
      else throw new Error(`Unexpected request: ${req.role} ${req.actor?.name ?? ''} tier ${req.actor?.tier ?? '?'}`);
      return { text: JSON.stringify(reply), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    } } });

    let run: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      run = await startTask(['--depth', depth, '--clean-workspace', '--no-learn-skills', '--no-direct-skills', 'Write the notes and probe them'], {
        seedCatalog(ctx, canonical) {
          registry = ctx.registry;
          live = ctx.toolDecls;
          const stale = staleOf(live);
          expect(stale).not.toEqual(live);
          // A tissue, a cell and a molecule validators wrote. The cell holds
          // record_probe, which its tissue does not, and the molecule write_file,
          // which its cell does not: neither parent's own declarations can fix them.
          const cellTools = scopeTools(stale, ['read_file', 'run_shell', 'record_probe']);
          const tissue = validatorWritten(registry, 3, scopeTools(stale, ['read_file', 'run_shell', 'write_file']),
            'You are a tissue whose method a validator wrote: verify every write.');
          const cell = validatorWritten(registry, 2, cellTools, 'You are a cell whose prompt a validator wrote: record_probe proves the server.');
          const molecule = validatorWritten(registry, 1, scopeTools(stale, ['write_file', 'read_file', 'record_probe']),
            'You are a molecule whose prompt a validator wrote: write_file the notes, then record_probe.');
          custom.push(tissue, cell, molecule);
          // Template-born molecules of every signature a seed of this run builds:
          // the cell's explicit create, its invented name, and the reused molecule's branch.
          const created = templateBorn(registry, scopeTools(stale, ['read_file', 'record_probe']));
          const invented = templateBorn(registry, cellTools);
          const branch = templateBorn(registry, scopeTools(stale, ['write_file', 'read_file', 'record_probe']));
          Object.assign(names, {
            tissue: tissue.name, cell: cell.name, reused: molecule.name,
            created: depth === 'short' ? created.name : invented.name, branchTarget: branch.name, invented: 'Inventedium',
          });
          canonical(ctx);
          // The bootstrap refreshed the template-born rows and kept the validator-written ones stale.
          for (const row of [created, invented, branch]) expect(registry.getByName(row.name)!.tools).toEqual(scopeTools(live, row.tools.map((tool) => tool.name)));
          for (const row of custom) expect(registry.getByName(row.name)).toMatchObject({ version: row.version, tools: row.tools });
          before = rowsOf(registry);
        },
      });

      const settled = await run.settled;
      const file = readdirSync(runs).find((name) => name.endsWith('.json') && name !== 'index.json')!;
      const trace = JSON.parse(readFileSync(join(runs, file), 'utf8')) as VizRun;
      expect(settled, trace.error).toEqual({ outcome: 'delivered' });
      // One attempt at the requested depth: a short run that deepened would reach its L3 path instead.
      expect(trace.events.filter((event) => event.kind === 'topology').map((event) => event.mode)).toEqual([depth]);

      // The routes ran: the custom cell planned (reused, or mutualized), and the
      // reused molecule, the created one and the escalation branch executed.
      expect(calls.some((req) => req.role === 'plan' && req.actor?.name === names.cell)).toBe(true);
      const executors = new Set(calls.filter((req) => req.role === 'execute').map((req) => req.actor?.name));
      for (const name of [names.reused, names.created, names.branchTarget]) expect(executors).toContain(name);

      // (a) Every request declares the live builtin tools, and carries no stale text.
      const byName = new Map(live.map((tool) => [tool.name, tool]));
      const staleDeclarations = calls.flatMap((req) => (req.tools ?? [])
        .filter((tool) => byName.has(tool.name) && JSON.stringify(tool) !== JSON.stringify(byName.get(tool.name)))
        .map((tool) => `${req.role} ${req.actor?.name ?? ''}: ${tool.name}`));
      expect(staleDeclarations).toEqual([]);
      const staleText = calls.filter((req) => STALE_MARKER.test(`${req.systemPrompt ?? ''}\n${req.userContent}`))
        .map((req) => `${req.role} ${req.actor?.name ?? ''}`);
      expect(staleText).toEqual([]);

      // (b) No row moved: no family flip, no rewritten validator row, no clone.
      const after = rowsOf(registry);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [name, row] of before) expect(after.get(name), name).toEqual(row);
      for (const row of custom) expect(after.get(row.name)!.tools).toEqual(row.tools);
    } finally {
      await run?.shutdown();
      closeStoreHandles();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
