import { formatDateTime } from '../../../client/date-format.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';
import { witCounts } from '../../wit-presentation.js';
import { wrapCopyLines } from '../compute-results-block.js';
import { drawLoadingNotice } from '../loading-notice.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_PAD, VIEW_FRAME_PANE_AIR } from '../view-frame.js';

export function drawWit(ctx: RendererCtx, snapshot: GpuRenderSnapshot, width: number, height: number): void {
  const { t } = snapshot;
  const frame = viewFrame(width, height);
  drawViewFrame(ctx, frame, t('wit.title'), '');
  const report = snapshot.data.witReport;
  const fetching = snapshot.data.witFetching === true;
  // This status stays outside the scrolling list; reserve its row even at rest.
  const contentTop = frame.contentTop + 36;
  if (fetching) {
    drawLoadingNotice(ctx, ctx.root, t('loading.wit'), frame.innerX, frame.contentTop + 4, { width: frame.innerWidth });
  } else if (report) {
    const label = t('wit.updated', { at: formatDateTime(report.generatedAt, snapshot.state.locale) });
    ctx.text(ctx.root, label, frame.innerX, frame.contentTop + 4, { size: 11, color: GPU_COLORS.muted, width: frame.innerWidth, singleLine: true });
    ctx.tooltip(ctx.root, { x: frame.innerX, y: frame.contentTop, width: frame.innerWidth, height: 28, text: label });
  }
  const pane = createScrollPane(ctx.root, { x: frame.x, y: contentTop, width: frame.width,
    height: Math.max(0, frame.bottom - VIEW_FRAME_PAD - contentTop),
    scrollY: snapshot.state.scrollY.wit, bottomPadding: 24, air: { ...VIEW_FRAME_PANE_AIR, top: 0 } });
  const x = VIEW_FRAME_PAD, w = frame.innerWidth;
  let y = 8;
  const line = (text: string, size = 12, color: number = GPU_COLORS.text) => {
    for (const paragraph of text.split('\n')) {
      for (const part of wrapCopyLines(ctx, paragraph, w, size)) {
        if (pane.visible(y, y + size + 8)) ctx.text(pane.content, part, x, y, { size, color, width: w, singleLine: true });
        y += size + 8;
      }
    }
    y += 12;
  };
  const button = (id: string, label: string) => {
    if (pane.visible(y, y + 32)) {
      ctx.button(pane.content, id, 'button', label, x, y,
        Math.min(w, ctx.measureText(label, { size: 11 }) + 52), 32, false, snapshot.onActivate,
        GPU_COLORS.primary, false, false, undefined, undefined, undefined,
        fetching && (id === 'wit.latest' || id === 'wit.next'));
    }
    y += 44;
  };
  line(t('wit.scope'), 12, GPU_COLORS.muted);
  button('wit.latest', t('wit.latest'));
  if (report) {
    line(t('wit.coverage', { count: report.runsScanned, total: report.totalRuns }), 14);
    line(witCounts(report).map(row => `${t(`wit.status.${row.status}`)}: ${row.count}`).join(' · '), 14);
    if (report.unreadableRuns || report.omittedEvents) line(t('wit.incomplete', { runs: report.unreadableRuns, events: report.omittedEvents }), 12);
    if (!report.receipts.length) line(t('wit.empty'));
    report.receipts.forEach((row, index) => {
      y += 16;
      line(`${row.runLabel} · ${t(`wit.status.${row.status}`)}`, 15);
      line(`${formatDateTime(row.at, snapshot.state.locale)} · ${row.actor ?? '—'} · ${t('wit.exit', { code: row.exitCode ?? '—' })}`, 11, GPU_COLORS.muted);
      line(row.command);
      line(row.output || t('wit.noOutput'), 11, GPU_COLORS.muted);
      if (row.outputTruncated) line(t('wit.truncated'), 11);
      button(`wit.open.${index}`, t('wit.open'));
    });
    if (report.nextBefore) button('wit.next', t('wit.next'));
    line(t('wit.details'), 11, GPU_COLORS.muted);
  }
  pane.extend(y);
  ctx.scrollMax.wit = pane.finish();
}
