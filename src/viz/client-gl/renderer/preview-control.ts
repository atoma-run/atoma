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
 * The Preview control, a SIBLING of the summary card and never a child of it.
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
  const preview = snapshot.data.preview;
  // Web descriptors and terminal capability are separate, host-owned facts.
  const labelKey = previewControlLabel(preview);
  if (!preview || !labelKey) return 0;

  const height = 30;
  const label = snapshot.t(labelKey);
  const availableWidth = Math.max(0, width - 20);
  const gap = 8;
  const stopLabel = snapshot.t('preview.stop');
  const openMinWidth = Math.ceil(ctx.measureText(label, {
    size: 11, weight: preview.state === 'starting' ? '700' : '600',
  })) + 20 + BUTTON_ICON_SPACE;
  const stopWidth = Math.ceil(ctx.measureText(stopLabel, { size: 11, weight: '600' })) + 20 + BUTTON_ICON_SPACE;
  const showStop = preview.state === 'ready';
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
    preview.state === 'starting',
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
