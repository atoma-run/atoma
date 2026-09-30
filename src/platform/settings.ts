import type Database from 'better-sqlite3';
import {
  assertPlatformSettingValue,
  DEFAULT_PLATFORM_LIMITS,
  platformSettingKeySchema,
  PLATFORM_SETTINGS,
  resolvePlatformLimits,
  type PlatformLimits,
  type PlatformSettingKey,
  type PlatformSettingOverrides,
} from '../contracts/platformSettings.js';
import { openStoreHandle, storeDbPath } from '../core/stores.js';

/**
 * THE PLATFORM SETTINGS STORE — what an admin has re-stated, and who did.
 *
 * One more table group on the ONE product store, joined through
 * `openStoreHandle` exactly like the auth, projects, github, push and
 * platform-event groups. It lives in `src/platform/` because the rows are a
 * control-plane decision of the same kind as the audit journal beside it:
 * instance-wide, operator-owned, and never scoped to an organisation.
 *
 * SPARSE BY CONSTRUCTION. A row exists only for a key an admin has actually
 * stated. That is what makes "this limit is the default" and "an admin chose
 * a number that happens to equal the default" two distinguishable facts —
 * `clear()` removes the row rather than writing the fallback back, so a later
 * change to a code default reaches every instance that never overrode it.
 *
 * READS FAIL OPEN, WRITES FAIL LOUD. A run must never fail to launch because
 * this table is missing or torn: `limits()` falls back to
 * `DEFAULT_PLATFORM_LIMITS`, which is exactly the behaviour of an instance
 * that never had the feature. A WRITE is the opposite — an admin who pressed
 * Save and was told nothing would believe a limit is in force that is not —
 * so `set()` and `clear()` throw.
 *
 * A FOREIGN ROW IS TOLERATED, NOT TRUSTED. A key this build does not know (a
 * downgrade, a hand-edited store) is DROPPED on read with no error, on the
 * same reasoning as the journal's unknown-kind tolerance: the settings this
 * build enforces are the ones it can name. An out-of-range value for a known
 * key is dropped too — the bounds are the contract, and a store edited past
 * them must not become policy.
 */

export const PLATFORM_SETTINGS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  -- REAL, not INTEGER: \`run.costMaxUsd\` is the one non-integer entry, and a
  -- column that truncated $2.50 to $2 would make the form lie back at the
  -- admin who typed it. Integer entries are validated as integers by the
  -- contract before they reach this column.
  value      REAL NOT NULL,
  updated_at TEXT NOT NULL,
  -- The principal id of the admin who stated it, or null for a row written by
  -- the operator CLI against the store on disk with no session. Never an
  -- email, never a display name: this column is an audit reference, and the
  -- readable "who" belongs in the platform event the change also emits.
  updated_by TEXT
);
`;

/** One stated row, as the admin surface and the CLI render it. */
export interface PlatformSettingRow {
  readonly key: PlatformSettingKey;
  readonly value: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

export class PlatformSettingsStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  private constructor(db: Database.Database, now?: () => Date) {
    this.db = db;
    this.now = now ?? (() => new Date());
  }

  static open(path?: string, now?: () => Date): PlatformSettingsStore {
    return new PlatformSettingsStore(
      openStoreHandle(path ?? storeDbPath(), PLATFORM_SETTINGS_TABLE_DDL),
      now
    );
  }

  /** Every stated row, catalog order, foreign and out-of-range rows dropped. */
  rows(): PlatformSettingRow[] {
    let raw: Array<{ key: string; value: number; updated_at: string; updated_by: string | null }>;
    try {
      raw = this.db
        .prepare('SELECT key, value, updated_at, updated_by FROM platform_settings')
        .all() as typeof raw;
    } catch {
      return [];
    }
    const out: PlatformSettingRow[] = [];
    for (const row of raw) {
      const key = platformSettingKeySchema.safeParse(row.key);
      if (!key.success) continue;
      const spec = PLATFORM_SETTINGS[key.data];
      if (!Number.isFinite(row.value) || row.value < spec.min || row.value > spec.max) continue;
      out.push({
        key: key.data,
        value: row.value,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      });
    }
    // Catalog order, not insertion order: the form, the CLI and the API all
    // render one list, and the order a store happened to be written in is not
    // a fact about the settings.
    const order = Object.keys(PLATFORM_SETTINGS) as PlatformSettingKey[];
    return out.sort((left, right) => order.indexOf(left.key) - order.indexOf(right.key));
  }

  /** What an admin has stated, as the contract's partial record. */
  overrides(): PlatformSettingOverrides {
    // Built as the partial record itself: `rows()` has already narrowed every
    // key against the catalog, so there is nothing left to assert.
    const out: PlatformSettingOverrides = {};
    for (const row of this.rows()) out[row.key] = row.value;
    return out;
  }

  /**
   * Every key resolved to the number the run path uses. THE read the run path
   * makes, and the one that must never throw — see the header.
   */
  limits(): PlatformLimits {
    try {
      return resolvePlatformLimits(this.overrides());
    } catch {
      return DEFAULT_PLATFORM_LIMITS;
    }
  }

  /**
   * What the stated rows WOULD be after clearing `clear` and stating `set`, and
   * the limits they resolve to — for a caller that must judge a change before
   * making it (a ceiling below an exported request is refused). Writes nothing.
   */
  proposed(
    set: Readonly<Partial<Record<PlatformSettingKey, number>>>,
    clear: readonly PlatformSettingKey[]
  ): { readonly stated: PlatformSettingOverrides; readonly limits: PlatformLimits } {
    const stated: PlatformSettingOverrides = { ...this.overrides() };
    for (const key of clear) delete stated[key];
    Object.assign(stated, set);
    return { stated, limits: resolvePlatformLimits(stated) };
  }

  /**
   * State one or more values. Validated against the catalog FIRST, all of
   * them, and only then written in one transaction: a form that sent four
   * numbers of which the third is out of range must change nothing, or the
   * admin is left guessing which half landed.
   */
  set(
    values: Readonly<Partial<Record<PlatformSettingKey, number>>>,
    actorPrincipalId: string | null
  ): PlatformLimits {
    const entries = Object.entries(values) as Array<[PlatformSettingKey, number]>;
    for (const [key, value] of entries) assertPlatformSettingValue(key, value);
    const at = this.now().toISOString();
    const upsert = this.db.prepare(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    );
    this.db.transaction(() => {
      for (const [key, value] of entries) upsert.run(key, value, at, actorPrincipalId);
    })();
    return this.limits();
  }

  /**
   * Drop the stated rows, returning the keys that actually existed. Clearing
   * is not "set it back to the default": the row's absence is what lets a
   * future change to a code default reach this instance.
   */
  clear(keys: readonly PlatformSettingKey[]): PlatformSettingKey[] {
    const remove = this.db.prepare('DELETE FROM platform_settings WHERE key = ?');
    const cleared: PlatformSettingKey[] = [];
    this.db.transaction(() => {
      for (const key of keys) {
        if (remove.run(key).changes > 0) cleared.push(key);
      }
    })();
    return cleared;
  }
}

/**
 * The run path's read, in one call: open the store this process was pointed
 * at and resolve the limits, falling back to the defaults when there is no
 * store to read. Used by the runner and the coordinator, which both already
 * know the product store path and must not grow a settings dependency they
 * have to remember to close.
 */
export function platformLimitsFor(dbPath?: string): PlatformLimits {
  try {
    return PlatformSettingsStore.open(dbPath).limits();
  } catch {
    return DEFAULT_PLATFORM_LIMITS;
  }
}
