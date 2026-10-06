import { Graphics } from 'pixi.js';
import type { RendererCtx } from '../gpu-renderer.js';
import { GPU_COLORS } from '../theme.js';
import { wrapDiffLine, type buildActivityDiff } from '../run-diff.js';
import type { ScrollPane } from './scroll-pane.js';

const CODE_STYLE = { size: 12, mono: true, weight: '400' } as const;
const LINE_HEIGHT = 20;
type Diff = ReturnType<typeof buildActivityDiff>;
interface DiffLayout {
  width: number;
  gutter: number;
  rows: { top: number; height: number; wrapped: string[][] }[];
  height: number;
}
const layoutCache = new WeakMap<Diff, DiffLayout>();

/** Measuring is done once per width; scrolling only draws the visible rows. */
function layoutDiff(ctx: RendererCtx, diff: Diff, width: number): DiffLayout {
  const cached = layoutCache.get(diff);
  if (cached?.width === width) return cached;
  const gutter = Math.max(46, ctx.measureText(String(diff.rows.length), CODE_STYLE) + 28);
  const codeWidth = Math.max(12, width / 2 - gutter - 12);
  const lines = new Map<string, string[]>();
  let height = 0;
  const rows = diff.rows.map(row => {
    const wrapped = [row.before, row.after].map(cell => {
      if (!cell) return [];
      let result = lines.get(cell.text);
      if (!result) {
        result = wrapDiffLine(cell.text, codeWidth, value => ctx.measureText(value, CODE_STYLE));
        lines.set(cell.text, result);
      }
      return result;
    });
    const rowHeight = Math.max(1, ...wrapped.map(value => value.length)) * LINE_HEIGHT + 4;
    const result = { top: height, height: rowHeight, wrapped };
    height += rowHeight;
    return result;
  });
  const layout = { width, gutter, rows, height };
  layoutCache.set(diff, layout);
  return layout;
}

/** Equal-width columns share row heights and the containing pane's one scroll offset. */
export function drawSplitDiff(ctx: RendererCtx, pane: ScrollPane,
  diff: ReturnType<typeof buildActivityDiff>, x: number, y: number, width: number,
  t: (key: string, vars?: Record<string, unknown>) => string): number {
  const half = width / 2;
  const layout = layoutDiff(ctx, diff, width);
  const graphics = new Graphics();
  graphics.label = 'split-diff';
  graphics.eventMode = 'none';
  pane.content.addChild(graphics);
  let cursor = y;
  if (pane.visible(cursor, cursor + 30)) {
    graphics.rect(x, cursor, width, 30).fill(GPU_COLORS.panelRaised);
    for (const [side, key] of ['activity.diff.before', 'activity.diff.after'].entries()) {
      ctx.text(pane.content, t(key), x + side * half + 12, cursor + 6,
        { size: 12, weight: '600', color: GPU_COLORS.text });
    }
  }
  cursor += 30;
  if (!diff.beforeAvailable || !diff.afterAvailable || diff.rows.length === 0) {
    if (pane.visible(cursor, cursor + 30)) {
      graphics.rect(x, cursor, width, 30).fill(GPU_COLORS.background);
      for (const [side, available] of [diff.beforeAvailable, diff.afterAvailable].entries()) {
        if (available && diff.rows.length) continue;
        const label = t(available ? 'activity.diff.empty' : 'activity.diff.unavailable');
        ctx.text(pane.content, ctx.fitText(label, half - 24, { size: 12 }), x + side * half + 12, cursor + 7,
          { size: 12, color: GPU_COLORS.muted });
      }
    }
    cursor += 30;
  }
  const rowsTop = cursor;
  let low = 0;
  let high = layout.rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const row = layout.rows[mid]!;
    if (rowsTop + row.top + row.height < pane.scrollY - 48) low = mid + 1;
    else high = mid;
  }
  for (let index = low; index < layout.rows.length; index++) {
    const { top, height: rowHeight, wrapped } = layout.rows[index]!;
    cursor = rowsTop + top;
    if (cursor > pane.scrollY + pane.height + 48) break;
    const row = diff.rows[index]!;
    const cells = [row.before, row.after];
    if (pane.visible(cursor, cursor + rowHeight)) {
      for (const [side, cell] of cells.entries()) {
        const left = x + side * half;
        graphics.rect(left, cursor, half, rowHeight).fill(GPU_COLORS.background);
        const tint = cell?.kind === 'delete' ? 0xf85149 : cell?.kind === 'insert' ? 0x3fb950 : null;
        if (tint !== null) {
          graphics.rect(left, cursor, half, rowHeight).fill({ color: tint, alpha: 0.15 });
          graphics.rect(left, cursor, layout.gutter - 5, rowHeight).fill({ color: tint, alpha: 0.12 });
        }
        if (!cell) continue;
        if (pane.visible(cursor, cursor + LINE_HEIGHT)) {
          const number = String(cell.line);
          ctx.text(pane.content, number, left + layout.gutter - 19 - ctx.measureText(number, CODE_STYLE), cursor + 2,
            { ...CODE_STYLE, color: GPU_COLORS.muted });
          if (cell.kind !== 'context') ctx.text(pane.content, cell.kind === 'delete' ? '−' : '+', left + layout.gutter - 14, cursor + 2,
            { ...CODE_STYLE, color: cell.kind === 'delete' ? 0xff938a : 0x7ee787 });
        }
        const firstLine = Math.max(0, Math.floor((pane.scrollY - 48 - cursor - 2) / LINE_HEIGHT));
        const lastLine = Math.min(wrapped[side]!.length, Math.ceil((pane.scrollY + pane.height + 48 - cursor) / LINE_HEIGHT));
        for (let index = firstLine; index < lastLine; index++) {
          const top = cursor + 2 + index * LINE_HEIGHT;
          if (pane.visible(top, top + LINE_HEIGHT)) ctx.text(pane.content, wrapped[side]![index]!, left + layout.gutter, top,
            { ...CODE_STYLE, color: GPU_COLORS.text });
        }
      }
    }
  }
  cursor = rowsTop + layout.height;
  // The divider is bounded to the same mask as the rows, even for a long wrapped line.
  const visibleTop = Math.max(y, pane.scrollY);
  const visibleBottom = Math.min(cursor, pane.scrollY + pane.height);
  if (visibleBottom > visibleTop) graphics.rect(x + half, visibleTop, 1, visibleBottom - visibleTop).fill(GPU_COLORS.border);
  return cursor - y;
}
