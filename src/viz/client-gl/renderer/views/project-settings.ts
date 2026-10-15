import { Container } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { deploymentCopy, hostingCopy, type HostingTone } from '../../project-deployment.js';
import { GPU_COLORS } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';

const TONE: Record<HostingTone, number> = {
  success: GPU_COLORS.success, warning: GPU_COLORS.warning, error: GPU_COLORS.error, muted: GPU_COLORS.muted,
};
const PAD = 20;
const BUTTON_HEIGHT = 40;
const GAP = 10;

/**
 * Project settings as two cards: the hosted application first (what is
 * online, where, and the actions that apply now), then the destination
 * preference. Each card's frame is drawn behind its content once the
 * content's height is known.
 */
export function drawProjectSettings(ctx: RendererCtx, snapshot: GpuRenderSnapshot,
  box: { x: number; top: number; width: number; bottom: number }): void {
  const view = snapshot.data.deploymentSettings;
  if (!view) return;
  const copy = deploymentCopy(view);
  const hosted = hostingCopy(view);
  const pane = createScrollPane(ctx.root, { x: box.x, y: box.top, width: box.width,
    height: Math.max(0, box.bottom - box.top - 16), scrollY: snapshot.state.scrollY.projects });
  const frames = new Container(); const content = new Container();
  pane.content.addChild(frames, content);
  const width = Math.max(0, Math.min(720, pane.width - 20));
  const inner = Math.max(0, width - PAD * 2);
  let y = 0;

  const line = (value: string, options: { size?: number; weight?: '400' | '600'; color?: number; gap?: number } = {}) => {
    const label = ctx.text(content, value, PAD, y, { size: options.size ?? 13, weight: options.weight ?? '400',
      color: options.color ?? GPU_COLORS.muted, width: inner });
    y += label.height + (options.gap ?? 12);
  };
  const button = (control: { id: string; label?: string; disabled?: boolean }, x: number, buttonWidth: number, active = false) => {
    if (pane.visible(y, y + BUTTON_HEIGHT)) ctx.button(content, control.id, 'button', snapshot.t(control.label ?? control.id),
      x, y, buttonWidth, BUTTON_HEIGHT, active, snapshot.onActivate,
      undefined, false, false, undefined, undefined, undefined, Boolean(control.disabled));
  };
  /** Side by side while each keeps a readable width, stacked below that. */
  const buttonRow = (controls: Array<{ id: string; label?: string; disabled?: boolean }>, maxEach = 240, active?: (id: string) => boolean) => {
    if (!controls.length) return;
    const each = Math.min(maxEach, (inner - GAP * (controls.length - 1)) / controls.length);
    if (each >= 150) {
      controls.forEach((control, index) => button(control, PAD + index * (each + GAP), each, active?.(control.id)));
      y += BUTTON_HEIGHT + 16;
    } else {
      for (const control of controls) { button(control, PAD, inner, active?.(control.id)); y += BUTTON_HEIGHT + GAP; }
      y += 6;
    }
  };
  const card = (draw: () => void) => {
    const top = y; y += PAD;
    draw();
    y += PAD - 12;
    ctx.panel(frames, 0, top, width, y - top, GPU_COLORS.panel, GPU_COLORS.border, undefined, 1);
    y += 24;
  };

  if (hosted) card(() => {
    line(snapshot.t('hosting.title'), { size: 16, weight: '600', color: GPU_COLORS.text, gap: 10 });
    const status = `● ${snapshot.t(hosted.status)}${hosted.version && hosted.tone === 'success' ? `  ·  ${snapshot.t('hosting.versionShort', { version: hosted.version })}` : ''}`;
    line(status, { color: TONE[hosted.tone], weight: '600', gap: 16 });
    if (hosted.address) {
      line(snapshot.t('hosting.address'), { size: 12, gap: 4 });
      const open = hosted.actions.find(action => action.id === 'hosting.open' && !action.disabled);
      if (open) {
        // Online: the address itself opens the application, like its button.
        const linkWidth = Math.min(inner, ctx.measureText(hosted.address, { size: 13 }) + 4);
        const link = ctx.linkRegion(content, 'hosting.open.address', hosted.address, PAD, y - 2, linkWidth, 22, () => snapshot.onActivate('hosting.open'));
        ctx.text(link, hosted.address, 0, 2, { size: 13, color: GPU_COLORS.primary, width: linkWidth, singleLine: true });
        y += 32;
      } else line(hosted.address, { color: GPU_COLORS.text, gap: 14 });
    }
    buttonRow(hosted.actions);
    if (hosted.update) {
      line(snapshot.t('hosting.updateTitle'), { weight: '600', color: GPU_COLORS.text, gap: 6 });
      line(snapshot.t(hosted.update, { version: hosted.candidateVersion }), { gap: 12 });
      if (hosted.deploy) buttonRow([hosted.deploy], 280);
    }
    if (hosted.stop) buttonRow([hosted.stop], 280);
    line(snapshot.t('hosting.private'), { size: 12 });
  });

  card(() => {
    line(snapshot.t('deployment.title'), { size: 16, weight: '600', color: GPU_COLORS.text, gap: 6 });
    line(snapshot.t('deployment.intro'), { gap: 14 });
    buttonRow(copy.choices.map(choice => ({ id: choice.id, label: choice.label, disabled: !view.canEdit || view.busy })), 220,
      id => id === `deployment.choose.${view.destination}`);
    line(snapshot.t(copy.description), { color: GPU_COLORS.text });
    if (copy.notice) line(snapshot.t(copy.notice));
    if (!view.canEdit) line(snapshot.t('deployment.adminOnly'));
    if (copy.status) line(snapshot.t(copy.status), { color: view.status === 'failed' || view.status === 'conflict' ? GPU_COLORS.error : GPU_COLORS.muted });
    if (copy.showSave) buttonRow([{ id: 'deployment.save', disabled: copy.saveDisabled }], 240);
  });

  pane.extend(y); ctx.scrollMax.projects = pane.finish();
}
