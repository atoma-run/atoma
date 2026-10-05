import { Container, Graphics } from 'pixi.js';
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
  const icon = new Graphics();
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.28;
  icon.circle(cx, cy, r).stroke({
    color: active ? GPU_COLORS.text : GPU_COLORS.muted,
    width: 1.6,
    alpha: active ? 1 : 0.9,
  });
  icon.circle(cx - r * 0.38, cy - r * 0.33, 1.5).fill(0x55d5d0);
  icon.circle(cx + r * 0.22, cy - r * 0.49, 1.5).fill(0xbba3ee);
  icon.circle(cx - r * 0.37, cy + r * 0.35, 1.5).fill(0xe4aa65);
  icon.circle(cx + r * 0.44, cy + r * 0.37, 2.3).stroke({
    color: active ? GPU_COLORS.text : GPU_COLORS.muted,
    width: 1,
  });
  icon.eventMode = 'none';
  control.addChild(icon);
  return control;
}
