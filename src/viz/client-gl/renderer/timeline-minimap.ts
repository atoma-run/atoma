import { Container, Graphics, Rectangle } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../gpu-renderer.js';
import type { TimelineLayout } from '../../client/timeline-layout.js';
import { GPU_COLORS } from '../theme.js';
import { eventAccent, gpuEventCardCopy } from './copy.js';

export const TIMELINE_MINIMAP_WIDTH = 36;
export const TIMELINE_JUMP_PREFIX = 'run.timeline.row.';
const PREVIEW_FONT_SIZE = 10;

/** A fixed, bounded index into the very same display rows as the timeline. */
export function drawTimelineMinimap(
  ctx: RendererCtx,
  parent: Container,
  snapshot: GpuRenderSnapshot,
  timeline: TimelineLayout,
  bookends: { start: string; end: string; endColor: number }
): (scrollY: number) => void {
  const viewport = ctx.metrics.timelineViewport!;
  if (viewport.height < 48) return () => {};
  const totalRows = timeline.items.length + viewport.rowOffset + 1;
  const height = viewport.height - 24;
  const tickCount = Math.min(totalRows, Math.max(2, Math.floor(height / 9)));
  const pitch = height / tickCount;
  const layer = new Container();
  layer.label = 'timeline-minimap';
  layer.position.set(viewport.left + viewport.width - TIMELINE_MINIMAP_WIDTH - 4, viewport.top + 12);
  parent.addChild(layer);
  const ink = new Graphics();
  ink.eventMode = 'none';
  layer.addChild(ink);
  const rows = Array.from({ length: tickCount }, (_, index) =>
    Math.round(index * (totalRows - 1) / (tickCount - 1)));
  const selectedIndex = timeline.items.findIndex(item => item.event.id === snapshot.state.selectedEventId);
  if (selectedIndex >= 0 && tickCount > 2) {
    const row = selectedIndex + viewport.rowOffset;
    const slot = Math.max(1, Math.min(tickCount - 2, Math.round(row / (totalRows - 1) * (tickCount - 1))));
    rows[slot] = row;
  }
  const accents = rows.map(row => {
    const item = timeline.items[row - viewport.rowOffset];
    return item ? eventAccent(item.event) : row === 0 ? bookends.endColor : GPU_COLORS.primary;
  });
  let hovered = -1;
  let offset = viewport.scrollY;
  const fit = (text: string) => ctx.fitText(text.replace(/\s+/g, ' ').trim(),
    Math.min(300, Math.max(120, viewport.width - 40)), { size: PREVIEW_FONT_SIZE, mono: true });
  const redraw = () => {
    ink.clear();
    const first = Math.max(0, (offset - viewport.contentTopPadding) / viewport.rowHeight);
    const last = (offset + viewport.height - viewport.contentTopPadding) / viewport.rowHeight;
    rows.forEach((row, index) => {
      const item = timeline.items[row - viewport.rowOffset];
      const selected = !!item && item.event.id === snapshot.state.selectedEventId;
      const visible = row >= first && row < last;
      const distance = hovered < 0 ? Infinity : Math.abs(index - hovered);
      const width = selected || distance === 0 ? 24 : distance === 1 ? 18
        : distance === 2 ? 12 : visible ? 10 : 6;
      const color = accents[index]!;
      ink.moveTo(28 - width, (index + 0.5) * pitch)
        .lineTo(28, (index + 0.5) * pitch)
        .stroke({ color, width: selected || distance === 0 ? 2 : 1.5, alpha: visible || distance < 3 || selected ? 0.95 : 0.45 });
    });
    // A quiet bracket reports the visible window even between sampled rows.
    const thumbHeight = Math.min(height, Math.max(8, height * viewport.height / viewport.totalHeight));
    const maximum = Math.max(0, viewport.totalHeight - viewport.height);
    const thumbY = maximum > 0 ? offset / maximum * (height - thumbHeight) : 0;
    ink.roundRect(33, thumbY, 2, thumbHeight, 1).fill({ color: GPU_COLORS.muted, alpha: 0.5 });
  };
  rows.forEach((row, index) => {
    const item = timeline.items[row - viewport.rowOffset];
    const copy = item ? gpuEventCardCopy(item.event, snapshot.t) : null;
    const title = copy?.title ?? (row === 0 ? bookends.end : bookends.start);
    const preview = copy
      ? [fit(title), fit(copy.body), fit([copy.meta, copy.footer].filter(Boolean).join(' · '))]
      : [fit(title), fit(row === 0 ? snapshot.data.run?.error ?? '' : snapshot.data.run?.task?.description ?? '')];
    const hit = new Container();
    hit.label = `${TIMELINE_JUMP_PREFIX}${row}`;
    hit.position.set(0, index * pitch);
    hit.hitArea = new Rectangle(0, 0, TIMELINE_MINIMAP_WIDTH, pitch);
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerover', () => { hovered = index; redraw(); });
    hit.on('pointerout', () => { hovered = -1; redraw(); });
    hit.on('pointertap', () => snapshot.onActivate(`${TIMELINE_JUMP_PREFIX}${row}`));
    layer.addChild(hit);
    ctx.recordHitTarget(layer, {
      id: `${TIMELINE_JUMP_PREFIX}${row}`, role: 'button',
      label: snapshot.t('timeline.jumpTo', { step: row + 1, title }),
      x: 0, y: index * pitch, width: TIMELINE_MINIMAP_WIDTH, height: pitch,
    });
    ctx.tooltip(layer, { x: 0, y: index * pitch, width: TIMELINE_MINIMAP_WIDTH,
      height: pitch, text: preview.filter(Boolean).join('\n'), placement: 'left', instant: true,
      fontSize: PREVIEW_FONT_SIZE, accent: accents[index]! });
  });
  redraw();
  return (scrollY) => { offset = scrollY; redraw(); };
}
