#!/usr/bin/env tsx
/**
 * atoma settings CLI — the instance's run limits, from the operator's own
 * terminal.
 *
 *   npm run settings -- list [--db path]
 *   npm run settings -- set <key> <value> [--db path]
 *   npm run settings -- unset <key> [<key> …] [--db path]
 *
 * WHY A CLI AS WELL AS A FORM. The same reason `auth grant-admin` is a CLI: a
 * platform admin is admitted through the browser, and a deployment whose only
 * way to lower a ceiling is a browser session cannot be recovered when the
 * ceiling is what is breaking the browser. This path needs no server, no gate
 * and no session — it writes the store on disk and journals the change with
 * `actorType: 'cli'`, which notifies nobody and is audited all the same.
 */
import { existsSync } from 'node:fs';
import {
  assertPlatformSettingValue,
  ceilingConflicts,
  PLATFORM_SETTING_KEYS,
  PLATFORM_SETTING_SPECS,
  PLATFORM_SETTINGS,
  PlatformSettingError,
  platformSettingKeySchema,
  type PlatformSettingKey,
  type PlatformSettingSpec,
} from '../contracts/platformSettings.js';
import { PLATFORM_EVENT_SUMMARY_MAX_CHARS } from '../contracts/platformEvents.js';
import { storeDbPath } from '../core/stores.js';
import { PlatformEventLog } from '../platform/events.js';
import { PlatformSettingsStore } from '../platform/settings.js';
import { parseCliArgs } from './args.js';
import { applyCheckoutDotenvForSourceEntry } from './loadDotenv.js';

const USAGE = `atoma settings — the run limits of this instance

usage:
  npm run settings -- list [--db path]
  npm run settings -- set <key> <value> [--db path]
  npm run settings -- unset <key> [<key> …] [--db path]

keys:
${PLATFORM_SETTING_SPECS.map(
  (spec) =>
    `  ${spec.key.padEnd(24)} ${spec.kind.padEnd(8)} ${spec.min}..${spec.max} ${spec.unit}` +
    ` (default ${spec.fallback}${spec.zeroMeansUnlimited ? ' = unlimited' : ''})`
).join('\n')}

a DEFAULT is what a run gets when nothing asks; a launch-time request (a flag,
an env var) still wins over it. a CEILING binds: a request above it is refused
at launch, and the token and spend ceilings cancel the run that crosses them.

unset removes the stated row rather than writing the default back, so a later
change to a shipped default reaches this instance.

flags:
  --db <path>   use this product store (default ATOMA_DB_PATH, then ./atoma.db)
  --help        show this help`;

/**
 * A usage refusal, THROWN rather than exited. `runSettingsCli` returns an exit
 * code so a test can drive every branch in-process — the same shape
 * `runAuthCli` settled on, and the reason neither CLI calls `process.exit`
 * from inside its own logic.
 */
class SettingsUsageError extends Error {}

function fail(message: string): never {
  throw new SettingsUsageError(message);
}

function parseKey(raw: string | undefined): PlatformSettingKey {
  const parsed = platformSettingKeySchema.safeParse(raw);
  if (!parsed.success) {
    fail(
      `unknown setting "${raw ?? ''}" — known keys:\n${PLATFORM_SETTING_KEYS.map(
        (key) => `  ${key}`
      ).join('\n')}`
    );
  }
  return parsed.data;
}

/** `900000`, `15m`, `2h`, `30s` — for a column measured in milliseconds. */
function parseValue(spec: PlatformSettingSpec, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') fail(`${spec.key} needs a value`);
  const text = raw.trim();
  if (spec.unit === 'ms') {
    const suffixed = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text);
    if (suffixed) {
      const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[
        suffixed[2] as 'ms' | 's' | 'm' | 'h'
      ];
      return Math.round(Number(suffixed[1]) * scale);
    }
  }
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) {
    fail(
      `${spec.key}: "${text}" is not a number` +
        (spec.unit === 'ms' ? ' (accepts a plain count of ms, or 30s / 15m / 2h)' : '')
    );
  }
  return numeric;
}

function formatValue(spec: PlatformSettingSpec, value: number): string {
  if (spec.zeroMeansUnlimited && value <= 0) return 'unlimited';
  if (spec.unit === 'usd') return `$${value.toFixed(2)}`;
  if (spec.unit !== 'ms') return String(value);
  if (value % 3_600_000 === 0) return `${value}ms (${value / 3_600_000}h)`;
  if (value % 60_000 === 0) return `${value}ms (${value / 60_000}m)`;
  return `${value}ms (${Math.round(value / 1_000)}s)`;
}

function list(store: PlatformSettingsStore, dbPath: string): void {
  const stated = new Map(store.rows().map((row) => [row.key, row]));
  const limits = store.limits();
  for (const spec of PLATFORM_SETTING_SPECS) {
    const row = stated.get(spec.key);
    console.log(`${spec.key}  [${spec.kind}]`);
    console.log(
      `  effective ${formatValue(spec, limits[spec.key])}` +
        (row
          ? `  — stated ${row.updatedAt.slice(0, 19)}Z${row.updatedBy ? ` by ${row.updatedBy}` : ' by the operator CLI'}`
          : '  — default (nothing stated)')
    );
    console.log(`  range     ${spec.min}..${spec.max} ${spec.unit}, default ${spec.fallback}`);
    // The env var is the LAUNCH-TIME request for a default and the thing a
    // ceiling binds. Printing the value it currently holds is the difference
    // between a screen that reports policy and one that reports the store.
    if (spec.env) {
      const exported = process.env[spec.env]?.trim();
      console.log(
        `  env       ${spec.env}=${exported ? exported : '(unset)'}` +
          (spec.kind === 'ceiling' ? ' — bounded by this ceiling' : ' — wins over this default')
      );
    }
    console.log(`  reads     ${spec.readAt}`);
    console.log(`  ${spec.summary}`);
    console.log('');
  }
  console.log(`${stated.size} of ${PLATFORM_SETTING_KEYS.length} stated — ${dbPath}`);
}

/**
 * The audit row, bounded exactly as the HTTP surface bounds it: the journal is
 * fail-open, so an oversized summary would be DROPPED and the change would
 * leave no trace at all.
 */
function journal(
  events: PlatformEventLog,
  changes: ReadonlyArray<{ key: PlatformSettingKey; from: number; to: number }>
): void {
  if (changes.length === 0) return;
  const listed = changes.map((change) => `${change.key} ${change.from}→${change.to}`).join(', ');
  const prefix = `Platform run limits updated (${changes.length}) via CLI: `;
  const room = PLATFORM_EVENT_SUMMARY_MAX_CHARS - prefix.length;
  events.append({
    kind: 'platform.settings_updated',
    actorType: 'cli',
    summary: prefix + (listed.length <= room ? listed : `${listed.slice(0, room - 1)}…`),
    detail: {
      changed: Object.fromEntries(
        changes.map((change) => [change.key, { from: change.from, to: change.to }])
      ),
    },
  });
}

function run(argv: readonly string[]): void {
  const parsed = parseCliArgs(argv, {
    booleanFlags: ['help'],
    valueFlags: ['db'],
    undeclared: 'discard',
  });
  const command = parsed.command ?? 'list';
  if (parsed.flags['help'] === 'true' || command === 'help') {
    console.log(USAGE);
    return;
  }
  const dbPath = storeDbPath(parsed.flags['db']);
  const rest = parsed.positional;
  // A missing store is a REFUSAL for every command, `list` included. Opening
  // one would create an empty file and report "nothing stated", which reads
  // as "this instance has no limits" when the truth is "you named the wrong
  // store" — the same trap `auth list` refuses.
  if (!existsSync(dbPath)) {
    fail(`no product store at ${dbPath} — pass --db, or set ATOMA_DB_PATH`);
  }
  const store = PlatformSettingsStore.open(dbPath);

  if (command === 'list') {
    list(store, dbPath);
    return;
  }

  if (command === 'set') {
    const key = parseKey(rest[0]);
    const value = parseValue(PLATFORM_SETTINGS[key], rest[1]);
    const before = store.limits();
    const statedBefore = store.overrides()[key];
    try {
      assertPlatformSettingValue(key, value);
    } catch (error) {
      fail(error instanceof PlatformSettingError ? error.message : String(error));
    }
    // A ceiling below a request THIS shell exports is refused, as the form
    // refuses one below the server's. The service may run with another
    // environment: the form is the check that sees that one.
    const conflicts = ceilingConflicts(store.proposed({ [key]: value }, []).limits, process.env);
    if (conflicts.length > 0) fail(conflicts.join('; '));
    // `null` and not a synthetic id: no principal made this change. The
    // column is an audit reference, and inventing one would be a lie a later
    // reader has no way to detect.
    const after = store.set({ [key]: value }, null);
    // Already STATED at this value: nothing moved. Stating a value equal to
    // today's default is still a change — it pins the key against a later
    // default change — and is journaled like any other.
    if (statedBefore === value) {
      console.log(`${key} is already stated as ${formatValue(PLATFORM_SETTINGS[key], after[key])}`);
      return;
    }
    journal(PlatformEventLog.open(dbPath), [{ key, from: before[key], to: after[key] }]);
    console.log(
      `${key}: ${formatValue(PLATFORM_SETTINGS[key], before[key])} → ` +
        `${formatValue(PLATFORM_SETTINGS[key], after[key])}  (${dbPath})`
    );
    return;
  }

  if (command === 'unset') {
    if (rest.length === 0) fail('unset needs at least one key');
    const keys = rest.map((raw) => parseKey(raw));
    const before = store.limits();
    const cleared = store.clear(keys);
    const after = store.limits();
    if (cleared.length === 0) {
      console.log(`nothing stated for ${keys.join(', ')} — ${dbPath}`);
      return;
    }
    journal(
      PlatformEventLog.open(dbPath),
      cleared.map((key) => ({ key, from: before[key], to: after[key] }))
    );
    for (const key of cleared) {
      console.log(
        `${key} cleared: back to the shipped default ` +
          `${formatValue(PLATFORM_SETTINGS[key], after[key])}`
      );
    }
    return;
  }

  fail(`unknown command "${String(command)}"\n\n${USAGE}`);
}

export function runSettingsCli(argv: readonly string[] = process.argv): number {
  try {
    run(argv);
    return 0;
  } catch (error) {
    if (error instanceof SettingsUsageError) {
      console.error(error.message);
      return 2;
    }
    console.error(
      `settings command failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }
}

if (process.argv[1] && /settings\.(ts|js)$/.test(process.argv[1])) {
  applyCheckoutDotenvForSourceEntry();
  process.exitCode = runSettingsCli();
}
