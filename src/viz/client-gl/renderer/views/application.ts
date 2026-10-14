import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { applicationGuide } from '../../application-guide.js';
import { GPU_COLORS } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';

export function drawApplicationGuide(ctx: RendererCtx, snapshot: GpuRenderSnapshot,
  box: { x: number; top: number; width: number; bottom: number }): void {
  const local = snapshot.data.workspace?.localDocker;
  if (!local) return;
  const pane = createScrollPane(ctx.root, { x: box.x, y: box.top, width: box.width,
    height: Math.max(0, box.bottom - box.top - 16), scrollY: snapshot.state.scrollY.projects });
  let y = 0;
  const width = Math.min(680, pane.width - 20);
  for (const item of applicationGuide(local, snapshot.t)) {
    if (item.kind === 'action') {
      if (pane.visible(y, y + 44)) ctx.button(pane.content, item.id, 'button', item.text, 0, y, width, 44,
        false, snapshot.onActivate, undefined, false, false, undefined, undefined, undefined, item.disabled);
      y += 54;
    } else {
      const label = ctx.text(pane.content, item.text, 0, y, { size: item.kind === 'heading' ? 16 : 14,
        weight: item.kind === 'heading' ? '600' : '400', color: item.kind === 'status' ? GPU_COLORS.muted : GPU_COLORS.text, width });
      y += label.height + (item.kind === 'heading' ? 10 : 20);
    }
  }
  pane.extend(y); ctx.scrollMax.projects = pane.finish();
}
