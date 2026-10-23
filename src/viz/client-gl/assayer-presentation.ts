import type { AssaySummary, SkillAssayRecord } from '../../contracts/skillAssay.js';
import type { ResidentAssayerHealth } from '../../supervisor/residentAssayer.js';
import { formatDateTime } from '../client/date-format.js';

export interface AssayerViewData {
  health: ResidentAssayerHealth | null;
  assays: AssaySummary[];
  hasMore: boolean;
  loading: boolean;
  error: boolean;
  selected: { summary: AssaySummary; record: SkillAssayRecord } | null;
  selectedLoading: boolean;
  selectedError: boolean;
}
type Translate = (key: string, vars?: Record<string, unknown>) => string;
/** The GPU section and its accessible twin share the exact same facts and wording. */
export function assayerLines(data: AssayerViewData, t: Translate, locale: string): string[] {
  const h = data.health;
  const lines = [t('assayer.scope'), t(h ? h.armed ? 'assayer.armed' : 'assayer.off' : 'assayer.unavailable')];
  if (h) {
    if (h.executorRelease) lines.push(t('assayer.executor', { release: h.executorRelease.slice(0, 12) }));
    lines.push(t(h.inFlight ? 'assayer.running' : 'assayer.idle', { skill: h.inFlight ?? '' }));
    if (h.pausedUntil) lines.push(t('assayer.paused', { at: formatDateTime(h.pausedUntil, locale) }));
    if (h.lastError) lines.push(h.lastError);
    lines.push(t('assayer.counters', { completed: h.assayed, failed: h.failed, deferred: h.deferred, preempted: h.preempted }));
  }
  if (data.error) lines.push(t('assayer.loadFailed'));
  if (!data.loading && !data.error && data.assays.length === 0) lines.push(t('assayer.empty'));
  return lines;
}
export function assayLabel(row: AssaySummary, t: Translate, locale: string): string {
  return `${formatDateTime(row.endedAt, locale)} · ${row.skillId} · ${t(`assayer.status.${row.status}`)} · ${row.judgement ? t(`assayer.verdict.${row.judgement.verdict}`) : t('assayer.noJudgement')}`;
}
export function assayDetailLines(data: AssayerViewData, t: Translate): string[] {
  if (data.selectedError) return [t('assayer.loadFailed')];
  if (!data.selected) return [];
  const { summary: row, record } = data.selected;
  const lines = [row.skillId, row.surfaceDigest, row.failure ?? t('assayer.validEvidence')];
  if (row.judgement) lines.push(t('assayer.comparison', { matched: row.judgement.matchedCases,
    with: row.judgement.deliveries.with, without: row.judgement.deliveries.without,
    decision: t(`assayer.decision.${row.judgement.decision}`) }));
  record.cases.forEach((c, i) => {
    lines.push(t('assayer.case', { index: i + 1 }), c.task);
    for (const a of [c.with, c.without]) lines.push(`${t(`assayer.arm.${a.arm}`)} · ${a.outcome} · ${t('assayer.armEvidence', { calls: a.llmCalls ?? '—', matched: t(a.matched ? 'assayer.yes' : 'assayer.no') })}`);
  });
  return lines;
}
