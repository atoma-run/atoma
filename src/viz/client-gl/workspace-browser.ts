import type { WorkspaceIndex, WorkspaceFile } from '../../contracts/workspaceBrowser.js';
import type { VizProjectRun } from '../client/types.js';
export function latestWorkspaceRun(runs: readonly VizProjectRun[]) {
  return runs.find(r => !r.rerunOf && !r.bytesExpiredAt && (r.status === 'delivered' || r.status === 'partial'));
}
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

/** Wrap by measured glyph width, preserving whitespace and all preview bytes. */
export function workspaceLines(text: string, width: number, measure: (text: string) => number): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').flatMap(line => {
    let rest = line.replace(/\t/g, '    ');
    const rows: string[] = [];
    while (rest.length) {
      // Grow a measured window instead of repeatedly measuring half of a
      // potentially 256 KiB minified line for every visible row.
      let lo = 1, hi = Math.min(rest.length, 128);
      while (hi < rest.length && measure(rest.slice(0, hi)) <= width) hi = Math.min(rest.length, hi * 2);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measure(rest.slice(0, mid)) <= width) lo = mid; else hi = mid - 1;
      }
      if (lo < rest.length && /[\uD800-\uDBFF]/.test(rest[lo - 1]!)) lo = lo === 1 ? 2 : lo - 1;
      rows.push(rest.slice(0, lo)); rest = rest.slice(lo);
    }
    return rows.length ? rows : [''];
  });
}
