import type { AssayerViewData } from './assayer-presentation.js';
import { assayDetailLines, assayLabel } from './assayer-presentation.js';
import { AtomaLoader } from './AtomaLoader.js';
import { ButtonIcon } from './ButtonIcon.js';
import { formatDateTime } from '../client/date-format.js';
import type { VizSentinelSnapshot } from '../client/types.js';
import {
  assayerStats, assayerStatus, SENTINEL_SECTION_ICONS, sentinelTabs, sentinelWatchNotes, sentinelWatchStats, sentinelWatchStatus,
} from './sentinel-presentation.js';
import type { SentinelSection } from './store.js';

/**
 * The Sentinel screen's accessible twin: the same five tabs, the same
 * headline, figures and lists as the canvas, from the same presentation
 * module — so a screen reader and the GPU never disagree on a fact.
 */
export function SentinelAccessible({ payload, assayer, section, locale, t, onActivate }: {
  payload: VizSentinelSnapshot | null;
  assayer: AssayerViewData | null;
  section: SentinelSection;
  locale: string;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onActivate?: (id: string) => void;
}) {
  const tabs = sentinelTabs(payload, assayer, t);
  const watch = payload?.watch ?? null;
  const watchStatus = sentinelWatchStatus(watch, t, locale);
  const assayStatus = assayerStatus(assayer, t, locale);
  const stats = (rows: ReturnType<typeof sentinelWatchStats>) => rows.length === 0 ? null : (
    <dl>{rows.map(stat => <div key={stat.key}><dt>{stat.label}</dt><dd>{stat.value}</dd></div>)}</dl>
  );
  return (
    <section aria-label={t('sentinel.title')}>
      <nav role="tablist" aria-label={t('sentinel.title')}>
        {tabs.map(tab => (
          <button key={tab.id} id={`sentinel-tab-${tab.id}`} type="button" role="tab" aria-selected={section === tab.id}
            aria-controls={`sentinel-panel-${tab.id}`} onClick={() => onActivate?.(`sentinel.section.${tab.id}`)}>
            <ButtonIcon kind={SENTINEL_SECTION_ICONS[tab.id]} />{tab.label}
          </button>
        ))}
      </nav>
      <div id={`sentinel-panel-${section}`} role="tabpanel" aria-labelledby={`sentinel-tab-${section}`}>
        {section === 'watch' ? <>
          <h2>{watchStatus.headline}</h2>
          <p>{watchStatus.sentence}</p>
          {stats(sentinelWatchStats(watch, t, locale))}
          {sentinelWatchNotes(watch, t, locale).map((line, i) => <p key={i}>{line}</p>)}
        </> : null}
        {section === 'assayer' ? <>
          <h2>{assayStatus.headline}</h2>
          <p>{t('assayer.scope')}</p>
          {assayStatus.facts.map((line, i) => <p key={i}>{line}</p>)}
          {stats(assayerStats(assayer, t, locale))}
          <h3>{t('assayer.attempts')}</h3>
          {!assayer ? <p>{t('assayer.unavailable')}</p> : <>
            {assayer.error || assayer.selectedError ? <p role="alert">{t('assayer.loadFailed')}</p> : null}
            {assayer.loading || assayer.selectedLoading ? <AtomaLoader label={t('loading.assayer')} /> : null}
            {!assayer.loading && !assayer.error && assayer.assays.length === 0 ? <p>{t('assayer.empty')}</p> : null}
            {assayer.assays.map(row => {
              const open = assayer.selected?.summary.id === row.id;
              return <article key={row.id}>
                <button type="button" aria-expanded={open} onClick={() => onActivate?.(`assayer.open.${row.id}`)}>
                  <ButtonIcon kind="eye" />{assayLabel(row, t, locale)}
                </button>
                {open ? assayDetailLines(assayer, t).map((line, i) => <p key={i}>{line}</p>) : null}
              </article>;
            })}
            {assayer.hasMore ? <button type="button" disabled={assayer.loading} onClick={() => onActivate?.('assayer.more')}>
              <ButtonIcon kind="down" />{t('assayer.more')}
            </button> : null}
          </>}
        </> : null}
        {section === 'coverage' ? <>
          <h2>{t('sentinel.coverage')}</h2>
          {!payload || payload.live.length === 0 ? <p>{t('sentinel.coverageEmpty')}</p> : payload.live.map(run => (
            <article key={run.runId}>
              <p>{t(`sentinel.corpus.${run.corpus}`)} · {run.label ?? run.runId} · {run.runId}</p>
              <button type="button" onClick={() => onActivate?.(`sentinel.run.${run.runId}`)}><ButtonIcon kind="play" />{t('sentinel.openRun')}</button>
            </article>
          ))}
          {payload && payload.skipped.length > 0 ? <>
            <h3>{t('sentinel.skipped')}</h3>
            {payload.skipped.map((skip, i) => <p key={i}>{skip.runId ?? '—'} · {skip.reason}</p>)}
          </> : null}
        </> : null}
        {section === 'rules' ? <>
          <h2>{t('sentinel.rules')}</h2>
          {!payload || payload.rules.length === 0 ? <p>{t('sentinel.rulesEmpty')}</p> : payload.rules.map(rule => {
            const prose = t(`sentinel.rule.${rule.id}`);
            return <article key={rule.id}>
              <h3>{rule.id} · {rule.kind}</h3>
              {prose === `sentinel.rule.${rule.id}` ? null : <p>{prose}</p>}
            </article>;
          })}
        </> : null}
        {section === 'findings' ? <>
          <h2>{t('sentinel.findings')}</h2>
          <p>{t('sentinel.flagOnly')}</p>
          {payload && payload.findings.length > 0 ? <>
            <h3>{t('sentinel.byRule')}</h3>
            <dl>{[...payload.findings.reduce((counts, finding) => {
              const ruleId = typeof finding.detail?.['ruleId'] === 'string' ? finding.detail['ruleId'] : '—';
              return counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
            }, new Map<string, number>())].map(([ruleId, count]) => <div key={ruleId}><dt>{ruleId}</dt><dd>{count}</dd></div>)}</dl>
          </> : null}
          {!payload || payload.findings.length === 0 ? <p>{t('sentinel.findingsEmpty')}</p> : payload.findings.map(finding => {
            const detail = finding.detail ?? {};
            const ruleId = typeof detail['ruleId'] === 'string' ? detail['ruleId'] : '';
            return <article key={finding.seq}>
              <p>{formatDateTime(finding.at, locale, { seconds: true })} · {finding.severity} · {finding.summary}{ruleId ? ` · ${ruleId}` : ''}</p>
              {finding.runId ? <button type="button" onClick={() => onActivate?.(`sentinel.run.${finding.runId}`)}><ButtonIcon kind="play" />{t('sentinel.openRun')}</button> : null}
            </article>;
          })}
        </> : null}
      </div>
    </section>
  );
}
