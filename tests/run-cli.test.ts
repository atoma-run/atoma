import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { defaultBuiltinTools } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import {
  MERISTEM_SYSTEM_PROMPT,
  MERISTEM_DESCRIPTION,
  seedTissueCatalog,
} from '../src/run/tissues.js';
import { GOAL_GUIDANCE } from '../src/run/guidance.js';
import { DEPTH_CONTRACT, seedCatalog } from '../src/run/setup.js';
import {
  runTask,
  parseRunnerArgs,
  resolveSkillPromotion,
  formatUsage,
  HELP_FLAGS,
} from '../src/run/runner.js';
import {
  assertIsolationBoundary,
  resolveIsolationRequirement,
} from '../src/run/backendMode.js';
import { RunnerConfigError } from '../src/core/errors.js';

/**
 * Guards for the generic-runner extraction (build-app.ts 541 lines -> a
 * 20-line shell over src/run/runner.ts + src/run/setup.ts).
 *
 * The refactor had to be a pure MOVE, and two things make that non-obvious:
 *
 *  1. SEEDS. `seedTissueCatalog` re-aligns the canonical tier-3 prompt whenever the
 *     constant changes, and `AtomRegistry.patch` resets the trust streak while preserving totals. A
 *     single character drifting during the move would have been the first
 *     tier-3 patch in the project's history. The 2026-10-02 owner correction extends the
 *     post-taxonomy Meristem tissue prompt.
 *
 *  2. STDOUT. `src/cli/burnin.ts` parses the run's console output to build
 *     `burnin/results.csv`, 146 committed rows of longitudinal cost curve.
 *     Three markers are owned by the runner; losing one silently
 *     reclassifies every future run.
 */

const MERISTEM_PROMPT_SHA16 = 'd22aca5eae613f94';

function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

describe('build profile — canonical seed and child catalog', () => {
  it('the tier-3 seed pins the intentional multi-cell prompt correction', () => {
    expect(sha16(MERISTEM_SYSTEM_PROMPT)).toBe(MERISTEM_PROMPT_SHA16);
    expect(MERISTEM_SYSTEM_PROMPT.length).toBe(1141);
  });

  it('seeding twice on a fresh store does not bump the version', () => {
    // The idempotence that keeps trust alive across runs.
    const reg = new AtomRegistry(openDb(':memory:'));
    const sandbox = new ToolSandbox('/tmp');
    const tools = defaultBuiltinTools({ sandbox }).map((t) => t.declaration);
    const log = (): void => undefined;
    const ctx = { registry: reg, toolDecls: tools, log };

    const first = seedTissueCatalog(ctx);
    expect(first.systemPrompt).toBe(MERISTEM_SYSTEM_PROMPT);
    expect(first.description).toBe(MERISTEM_DESCRIPTION);
    seedCatalog(ctx);
    const versionsAfterFirst = reg
      .listByTier(1)
      .concat(reg.listByTier(2), reg.listByTier(3))
      .map((t) => `${t.name}:v${t.version}`)
      .sort();

    const second = seedTissueCatalog(ctx);
    seedCatalog(ctx);
    const versionsAfterSecond = reg
      .listByTier(1)
      .concat(reg.listByTier(2), reg.listByTier(3))
      .map((t) => `${t.name}:v${t.version}`)
      .sort();

    expect(second.name).toBe(first.name);
    expect(versionsAfterSecond).toEqual(versionsAfterFirst);
  });

  it('seeds four L1 buckets and three L2 orchestrators', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const tools = defaultBuiltinTools({ sandbox: new ToolSandbox('/tmp') }).map(
      (t) => t.declaration
    );
    const ctx = { registry: reg, toolDecls: tools, log: (): void => undefined };
    seedTissueCatalog(ctx);
    seedCatalog(ctx);
    expect(reg.listByTier(1)).toHaveLength(4);
    expect(reg.listByTier(2)).toHaveLength(3);
    expect(reg.listByTier(3)).toHaveLength(1);
  });

  it('keeps launch configuration independent of task constraints and root identity', () => {
    expect(DEPTH_CONTRACT.defaultMode).toBe('deep');
    expect(DEPTH_CONTRACT.floor).toEqual([]);
  });
});

describe('runner CLI parsing — the declared grammar is load-bearing', () => {
  it('keeps the goal that FOLLOWS --clean-workspace', () => {
    // The old greedy grammar treated --clean-workspace as a flag-with-value
    // and swallowed the goal, silently falling back to the default
    // Minesweeper task on every burn-in run. The runner now declares its
    // booleans to the SHARED parser; this pin proves a declared boolean
    // never consumes the token after it.
    const args = parseRunnerArgs(['--clean-workspace', 'Build a CSV merger CLI']);
    expect(args.cleanWorkspace).toBe(true);
    expect(args.goal).toBe('Build a CSV merger CLI');
  });

  it('reads the skill kill switches and takes the FIRST positional as the goal', () => {
    const args = parseRunnerArgs([
      'first goal',
      'second ignored',
      '--no-learn-skills',
      '--no-promote-skills',
      '--no-direct-skills',
    ]);
    expect(args.goal).toBe('first goal');
    expect(args.noLearnSkills).toBe(true);
    expect(args.noPromoteSkills).toBe(true);
    expect(args.noDirectSkills).toBe(true);
  });

  it('marks --seed as maintenance context without swallowing the goal', () => {
    const args = parseRunnerArgs([
      '--seed',
      'benchmark/fixtures/wclite',
      'Maintain the seeded CLI',
    ]);
    expect(args.seed).toBe('benchmark/fixtures/wclite');
    expect(args.goal).toBe('Maintain the seeded CLI');
  });
});

/**
 * Equivalence pins for the hand-rolled-loop → shared-parser adapter rewrite
 * (review §3.9 residual). Every invocation below is one the old parser
 * accepted — burn-in spawns them, MCP `spawnRun` orders flags before the
 * goal — and each must parse byte-identically through `parseArgTokens`.
 */
describe('parseRunnerArgs equivalence — documented invocations', () => {
  const ENV_KEYS = ['ATOMA_BASELINE', 'ATOMA_SEED', 'ATOMA_CONTAINER', 'ATOMA_EGRESS'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it('goal only: everything defaults off, goal is the first positional', () => {
    expect(parseRunnerArgs(['build a thing'])).toEqual({
      goal: 'build a thing',
      noLearnSkills: false,
      noPromoteSkills: false,
      noDirectSkills: false,
      cleanWorkspace: false,
      container: false,
      egress: false,
      baseline: false,
      // An ordinary run is not a measurement arm, so it takes the family's
      // supervision default (tests/project-run-supervision-depth.test.ts).
      comparison: false,
    });
  });

  it('--baseline goal, and --no-baseline overrides ATOMA_BASELINE=1', () => {
    const a = parseRunnerArgs(['--baseline', 'compare the arms']);
    expect(a.baseline).toBe(true);
    expect(a.goal).toBe('compare the arms');

    process.env['ATOMA_BASELINE'] = '1';
    expect(parseRunnerArgs(['g']).baseline).toBe(true);
    expect(parseRunnerArgs(['--no-baseline', 'g']).baseline).toBe(false);
    // Last spelling wins, exactly like the old sequential loop.
    expect(parseRunnerArgs(['--no-baseline', '--baseline', 'g']).baseline).toBe(true);
  });

  it('--no-learn-skills is a bare boolean, never a value flag', () => {
    const a = parseRunnerArgs(['--no-learn-skills', 'the goal']);
    expect(a.noLearnSkills).toBe(true);
    expect(a.goal).toBe('the goal');
  });

  it('--seed X goal: flag wins over ATOMA_SEED; env is the fallback', () => {
    process.env['ATOMA_SEED'] = 'env/dir';
    expect(parseRunnerArgs(['g']).seed).toBe('env/dir');
    expect(parseRunnerArgs(['--seed', 'cli/dir', 'g']).seed).toBe('cli/dir');
    // A trailing --seed clobbers the env default (historical contract: the
    // old loop assigned `argv[++i]` — undefined — over the env value).
    expect(parseRunnerArgs(['g', '--seed']).seed).toBeUndefined();
  });

  it('--container/--egress pass through resolveToolBackendMode unchanged', () => {
    expect(parseRunnerArgs(['--container', 'g'])).toMatchObject({
      container: true,
      egress: false,
      goal: 'g',
    });
    // Egress implies container — the implication lives in backendMode.ts,
    // and the adapter must not shadow it with its own parsed values.
    expect(parseRunnerArgs(['--egress', '--no-container', 'g'])).toMatchObject({
      container: true,
      egress: true,
      goal: 'g',
    });
  });

  it('isolation is off by default and switched on by the HOST environment', () => {
    expect(resolveIsolationRequirement({})).toBe(false);
    expect(resolveIsolationRequirement({ ATOMA_REQUIRE_ISOLATION: '1' })).toBe(true);
    // Anything other than the exact opt-in leaves it off — the same
    // fail-closed-on-invalid shape the other lifecycle toggles use.
    expect(resolveIsolationRequirement({ ATOMA_REQUIRE_ISOLATION: 'true' })).toBe(false);
    // An embedder's explicit choice outranks the environment in both
    // directions.
    expect(resolveIsolationRequirement({ ATOMA_REQUIRE_ISOLATION: '1' }, false)).toBe(false);
    expect(resolveIsolationRequirement({}, true)).toBe(true);
  });

  it('refuses the local backend when a boundary is required (T1)', () => {
    // The local backend was never a boundary: run_shell spawns an unjailed
    // child with the workspace as cwd, so `../..` reaches the stores.
    expect(() => assertIsolationBoundary({ container: false, egress: false }, true)).toThrow(
      RunnerConfigError
    );
    expect(() => assertIsolationBoundary({ container: false, egress: false }, true)).toThrow(
      /not a boundary/
    );
    // Both containerised modes satisfy it: `--network none` reaches nothing,
    // and --egress routes through a per-run allowlisted proxy.
    expect(() =>
      assertIsolationBoundary({ container: true, egress: false }, true)
    ).not.toThrow();
    expect(() => assertIsolationBoundary({ container: true, egress: true }, true)).not.toThrow();
    // Not required: the developer path is untouched.
    expect(() =>
      assertIsolationBoundary({ container: false, egress: false }, false)
    ).not.toThrow();
  });

  it('an unknown flag is warn-and-DISCARDED and never eats the goal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = parseRunnerArgs(['--contianer', 'build X']);
    // The goal SURVIVES: swallowing it would silently run the profile's
    // default goal instead (the failure mode pinned in mcp-server.test.ts).
    expect(a.goal).toBe('build X');
    expect(a.container).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('unknown flag: --contianer');
  });
});

describe('runTask --help — usage, never a run', () => {
  // `--help` used to be an UNKNOWN flag: discarded with a warning, after
  // which the runner fell through to the profile's default goal and started
  // a real, quota-spending run (2026-09-07). Usage is answered before
  // startTask, so it needs no tier pins and touches nothing.
  const PINS = ['ATOMA_MODEL_L1', 'ATOMA_MODEL_L2', 'ATOMA_MODEL_L3'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of PINS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of PINS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it.each(HELP_FLAGS)('%s prints the usage and returns without pins or a run', async (flag) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''}) must not be called`);
    }) as never);

    await expect(runTask([flag])).resolves.toBeUndefined();

    expect(exit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(formatUsage());
  });

  it('the usage is derived from the goal guidance and the runner flags', () => {
    const usage = formatUsage();
    expect(usage).toContain('Usage: run');
    expect(usage).toContain(GOAL_GUIDANCE.help);
    for (const example of GOAL_GUIDANCE.examples) expect(usage).toContain(example);
    for (const flag of ['--clean-workspace', '--container', '--no-container', '--egress', '--seed <dir>', '--help, -h']) {
      expect(usage).toContain(flag);
    }
    expect(usage).toContain('ATOMA_MODEL_L1');
  });
});

describe('runner skill-promotion policy — pure, no provider calls', () => {
  // Owner decision 2026-09-26: a recipe that can be compiled is compiled at
  // learn time on EVERY run. The seed no longer decides anything here.
  it('enables compilation by default on an unseeded run', () => {
    expect(resolveSkillPromotion({ noPromoteSkills: false }, undefined)).toEqual({
      enabled: true,
      source: 'default-enable',
    });
  });

  it('keeps exact ATOMA_SKILL_PROMOTE=1 as an explicit opt-in', () => {
    expect(resolveSkillPromotion({ noPromoteSkills: false }, '1')).toEqual({
      enabled: true,
      source: 'environment-enable',
    });
  });

  it('lets an explicit environment opt-out override the default', () => {
    expect(resolveSkillPromotion({ noPromoteSkills: false }, '0')).toEqual({
      enabled: false,
      source: 'environment-disable',
    });
  });

  it('fails closed on mistyped environment opt-ins', () => {
    expect(resolveSkillPromotion({ noPromoteSkills: false }, 'true')).toEqual({
      enabled: false,
      source: 'environment-disable',
    });
  });

  it('makes --no-promote-skills the final veto over an env opt-in', () => {
    expect(resolveSkillPromotion({ noPromoteSkills: true }, '1')).toEqual({
      enabled: false,
      source: 'cli-disable',
    });
  });
});

describe('runner stdout contract — burn-in parses this', () => {
  const src = readFileSync('src/run/runner.ts', 'utf8');

  // Prose outcome markers remain stable for interrupted runs that cannot
  // emit the structured epilogue.
  it.each([
    ['✓ build finished', 'delivered'],
    ['--- run failed ---', 'failed'],
    ['TIMEOUT after', 'failed'],
  ])('still emits %s (burn-in reads it as "%s")', (marker) => {
    expect(src).toContain(marker);
  });

  // The runner's stdout is an operator-facing API (burn-in parses it, and
  // `docs`/README quote it). It shipped two FRENCH lines on an otherwise
  // English stream — the user speaks French, the product does not.
  it('keeps the trace-recorded line English on both the delivered and failed paths', () => {
    expect(src.match(/run recorded in \$\{recorder\.runsDir\}/g)).toHaveLength(2);
    expect(src).not.toMatch(/enregistr|visualiseur|d\u00e9marre/);
  });

  // Epilogues are exercised through startTask in project-retrieval-runner.test.ts,
  // including delivered, failed-model and infrastructure-preparation outcomes.

  it('exposes runTask taking argv', () => {
    expect(typeof runTask).toBe('function');
    expect(runTask.length).toBe(1);
  });
});
