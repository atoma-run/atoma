import { Container, Graphics, Rectangle } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../gpu-renderer.js';
import type { TimelineLayout } from '../../client/timeline-layout.js';
import { GPU_COLORS } from '../theme.js';
import { eventAccent, gpuEventCardCopy } from './copy.js';
import { createScrollPane } from './scroll-pane.js';

export const TIMELINE_MINIMAP_WIDTH = 36;
export const TIMELINE_MINIMAP_MAX_BARS = 40;
export const TIMELINE_JUMP_PREFIX = 'run.timeline.row.';
const PITCH = 10;
const FADE_ROWS = 4;
const PREVIEW_FONT_SIZE = 10;

/** All display rows, visited through a bounded window of consecutive bars. */
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
  const tickCount = Math.min(totalRows, TIMELINE_MINIMAP_MAX_BARS,
    Math.max(2, Math.floor((viewport.height - 24) / PITCH)));
  const height = tickCount * PITCH;
  const maxFirst = totalRows - tickCount;
  const layer = new Container();
  layer.label = 'timeline-minimap';
  layer.position.set(viewport.left + viewport.width - TIMELINE_MINIMAP_WIDTH - 4, viewport.top + 12);
  parent.addChild(layer);
  // Only the reusable visible slots have geometry, hit targets and previews.
  // The logical row range remains complete, regardless of trace length.
  const pane = createScrollPane(layer, {
    x: 0, y: 0, width: TIMELINE_MINIMAP_WIDTH, height, scrollY: 0, bottomPadding: 0,
  });
  const ink = new Graphics();
  ink.label = 'timeline-minimap-bars';
  ink.eventMode = 'none';
  pane.content.addChild(ink);
  let hovered = -1;
  let offset = viewport.scrollY;
  let firstRow = 0;
  let railOffset = 0;
  const fit = (text: string) => ctx.fitText(text.replace(/\s+/g, ' ').trim(),
    Math.min(300, Math.max(120, viewport.width - 40)), { size: PREVIEW_FONT_SIZE, mono: true });
  const slots = Array.from({ length: tickCount }, (_, index) => {
    const hit = new Container();
    hit.position.set(0, index * PITCH);
    hit.hitArea = new Rectangle(0, 0, TIMELINE_MINIMAP_WIDTH, PITCH);
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerover', () => { hovered = index; redraw(); });
    hit.on('pointerout', () => { hovered = -1; redraw(); });
    hit.on('pointertap', () => snapshot.onActivate(`${TIMELINE_JUMP_PREFIX}${firstRow + index}`));
    pane.content.addChild(hit);
    const target = ctx.recordHitTarget(pane.content, {
      id: `${TIMELINE_JUMP_PREFIX}${index}`, role: 'button', label: bookends.end,
      x: 0, y: index * PITCH, width: TIMELINE_MINIMAP_WIDTH, height: PITCH,
    });
    const tooltip = ctx.tooltip(pane.content, {
      x: 0, y: index * PITCH, width: TIMELINE_MINIMAP_WIDTH, height: PITCH,
      text: bookends.end, placement: 'left', instant: true, fontSize: PREVIEW_FONT_SIZE,
    });
    return { hit, target, tooltip, color: GPU_COLORS.primary, row: -1 };
  });
  function redraw() {
    ink.clear();
    const first = Math.max(0, (offset - viewport.contentTopPadding) / viewport.rowHeight);
    const last = (offset + viewport.height - viewport.contentTopPadding) / viewport.rowHeight;
    slots.forEach((slot, index) => {
      const row = firstRow + index;
      const item = timeline.items[row - viewport.rowOffset];
      if (slot.row !== row) {
        slot.row = row;
        slot.color = item ? eventAccent(item.event) : row === 0 ? bookends.endColor : GPU_COLORS.primary;
        const copy = item ? gpuEventCardCopy(item.event, snapshot.t) : null;
        const title = copy?.title ?? (row === 0 ? bookends.end : bookends.start);
        const preview = copy
          ? [fit(title), fit(copy.body), fit([copy.meta, copy.footer].filter(Boolean).join(' · '))]
          : [fit(title), fit(row === 0 ? snapshot.data.run?.error ?? '' : snapshot.data.run?.task?.description ?? '')];
        slot.hit.label = `${TIMELINE_JUMP_PREFIX}${row}`;
        slot.target.id = slot.hit.label;
        slot.target.label = snapshot.t('timeline.jumpTo', { step: row + 1, title });
        if (slot.tooltip) Object.assign(slot.tooltip, { text: preview.filter(Boolean).join('\n'), accent: slot.color });
      }
      const selected = !!item && item.event.id === snapshot.state.selectedEventId;
      const visible = row + 1 > first && row < last;
      const distance = hovered < 0 ? Infinity : Math.abs(index - hovered);
      const width = selected || distance === 0 ? 24 : distance === 1 ? 18
        : distance === 2 ? 12 : visible ? 10 : 6;
      const fade = Math.min(1, firstRow > 0 ? (index + 0.5) / FADE_ROWS : 1,
        firstRow < maxFirst ? (tickCount - index - 0.5) / FADE_ROWS : 1);
      ink.moveTo(28 - width, (index + 0.5) * PITCH)
        .lineTo(28, (index + 0.5) * PITCH)
        .stroke({ color: slot.color, width: selected || distance === 0 ? 2 : 1.5,
          alpha: (visible || distance < 3 || selected ? 0.95 : 0.45) * fade });
    });
    // Position within the complete index, including rows outside this window.
    if (maxFirst > 0) {
      const thumbHeight = Math.max(8, height * tickCount / totalRows);
      ink.roundRect(33, firstRow / maxFirst * (height - thumbHeight), 2, thumbHeight, 1)
        .fill({ color: GPU_COLORS.muted, alpha: 0.5 });
    }
  }
  pane.extend(height);
  pane.finish();
  const topLeft = layer.toGlobal({ x: 0, y: 0 });
  ctx.timelineMinimapScroll = {
    bounds: new Rectangle(topLeft.x, topLeft.y, TIMELINE_MINIMAP_WIDTH, height),
    move(delta) {
      railOffset = Math.max(0, Math.min(maxFirst * PITCH, railOffset + delta));
      const next = Math.floor(railOffset / PITCH);
      if (next === firstRow) return;
      firstRow = next;
      redraw();
    },
  };
  const follow = (scrollY: number) => {
    offset = scrollY;
    const maximum = Math.max(0, viewport.totalHeight - viewport.height);
    const centreRow = (offset + viewport.height / 2 - viewport.contentTopPadding) / viewport.rowHeight;
    firstRow = offset <= 0 ? 0 : offset >= maximum ? maxFirst
      : Math.max(0, Math.min(maxFirst, Math.floor(centreRow - tickCount / 2)));
    railOffset = firstRow * PITCH;
    redraw();
  };
  follow(offset);
  return follow;
}
