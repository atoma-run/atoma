import type { WorkspaceIndex, WorkspaceFile } from '../../contracts/workspaceBrowser.js';
import type { VizProjectRun } from '../client/types.js';
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
