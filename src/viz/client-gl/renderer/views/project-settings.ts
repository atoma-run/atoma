import { computeTargetKey, showComputeSetup } from '../../project-compute.js';
import { Container } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { deploymentCopy, hostingCopy, type HostingTone } from '../../project-deployment.js';
import { connectorsCopy } from '../../project-connectors.js';
import { GPU_COLORS } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';

const TONE: Record<HostingTone, number> = {
  success: GPU_COLORS.success, warning: GPU_COLORS.warning, error: GPU_COLORS.error, muted: GPU_COLORS.muted,
};
const PAD = 20;
const BUTTON_HEIGHT = 40;
const GAP = 10;

/**
 * Project settings as cards: the hosted application first (what is online,
 * where, and the actions that apply now), then the destination preference,
 * then the organisation's MCP servers this project's runs may use. Each
 * card's frame is drawn behind its content once the content's height is known.
 */
export function drawProjectSettings(ctx: RendererCtx, snapshot: GpuRenderSnapshot,
  box: { x: number; top: number; width: number; bottom: number }): void {
  const view = snapshot.data.deploymentSettings;
  if (!view) return;
  const copy = deploymentCopy(view);
  const hosted = hostingCopy(view);
  const pane = createScrollPane(ctx.root, { x: box.x, y: box.top, width: box.width,
    height: Math.max(0, box.bottom - box.top - 16), scrollY: snapshot.state.scrollY.projects,
    // The section tabs (raised) stand right above; the frame's pad lies below.
    air: { bottom: 16 } });
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

  const compute = snapshot.data.computeSettings;
  if (compute) card(() => {
    if (compute.loadFailed) {
      line(snapshot.t('compute.title'), { size: 16, weight: '600', color: GPU_COLORS.text, gap: 6 });
      line(snapshot.t('compute.loadFailed'), { color: GPU_COLORS.error });
      buttonRow([{ id: 'compute.refresh' }], 280);
      return;
    }
    const selected = computeTargetKey(compute.selected), saved = computeTargetKey(compute.project.target);
    const disabled = !compute.project.canEdit || compute.busy;
    line(snapshot.t('compute.title'), { size: 16, weight: '600', color: GPU_COLORS.text, gap: 6 });
    line(snapshot.t('compute.intro'));
    if (showComputeSetup(compute.project)) buttonRow([{ id: 'compute.setup', label: 'compute.connectComputer' }], 280);
    buttonRow([{ id: 'compute.choose.hosted', label: 'compute.hosted', disabled: disabled || !compute.project.hostedAllowed }],
      280, () => selected === 'hosted');
    if (!compute.project.hostedAllowed) {
      line(snapshot.t('compute.hostedBeta'), { size: 12, gap: 8 });
      buttonRow([{ id: 'compute.contact', label: 'compute.contact' }], 280);
    }
    for (const device of compute.project.devices) {
      if (pane.visible(y, y + BUTTON_HEIGHT)) ctx.button(content, `compute.choose.${device.deviceId}`, 'button', device.name,
        PAD, y, Math.min(inner, 360), BUTTON_HEIGHT, selected === device.deviceId, snapshot.onActivate,
        undefined, false, false, undefined, undefined, undefined, disabled || !device.allowed || device.revoked);
      y += BUTTON_HEIGHT + 4;
      line(`${snapshot.t(`compute.availability.${device.availability}`)} · ${snapshot.t(device.allowed ? 'compute.allowed' : 'compute.notAllowed')}`, { size: 12 });
      if (!device.revoked && compute.project.canEdit) buttonRow([{ id: `compute.grant.${device.deviceId}`,
        label: device.allowed ? 'compute.removeAccess' : 'compute.allowProject', disabled }], 280);
    }
    if (!compute.project.devices.length) line(snapshot.t('compute.empty'));
    line(snapshot.t('compute.scope'), { size: 12 });
    for (const run of compute.project.pendingRuns ?? []) {
      line(snapshot.t('compute.pending'), { size: 12 });
      buttonRow([{ id: `compute.finalize.${run.runId}`, label: 'compute.finalize', disabled: compute.busy }], 280);
    }
    if (!compute.project.canEdit) line(snapshot.t('deployment.adminOnly'));
    if (compute.notice !== 'idle') line(snapshot.t(`compute.${compute.notice}`), { color: compute.notice === 'saved' || compute.notice === 'resultsArrived' ? GPU_COLORS.muted : GPU_COLORS.error });
    if (selected !== saved) buttonRow([{ id: 'compute.save', disabled }], 280);
  });

  const connectors = snapshot.data.connectorSettings;
  if (connectors) card(() => {
    const model = connectorsCopy(connectors);
    line(snapshot.t('connectors.title'), { size: 16, weight: '600', color: GPU_COLORS.text, gap: 6 });
    line(snapshot.t('connectors.intro'), { gap: 14 });
    if (model.empty) line(snapshot.t(model.empty), { color: GPU_COLORS.text });
    for (const row of model.rows) {
      // The name is the organisation's, never a catalogue key: drawn as is, never through t().
      if (pane.visible(y, y + BUTTON_HEIGHT)) ctx.button(content, row.id, 'button', row.name, PAD, y, Math.min(inner, 360), BUTTON_HEIGHT,
        row.checked, snapshot.onActivate, undefined, false, false, undefined, undefined, undefined, row.disabled);
      y += BUTTON_HEIGHT + 4;
      line(snapshot.t(row.detail, { ...row.detailVars, status: snapshot.t(String(row.detailVars['status'])) }), { size: 12, gap: 12 });
    }
    if (!connectors.canEdit && !connectors.loading) line(snapshot.t('connectors.adminOnly'));
    if (model.status) line(snapshot.t(model.status), { color: connectors.status === 'failed' || connectors.status === 'conflict' ? GPU_COLORS.error : GPU_COLORS.muted });
    buttonRow([
      ...(model.showSave ? [{ id: 'connectors.save', disabled: model.saveDisabled }] : []),
      ...(model.showOpenSettings ? [{ id: 'connectors.openSettings' }] : []),
    ], 260);
  });

  pane.extend(y); ctx.scrollMax.projects = pane.finish();
}
