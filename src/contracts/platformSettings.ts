import { z } from 'zod';

/**
 * PLATFORM SETTINGS — THE NUMBERS AN OPERATOR MAY CHANGE WITHOUT A DEPLOY.
 * ========================================================================
 *
 * A closed catalog of bounded numeric limits, each one already load-bearing
 * somewhere in the run path, that a PLATFORM ADMIN may re-state at runtime.
 * Nothing here is new policy: every entry names a constant this repository
 * already ships, its bounds, and the one site that reads it.
 *
 * WHY A CATALOG AND NOT A `Record<string, number>`. A settings table whose
 * keys are strings is a table nobody can validate: the API cannot refuse an
 * absurd value, the UI cannot render a unit, and a key that stops being read
 * by any call site stays in the store forever looking authoritative. The
 * catalog IS the schema — `platformSettingOverridesSchema` is derived from it,
 * so an unknown key is a 400 rather than a row, and every value is bounded on
 * both ends before it is stored.
 *
 * TWO KINDS, AND THE DIFFERENCE IS THE WHOLE PRECEDENCE RULE.
 *
 *   - A `default` replaces the constant the code falls back to when NOTHING
 *     asks for a value. A launch-time request — a CLI flag, an env var the
 *     launcher exports — still wins over it. Changing a default changes what
 *     an unattended run gets; it never overrules an operator who asked.
 *   - A `ceiling` BINDS. Whatever a launcher, an env var or a tenant requests,
 *     the effective value cannot exceed it. A request above a ceiling is
 *     REFUSED at the launch sites that already refuse an out-of-range budget,
 *     and enforced mid-run where there is no request to refuse (tokens, spend).
 *
 * That split is why this module reads NO environment variable. Folding env
 * into the resolver would have created a second reader for
 * `ATOMA_PROJECT_TIMEOUT_MS` and `ATOMA_CLI_CALL_TIMEOUT_MS` beside the ones
 * that already parse and refuse them — the one-number-two-definitions drift
 * the root contract warns about. `spec.env` is therefore METADATA: it names
 * the variable a reader should mention next to the value, and nothing here
 * consults it. `resolvePlatformLimits` is pure.
 *
 * NOTHING HERE IS A SECRET, a model, a credential or a path. Eight numbers,
 * bounded, served to a platform admin and journaled when one changes.
 */

/**
 * The closed vocabulary. `PLATFORM_SETTINGS` below is a
 * `Record<PlatformSettingKey, …>`, so a key added here does not compile until
 * its bounds, its default, its kind and its summary are all stated.
 */
export const PLATFORM_SETTING_KEYS = [
  'run.timeoutDefaultMs',
  'run.timeoutMaxMs',
  'run.tokenMaxTotal',
  'run.costMaxUsd',
  'run.watchdogGraceMs',
  'llm.callTimeoutMs',
  'llm.codexCallTimeoutMs',
  'llm.maxToolIterations',
] as const;

export type PlatformSettingKey = (typeof PLATFORM_SETTING_KEYS)[number];

export const platformSettingKeySchema = z.enum(PLATFORM_SETTING_KEYS);

/** What the number MEANS, so a form can render it and a CLI can print it. */
export type PlatformSettingUnit = 'ms' | 'tokens' | 'usd' | 'count';

export type PlatformSettingKind = 'default' | 'ceiling';

export interface PlatformSettingSpec {
  readonly key: PlatformSettingKey;
  readonly unit: PlatformSettingUnit;
  readonly kind: PlatformSettingKind;
  /** Inclusive bounds. A value outside them is refused, never clamped. */
  readonly min: number;
  readonly max: number;
  /** The value in force when no admin has stated one — today's constant. */
  readonly fallback: number;
  /**
   * `true` when `0` means "no ceiling at all". Only ceilings whose default is
   * unlimited carry it, and it exists so today's behaviour is the default:
   * a fresh instance enforces exactly what it enforced before this feature.
   */
  readonly zeroMeansUnlimited: boolean;
  /**
   * The env var a launcher still uses to ask for a value, or null when the
   * code default is the only other source. Metadata — see the header.
   */
  readonly env: string | null;
  /** Where the number is read. Shown by the CLI so a change is traceable. */
  readonly readAt: string;
  /** Operator-facing English, one sentence. */
  readonly summary: string;
}

/**
 * THE CATALOG. Every `fallback` is the constant that shipped before this
 * module existed, verbatim — a fresh instance with no rows behaves
 * identically to one built without the feature. That is deliberate: a
 * settings surface whose mere existence changed a limit would make the
 * change invisible in exactly the deployments least able to explain it.
 */
export const PLATFORM_SETTINGS: Record<PlatformSettingKey, PlatformSettingSpec> = {
  'run.timeoutDefaultMs': {
    key: 'run.timeoutDefaultMs',
    unit: 'ms',
    kind: 'default',
    min: 60_000,
    max: 7_200_000,
    fallback: 3_600_000,
    zeroMeansUnlimited: false,
    env: 'ATOMA_PROJECT_TIMEOUT_MS',
    readAt: 'src/projects/coordinator.ts#projectRunTimeoutMs',
    summary: 'Wall-clock budget a project run gets when its launcher asks for none.',
  },
  'run.timeoutMaxMs': {
    key: 'run.timeoutMaxMs',
    unit: 'ms',
    kind: 'ceiling',
    min: 60_000,
    // 24h. Not "unlimited": the runner arms a watchdog and an abort signal off
    // this number, and a value they cannot represent is not a policy.
    max: 86_400_000,
    fallback: 7_200_000,
    zeroMeansUnlimited: false,
    env: null,
    readAt: 'src/projects/coordinator.ts, src/run/runner.ts',
    summary: 'Hard ceiling on any run wall clock; a launcher asking for more is refused.',
  },
  'run.tokenMaxTotal': {
    key: 'run.tokenMaxTotal',
    unit: 'tokens',
    kind: 'ceiling',
    min: 0,
    max: 1_000_000_000,
    fallback: 0,
    zeroMeansUnlimited: true,
    env: null,
    readAt: 'src/core/runBudget.ts',
    summary: 'Hard ceiling on the billable tokens one run may consume; 0 disables it.',
  },
  'run.costMaxUsd': {
    key: 'run.costMaxUsd',
    unit: 'usd',
    kind: 'ceiling',
    min: 0,
    max: 10_000,
    fallback: 0,
    zeroMeansUnlimited: true,
    env: null,
    readAt: 'src/core/runBudget.ts',
    summary: 'Hard ceiling on one run estimated spend in USD; 0 disables it.',
  },
  'run.watchdogGraceMs': {
    key: 'run.watchdogGraceMs',
    unit: 'ms',
    kind: 'default',
    // BOUNDED BY TWO DEADLINES THIS MODULE DOES NOT OWN (2026-09-30 review).
    // Below, the 45s finalization window (`FINALIZATION_GRACE_MS`) runs INSIDE
    // this grace: a shorter one kills a run while it lands, recording `failed`
    // what would have been `partial`. Above, the harness hard-reaps at
    // deadline + 180s (`DEFAULT_HARD_KILL_MARGIN_MS`): a longer grace means the
    // group-kill always wins and the trace never closes. The test pins both.
    min: 60_000,
    max: 150_000,
    fallback: 60_000,
    zeroMeansUnlimited: false,
    env: null,
    readAt: 'src/run/runner.ts',
    summary: 'Grace past the deadline before the watchdog calls the transport wedged.',
  },
  'llm.callTimeoutMs': {
    key: 'llm.callTimeoutMs',
    unit: 'ms',
    kind: 'ceiling',
    // 0 = no ceiling, and it is the fallback: the call timeout that shipped is
    // a DEFAULT its env var may raise, so an instance with no row must not
    // bound it (2026-09-30 review). A stated ceiling is at least 30s.
    min: 30_000,
    max: 3_600_000,
    fallback: 0,
    zeroMeansUnlimited: true,
    env: 'ATOMA_CLI_CALL_TIMEOUT_MS',
    readAt: 'src/core/llmClaudeCli.ts#cliCallTimeoutMs',
    summary: 'Hard ceiling on one Claude-CLI call inactivity timeout; 0 disables it.',
  },
  'llm.codexCallTimeoutMs': {
    key: 'llm.codexCallTimeoutMs',
    unit: 'ms',
    kind: 'ceiling',
    // 0 = no ceiling, and it is the fallback: the call timeout that shipped is
    // a DEFAULT its env var may raise, so an instance with no row must not
    // bound it (2026-09-30 review). A stated ceiling is at least 30s.
    min: 30_000,
    max: 3_600_000,
    fallback: 0,
    zeroMeansUnlimited: true,
    env: 'ATOMA_CODEX_CALL_TIMEOUT_MS',
    readAt: 'src/core/llmCodexCli.ts#codexCallTimeoutMs',
    summary: 'Hard ceiling on one Codex-CLI call inactivity timeout; 0 disables it.',
  },
  'llm.maxToolIterations': {
    key: 'llm.maxToolIterations',
    unit: 'count',
    kind: 'ceiling',
    min: 0,
    max: 200,
    // 0, NOT 24. The tiers ask for 40 when a validator is attached and the
    // benchmark baseline asks for 80, so a ceiling of 24 would silently
    // shorten every validated tool loop the day this module landed.
    fallback: 0,
    zeroMeansUnlimited: true,
    env: null,
    readAt: 'src/core/runBudget.ts',
    summary: 'Hard ceiling on one LLM call tool-loop iterations; 0 disables it.',
  },
};

/** The catalog in declaration order — the order a form and the CLI render. */
export const PLATFORM_SETTING_SPECS: readonly PlatformSettingSpec[] =
  PLATFORM_SETTING_KEYS.map((key) => PLATFORM_SETTINGS[key]);

/**
 * What an admin has actually stated. A PARTIAL record on purpose: an absent
 * key means "whatever the code says", which is a different fact from "an
 * admin chose the number that happens to equal the default" and is what lets
 * the UI show `default` beside an untouched row.
 */
export const platformSettingOverridesSchema = z
  .object(
    Object.fromEntries(
      PLATFORM_SETTING_KEYS.map((key) => {
        const spec = PLATFORM_SETTINGS[key];
        // `usd` is the one non-integer unit: a $2.50 ceiling is a reasonable
        // thing to ask for, and rounding it to $3 would be a surprise.
        const base = spec.unit === 'usd' ? z.number() : z.number().int();
        return [key, base.max(spec.max).refine((value) => value >= spec.min || (spec.zeroMeansUnlimited && value === 0), { message: `must be at least ${spec.min}${spec.zeroMeansUnlimited ? ' or 0 (unlimited)' : ''}` }).optional()];
      })
    ) as { [K in PlatformSettingKey]: z.ZodOptional<z.ZodNumber> }
  )
  .strict();

export type PlatformSettingOverrides = z.infer<typeof platformSettingOverridesSchema>;

/**
 * ONE REQUEST SHAPE for the admin surface, and it names both halves.
 *
 * `set` states values; `clear` removes stated rows. They are separate fields
 * rather than a `null` value inside `set`, because "back to the default" and
 * "the default happens to be this number" must stay distinguishable at the
 * WIRE too — a `null` that arrived as JSON from a form field the user emptied
 * is indistinguishable from a field the form forgot to send.
 *
 * A key in both halves is REFUSED rather than resolved in an order nobody can
 * read off the request. `.strict()` on both sides means an unknown key is a
 * 400: the catalog is the schema.
 */
export const platformSettingsUpdateSchema = z
  .object({
    set: platformSettingOverridesSchema.default({}),
    clear: z.array(platformSettingKeySchema).max(PLATFORM_SETTING_KEYS.length).default([]),
  })
  .strict()
  .refine(
    (request) => !request.clear.some((key) => key in request.set),
    { message: 'a key may be set or cleared, not both' }
  );

export type PlatformSettingsUpdate = z.infer<typeof platformSettingsUpdateSchema>;

/** Every key resolved to the number the run path will actually use. */
export type PlatformLimits = Readonly<Record<PlatformSettingKey, number>>;

export class PlatformSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformSettingError';
  }
}

/**
 * Validate ONE value against its spec. Out of range is a REFUSAL, never a
 * clamp: an admin who typed 30 days into a field bounded at 24 hours has made
 * a mistake worth hearing about, and a silently rewritten limit is the defect
 * `projectRunTimeoutMs` already refuses to reproduce.
 */
export function assertPlatformSettingValue(key: PlatformSettingKey, value: number): number {
  const spec = PLATFORM_SETTINGS[key];
  if (!Number.isFinite(value)) {
    throw new PlatformSettingError(`${key} must be a finite number`);
  }
  if (spec.unit !== 'usd' && !Number.isSafeInteger(value)) {
    throw new PlatformSettingError(`${key} must be an integer (${spec.unit})`);
  }
  // An entry whose zero means "no ceiling" takes 0 below its minimum: the
  // minimum bounds a STATED ceiling, not its absence.
  if (spec.zeroMeansUnlimited && value === 0) return value;
  if (value < spec.min || value > spec.max) {
    throw new PlatformSettingError(
      `${key}=${value} is outside ${spec.min}..${spec.max} (${spec.unit})`
    );
  }
  return value;
}

/**
 * Resolve every key to the number the run path uses. PURE — no environment,
 * no store, no clock — so a call site, a test and the admin form all agree on
 * what a given set of overrides means.
 */
export function resolvePlatformLimits(
  overrides: PlatformSettingOverrides = {}
): PlatformLimits {
  const out = {} as Record<PlatformSettingKey, number>;
  for (const key of PLATFORM_SETTING_KEYS) {
    const stated = overrides[key];
    out[key] = stated === undefined ? PLATFORM_SETTINGS[key].fallback : stated;
  }
  return out;
}

/**
 * The environment variables a CEILING bounds: each names a REQUEST the host
 * may export, which the ceiling refuses at launch when it asks for more.
 * `run.timeoutMaxMs` bounds the project budget (`spec.env` of the default,
 * since that is where the request lands); the call timeouts bound their own.
 */
export const CEILING_REQUEST_ENV: Readonly<Partial<Record<PlatformSettingKey, string>>> = {
  'run.timeoutMaxMs': 'ATOMA_PROJECT_TIMEOUT_MS',
  'llm.callTimeoutMs': 'ATOMA_CLI_CALL_TIMEOUT_MS',
  'llm.codexCallTimeoutMs': 'ATOMA_CODEX_CALL_TIMEOUT_MS',
};

/**
 * The ceilings in `limits` that an exported request in `env` exceeds, in
 * words an admin can act on. A save that would create one is REFUSED (the
 * form, the CLI), because from that moment every run asking for that request
 * would be refused — the 2026-09-30 review found a saved ceiling below
 * `ATOMA_PROJECT_TIMEOUT_MS` failing every project run. It reads the env it is
 * GIVEN, so the resolver stays environment-free.
 */
export function ceilingConflicts(
  limits: PlatformLimits,
  env: Readonly<Record<string, string | undefined>>,
  keys: readonly PlatformSettingKey[] = Object.keys(CEILING_REQUEST_ENV) as PlatformSettingKey[]
): string[] {
  const conflicts: string[] = [];
  for (const key of keys) {
    const variable = CEILING_REQUEST_ENV[key];
    if (!variable) continue;
    const ceiling = ceilingOf(limits, key);
    const raw = env[variable]?.trim();
    if (ceiling === null || !raw) continue;
    const requested = Number(raw);
    if (Number.isFinite(requested) && requested > ceiling) {
      conflicts.push(`${variable}=${raw} is exported and exceeds ${key}=${ceiling}: raise the ceiling or unset the variable first`);
    }
  }
  return conflicts;
}

/**
 * The wall-clock ceiling a RUNNER-LEVEL launch obeys: the stated one, when an
 * admin narrowed it below the shipped value, else none. The operator's own
 * runner never had a ceiling, and an instance with no row must launch exactly
 * what it launched before (2026-09-30 review); project runs are bounded by the
 * coordinator, which always applies `MAX_PROJECT_RUN_TIMEOUT_MS`.
 */
export function narrowedRunTimeoutCeilingMs(limits: PlatformLimits): number | null {
  const value = limits['run.timeoutMaxMs'];
  return value < PLATFORM_SETTINGS['run.timeoutMaxMs'].fallback ? value : null;
}

/** The limits of an instance where no admin has stated anything. */
export const DEFAULT_PLATFORM_LIMITS: PlatformLimits = resolvePlatformLimits();

/**
 * A ceiling as a caller wants to apply it: the number, or `null` when the
 * entry is disabled. Written once here so the enforcement sites stop spelling
 * `value > 0 ? value : null` each with its own idea of what a zero means for
 * a key that does not treat zero as unlimited.
 */
export function ceilingOf(limits: PlatformLimits, key: PlatformSettingKey): number | null {
  const spec = PLATFORM_SETTINGS[key];
  const value = limits[key];
  if (spec.zeroMeansUnlimited && value <= 0) return null;
  return value;
}
