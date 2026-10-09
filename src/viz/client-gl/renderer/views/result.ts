import { BUTTON_ICON_SPACE } from '../../button-icons.js';
import { Rectangle } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';
import { resultNarrative, resultSections, resultText } from '../../run-result.js';
import { runStatus } from '../../../client/run-utils.js';
import { formatDateTime } from '../../../client/date-format.js';
import { drawPreviewControl } from '../preview-control.js';

/** One bounded result reader shared by Projects and Runs. No model HTML executes. */
export function drawResultPanel(ctx: RendererCtx, snapshot: GpuRenderSnapshot,
  x: number, y: number, width: number, height: number, showBackButton = true,
  /** Runs carries the preview in its own action row, above this reader. */
  showPreview = true): void {
  const run = snapshot.data.resultRun?.id === snapshot.state.resultRunId ? snapshot.data.resultRun : null;
  const projectRun = Object.values(snapshot.data.projectRuns).flat()
    .find(row => row.traceId === snapshot.state.resultRunId || row.projectRunId === snapshot.state.resultRunId);
  const details = snapshot.state.resultDetailsOpen;
  ctx.panel(ctx.root, x, y, width, height, GPU_COLORS.panel, GPU_COLORS.border);
  const buttonWidth = (label: string) => Math.ceil(ctx.measureText(label, { size: 11, weight: '600' })) + 24 + BUTTON_ICON_SPACE;
  const backLabel = snapshot.t('result.back');
  const backWidth = buttonWidth(backLabel);
  const title = snapshot.t('result.title');
  const titleStyle = { size: 16, weight: '700' } as const;
  const titleWidth = ctx.measureText(title, titleStyle);
  const detailsLabel = snapshot.t(details ? 'result.hideDetails' : 'result.details');
  const detailsWidth = Math.min(width - 32, buttonWidth(detailsLabel));
  const titleStacked = showBackButton && backWidth + 16 + titleWidth > width - 32;
  const firstRowWidth = titleWidth + (showBackButton ? backWidth + 16 : 0);
  const detailsStacked = titleStacked || firstRowWidth + detailsWidth + 16 > width - 32;
  if (showBackButton) {
    ctx.button(ctx.root, 'result.close', 'button', backLabel, x + 16, y + 8,
      Math.min(backWidth, width - 32), 30, false, snapshot.onActivate);
  }
  ctx.text(ctx.root, title, x + 16 + (titleStacked || !showBackButton ? 0 : backWidth + 16),
    y + (titleStacked ? 48 : 12), titleStyle);
  const detailsY = detailsStacked ? (titleStacked ? 80 : 48) : 8;
  if (run) {
    ctx.button(ctx.root, 'result.details', 'button', detailsLabel,
      detailsStacked ? x + 16 : x + width - 16 - detailsWidth, y + detailsY,
      detailsWidth, 30, details, snapshot.onActivate);
  }
  let top = y + (run && detailsStacked ? detailsY + 40 : titleStacked ? 80 : 48);
  if (showPreview) top += drawPreviewControl(ctx, snapshot, x + 6, top, width - 12);
  const paneHeight = Math.max(0, height - (top - y) - 12);
  const pane = createScrollPane(ctx.root, { x: x + 12, y: top, width: width - 24,
    height: paneHeight, scrollY: ctx.detailScrollY });
  ctx.detailBounds = new Rectangle(x + 12, top, width - 24, paneHeight);
  // Keep paragraphs readable on a large display instead of spanning the viewport.
  const contentWidth = Math.min(960, width - 44);
  let cursor = 4;
  const text = (value: string, heading = false, muted = false) => {
    const label = ctx.text(pane.content, value, 4, cursor, { size: heading ? 15 : 13,
      weight: heading ? '700' : '400', color: muted ? GPU_COLORS.muted : GPU_COLORS.text, width: contentWidth });
    cursor += label.height + 14;
  };
  const action = (id: string, key: string) => {
    const label = snapshot.t(key);
    ctx.button(pane.content, id, 'button', label, 4, cursor,
      Math.min(contentWidth, buttonWidth(label)), 32, false, snapshot.onActivate);
    cursor += 42;
  };
  const sections = (values: { title: string; text: string }[]) => {
    let remaining = 24000;
    let shortened = false;
    for (const section of values.slice(0, 80)) {
      if (remaining <= 0) { shortened = true; break; }
      if (section.title) text(section.title, true);
      text(section.text.slice(0, remaining));
      shortened ||= section.text.length > remaining;
      remaining -= section.text.length;
    }
    if (shortened || values.length > 80) text(snapshot.t('result.truncated'), false, true);
  };

  if (run) {
    text(`${snapshot.t(`runs.flag.${runStatus(run)}`)} · ${formatDateTime(run.endedAt ?? run.startedAt, snapshot.state.locale)}`, false, true);
    if (runStatus(run) !== 'delivered') text(snapshot.t('result.notFinal'));
  } else {
    text(snapshot.t(snapshot.data.resultFailed ? 'result.unavailable' : 'result.loading'));
  }

  // Only the host's manifest grants file actions; names in model output do not.
  const files = projectRun?.artifactManifest?.files ?? [];
  if (files.length > 0 && projectRun) {
    text(snapshot.t(projectRun.status === 'delivered' ? 'result.files' : 'result.savedFiles', { count: files.length }), true);
    const canOpen = !projectRun.bytesExpiredAt && ['delivered', 'partial'].includes(projectRun.status);
    if (projectRun.bytesExpiredAt) text(snapshot.t('result.expired'), false, true);
    else if (canOpen) text(snapshot.t('result.openFiles'), false, true);
    const columns = contentWidth >= 760 ? 2 : 1;
    const gap = 12;
    const fileWidth = (contentWidth - gap * (columns - 1)) / columns;
    files.forEach((file, index) => {
      const fileX = 4 + (index % columns) * (fileWidth + gap);
      const fileY = cursor + Math.floor(index / columns) * 40;
      if (!pane.visible(fileY, fileY + 32)) return;
      const label = `${file.path} · ${file.size.toLocaleString(snapshot.state.locale)} B`;
      if (canOpen) {
        ctx.button(pane.content, `result.file.${encodeURIComponent(file.path)}`, 'button', label,
          fileX, fileY, fileWidth, 32, false, snapshot.onActivate);
      } else {
        ctx.text(pane.content, label, fileX, fileY + 7, { size: 12, width: fileWidth, singleLine: true });
      }
      ctx.tooltip(pane.content, { x: fileX, y: fileY, width: fileWidth, height: 32, text: label });
    });
    cursor += Math.ceil(files.length / columns) * 40 + 16;
  }

  if (run) {
    const output = resultText(run);
    const narrative = resultNarrative(run);
    const summary = run.result?.summary;
    if (summary && !narrative.some(section => section.text === summary)) {
      text(snapshot.t('result.overview'), true);
      text(summary.slice(0, 12000));
      if (summary.length > 12000) text(snapshot.t('result.truncated'), false, true);
    }
    if (narrative.length > 0) {
      text(snapshot.t('result.answer'), true);
      sections(narrative.map((section, index) => ({ ...section, title: index === 0 ? '' : section.title })));
    } else if (output !== null && !summary && files.length === 0) {
      text(snapshot.t('result.structured'), false, true);
    }
    if (output === null) text(snapshot.t('result.noOutput'));
    else if (narrative.length > 0) action('result.copy', 'result.copy');
    if (snapshot.state.resultActionStatus) text(snapshot.t(`result.${snapshot.state.resultActionStatus}`));

    if (details) {
      cursor += 16;
      text(snapshot.t('result.details'), true);
      if (output !== null && narrative.length === 0) action('result.copy', 'result.copyOutput');
      if (output !== null) action('result.download', 'result.download');
      text(snapshot.t('result.request'), true);
      const goal = run.task?.description ?? run.label;
      text(goal.slice(0, 12000));
      if (goal.length > 12000) text(snapshot.t('result.truncated'), false, true);
      text(run.id, false, true);
      if (output !== null) {
        text(snapshot.t('result.recordedOutput'), true);
        sections(resultSections(run));
      }
    }
  }
  pane.extend(cursor);
  ctx.detailScrollMax = pane.finish();
  ctx.detailScrollY = Math.min(ctx.detailScrollY, ctx.detailScrollMax);
}
