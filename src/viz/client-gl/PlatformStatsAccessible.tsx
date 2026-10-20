import { runDuration } from '../client/run-utils.js';
import { PLATFORM_STATS_DAYS, type PlatformStats, type PlatformStatsDays } from '../../contracts/platformStats.js';
import { formatDateTime } from '../client/date-format.js';
import { platformDaily, platformMetrics, platformNumber, PLATFORM_RUN_STATES } from './platform-stats.js';
import { ButtonIcon } from './ButtonIcon.js';

export function PlatformStatsAccessible({ stats, days, locale, t, onActivate }: {
  stats: PlatformStats | null; days: PlatformStatsDays; locale: string;
  t: (key: string, options?: Record<string, unknown>) => string; onActivate?: (id: string) => void;
}) {
  const number = (n: number | null, currency = false) => platformNumber(n, locale, currency);
  return <section aria-label={t('nav.platform')}>
    <h2>{t('platform.title')}</h2><p>{t('platform.subtitle')}</p>
    <div role="group" aria-label={t('platform.period')}>
      {PLATFORM_STATS_DAYS.map(value => <button key={value} type="button" aria-pressed={days === value}
        onClick={() => onActivate?.(`platform.period.${value}`)}><ButtonIcon kind="clock" />{t('platform.days', { count: value })}</button>)}
    </div>
    {stats ? <>
      <p>{t('platform.updated', { at: formatDateTime(stats.generatedAt, locale) })}</p>
      <dl>{platformMetrics(stats).map(metric => <div key={metric.key}>
        <dt>{t(`platform.metric.${metric.key}`)}</dt><dd>{number(metric.value, metric.currency)}
          {metric.hint && metric.amount !== null ? ` · ${t(`platform.${metric.hint}`, { count: metric.amount ?? 0 })}` : null}</dd>
      </div>)}</dl>
      <p>{t('platform.scope')}</p>
      <p>{stats.traffic ? t('platform.trafficSince', { at: formatDateTime(stats.traffic.startedAt, locale) }) : t('platform.trafficUnavailable')}</p>
      <p>{t('platform.costNote')}</p>
      {stats.projects?.unmeteredRuns ? <p>{t('platform.unmetered', { count: stats.projects.unmeteredRuns })}</p> : null}
      <table><caption>{t('platform.daily')}</caption><thead><tr><th>{t('platform.day')}</th>
        <th>{t('platform.chart.requests')}</th><th>{t('platform.chart.signups')}</th><th>{t('platform.chart.runs')}</th>
      </tr></thead><tbody>{platformDaily(stats).map(row => <tr key={row.day}><th scope="row">{row.day}</th>
        <td>{row.requests === null ? t('platform.noMeasurement') : number(row.requests)}</td><td>{number(row.signups)}</td><td>{number(row.runs)}</td>
      </tr>)}</tbody></table>
      <h3>{t('platform.execution')}</h3><dl>{PLATFORM_RUN_STATES.map(state => <div key={state}>
        <dt>{t(`platform.run.${state}`)}</dt><dd>{number(stats.projects?.[state] ?? null)}</dd></div>)}</dl>
      <h3>{t('platform.health')}</h3><dl>
        <dt>{t('platform.clientErrors')}</dt><dd>{number(stats.traffic?.totals.clientErrors ?? null)}</dd>
        <dt>{t('platform.serverErrors')}</dt><dd>{number(stats.traffic?.totals.serverErrors ?? null)}</dd>
        <dt>{t('platform.meanResponse')}</dt><dd>{stats.traffic?.totals.requests ? `${number(stats.traffic.totals.durationMs / stats.traffic.totals.requests)} ms` : '—'}</dd>
        <dt>{t('platform.uptime')}</dt><dd>{runDuration(stats.uptimeSeconds * 1000, t)}</dd>
        <dt>{t('platform.pendingInvitations')}</dt><dd>{number(stats.accounts.pendingInvitations)}</dd>
      </dl>
      <h3>{t('platform.surfaces')}</h3><dl>{stats.traffic?.surfaces.map(row => <div key={row.surface}>
        <dt>{t(`platform.surface.${row.surface}`)}</dt><dd>{number(row.requests)}</dd></div>)}</dl>
      <h3>{t('platform.recentSignups')}</h3>{stats.accounts.recent.length ? <ul>{stats.accounts.recent.map((row, index) => <li key={index}>
        {row.displayName} · {formatDateTime(row.createdAt, locale)}</li>)}</ul> : <p>{t('platform.noSignups')}</p>}
      <p>{t('platform.privacy')}</p>
    </> : null}
  </section>;
}
