import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertPlatformSettingValue,
  ceilingOf,
  DEFAULT_PLATFORM_LIMITS,
  PLATFORM_SETTING_KEYS,
  PLATFORM_SETTING_SPECS,
  PLATFORM_SETTINGS,
  PlatformSettingError,
  platformSettingOverridesSchema,
  platformSettingsUpdateSchema,
  resolvePlatformLimits,
} from '../src/contracts/platformSettings.js';
import {
  DEFAULT_CLI_CALL_TIMEOUT_MS,
  ClaudeCliLlmClient,
} from '../src/core/llmClaudeCli.js';
import {
  DEFAULT_CODEX_CALL_TIMEOUT_MS,
  CodexCliLlmClient,
} from '../src/core/llmCodexCli.js';
import { DEFAULT_MAX_TOOL_ITERATIONS } from '../src/core/llm.js';
import {
  billableTokensOf,
  capRequestedToolIterations,
  RunBudgetExceededError,
  RunBudgetMeter,
  ToolIterationCeilingLlmClient,
} from '../src/core/runBudget.js';
import type { LlmCallMetrics, MetricsRecorder } from '../src/core/metrics.js';
import { closeStoreHandles } from '../src/core/stores.js';
import {
  PLATFORM_SETTINGS_TABLE_DDL,
  PlatformSettingsStore,
  platformLimitsFor,
} from '../src/platform/settings.js';
import {
  DEFAULT_PROJECT_RUN_TIMEOUT_MS,
  MAX_PROJECT_RUN_TIMEOUT_MS,
  MIN_PROJECT_RUN_TIMEOUT_MS,
  PROJECT_RUN_TIMEOUT_ENV,
  ProjectRunConfigurationError,
  projectRunTimeoutMs,
} from '../src/projects/coordinator.js';
import type { LlmClient, LlmCompletionRequest } from '../src/core/types.js';
import { makeTransportClient } from '../src/run/providers.js';

const roots: string[] = [];

afterEach(() => {
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openStore(now?: () => Date): { store: PlatformSettingsStore; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'atoma-platform-settings-'));
  roots.push(root);
  const dbPath = join(root, 'atoma.db');
  return { store: PlatformSettingsStore.open(dbPath, now), dbPath };
}

/**
 * THE REGRESSION THAT MATTERS MOST.
 *
 * The whole premise of the settings surface is that adding it changed no
 * limit: an instance with no rows must behave exactly as one built before the
 * feature existed. Every fallback is therefore pinned against the constant it
 * replaced, at the module that owns that constant — not against a literal
 * copied into this file, which would pass while the two drifted.
 */
describe('the catalog ships today’s constants, unchanged', () => {
  it('pins every fallback to the constant its call site already used', () => {
    expect(PLATFORM_SETTINGS['run.concurrentMax'].fallback).toBe(10);
    expect(PLATFORM_SETTINGS['run.timeoutDefaultMs'].fallback).toBe(
      DEFAULT_PROJECT_RUN_TIMEOUT_MS
    );
    expect(PLATFORM_SETTINGS['run.timeoutMaxMs'].fallback).toBe(MAX_PROJECT_RUN_TIMEOUT_MS);
    // The call timeouts shipped as DEFAULTS their env var may raise, so with no
    // row there is NO ceiling on them (2026-09-30 review): a fallback equal to
    // the default made the env var unable to raise a timeout any more.
    for (const key of ['llm.callTimeoutMs', 'llm.codexCallTimeoutMs'] as const) {
      expect(PLATFORM_SETTINGS[key].zeroMeansUnlimited, key).toBe(true);
      expect(ceilingOf(DEFAULT_PLATFORM_LIMITS, key), key).toBeNull();
    }
    // 60s of watchdog grace, and the value the runner used as a literal.
    expect(PLATFORM_SETTINGS['run.watchdogGraceMs'].fallback).toBe(60_000);
  });

  it('leaves an exported call timeout as it was when no row is stated', () => {
    vi.stubEnv('ATOMA_CLI_CALL_TIMEOUT_MS', '900000');
    try {
      const claude = makeTransportClient('claude-cli', { limits: DEFAULT_PLATFORM_LIMITS }) as unknown as { callTimeoutMs: number };
      const codex = makeTransportClient('codex-cli', {
        env: { ...process.env, ATOMA_CODEX_CALL_TIMEOUT_MS: '900000' }, limits: DEFAULT_PLATFORM_LIMITS,
      }) as unknown as { callTimeoutMs: number };
      expect(claude.callTimeoutMs).toBe(900_000);
      expect(codex.callTimeoutMs).toBe(900_000);
      // And with nothing exported, the shipped defaults.
      vi.stubEnv('ATOMA_CLI_CALL_TIMEOUT_MS', '');
      delete process.env['ATOMA_CLI_CALL_TIMEOUT_MS'];
      expect((makeTransportClient('claude-cli', { limits: DEFAULT_PLATFORM_LIMITS }) as unknown as { callTimeoutMs: number }).callTimeoutMs)
        .toBe(DEFAULT_CLI_CALL_TIMEOUT_MS);
      expect((makeTransportClient('codex-cli', { env: {}, limits: DEFAULT_PLATFORM_LIMITS }) as unknown as { callTimeoutMs: number }).callTimeoutMs)
        .toBe(DEFAULT_CODEX_CALL_TIMEOUT_MS);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('leaves the two spend ceilings and the tool loop DISABLED by default', () => {
    // A ceiling of 24 iterations would have silently shortened every
    // validated tool loop (the tiers ask for 40) the day this landed.
    for (const key of ['run.tokenMaxTotal', 'run.costMaxUsd', 'llm.maxToolIterations'] as const) {
      expect(PLATFORM_SETTINGS[key].zeroMeansUnlimited).toBe(true);
      expect(DEFAULT_PLATFORM_LIMITS[key]).toBe(0);
      expect(ceilingOf(DEFAULT_PLATFORM_LIMITS, key)).toBeNull();
    }
    // And a ceiling that does NOT treat zero as unlimited never reports null,
    // whatever its value — that is the distinction `ceilingOf` exists for.
    expect(ceilingOf({ ...DEFAULT_PLATFORM_LIMITS, 'run.timeoutMaxMs': 60_000 }, 'run.timeoutMaxMs')).toBe(
      60_000
    );
  });

  it('states bounds that contain the default, for every entry', () => {
    for (const spec of PLATFORM_SETTING_SPECS) {
      // A disabled ceiling's 0 sits below the minimum of a STATED one.
      if (!(spec.zeroMeansUnlimited && spec.fallback === 0)) expect(spec.min, spec.key).toBeLessThanOrEqual(spec.fallback);
      expect(spec.max, spec.key).toBeGreaterThanOrEqual(spec.fallback);
      expect(spec.summary.length, spec.key).toBeGreaterThan(0);
      expect(spec.readAt.length, spec.key).toBeGreaterThan(0);
    }
  });

  it('resolves purely: no environment, no store, no clock', () => {
    vi.stubEnv('ATOMA_PROJECT_TIMEOUT_MS', '2400000');
    vi.stubEnv('ATOMA_CLI_CALL_TIMEOUT_MS', '90000');
    try {
      // The env vars are METADATA on the spec, read by their existing owners.
      // A resolver that folded them would be a second reader for the same
      // number, which is the drift this split exists to prevent.
      expect(resolvePlatformLimits()).toEqual(DEFAULT_PLATFORM_LIMITS);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the catalog is the schema', () => {
  it('refuses an unknown key and an out-of-range value', () => {
    expect(platformSettingOverridesSchema.safeParse({ 'run.nope': 1 }).success).toBe(false);
    expect(
      platformSettingOverridesSchema.safeParse({ 'run.timeoutMaxMs': 30_000 }).success
    ).toBe(false);
    expect(
      platformSettingOverridesSchema.safeParse({ 'run.timeoutMaxMs': 3_600_000 }).success
    ).toBe(true);
  });

  it('requires integers everywhere except the one entry priced in dollars', () => {
    expect(() => assertPlatformSettingValue('run.tokenMaxTotal', 1.5)).toThrow(
      PlatformSettingError
    );
    expect(assertPlatformSettingValue('run.costMaxUsd', 2.5)).toBe(2.5);
    expect(() => assertPlatformSettingValue('run.costMaxUsd', Number.NaN)).toThrow(
      PlatformSettingError
    );
  });

  it('refuses out of range rather than clamping', () => {
    // A silently rewritten limit is the defect `projectRunTimeoutMs` already
    // refuses to reproduce; the message names the bounds and the unit.
    expect(() => assertPlatformSettingValue('run.timeoutMaxMs', 172_800_000)).toThrow(
      /outside 60000\.\.86400000 \(ms\)/
    );
  });

  it('refuses a key that is both set and cleared', () => {
    expect(
      platformSettingsUpdateSchema.safeParse({
        set: { 'run.timeoutMaxMs': 3_600_000 },
        clear: ['run.timeoutMaxMs'],
      }).success
    ).toBe(false);
    const both = platformSettingsUpdateSchema.safeParse({
      set: { 'run.timeoutMaxMs': 3_600_000 },
      clear: ['run.tokenMaxTotal'],
    });
    expect(both.success).toBe(true);
  });

  it('defaults both halves so an empty body parses to a no-op', () => {
    const parsed = platformSettingsUpdateSchema.parse({});
    expect(parsed).toEqual({ set: {}, clear: [] });
  });
});

describe('the settings store', () => {
  it('is sparse: a stated row exists, an untouched key does not', () => {
    const { store } = openStore();
    expect(store.rows()).toEqual([]);
    expect(store.limits()).toEqual(DEFAULT_PLATFORM_LIMITS);

    store.set({ 'run.tokenMaxTotal': 5_000_000 }, 'principal-1');
    expect(store.overrides()).toEqual({ 'run.tokenMaxTotal': 5_000_000 });
    expect(store.limits()['run.tokenMaxTotal']).toBe(5_000_000);
    // Untouched keys stay at the shipped constant, not at a written copy.
    expect(store.limits()['run.timeoutMaxMs']).toBe(
      PLATFORM_SETTINGS['run.timeoutMaxMs'].fallback
    );
  });

  it('clears by REMOVING the row, so a later default change still reaches here', () => {
    const { store, dbPath } = openStore();
    store.set({ 'run.costMaxUsd': 2.5 }, 'principal-1');
    expect(store.clear(['run.costMaxUsd'])).toEqual(['run.costMaxUsd']);
    expect(store.rows()).toEqual([]);
    // Not "0 written back": no row at all.
    const raw = new Database(dbPath);
    try {
      expect(raw.prepare('SELECT COUNT(*) AS n FROM platform_settings').get()).toEqual({ n: 0 });
    } finally {
      raw.close();
    }
    // Clearing a key nobody stated reports nothing cleared, rather than lying.
    expect(store.clear(['run.costMaxUsd'])).toEqual([]);
  });

  it('keeps a dollar value to the cent — the column is REAL for this reason', () => {
    const { store } = openStore();
    store.set({ 'run.costMaxUsd': 2.5 }, 'principal-1');
    expect(store.limits()['run.costMaxUsd']).toBe(2.5);
  });

  it('records who stated a row, and null for the operator CLI', () => {
    const { store } = openStore(() => new Date('2026-09-04T10:00:00.000Z'));
    store.set({ 'run.tokenMaxTotal': 10 }, 'principal-7');
    store.set({ 'run.costMaxUsd': 1 }, null);
    const rows = new Map(store.rows().map((row) => [row.key, row]));
    expect(rows.get('run.tokenMaxTotal')?.updatedBy).toBe('principal-7');
    expect(rows.get('run.costMaxUsd')?.updatedBy).toBeNull();
    expect(rows.get('run.tokenMaxTotal')?.updatedAt).toBe('2026-09-04T10:00:00.000Z');
  });

  it('validates the WHOLE batch before writing any of it', () => {
    const { store } = openStore();
    expect(() =>
      store.set({ 'run.tokenMaxTotal': 10, 'run.timeoutMaxMs': 1 }, 'principal-1')
    ).toThrow(PlatformSettingError);
    // A form that sent four numbers of which one is out of range must change
    // nothing, or the admin is left guessing which half landed.
    expect(store.rows()).toEqual([]);
  });

  it('TOLERATES a foreign row and an out-of-range one, without trusting either', () => {
    const { store, dbPath } = openStore();
    const raw = new Database(dbPath);
    try {
      raw.exec(PLATFORM_SETTINGS_TABLE_DDL);
      raw
        .prepare(
          'INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)'
        )
        .run('run.fromTheFuture', 42, '2026-09-04T00:00:00.000Z', null);
      raw
        .prepare(
          'INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)'
        )
        .run('run.timeoutMaxMs', 999_999_999_999, '2026-09-04T00:00:00.000Z', null);
    } finally {
      raw.close();
    }
    // Neither becomes policy: the settings this build enforces are the ones
    // it can name, inside the bounds it declares.
    expect(store.rows()).toEqual([]);
    expect(store.limits()).toEqual(DEFAULT_PLATFORM_LIMITS);
  });

  it('renders rows in CATALOG order, not insertion order', () => {
    const { store } = openStore();
    store.set({ 'llm.callTimeoutMs': 120_000 }, null);
    store.set({ 'run.timeoutMaxMs': 3_600_000 }, null);
    expect(store.rows().map((row) => row.key)).toEqual([
      'run.timeoutMaxMs',
      'llm.callTimeoutMs',
    ]);
  });

  it('reads FAIL OPEN: no store means the shipped constants, never a throw', () => {
    // A run must never fail to launch because the settings table is absent.
    expect(platformLimitsFor(join(tmpdir(), 'atoma-no-such-dir-19f3', 'atoma.db'))).toEqual(
      DEFAULT_PLATFORM_LIMITS
    );
  });
});

describe('a platform ceiling binds the project run budget', () => {
  it('narrows the default and REFUSES a request above the ceiling', () => {
    const limits = resolvePlatformLimits({
      'run.timeoutMaxMs': 1_800_000,
      'run.timeoutDefaultMs': 600_000,
    });
    expect(projectRunTimeoutMs({}, undefined, limits)).toBe(600_000);
    expect(projectRunTimeoutMs({}, 1_800_000, limits)).toBe(1_800_000);
    // Refused, not clamped — the same contract an out-of-range flag already
    // gets, so an operator who asked for an hour is never quietly given 30
    // minutes.
    expect(() => projectRunTimeoutMs({}, 3_600_000, limits)).toThrow(
      ProjectRunConfigurationError
    );
    expect(() => projectRunTimeoutMs({}, 3_600_000, limits)).toThrow(/outside 60000\.\.1800000ms/);
    // The env var is a launch-time REQUEST and is bounded the same way.
    expect(() =>
      projectRunTimeoutMs({ [PROJECT_RUN_TIMEOUT_ENV]: '3600000' }, undefined, limits)
    ).toThrow(ProjectRunConfigurationError);
  });

  it('lets an admin only NARROW the ceiling, never raise it past the constant', () => {
    // MAX_PROJECT_RUN_TIMEOUT_MS is what the child's watchdog and the burn-in
    // reaper were sized against; a setting above it would move two deadlines
    // this module does not own.
    const limits = resolvePlatformLimits({ 'run.timeoutMaxMs': 86_400_000 });
    expect(() => projectRunTimeoutMs({}, 86_400_000, limits)).toThrow(
      ProjectRunConfigurationError
    );
    expect(projectRunTimeoutMs({}, MAX_PROJECT_RUN_TIMEOUT_MS, limits)).toBe(
      MAX_PROJECT_RUN_TIMEOUT_MS
    );
  });

  it('honours the TIGHTER of a default above its own ceiling', () => {
    // Two settings that disagree must not fail every run on the instance.
    const limits = resolvePlatformLimits({
      'run.timeoutDefaultMs': 7_200_000,
      'run.timeoutMaxMs': 600_000,
    });
    expect(projectRunTimeoutMs({}, undefined, limits)).toBe(600_000);
  });

  it('behaves exactly as before when nothing is stated', () => {
    expect(projectRunTimeoutMs({})).toBe(DEFAULT_PROJECT_RUN_TIMEOUT_MS);
    expect(projectRunTimeoutMs({}, MIN_PROJECT_RUN_TIMEOUT_MS)).toBe(MIN_PROJECT_RUN_TIMEOUT_MS);
    expect(projectRunTimeoutMs({}, MAX_PROJECT_RUN_TIMEOUT_MS)).toBe(MAX_PROJECT_RUN_TIMEOUT_MS);
  });
});

function call(overrides: Partial<LlmCallMetrics> = {}): LlmCallMetrics {
  return {
    model: 'claude-haiku-4-5',
    inputTokens: 1_000,
    outputTokens: 100,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    durationMs: 10,
    stopReason: 'end_turn',
    ...overrides,
  };
}

describe('the run budget meter', () => {
  it('counts ALL FOUR disjoint token counters', () => {
    // `input_tokens` is only the content after the last cache breakpoint, so
    // input+output alone would undercount a cache-heavy run by most of its
    // volume.
    expect(
      billableTokensOf({
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationInputTokens: 4,
        cacheReadInputTokens: 8,
      })
    ).toBe(15);
  });

  it('fires ONCE on the token ceiling, and forwards every call regardless', () => {
    const seen: LlmCallMetrics[] = [];
    const inner: MetricsRecorder = { record: (metrics) => seen.push(metrics) };
    const fired: RunBudgetExceededError[] = [];
    const meter = new RunBudgetMeter(inner, { tokens: 2_000, costUsd: null }, (error) =>
      fired.push(error)
    );
    meter.record(call()); // 1_100
    expect(fired).toHaveLength(0);
    meter.record(call()); // 2_200 — over
    meter.record(call());
    meter.record(call());
    // A run keeps calling for as long as the abort takes to land, and an
    // operator does not need four rows saying the same thing.
    expect(fired).toHaveLength(1);
    expect(fired[0]!.kind).toBe('tokens');
    expect(fired[0]!.observed).toBe(2_200);
    expect(fired[0]!.ceiling).toBe(2_000);
    // The inner recorder saw every call INCLUDING the one that crossed: the
    // summary must carry the evidence for the cancellation.
    expect(seen).toHaveLength(4);
    expect(meter.consumed().tokens).toBe(4_400);
  });

  it('fires on the spend ceiling, using the one cost formula', () => {
    const fired: RunBudgetExceededError[] = [];
    const meter = new RunBudgetMeter(
      { record: () => {} },
      { tokens: null, costUsd: 0.01 },
      (error) => fired.push(error)
    );
    // Haiku at $1/$5 per million: 1M input + 1M output = $6.
    meter.record(call({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    expect(fired).toHaveLength(1);
    expect(fired[0]!.kind).toBe('cost');
    expect(fired[0]!.message).toMatch(/run cost ceiling exceeded/);
  });

  it('never fires when both ceilings are disabled', () => {
    const fired: RunBudgetExceededError[] = [];
    const meter = new RunBudgetMeter(
      { record: () => {} },
      { tokens: null, costUsd: null },
      (error) => fired.push(error)
    );
    for (let index = 0; index < 50; index += 1) {
      meter.record(call({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    }
    expect(fired).toEqual([]);
  });
});

describe('the tool-iteration ceiling', () => {
  it('only ever LOWERS a request', () => {
    expect(capRequestedToolIterations(40, null)).toBe(40);
    expect(capRequestedToolIterations(40, 12)).toBe(12);
    expect(capRequestedToolIterations(8, 12)).toBe(8);
    // A request that named no budget must not be RAISED to the ceiling: a
    // limit that increased spend is not a limit.
    expect(capRequestedToolIterations(undefined, 50)).toBe(DEFAULT_MAX_TOOL_ITERATIONS);
    expect(capRequestedToolIterations(undefined, 5)).toBe(5);
    expect(capRequestedToolIterations(undefined, null)).toBeUndefined();
    // A ceiling of zero reaches this function as `null` via `ceilingOf`, so a
    // stray non-positive value still leaves one usable iteration.
    expect(capRequestedToolIterations(40, 0)).toBe(1);
  });

  it('passes the capped request through to the transport', async () => {
    const seen: LlmCompletionRequest[] = [];
    const inner: LlmClient = {
      complete: async (req) => {
        seen.push(req);
        return {
          text: 'ok',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const client = new ToolIterationCeilingLlmClient(inner, 3);
    const request: LlmCompletionRequest = {
      model: 'claude-haiku-4-5',
      systemPrompt: 's',
      userContent: 'u',
      maxToolIterations: 40,
    };
    await client.complete(request);
    expect(seen[0]!.maxToolIterations).toBe(3);
    // The caller's own request object is untouched — the decorator copies.
    expect(request.maxToolIterations).toBe(40);
  });
});

describe('a platform ceiling binds one LLM call', () => {
  it('binds the claude-cli transport below its env var and its default', () => {
    vi.stubEnv('ATOMA_CLI_CALL_TIMEOUT_MS', '1200000');
    try {
      const bound = new ClaudeCliLlmClient({ callTimeoutCeilingMs: 90_000 });
      expect(callTimeoutOf(bound)).toBe(90_000);
      // Below the ceiling, the request stands.
      const asked = new ClaudeCliLlmClient({
        callTimeoutMs: 45_000,
        callTimeoutCeilingMs: 90_000,
      });
      expect(callTimeoutOf(asked)).toBe(45_000);
      // No ceiling: exactly the behaviour that shipped.
      expect(callTimeoutOf(new ClaudeCliLlmClient())).toBe(1_200_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('binds the codex transport the same way', () => {
    vi.stubEnv('ATOMA_CODEX_CALL_TIMEOUT_MS', '1200000');
    try {
      expect(callTimeoutOf(new CodexCliLlmClient({ callTimeoutCeilingMs: 60_000 }))).toBe(60_000);
      expect(callTimeoutOf(new CodexCliLlmClient())).toBe(1_200_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/**
 * The transports keep `callTimeoutMs` private, and deliberately: it is not a
 * knob anything downstream may read. The ceiling is still a behavioural
 * property worth pinning, so the test reads the field it cannot ask for —
 * narrower than driving a real subprocess, and honest about what it is doing.
 */
function callTimeoutOf(client: object): number {
  return (client as { callTimeoutMs: number }).callTimeoutMs;
}

describe('the operator CLI', () => {
  /**
   * The CLI exists for the deployment whose ceiling is what broke the
   * browser: it needs no server, no gate and no session. Driven in-process
   * through the exported entrypoint, which is why `runSettingsCli` returns an
   * exit code instead of calling `process.exit` — the same shape `runAuthCli`
   * settled on.
   */
  async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const { runSettingsCli } = await import('../src/cli/settings.js');
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...parts) => {
      out.push(parts.map(String).join(' '));
    });
    const error = vi.spyOn(console, 'error').mockImplementation((...parts) => {
      err.push(parts.map(String).join(' '));
    });
    try {
      return { code: runSettingsCli(['node', 'settings', ...argv]), out: out.join('\n'), err: err.join('\n') };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }

  it('sets, lists and unsets against a store on disk', async () => {
    const { dbPath } = openStore();
    const set = await cli(['set', 'run.tokenMaxTotal', '5000000', '--db', dbPath]);
    expect(set.code).toBe(0);
    expect(set.out).toContain('run.tokenMaxTotal: unlimited → 5000000');

    const listed = await cli(['list', '--db', dbPath]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('effective 5000000');
    // A default nobody stated still reports its effective value, and says so.
    expect(listed.out).toContain('default (nothing stated)');
    expect(listed.out).toContain(`1 of ${PLATFORM_SETTING_KEYS.length} stated`);

    const unset = await cli(['unset', 'run.tokenMaxTotal', '--db', dbPath]);
    expect(unset.code).toBe(0);
    expect(unset.out).toContain('back to the shipped default unlimited');
    // Clearing what nobody stated says nothing moved rather than claiming it did.
    expect((await cli(['unset', 'run.tokenMaxTotal', '--db', dbPath])).out).toContain(
      'nothing stated'
    );
  });

  it('accepts a duration suffix where the unit is milliseconds', async () => {
    const { store, dbPath } = openStore();
    expect((await cli(['set', 'run.timeoutMaxMs', '90m', '--db', dbPath])).code).toBe(0);
    expect(store.limits()['run.timeoutMaxMs']).toBe(5_400_000);
    expect((await cli(['set', 'llm.callTimeoutMs', '45s', '--db', dbPath])).code).toBe(0);
    expect(store.limits()['llm.callTimeoutMs']).toBe(45_000);
    // A suffix is not accepted where it would be meaningless.
    const counted = await cli(['set', 'llm.maxToolIterations', '12m', '--db', dbPath]);
    expect(counted.code).toBe(2);
    expect(counted.err).toContain('is not a number');
  });

  it('exits 2 on an unknown key, an unknown command and an out-of-range value', async () => {
    const { dbPath } = openStore();
    const unknown = await cli(['set', 'run.nope', '1', '--db', dbPath]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown setting "run.nope"');
    expect((await cli(['frobnicate', '--db', dbPath])).code).toBe(2);
    const range = await cli(['set', 'run.timeoutMaxMs', '48h', '--db', dbPath]);
    expect(range.code).toBe(2);
    expect(range.err).toContain('outside 60000..86400000');
  });

  it('REFUSES a missing store instead of creating one that reads as unlimited', async () => {
    // "nothing stated" against the wrong store reads as "this instance has no
    // limits", which is the opposite of the truth.
    const missing = await cli(['list', '--db', join(tmpdir(), 'atoma-no-such-store-4b2.db')]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('no product store at');
  });

  it('journals its own change with actorType cli, notifying nobody', async () => {
    const { dbPath } = openStore();
    expect((await cli(['set', 'run.costMaxUsd', '2.5', '--db', dbPath])).code).toBe(0);
    const raw = new Database(dbPath);
    try {
      const row = raw
        .prepare(
          "SELECT kind, severity, actor_type, actor_id, summary FROM platform_events WHERE kind = 'platform.settings_updated'"
        )
        .get() as { severity: string; actor_type: string; actor_id: string | null; summary: string };
      expect(row.severity).toBe('security');
      expect(row.actor_type).toBe('cli');
      // No principal made this change; inventing one would be a lie a later
      // reader has no way to detect.
      expect(row.actor_id).toBeNull();
      expect(row.summary).toContain('run.costMaxUsd 0→2.5');
    } finally {
      raw.close();
    }
  });

  it('prints help for --help and for no command, without touching a store', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('atoma settings — the run limits of this instance');
    // Every catalog key is documented by the usage block, derived rather than
    // written twice — a key added to the contract cannot go unmentioned.
    for (const key of PLATFORM_SETTING_KEYS) expect(help.out).toContain(key);
  });
});

describe('every key is wired to something', () => {
  it('names a source path per key, and no key is orphaned in the catalog', () => {
    expect(PLATFORM_SETTING_SPECS.map((spec) => spec.key)).toEqual([...PLATFORM_SETTING_KEYS]);
    for (const spec of PLATFORM_SETTING_SPECS) {
      expect(spec.readAt, spec.key).toMatch(/^src\//);
    }
  });
});

it('round-trips unlimited zero through the HTTP contract and persisted settings', () => {
  const { store } = openStore();
  for (const spec of PLATFORM_SETTING_SPECS.filter((entry) => entry.zeroMeansUnlimited)) {
    const overrides = platformSettingOverridesSchema.parse({ [spec.key]: 0 });
    store.set(overrides, null);
    expect(store.overrides()[spec.key]).toBe(0);
    expect(store.rows().find((row) => row.key === spec.key)?.value).toBe(0);
  }
});
