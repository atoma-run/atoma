import { Container, Graphics, Rectangle } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { BUTTON_LABEL_INSET } from '../../gpu-renderer.js';
import { sidebarWidthForViewport, GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { buildRunPicker, runPickerTotalsLabel, runPickerViewportHeight, RUN_PICKER_ROW_HEIGHT, RUN_PICKER_GROUP_HEIGHT, RUN_PICKER_HEADER_HEIGHT } from '../../run-picker.js';
import { RUN_STATUS_GLYPH, runIndexStatus } from '../../../client/run-utils.js';
import { fmtTokenCount } from '../copy.js';
import { relativeTime } from '../relative-time.js';
import { drawScrollbarThumb } from '../scroll-pane.js';
import { runsPaneLayout, runsPickerControlLayout, RUN_STATUS_COLOR } from './runs.js';

const RUN_PICKER_ROW_LABEL_TOP = 5;
const RUN_PICKER_ROW_SECOND_TOP = 24;
const RUN_PICKER_ROW_SECOND_SIZE = 10;

export function drawRunPicker(ctx: RendererCtx, snapshot: GpuRenderSnapshot, width: number, height: number) {
  const contentLeft = sidebarWidthForViewport(width);
  const contentWidth = Math.max(0, width - contentLeft);
  const picker = runsPickerControlLayout(contentWidth);
  const pane = runsPaneLayout(contentWidth);
  const x = contentLeft + picker.x;
  const popupWidth = Math.max(0, pane.leftWidth - 28);
  const popupY = picker.y + picker.height + 4;
  const rowHeight = RUN_PICKER_ROW_HEIGHT;
  const headerHeight = RUN_PICKER_HEADER_HEIGHT;
  const model = buildRunPicker(snapshot.data.runs, snapshot.state.search.run);
  const listViewportHeight = runPickerViewportHeight(height, popupY);
  const contentHeight = model.height;
  const scrollMax = Math.max(0, contentHeight - listViewportHeight);
  const scrollY = Math.max(
    0,
    Math.min(scrollMax, snapshot.state.runPickerScrollY)
  );
  const visibleListHeight = Math.min(listViewportHeight, Math.max(rowHeight, contentHeight));
  const popupHeight = headerHeight + visibleListHeight + 7;
  const bounds = new Rectangle(x, popupY, popupWidth, popupHeight);
  ctx.panel(
    ctx.root,
    x,
    popupY,
    popupWidth,
    popupHeight,
    0x0c1321,
    GPU_COLORS.primary,
    GPU_LAYOUT.radius,
    2
  );
  ctx.text(
    ctx.root,
    snapshot.t('runs.picker.count', { count: model.options.length, total: snapshot.data.runs.length }),
    x + 12,
    popupY + 8,
    { size: 9, color: GPU_COLORS.muted, weight: '700' }
  );

  const listY = popupY + headerHeight;
  const rowX = x + 30;
  const rowWidth = Math.max(0, popupWidth - 43);
  const listMask = new Graphics();
  listMask
    .rect(x + 4, listY, popupWidth - 8, visibleListHeight)
    .fill(0xffffff);
  ctx.root.addChild(listMask);
  const listLayer = new Container();
  listLayer.mask = listMask;
  ctx.root.addChild(listLayer);

  for (const section of model.sections) {
    const headerY = listY + section.top - scrollY;
    if (headerY + RUN_PICKER_GROUP_HEIGHT >= listY && headerY < listY + visibleListHeight) {
      const label = section.label ?? snapshot.t('runs.project.operator');
      const count = snapshot.t('runs.picker.groupCount', { count: section.rows.length });
      const countWidth = ctx.measureText(count, { size: 9 });
      ctx.text(listLayer, ctx.fitText(label, popupWidth - countWidth - 42, { size: 11, weight: '700' }),
        x + 14, headerY + 7, { size: 11, weight: '700', color: GPU_COLORS.text, singleLine: true });
      ctx.text(listLayer, count, x + popupWidth - 18 - countWidth, headerY + 8,
        { size: 9, color: GPU_COLORS.muted, singleLine: true });
      const totals = runPickerTotalsLabel(section.totals, snapshot.t);
      ctx.text(listLayer, ctx.fitText(totals, popupWidth - 32, { size: 10, weight: '700' }),
        x + 14, headerY + 25, { size: 10, weight: '700', color: GPU_COLORS.primary, singleLine: true });
    }
    for (const { run, top, index } of section.rows) {
      const rowY = listY + top - scrollY;
      if (rowY + rowHeight < listY || rowY > listY + visibleListHeight) continue;
      const keyboardActive = index === snapshot.state.runPickerActiveIndex;
      const selected = snapshot.state.selectedRunId === run.id;
      // The SAME answer the run header gives, from the same precedence, and
      // marked with the same glyphs its status chip spells out. The picker
      // used to invent its own — `!` for an error, `✕` for a cancellation,
      // and NOTHING for a run that worked, so a delivered run was the one
      // outcome the list could not name.
      const status = runIndexStatus(run);
      ctx.button(
        listLayer,
        `run.select.${run.id}`,
        'option',
        // NOT truncated here. `button` fits its own label to the width it is
        // given, by measurement, and a character cap ahead of it can only take
        // away what that measurement would have kept: 82 characters is about
        // 525px of this face, and these rows are as wide as the panel — so a
        // third of every row sat empty while its label ended in an ellipsis
        // (owner report, 2026-09-22). The full label also makes a better
        // accessible name than a pre-cut one.
        // The GOAL where the index carries it, because the label is the
        // COMPACT form — capped at 80 characters when the run was recorded —
        // and this row is as wide as the panel. The label remains the fallback
        // for an index that predates the goal, or a run that never had one.
        // A named run shows its TITLE first: a goal is up to 4 000 characters
        // of specification, and one row cannot say which run it is with that.
        `${RUN_STATUS_GLYPH[status]} ${
          run.title ?? run.goal ?? run.label.replace(/^(?:build-app|baseline):\s*/i, '')
        }`,
        rowX,
        rowY + 2,
        rowWidth,
        rowHeight - 5,
        keyboardActive,
        snapshot.onActivate,
        // Selection keeps its own accent; everything else wears its outcome.
        selected ? GPU_COLORS.tiers[3] : RUN_STATUS_COLOR[status],
        false,
        false,
        undefined,
        RUN_PICKER_ROW_LABEL_TOP,
        undefined,
        false,
        null
      );
      // WHEN it ran and WHAT IT SPENT, under the goal. The list used to say
      // neither, so choosing between two runs of the same project meant
      // opening them. Drawn beside the button rather than inside it: a button
      // carries one label, and this line is not part of the thing you click.
      const spent = typeof run.tokens === 'number'
        ? `${fmtTokenCount(run.tokens)} ${snapshot.t('runs.picker.tokens')}`
        : '';
      const second = [
        relativeTime(run.startedAt, snapshot.t, snapshot.state.locale),
        spent,
      ].filter(Boolean).join(' · ');
      if (second) {
        ctx.text(
          listLayer,
          ctx.fitText(second, rowWidth - BUTTON_LABEL_INSET * 2, { size: RUN_PICKER_ROW_SECOND_SIZE }),
          rowX + BUTTON_LABEL_INSET,
          rowY + RUN_PICKER_ROW_SECOND_TOP,
          { size: RUN_PICKER_ROW_SECOND_SIZE, color: GPU_COLORS.muted, singleLine: true }
        );
      }
    }
  }

  // ONE scrollbar-thumb definition (renderer/scroll-pane.ts) — the popup
  // keeps its 4px-inset track but shares geometry/styling with every other
  // scrollable region. No-ops when runPickerScrollMax is 0.
  drawScrollbarThumb(ctx.root, {
    x,
    y: listY + 4,
    width: popupWidth,
    height: visibleListHeight - 8,
    scrollY,
    maxScroll: scrollMax,
  });
  if (!model.options.length) {
    ctx.text(ctx.root, snapshot.t('runs.none'), x + 14, listY + 12, {
      size: 11,
      color: GPU_COLORS.muted,
    });
  }
  return { bounds, scrollMax };
}
