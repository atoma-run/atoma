import type { VizRun } from '../client/types.js';
import { ACTIVITY_CHANGE_PAGE_SIZE, activityFileSummary, buildRunActivity } from './run-activity.js';
import { buildActivityDiff } from './run-diff.js';
import { CODE_FONT_FAMILY } from './theme.js';
import { useGpuStore } from './store.js';
import { runCost, runDuration, runElapsedMs, runStatus, runUsageValue } from '../client/run-utils.js';
import { formatDateTime } from '../client/date-format.js';

/** Semantic twin of the GPU progress reader; all controls use the same store actions. */
export function AccessibleRunActivity({ run, t }: {
  run: VizRun;
  t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  const state = useGpuStore();
  const activity = buildRunActivity(run);
  const selected = activity.files.find(file => file.path === state.runActivityFile);
  const pages = Math.max(1, Math.ceil((selected?.changes.length ?? 0) / ACTIVITY_CHANGE_PAGE_SIZE));
  const page = Math.min(state.runActivityPage, pages - 1);
  const end = (selected?.changes.length ?? 0) - page * ACTIVITY_CHANGE_PAGE_SIZE;
  return <section aria-label={t('activity.title')}>
    <button onClick={() => state.showRunActivity(!state.runActivityOpen)} aria-expanded={state.runActivityOpen}>
      {t(state.runActivityOpen ? 'activity.backTrace' : 'activity.open', { count: activity.touched })}
    </button>
    {state.runActivityOpen && <>
      <p>{t(`runs.flag.${runStatus(run)}`)}</p>
      {selected ? <>
        <button onClick={() => state.selectActivityFile(null)}>{t('activity.backFiles')}</button>
        <h2>{selected.path}</h2>
        <p>{activityFileSummary(selected, t)}</p>
        <p>{t('activity.excerpts')}</p>
        <p>{t('activity.page', { page: page + 1, pages })}</p>
        {selected.changes.slice(Math.max(0, end - ACTIVITY_CHANGE_PAGE_SIZE), end).reverse().map((change, index) => {
          const expanded = state.runActivityExpandedChanges[change.event.id] ?? index === 0;
          const diff = expanded ? buildActivityDiff(change.event) : null;
          return <article key={change.event.id}>
          <h3><button aria-expanded={expanded} onClick={() => state.setActivityChangeExpanded(change.event.id, !expanded)}>
            {t(expanded ? 'activity.diff.hide' : 'activity.diff.show')} · {t(`activity.${change.status}`)} · {formatDateTime(change.event.ts, state.locale)}
          </button></h3>
          {diff && <>
          {change.transformed && <p>{t('activity.transformed')}</p>}
          {change.replacements !== undefined && <p>{t('activity.replacements', { count: change.replacements })}</p>}
          {change.event.error && <p>{change.event.error.slice(0, 2400)}</p>}
          <table className="gpu-code-diff" style={{ fontFamily: CODE_FONT_FAMILY }}>
            <caption>{t('activity.diff.numbering')}</caption>
            <colgroup><col className="gpu-code-diff-number" /><col /><col className="gpu-code-diff-number" /><col /></colgroup>
            <thead><tr><th colSpan={2} scope="colgroup">{t('activity.diff.before')}</th><th colSpan={2} scope="colgroup">{t('activity.diff.after')}</th></tr></thead>
            <tbody>
              {(!diff.beforeAvailable || !diff.afterAvailable || diff.rows.length === 0) && <tr>
                {[diff.beforeAvailable, diff.afterAvailable].map((available, side) => <td colSpan={2} key={side}>
                  {!available ? t('activity.diff.unavailable') : diff.rows.length === 0 ? t('activity.diff.empty') : ''}
                </td>)}
              </tr>}
              {diff.rows.map((row, index) => <tr key={index}>
                <td data-kind={row.before?.kind}>{row.before?.line}</td><td data-kind={row.before?.kind}><code>{row.before?.kind === 'delete' ? '− ' : ''}{row.before?.text}</code></td>
                <td data-kind={row.after?.kind}>{row.after?.line}</td><td data-kind={row.after?.kind}><code>{row.after?.kind === 'insert' ? '+ ' : ''}{row.after?.text}</code></td>
              </tr>)}
            </tbody>
          </table>
          <p>{t('activity.source', { id: change.event.id })}</p>
          <button onClick={() => state.selectEvent(change.event.id)}>{t('activity.viewSource')}</button>
          </>}
        </article>; })}
        {page > 0 && <button onClick={() => state.pageActivity(-1)}>{t('activity.newer')}</button>}
        {page + 1 < pages && <button onClick={() => state.pageActivity(1)}>{t('activity.older')}</button>}
      </> : <>
        <h2>{t(activity.touched ? 'activity.files' : 'activity.noSavedFiles', { count: activity.touched })}</h2>
        <p>{t('activity.confirmedCount', { count: activity.edits })} · {t('summary.cost')}: {runUsageValue(run, runCost(run.totals?.costUsd), t)} · {runDuration(runElapsedMs(run), t)}</p>
        <h3>{t('activity.fileHistory')}</h3><p>{t('activity.fileHint')}</p>
        {!activity.files.length && <p>{t('activity.noFiles')}</p>}
        {activity.files.map(file => <div key={file.path}>
          <button onClick={() => state.selectActivityFile(file.path)} aria-label={t('activity.viewFile', { path: file.path })}>{file.path}</button>
          <p>{activityFileSummary(file, t)}</p>
        </div>)}
        <details><summary>{t('activity.fileScope')}</summary><p>{t('activity.coverage')}</p></details>
        <h3>{t('activity.process')}</h3><p>{t('activity.processHint')}</p>
        <ol>{activity.steps.map(step => <li key={step.id}>
          <h4>{t(`activity.step.${step.id}`)}</h4>
          <p>{t(`activity.step.${step.detail}`, { count: step.count })}</p>
        </li>)}</ol>
      </>}
    </>}
  </section>;
}
