import { formatDateTime } from '../../../client/date-format.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_PAD } from '../view-frame.js';

/** The platform's transactional running set, including preparation before a trace exists. */
export function drawLiveRuns(ctx: RendererCtx, snapshot: GpuRenderSnapshot, width: number, height: number): void {
  const runs = snapshot.data.adminLiveRuns;
  const frame = viewFrame(width, height);
  drawViewFrame(ctx, frame, snapshot.t('nav.liveRuns'), snapshot.t('liveRuns.count', { count: runs.length }));
  const pane = createScrollPane(ctx.root, {
    x: frame.x, y: frame.contentTop, width: frame.width,
    height: Math.max(0, frame.bottom - VIEW_FRAME_PAD - frame.contentTop),
    scrollY: snapshot.state.scrollY.liveRuns, bottomPadding: 24,
  });
  const x = VIEW_FRAME_PAD;
  const textX = x + 16;
  const textWidth = Math.max(0, frame.innerWidth - 32);
  const note = ctx.text(pane.content, snapshot.t('liveRuns.scope'), textX, 8,
    { size: 11, color: GPU_COLORS.muted, width: textWidth });
  let y = 20 + note.height;
  if (runs.length === 0) {
    const empty = ctx.text(pane.content, snapshot.t('liveRuns.empty'), textX, y,
      { size: 13, color: GPU_COLORS.muted, width: textWidth });
    y += empty.height + 16;
  }
  for (const run of runs) {
    const cardHeight = 166;
    if (pane.visible(y, y + cardHeight)) {
      ctx.panel(pane.content, x, y, frame.innerWidth, cardHeight, GPU_COLORS.panel,
        GPU_COLORS.border, GPU_LAYOUT.radius, 2);
      const line = (text: string, offset: number, size: number, color: number = GPU_COLORS.text) => {
        ctx.text(pane.content, text, textX, y + offset, { size, color, width: textWidth, singleLine: true });
        ctx.tooltip(pane.content, { x: textX, y: y + offset, width: textWidth, height: size + 6, text });
      };
      line(run.orgName ?? run.orgId, 12, 11, GPU_COLORS.primary);
      line(run.projectName, 32, 13);
      line(run.goal, 56, 12);
      line(snapshot.t('liveRuns.started', { at: run.startedAt ? formatDateTime(run.startedAt, snapshot.state.locale) : '—' }),
        80, 10, GPU_COLORS.muted);
      line(run.projectRunId, 100, 9, GPU_COLORS.muted);
      if (run.traceId) {
        const label = snapshot.t('liveRuns.open');
        const buttonWidth = Math.min(textWidth, ctx.measureText(label, { size: 11 }) + 52);
        ctx.button(pane.content, `liveRuns.run.${run.projectRunId}`, 'button', label,
          textX, y + 124, buttonWidth, 28, false, snapshot.onActivate);
      } else {
        line(snapshot.t('liveRuns.preparing'), 130, 11, GPU_COLORS.muted);
      }
    }
    y += cardHeight + 12;
  }
  pane.extend(y);
  ctx.scrollMax.liveRuns = pane.finish();
}
