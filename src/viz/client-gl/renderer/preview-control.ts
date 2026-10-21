import { BUTTON_ICON_SPACE } from '../button-icons.js';
import type { GpuRenderSnapshot, RendererCtx } from '../gpu-renderer.js';
import type { VizPreviewSummary } from '../../client/types.js';

type PreviewControlState = Pick<VizPreviewSummary, 'state' | 'availability' | 'mode' | 'terminalAvailable'>;

/** One label decision for the canvas and its accessible mirror. */
export function previewControlLabel(preview: PreviewControlState | null | undefined): string | null {
  if (!preview || preview.availability !== 'available') return null;
  return 'preview.app';
}

/** Explicit capabilities; a terminal never substitutes for an application. */
export function previewActionsFor(preview: PreviewControlState | null | undefined, t: (key: string) => string): { id: string; label: string; active: boolean }[] {
  if (!preview) return [];
  const actions = [];
  if (previewControlLabel(preview)) actions.push({ id: 'run.preview.open', label: t('preview.app'), active: preview.state === 'starting' && preview.mode !== 'terminal' });
  if (preview.terminalAvailable) actions.push({ id: 'run.preview.terminal', label: t('preview.terminal.start'), active: preview.state === 'starting' && preview.mode === 'terminal' });
  if (actions.length && preview.state === 'ready') actions.push({ id: 'run.preview.stop', label: t('preview.stop'), active: false });
  return actions;
}

export function previewActions(snapshot: GpuRenderSnapshot): { id: string; label: string; active: boolean }[] {
  return previewActionsFor(snapshot.data.preview, snapshot.t);
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
  const actions = previewActions(snapshot);
  if (!actions.length) return 0;
  const availableWidth = Math.max(0, width - 20);
  const height = 30, gap = 8;
  let cursorX = 0, cursorY = 0;
  for (const action of actions) {
    const buttonWidth = Math.min(availableWidth, Math.ceil(ctx.measureText(action.label, {
      size: 11, weight: action.active ? '700' : '600',
    })) + 20 + BUTTON_ICON_SPACE);
    if (cursorX && cursorX + buttonWidth > availableWidth) { cursorX = 0; cursorY += height + gap; }
    ctx.button(ctx.root, action.id, 'button', action.label, x + 10 + cursorX, y + cursorY,
      buttonWidth, height, action.active, snapshot.onActivate);
    cursorX += buttonWidth + gap;
  }
  return cursorY + height + 12;
}
