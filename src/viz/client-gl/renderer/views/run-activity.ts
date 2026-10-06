import { Rectangle } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';
import { formatDateTime } from '../../../client/date-format.js';
import { runCost, runDuration, runElapsedMs, runUsageValue } from '../../../client/run-utils.js';
import { ACTIVITY_CHANGE_PAGE_SIZE, activityFileSummary, buildRunActivity } from '../../run-activity.js';
import { buildActivityDiff } from '../../run-diff.js';
import { drawSplitDiff } from '../split-diff.js';

/** Only the selected file's bounded page is rendered; all list rows outside the pane are culled. */
export function drawRunActivity(ctx: RendererCtx, snapshot: GpuRenderSnapshot,
  x: number, y: number, width: number, height: number): void {
  const run = snapshot.data.run;
  if (!run) return;
  const activity = buildRunActivity(run);
  const t = snapshot.t;
  const selected = activity.files.find(file => file.path === snapshot.state.runActivityFile);
  // Keep the reading columns together on a large screen. The enclosing run
  // frame and selector retain their shared geometry.
  const contentWidth = selected ? width - 32 : Math.min(width - 32, 1120);
  const stackedHeader = contentWidth < 520;
  const paneTop = stackedHeader ? 118 : 80;
  const paneHeight = Math.max(0, height - paneTop - 6);
  const pane = createScrollPane(ctx.root, { x: x + 16, y: y + paneTop, width: contentWidth,
    height: paneHeight, scrollY: ctx.detailScrollY });
  ctx.detailBounds = new Rectangle(x + 16, y + paneTop, contentWidth, paneHeight);
  const title = selected?.path ?? t(activity.touched ? 'activity.files' : 'activity.noSavedFiles', { count: activity.touched });
  const titleWidth = Math.max(40, contentWidth - (stackedHeader ? 0 : 146));
  ctx.text(ctx.root, ctx.fitText(title, titleWidth, { size: 22, weight: '700' }), x + 16, y + 8,
    { size: 22, weight: '700', singleLine: true });
  ctx.tooltip(ctx.root, { x: x + 16, y: y + 8, width: titleWidth, height: 28, text: title });
  ctx.button(ctx.root, selected ? 'activity.files' : 'activity.close', 'button',
    t(selected ? 'activity.backFiles' : 'activity.fullTrace'), x + 16 + (stackedHeader ? 0 : contentWidth - 126),
    y + (stackedHeader ? 76 : 6), 126, 30, false, snapshot.onActivate);
  const metrics = selected ? activityFileSummary(selected, t) : [
    t('activity.confirmedCount', { count: activity.edits }),
    `${t('summary.cost')}: ${runUsageValue(run, runCost(run.totals?.costUsd), t)}`,
    runDuration(runElapsedMs(run), t),
  ].join(' · ');
  ctx.text(ctx.root, ctx.fitText(metrics, contentWidth, { size: 12 }), x + 16, y + 44,
    { size: 12, color: GPU_COLORS.muted, singleLine: true });
  ctx.tooltip(ctx.root, { x: x + 16, y: y + 44, width: contentWidth, height: 20, text: metrics });
  let innerWidth = contentWidth - 8;
  let columnX = 0;
  let cursor = 0;
  const line = (value: string, options: { color?: number; heading?: boolean; mono?: boolean } = {}) => {
    const height = options.heading ? 28 : 24;
    const style = { size: 13, weight: options.heading ? '700' : '400', mono: options.mono } as const;
    if (pane.visible(cursor, cursor + height)) {
      ctx.text(pane.content, ctx.fitText(value, innerWidth, style), columnX, cursor,
        { ...style, color: options.color ?? GPU_COLORS.text, singleLine: true });
      ctx.tooltip(pane.content, { x: columnX, y: cursor, width: innerWidth, height, text: value.slice(0, 2400) });
    }
    cursor += height;
  };
  const button = (id: string, value: string, active = false) => {
    if (pane.visible(cursor, cursor + 32)) ctx.button(pane.content, id, 'button', value,
      columnX, cursor, innerWidth, 32, active, snapshot.onActivate);
    cursor += 38;
  };
  if (selected) {
    line(t('activity.excerpts'), { color: GPU_COLORS.muted });
    line(t('activity.diff.numbering'), { color: GPU_COLORS.muted });
    const pages = Math.max(1, Math.ceil(selected.changes.length / ACTIVITY_CHANGE_PAGE_SIZE));
    const page = Math.min(snapshot.state.runActivityPage, pages - 1);
    line(t('activity.page', { page: page + 1, pages }));
    // Newest first, preserving older attempts as evidence. Each page yields to the browser before another is drawn.
    const end = selected.changes.length - page * ACTIVITY_CHANGE_PAGE_SIZE;
    for (const [index, change] of selected.changes.slice(Math.max(0, end - ACTIVITY_CHANGE_PAGE_SIZE), end).reverse().entries()) {
      const event = change.event;
      const expanded = snapshot.state.runActivityExpandedChanges[event.id] ?? index === 0;
      const heading = `${t(`activity.${change.status}`)} · ${formatDateTime(event.ts, snapshot.state.locale)}`;
      button(`activity.${expanded ? 'collapse' : 'expand'}.${encodeURIComponent(event.id)}`,
        `${expanded ? '▾' : '▸'} ${heading} · ${t(expanded ? 'activity.diff.hide' : 'activity.diff.show')}`, expanded);
      if (!expanded) { cursor += 12; continue; }
      if (change.replacements !== undefined) line(t('activity.replacements', { count: change.replacements }));
      if (change.transformed) line(t('activity.transformed'), { color: GPU_COLORS.warning });
      if (event.error) line(event.error.slice(0, 2400), { color: GPU_COLORS.error });
      const diff = buildActivityDiff(event);
      cursor += drawSplitDiff(ctx, pane, diff, columnX, cursor, innerWidth, t) + 12;
      line(t('activity.source', { id: event.id }), { color: GPU_COLORS.muted });
      button(`event.${event.id}`, t('activity.viewSource'));
      cursor += 12;
    }
    if (page > 0) button('activity.newer', t('activity.newer'));
    if (page + 1 < pages) button('activity.older', t('activity.older'));
  } else {
    const split = contentWidth >= 760;
    const sideWidth = split ? 300 : innerWidth;
    const filesWidth = split ? contentWidth - sideWidth - 44 : innerWidth;
    innerWidth = filesWidth;
    line(t('activity.fileHistory'), { heading: true });
    line(t('activity.fileHint'), { color: GPU_COLORS.muted });
    cursor += 10;
    if (!activity.files.length) line(t('activity.noFiles'));
    for (const file of activity.files) {
      if (pane.visible(cursor, cursor + 66)) {
        const label = t('activity.viewChanges');
        const actionWidth = Math.min(innerWidth * 0.34, ctx.measureText(label, { size: 11 }) + 16);
        const card = ctx.button(pane.content, `activity.file.${encodeURIComponent(file.path)}`, 'button', '',
          columnX, cursor, innerWidth, 66, false, snapshot.onActivate, GPU_COLORS.primary,
          false, false, undefined, undefined, t('activity.viewFile', { path: file.path }));
        ctx.text(card, ctx.fitText(file.path, innerWidth - actionWidth - 36, { size: 13, weight: '700' }), 12, 10,
          { size: 13, weight: '700', singleLine: true });
        ctx.text(card, ctx.fitText(label, actionWidth, { size: 11 }), innerWidth - actionWidth - 12, 12,
          { size: 11, color: GPU_COLORS.primary, singleLine: true });
        const summary = activityFileSummary(file, t);
        ctx.text(card, ctx.fitText(summary, innerWidth - 24, { size: 12 }), 12, 37,
          { size: 12, color: file.failed ? GPU_COLORS.warning : GPU_COLORS.muted, singleLine: true });
        ctx.tooltip(pane.content, { x: columnX, y: cursor, width: innerWidth, height: 66, text: `${file.path}\n${summary}` });
      }
      cursor += 78;
    }
    cursor += 4;
    line(t('activity.fileScope'), { color: GPU_COLORS.muted });
    if (pane.visible(cursor - 24, cursor)) ctx.tooltip(pane.content,
      { x: columnX, y: cursor - 24, width: innerWidth, height: 24, text: t('activity.coverage') });
    const filesBottom = cursor;
    innerWidth = sideWidth;
    if (split) { columnX = filesWidth + 36; cursor = 0; } else cursor += 28;
    line(t('activity.process'), { heading: true });
    line(t('activity.processHint'), { color: GPU_COLORS.muted });
    cursor += 10;
    for (const [index, step] of activity.steps.entries()) {
      if (pane.visible(cursor, cursor + 60)) {
        ctx.text(pane.content, String(index + 1).padStart(2, '0'), columnX, cursor + 2,
          { size: 13, weight: '700', color: step.recorded ? GPU_COLORS.primary : GPU_COLORS.muted });
        ctx.text(pane.content, ctx.fitText(t(`activity.step.${step.id}`), innerWidth - 38, { size: 13, weight: '700' }), columnX + 34, cursor,
          { size: 13, weight: '700', singleLine: true });
        const status = t(`activity.step.${step.detail}`, { count: step.count });
        ctx.text(pane.content, ctx.fitText(status, innerWidth - 38, { size: 12 }), columnX + 34, cursor + 25,
          { size: 12, color: step.active ? GPU_COLORS.primary : GPU_COLORS.muted, singleLine: true });
      }
      cursor += 78;
    }
    if (split) cursor = Math.max(cursor, filesBottom);
  }
  pane.extend(cursor);
  ctx.detailScrollMax = pane.finish();
  ctx.detailScrollY = Math.min(ctx.detailScrollY, ctx.detailScrollMax);
}
