import type { VizProjectRun } from '../client/types.js';
import { runCost } from '../client/run-utils.js';
import { projectOverview } from './project-overview.js';
import { useGpuStore } from './store.js';

/**
 * The semantic twin of the GPU overview column: the canvas is aria-hidden,
 * so the figures and the cost breakdown are here as a list and a table —
 * the table being the pie's non-visual reading.
 */
export function ProjectOverviewAccessible({ runs, t }: {
  runs: readonly VizProjectRun[]; t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  const locale = useGpuStore(s => s.locale);
  const collapsed = useGpuStore(s => s.projectOverviewCollapsed);
  const toggle = useGpuStore(s => s.toggleProjectOverview);
  const overview = projectOverview(runs, t('projects.overview.unknownUser'));
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return <section aria-label={t('projects.overview.title')}>
    <h3>{t('projects.overview.title')}</h3>
    <button type="button" aria-expanded={!collapsed} onClick={toggle}>
      {t(collapsed ? 'projects.overview.expand' : 'projects.overview.collapse')}
    </button>
    <ul>
      <li>{t('projects.overview.runCount')}: {overview.runCount}</li>
      <li>{t('projects.overview.llmCost')}: {runCost(overview.llmCostUsd)}</li>
      <li>{t('projects.overview.tokens')}: {overview.tokens.toLocaleString(locale)}</li>
      <li>{t('projects.overview.llmCalls')}: {overview.llmCalls.toLocaleString(locale)}</li>
      <li>{t('projects.overview.jevCalls')}: {overview.jevCalls.toLocaleString(locale)}</li>
    </ul>
    {overview.requesters.length ? <>
      <h4>{t('projects.overview.launchedBy')}</h4>
      <ul>{overview.requesters.map(requester => <li key={requester.principalId}>
        {requester.name}: {t('projects.overview.runs', { count: requester.runs })}, {runCost(requester.costUsd)}
      </li>)}</ul>
    </> : null}
    {overview.slices.length ? <table aria-label={t('projects.overview.table')}>
      <thead><tr>
        <th scope="col">{t('projects.overview.costBreakdown')}</th>
        <th scope="col">{t('projects.overview.cost')}</th>
        <th scope="col">{t('projects.overview.share')}</th>
      </tr></thead>
      <tbody>{overview.slices.map(slice => <tr key={slice.key}>
        <th scope="row">{t(`projects.overview.slice.${slice.key}`)}{slice.models[0] ? ` (${slice.models[0].model})` : ''}</th>
        <td>{runCost(slice.costUsd)}</td>
        <td>{percent.format(slice.share)}</td>
      </tr>)}</tbody>
    </table> : null}
  </section>;
}
