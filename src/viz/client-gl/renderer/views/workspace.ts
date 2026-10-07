import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';
import { workspaceChildren, workspaceLines, workspaceParent } from '../../workspace-browser.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame } from '../view-frame.js';
import { formatDateTime } from '../../../client/date-format.js';

let cached: { text: string; width: number; rows: string[] } | undefined;
export function drawWorkspace(ctx: RendererCtx, snapshot: GpuRenderSnapshot, width: number, height: number,
  embedded?: { x: number; top: number; width: number; bottom: number }): void {
  const frame = viewFrame(width, height), data = snapshot.data.workspace;
  const left = embedded?.x ?? frame.innerX;
  const contentWidth = embedded?.width ?? frame.innerWidth;
  const bottomEdge = embedded?.bottom ?? frame.bottom;
  const path = snapshot.state.workspacePath;
  const isFile = data?.index?.files.some(f => f.path === path);
  const t = snapshot.t;
  const project = snapshot.data.projects.find(p => p.projectId === snapshot.state.selectedProjectId);
  if (!embedded) drawViewFrame(ctx, frame, `${project?.name ?? ''} · ${t('workspace.title')}`);
  let top = embedded?.top ?? frame.contentTop;
  if (!embedded) {
    ctx.button(ctx.root, 'workspace.close', 'button', t('workspace.back'), left, top,
      Math.min(180, contentWidth), 32, false, snapshot.onActivate);
    top += 44;
  }
  const identity = data?.index ? `${data.index.runId.slice(0, 8)} · ${formatDateTime(data.index.createdAt, snapshot.state.locale)} · ${t(`projects.runStatus.${data.index.status}`)}` : '';
  const caption = ctx.text(ctx.root, identity + '\n' + t('workspace.snapshot'), left, top,
    { size: 11, color: GPU_COLORS.muted, width: contentWidth });
  top += caption.height + 14;
  if (path) {
    ctx.button(ctx.root, 'workspace.path.' + workspaceParent(path), 'button', t('workspace.parent'),
      left, top, Math.min(180, contentWidth), 30, false, snapshot.onActivate,
      undefined, false, false, undefined, undefined, undefined, false, 'back');
    top += 40;
  }
  ctx.text(ctx.root, path || '/', left, top, { size: 12, mono: true, width: contentWidth, singleLine: true });
  ctx.tooltip(ctx.root, { x: left, y: top, width: contentWidth, height: 22, text: path || '/' });
  top += 30;
  const pane = createScrollPane(ctx.root, { x: left, y: top, width: contentWidth,
    height: Math.max(0, bottomEdge - top - 12), scrollY: snapshot.state.scrollY.projects });
  let bottom = 0;
  const message = (key: string) => { ctx.text(pane.content, t(key), 0, 0, { size: 12, width: pane.width - 16 }); bottom = 60; };
  if (data?.failed) message('workspace.unavailable');
  else if (!data?.index || data.loading) message('workspace.loading');
  else if (isFile) {
    if (data.file?.kind !== 'text') message(data.file?.kind === 'too_large' ? 'workspace.tooLarge' : 'workspace.binary');
    else {
      const text = data.file.text ?? '', available = Math.max(20, pane.width - 20);
      if (!cached || cached.text !== text || cached.width !== available) cached = { text, width: available,
        rows: workspaceLines(text, available, value => ctx.measureText(value, { size: 12, mono: true })) };
      cached.rows.forEach((line, i) => { if (pane.visible(i * 19, (i + 1) * 19)) ctx.text(pane.content, line, 0, i * 19,
        { size: 12, mono: true, singleLine: true }); });
      bottom = cached.rows.length * 19;
    }
  } else {
    const children = workspaceChildren(data.index, path);
    if (!children.length) message('workspace.empty');
    children.forEach((entry, i) => {
      if (pane.visible(i * 40, i * 40 + 34)) ctx.button(pane.content, 'workspace.path.' + entry.path, 'button',
        entry.directory ? entry.name + '/' : `${entry.name} · ${entry.size.toLocaleString(snapshot.state.locale)} B`,
        0, i * 40, pane.width - 16, 34, false, snapshot.onActivate, entry.directory ? GPU_COLORS.primary : GPU_COLORS.text,
        false, false, undefined, undefined, undefined, false, entry.directory ? 'folder' : 'file');
    });
    bottom = Math.max(bottom, children.length * 40);
  }
  pane.extend(bottom); ctx.scrollMax.projects = pane.finish();
}
