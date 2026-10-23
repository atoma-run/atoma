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
/** The GPU section and its accessible twin share the exact same facts and wording (`sentinel-presentation.ts` holds the health lines). */
export function assayLabel(row: AssaySummary, t: Translate, locale: string): string {
  return `${formatDateTime(row.endedAt, locale)} · ${row.skillId} · ${t(`assayer.status.${row.status}`)} · ${row.judgement ? t(`assayer.verdict.${row.judgement.verdict}`) : t('assayer.noJudgement')}`;
}
export function assayDetailLines(data: AssayerViewData, t: Translate): string[] {
  if (data.selectedError) return [t('assayer.loadFailed')];
  if (!data.selected) return [];
  const { summary: row, record } = data.selected;
  // The row above already names the recipe; the surface is identified by a
  // short prefix of its digest, the full value reachable from the record.
  const lines = [row.failure ?? t('assayer.validEvidence'), t('assayer.surface', { digest: row.surfaceDigest.slice(0, 12) })];
  if (row.judgement) lines.push(t('assayer.comparison', { matched: row.judgement.matchedCases,
    with: row.judgement.deliveries.with, without: row.judgement.deliveries.without,
    decision: t(`assayer.decision.${row.judgement.decision}`) }));
  record.cases.forEach((c, i) => {
    lines.push(t('assayer.case', { index: i + 1 }), c.task);
    for (const a of [c.with, c.without]) lines.push(`${t(`assayer.arm.${a.arm}`)} · ${a.outcome} · ${t('assayer.armEvidence', { calls: a.llmCalls ?? '—', matched: t(a.matched ? 'assayer.yes' : 'assayer.no') })}`);
  });
  return lines;
}
