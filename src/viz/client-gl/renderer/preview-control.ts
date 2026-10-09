import { BUTTON_ICON_SPACE } from '../button-icons.js';
import type { GpuRenderSnapshot, RendererCtx } from '../gpu-renderer.js';
import type { VizPreviewSummary } from '../../client/types.js';

type PreviewControlState = Pick<VizPreviewSummary, 'state' | 'availability' | 'mode' | 'terminalAvailable'>;

/** One label decision for the canvas and its accessible mirror. */
export function previewControlLabel(preview: PreviewControlState | null | undefined): string | null {
  if (!preview || (preview.availability !== 'available' && !preview.terminalAvailable)) return null;
  if (preview.state === 'starting') return 'preview.starting';
  if (preview.state === 'failed') return 'preview.retry';
  if (preview.state === 'ready') return 'preview.open';
  return preview.mode === 'terminal' || preview.availability !== 'available' ? 'preview.terminal.start' : 'preview.start';
}

/**
 * The preview's controls in order — open (or start, retry), then stop once it
 * is ready — for every surface that draws them, so none decides alone.
 */
export function previewActions(snapshot: GpuRenderSnapshot): { id: string; label: string; active: boolean }[] {
  const preview = snapshot.data.preview;
  const labelKey = previewControlLabel(preview);
  if (!preview || !labelKey) return [];
  const actions = [{ id: 'run.preview.open', label: snapshot.t(labelKey), active: preview.state === 'starting' }];
  if (preview.state === 'ready') actions.push({ id: 'run.preview.stop', label: snapshot.t('preview.stop'), active: false });
  return actions;
}

/**
 * The Preview control where a surface has no action row of its own (the
 * result reader, the project's Preview section); Runs carries the same
 * actions at the end of its row. Never a child of a card.
 *
 * Two Pixi mechanics decide this, and both were read from the engine rather
 * than assumed. A parent `hitArea` PRUNES its whole subtree, so a control
 * drawn inside the card but outside `new Rectangle(0, 0, width - 20, cursor)`
 * would be unreachable — not merely covered. And a nested target that IS
 * inside it still bubbles: `pointertap` propagates over the composed path, so
 * one click would open the preview AND collapse the card. There is no
 * `stopPropagation` precedent anywhere in this client, and adding one to work
 * around a layout choice would be the wrong end to fix.
 *
 * So it sits below the card, on `ctx.root`, with its own measured target —
 * which is exactly what the design asked for when it said the full-card toggle
 * must not swallow it.
 */
export function drawPreviewControl(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  x: number,
  y: number,
  width: number
): number {
  // Web descriptors and terminal capability are separate, host-owned facts.
  const [open, stop] = previewActions(snapshot);
  if (!open) return 0;

  const height = 30;
  const label = open.label;
  const availableWidth = Math.max(0, width - 20);
  const gap = 8;
  const stopLabel = stop?.label ?? '';
  const openMinWidth = Math.ceil(ctx.measureText(label, {
    size: 11, weight: open.active ? '700' : '600',
  })) + 20 + BUTTON_ICON_SPACE;
  const stopWidth = Math.ceil(ctx.measureText(stopLabel, { size: 11, weight: '600' })) + 20 + BUTTON_ICON_SPACE;
  const showStop = !!stop;
  const stacked = showStop && openMinWidth + gap + stopWidth > availableWidth;
  const openWidth = Math.min(
    openMinWidth,
    availableWidth - (showStop && !stacked ? stopWidth + gap : 0)
  );
  ctx.button(
    ctx.root,
    'run.preview.open',
    'button',
    label,
    x + 10,
    y,
    openWidth,
    height,
    open.active,
    snapshot.onActivate
  );
  if (showStop) {
    ctx.button(
      ctx.root,
      'run.preview.stop',
      'button',
      stopLabel,
      x + 10 + (stacked ? 0 : openWidth + gap),
      y + (stacked ? height + gap : 0),
      Math.min(stopWidth, availableWidth),
      height,
      false,
      snapshot.onActivate
    );
  }
  return height + 12 + (stacked ? height + gap : 0);
}
