import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { deploymentCopy, hostingCopy } from '../../project-deployment.js';
import { GPU_COLORS } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';

export function drawProjectSettings(ctx: RendererCtx, snapshot: GpuRenderSnapshot,
  box: { x: number; top: number; width: number; bottom: number }): void {
  const view = snapshot.data.deploymentSettings;
  if (!view) return;
  const copy = deploymentCopy(view);
  const pane = createScrollPane(ctx.root, { x: box.x, y: box.top, width: box.width,
    height: Math.max(0, box.bottom - box.top - 16), scrollY: snapshot.state.scrollY.projects });
  const width = Math.max(0, Math.min(680, pane.width - 20));
  let y = 0;
  const paragraph = (key: string, heading = false) => {
    const label = ctx.text(pane.content, snapshot.t(key), 0, y, { size: heading ? 16 : 13,
      weight: heading ? '600' : '400', color: heading ? GPU_COLORS.text : GPU_COLORS.muted, width });
    y += label.height + 18;
  };
  paragraph('deployment.title', true);
  paragraph('deployment.journey');
  for (const choice of copy.choices) {
    if (pane.visible(y, y + 44)) ctx.button(pane.content, choice.id, 'button', snapshot.t(choice.label),
      0, y, width, 44, choice.destination === view.destination, snapshot.onActivate,
      undefined, false, false, undefined, undefined, undefined, !view.canEdit || view.busy);
    y += 54;
    paragraph(choice.description);
  }
  paragraph(copy.notice);
  paragraph('deployment.noSideEffects');
  if (!view.canEdit) paragraph('deployment.adminOnly');
  if (copy.status) paragraph(copy.status);
  if (pane.visible(y, y + 44)) ctx.button(pane.content, 'deployment.save', 'button', snapshot.t('deployment.save'),
    0, y, width, 44, false, snapshot.onActivate, undefined, false, false, undefined, undefined, undefined, copy.saveDisabled);
  y += 60;
  const hosted = hostingCopy(view);
  if (hosted) {
    paragraph('hosting.title', true); paragraph('hosting.private'); paragraph(hosted.status);
    for (const value of [hosted.version, hosted.url].filter(Boolean)) {
      const label = ctx.text(pane.content, value!, 0, y, { size: 13, color: GPU_COLORS.text, width }); y += label.height + 18;
    }
    if (hosted.candidateVersion) {
      const label = ctx.text(pane.content, `${snapshot.t('hosting.candidateVersion')}: ${hosted.candidateVersion}`, 0, y, { size: 13, color: GPU_COLORS.text, width }); y += label.height + 18;
    }
    paragraph('hosting.updateNotice');
    for (const button of hosted.buttons) {
      if (pane.visible(y, y + 44)) ctx.button(pane.content, button.id, 'button', snapshot.t(button.id),
        0, y, width, 44, false, snapshot.onActivate, undefined, false, false, undefined, undefined, undefined, Boolean(button.disabled));
      y += 54;
    }
  }
  pane.extend(y); ctx.scrollMax.projects = pane.finish();
}
