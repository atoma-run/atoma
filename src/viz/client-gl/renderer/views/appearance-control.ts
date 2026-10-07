import type { Container } from 'pixi.js';
import { drawButtonIcon } from '../button-icon.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';

/** A small painter's palette for the collapsed rail's theme picker. */
export function drawAppearancePaletteButton(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  x: number,
  y: number,
  width: number,
  height: number
): Container {
  const active = snapshot.state.accountMenuOpen && snapshot.state.themeDropdownOpen;
  const control = ctx.button(
    ctx.root,
    'appearance.dropdown.toggle',
    'button',
    '',
    x,
    y,
    width,
    height,
    active,
    snapshot.onActivate,
    GPU_COLORS.primary,
    true,
    false,
    undefined,
    undefined,
    snapshot.t('appearance.theme')
  );
  const size = Math.min(width, height) * 0.56;
  drawButtonIcon(control, 'palette', (width - size) / 2, (height - size) / 2,
    active ? GPU_COLORS.text : GPU_COLORS.muted, size);
  return control;
}
