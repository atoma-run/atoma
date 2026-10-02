import { useCallback, useEffect, useState } from 'react';
import { api } from '../client/data-api.js';
import type { VizPlatformSettings, VizPlatformSettingSpec } from '../client/types.js';

/**
 * PLATFORM RUN LIMITS — the hard budgets of this instance, in the one screen
 * the operator who owns them already opens.
 *
 * PLATFORM ADMIN ONLY, and the gate is the SERVER's: `/api/admin/settings`
 * refuses everyone else with a 403. This component's own `enabled` flag is
 * chrome — it decides whether to render, never whether the write is allowed —
 * which is the same division the org-models form draws between `canManageOrg`
 * and the role check on the route.
 *
 * WHY THE ROW LABELS ARE NOT TRANSLATED. Each row names a CONSTANT of this
 * codebase — `run.tokenMaxTotal`, and beside it the source path the number is
 * read at. Those are identifiers, not product copy: translating
 * `src/core/runBudget.ts` would make it wrong, and paraphrasing the key would
 * break the correspondence with `npm run settings -- list`, which is how the
 * same limits are read on a machine with no browser. The English `summary`
 * comes from the contract and is rendered AS SENT, on the same reasoning the
 * audit journal renders a server summary raw. Everything the component itself
 * says — the heading, the hints, the buttons, the statuses — is a catalog key.
 *
 * NOTHING IS COMPUTED LOCALLY AFTER A WRITE. Every save re-renders from the
 * snapshot the PUT returned, so a value the server clamped, refused, or
 * bounded by a second setting is what the admin sees — never the number they
 * typed sitting in a field that looks saved.
 */
export function PlatformLimitsForm({
  t,
  enabled,
  onError,
}: {
  t: (key: string, vars?: Record<string, unknown>) => string;
  enabled: boolean;
  onError: (message: string | null) => void;
}) {
  const [settings, setSettings] = useState<VizPlatformSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const adopt = useCallback((next: VizPlatformSettings) => {
    setSettings(next);
    // The draft is RESEEDED from the server's effective values on every
    // adoption, which is what makes a clamp or a refusal visible: a field
    // left holding the rejected number would read as saved.
    setDraft(
      Object.fromEntries(next.catalog.map((spec) => [spec.key, String(next.limits[spec.key] ?? spec.fallback)]))
    );
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      adopt(await api.adminSettings());
      onError(null);
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : t('settings.actionFailed'));
      return false;
    }
  }, [adopt, onError, t]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const apply = async (
    body: { set?: Record<string, number>; clear?: string[] },
    successKey: string
  ): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      adopt(await api.saveAdminSettings(body));
      onError(null);
      setStatus(t(successKey));
    } catch (error) {
      // The field is reseeded from the last good snapshot rather than left
      // holding the refused value: an out-of-range number that stays on
      // screen after an error looks like a limit that took effect.
      if (settings) adopt(settings);
      setStatus(null);
      onError(error instanceof Error ? error.message : t('settings.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (!enabled || !settings) return null;

  const stated = new Map(settings.rows.map((row) => [row.key, row]));

  return (
    <>
      <p className="gpu-org-models-title">{t('settings.platformLimits')}</p>
      <p className="gpu-org-models-hint">{t('settings.platformLimitsHint')}</p>
      {settings.catalog.map((spec) => {
        const row = stated.get(spec.key);
        const effective = settings.limits[spec.key] ?? spec.fallback;
        const typed = draft[spec.key] ?? String(effective);
        const parsed = Number(typed);
        const inRange =
          typed.trim() !== '' && Number.isFinite(parsed) && parsed <= spec.max &&
          (parsed >= spec.min || (spec.zeroMeansUnlimited && parsed === 0));
        const inputId = `platform-limit-${spec.key}`;
        return (
          <div key={spec.key}>
            <div className="gpu-org-models-row">
              <label htmlFor={inputId}>{spec.key}</label>
              <input
                id={inputId}
                className="gpu-dom-input"
                type="number"
                inputMode="decimal"
                min={spec.zeroMeansUnlimited ? 0 : spec.min}
                max={spec.max}
                step={spec.unit === 'usd' ? 0.01 : 1}
                disabled={busy}
                value={typed}
                onChange={(event) =>
                  setDraft((previous) => ({ ...previous, [spec.key]: event.target.value }))
                }
              />
              <div className="gpu-settings-actions">
                <button
                  type="button"
                  disabled={busy || !inRange || parsed === effective}
                  onClick={() => {
                    void apply({ set: { [spec.key]: parsed } }, 'settings.platformLimitsSaved');
                  }}
                >
                  {t('settings.save')}
                </button>
                <button
                  type="button"
                  disabled={busy || !row}
                  onClick={() => {
                    void apply({ clear: [spec.key] }, 'settings.platformLimitsCleared');
                  }}
                >
                  {t('settings.platformLimitReset')}
                </button>
              </div>
            </div>
            <p className="gpu-org-models-hint">
              {spec.summary}
              {' · '}
              {t(
                spec.kind === 'ceiling'
                  ? 'settings.platformLimitCeiling'
                  : 'settings.platformLimitDefaultKind'
              )}
              {' · '}
              {t('settings.platformLimitEffective', {
                value: formatLimit(spec, effective, t),
              })}
              {' · '}
              {row
                ? t('settings.platformLimitStated', {
                    date: row.updatedAt.slice(0, 10),
                    who: row.updatedBy ?? t('settings.platformLimitByCli'),
                  })
                : t('settings.platformLimitUnstated')}
              {' · '}
              {t('settings.platformLimitRange', {
                min: spec.min,
                max: spec.max,
                unit: spec.unit,
              })}
              {spec.env
                ? ` · ${t(
                    settings.env[spec.key]
                      ? 'settings.platformLimitEnvSet'
                      : 'settings.platformLimitEnvUnset',
                    { name: spec.env, value: settings.env[spec.key] ?? '' }
                  )}`
                : ''}
              {' · '}
              <code>{spec.readAt}</code>
            </p>
          </div>
        );
      })}
      {status ? (
        <span role="status" className="gpu-org-models-status">
          {status}
        </span>
      ) : null}
    </>
  );
}

/**
 * A limit as a human reads it. PURE and exported so the shape of "unlimited",
 * "$2.50" and "15m" is testable without a browser — the GPU smoke cannot run
 * in CI, and a ceiling rendered as `0` where it means "no ceiling" is the one
 * mistake this form must not make.
 *
 * An UNKNOWN unit falls through to the bare number rather than guessing: a
 * bundle older than the server must render a new entry plainly, not wrongly.
 */
export function formatLimit(
  spec: Pick<VizPlatformSettingSpec, 'unit' | 'zeroMeansUnlimited'>,
  value: number,
  t: (key: string, vars?: Record<string, unknown>) => string
): string {
  if (spec.zeroMeansUnlimited && value <= 0) return t('settings.platformLimitUnlimited');
  if (spec.unit === 'usd') return `$${value.toFixed(2)}`;
  if (spec.unit !== 'ms') return String(value);
  if (value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  return `${Math.round(value / 1_000)}s`;
}
