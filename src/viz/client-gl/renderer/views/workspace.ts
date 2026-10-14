import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { workspaceChildren, workspaceParent, workspacePreviewPath, workspaceSplit } from '../../workspace-browser.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_PAD } from '../view-frame.js';
import { formatDateTime } from '../../../client/date-format.js';

/**
 * Height of the docked reader's box below `top`: the column's content box
 * ends one frame pad above the frame's foot. The renderer publishes the same
 * number to the DOM reader, which has no other way to learn the layout height
 * a focused camera leaves visible.
 */
export function workspaceReaderHeight(frameBottom: number, top: number): number {
  return Math.max(0, frameBottom - VIEW_FRAME_PAD - top);
}

export function drawWorkspace(ctx: RendererCtx, snapshot: GpuRenderSnapshot, width: number, height: number,
  embedded?: { x: number; top: number; width: number; bottom: number }): void {
  const frame = viewFrame(width, height), data = snapshot.data.workspace;
  const left = embedded?.x ?? frame.innerX;
  const columnWidth = embedded?.width ?? frame.innerWidth;
  const bottomEdge = embedded?.bottom ?? frame.bottom;
  const path = snapshot.state.workspacePath;
  const t = snapshot.t;
  const project = snapshot.data.projects.find(p => p.projectId === snapshot.state.selectedProjectId);
  if (!embedded) drawViewFrame(ctx, frame, `${project?.name ?? ''} · ${t('workspace.title')}`);
  let top = embedded?.top ?? frame.contentTop;
  // An open file docks beside the list when the column holds both; the DOM
  // reader fills this frame (transparent wrapper, the Projects-guide pattern).
  const previewPath = workspacePreviewPath(snapshot.state);
  const split = embedded && previewPath !== null ? workspaceSplit(columnWidth) : null;
  const contentWidth = split?.listWidth ?? columnWidth;
  if (split) {
    ctx.panel(ctx.root, left + split.readerX, top, split.readerWidth, workspaceReaderHeight(bottomEdge, top),
      GPU_COLORS.panel, GPU_COLORS.border, GPU_LAYOUT.radius, 2);
  }
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
    ctx.text(ctx.root, path, left, top, { size: 12, mono: true, width: contentWidth, singleLine: true });
    ctx.tooltip(ctx.root, { x: left, y: top, width: contentWidth, height: 22, text: path });
    top += 30;
  }
  const pane = createScrollPane(ctx.root, { x: left, y: top, width: contentWidth,
    height: Math.max(0, bottomEdge - top - 12), scrollY: snapshot.state.scrollY.projects });
  let bottom = 0;
  const message = (key: string) => { ctx.text(pane.content, t(key), 0, 0, { size: 12, width: pane.width - 16 }); bottom = 60; };
  if (data?.failed) message('workspace.unavailable');
  else if (!data?.index || data.loading) message('workspace.loading');
  else {
    const children = workspaceChildren(data.index, path);
    if (!children.length) message('workspace.empty');
    children.forEach((entry, i) => {
      if (pane.visible(i * 40, i * 40 + 34)) ctx.button(pane.content, 'workspace.path.' + entry.path, 'button',
        entry.directory ? entry.name + '/' : `${entry.name} · ${entry.size.toLocaleString(snapshot.state.locale)} B`,
        0, i * 40, pane.width - 16, 34, !entry.directory && entry.path === previewPath, snapshot.onActivate,
        entry.directory ? GPU_COLORS.primary : GPU_COLORS.text,
        false, false, undefined, undefined, undefined, false, entry.directory ? 'folder' : 'file');
    });
    bottom = Math.max(bottom, children.length * 40);
  }
  pane.extend(bottom); ctx.scrollMax.projects = pane.finish();
}
