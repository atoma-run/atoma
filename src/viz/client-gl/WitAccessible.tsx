import type { WitReport } from '../../contracts/witReport.js';
import { formatDateTime } from '../client/date-format.js';
import { witCounts } from './wit-presentation.js';
import { ButtonIcon } from './ButtonIcon.js';
export function WitAccessible({ report, t, locale, onActivate }: {
  report: WitReport | null; locale: string; t: (key: string, vars?: Record<string, unknown>) => string;
  onActivate?: (id: string) => void;
}) {
  return <section aria-label={t('nav.wit')}><h2>{t('wit.title')}</h2><p>{t('wit.scope')}</p>
    <button type="button" onClick={() => onActivate?.('wit.latest')}><ButtonIcon kind="clock" />{t('wit.latest')}</button>
    {report ? <>
      <p>{t('wit.coverage', { count: report.runsScanned, total: report.totalRuns })}</p>
      <p>{t('wit.updated', { at: formatDateTime(report.generatedAt, locale) })}</p>
      <dl>{witCounts(report).map(row => <div key={row.status}><dt>{t(`wit.status.${row.status}`)}</dt><dd>{row.count}</dd></div>)}</dl>
      {!!(report.unreadableRuns || report.omittedEvents) && <p role="status">{t('wit.incomplete', { runs: report.unreadableRuns, events: report.omittedEvents })}</p>}
      {!report.receipts.length && <p>{t('wit.empty')}</p>}
      {report.receipts.map((row, index) => <article key={`${row.runId}:${row.eventId}:${index}`}>
        <h3>{row.runLabel} · {t(`wit.status.${row.status}`)}</h3>
        <p>{formatDateTime(row.at, locale)} · {row.actor ?? '—'} · {t('wit.exit', { code: row.exitCode ?? '—' })}</p>
        <pre>{row.command}</pre><pre>{row.output || t('wit.noOutput')}</pre>
        {row.outputTruncated && <p>{t('wit.truncated')}</p>}
        <button type="button" onClick={() => onActivate?.(`wit.open.${index}`)}><ButtonIcon kind="play" />{t('wit.open')}</button>
      </article>)}
      {report.nextBefore && <button type="button" onClick={() => onActivate?.('wit.next')}><ButtonIcon kind="clock" />{t('wit.next')}</button>}
      <p>{t('wit.details')}</p>
    </> : null}
  </section>;
}
