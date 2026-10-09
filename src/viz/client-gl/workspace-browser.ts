import type { WorkspaceIndex, WorkspaceFile } from '../../contracts/workspaceBrowser.js';
import type { VizProjectRun } from '../client/types.js';
import { sidebarWidthForViewport } from './theme.js';
import { viewFrame } from './renderer/view-frame.js';
export function latestWorkspaceRun(runs: readonly VizProjectRun[]) {
  return runs.find(r => !r.rerunOf && !r.bytesExpiredAt && (r.status === 'delivered' || r.status === 'partial'));
}
export interface FilePreviewTarget { projectId: string; runId: string; path: string }
export interface WorkspaceBrowserData {
  index: WorkspaceIndex | null; file: WorkspaceFile | null; loading: boolean; failed: boolean;
}
export function workspaceChildren(index: WorkspaceIndex | null, directory: string) {
  const prefix = directory ? directory + '/' : '';
  const children = new Map<string, { path: string; name: string; directory: boolean; size: number }>();
  for (const file of index?.files ?? []) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length), name = rest.split('/')[0]!;
    const folder = rest.includes('/');
    children.set(name, { path: prefix + name, name, directory: folder, size: folder ? 0 : file.size });
  }
  return [...children.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}
export function workspaceParent(path: string) { return path.split('/').slice(0, -1).join('/'); }

/**
 * THE FILES SPLIT — when the Files section holds its list and the open file
 * side by side, so a reader moves from file to file without closing anything.
 * The renderer narrows the list and draws the reader's frame from it; GpuApp
 * docks the reader there instead of opening the modal. Both ask with the
 * viewport width alone, so they cannot disagree. `null` keeps one column: a
 * narrow screen still reads a file in the modal.
 */
export const WORKSPACE_LIST_MIN_WIDTH = 240;
export const WORKSPACE_LIST_MAX_WIDTH = 360;
export const WORKSPACE_READER_MIN_WIDTH = 480;
export const WORKSPACE_SPLIT_GAP = 16;
export interface WorkspaceSplit { listWidth: number; readerX: number; readerWidth: number }
/** `columnWidth` is the frame's content width; offsets are relative to its left edge. */
export function workspaceSplit(columnWidth: number): WorkspaceSplit | null {
  const listWidth = Math.round(Math.min(WORKSPACE_LIST_MAX_WIDTH,
    Math.max(WORKSPACE_LIST_MIN_WIDTH, columnWidth * 0.3)));
  const readerWidth = columnWidth - listWidth - WORKSPACE_SPLIT_GAP;
  return readerWidth < WORKSPACE_READER_MIN_WIDTH ? null
    : { listWidth, readerX: listWidth + WORKSPACE_SPLIT_GAP, readerWidth };
}
export function workspaceSplitForViewport(viewportWidth: number): WorkspaceSplit | null {
  return workspaceSplit(viewFrame(viewportWidth - sidebarWidthForViewport(viewportWidth), 0).innerWidth);
}
/** The previewed path, when it belongs to the Files section on screen. */
export function workspacePreviewPath(state: {
  filePreview: FilePreviewTarget | null; view: string; projectSection: string;
  selectedProjectId: string | null; workspaceRunId: string | null;
}): string | null {
  const preview = state.filePreview;
  return preview && state.view === 'projects' && state.projectSection === 'files'
    && preview.projectId === state.selectedProjectId && preview.runId === state.workspaceRunId
    ? preview.path : null;
}
