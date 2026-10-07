import { createHash } from 'node:crypto';
import type { RepositoryFileState, RepositoryInventory, RepositoryTreeEntry } from '../contracts/repositorySync.js';
import { assertPublishableArtifactPath, normalizeArtifactPath, buildWorkspaceArtifactManifest, readManifestArtifact } from './artifacts.js';

export function repositoryFile(inventory: RepositoryInventory, p: string): RepositoryFileState | undefined {
  return Object.hasOwn(inventory, p) ? inventory[p] : undefined;
}

export function gitBlobSha(content: Uint8Array): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}
export function inventoryRepositoryWorkspace(workspaceRoot: string): RepositoryInventory {
  const { manifest } = buildWorkspaceArtifactManifest({ workspaceRoot, allowEmpty: true });
  return Object.fromEntries(manifest.files.map(file => [file.path, {
    mode: file.mode, sha: gitBlobSha(readManifestArtifact({ workspaceRoot, expected: file })),
  }]));
}
export function sameRepositoryFile(a?: RepositoryFileState, b?: RepositoryFileState): boolean {
  return a?.mode === b?.mode && a?.sha === b?.sha;
}
export function repositoryDebt(base: RepositoryInventory, ours: RepositoryInventory, published: boolean): Set<string> {
  return new Set([...new Set([...Object.keys(base), ...Object.keys(ours)])].filter(p =>
    published ? !!repositoryFile(base, p) && !repositoryFile(ours, p) : !sameRepositoryFile(repositoryFile(base, p), repositoryFile(ours, p))));
}
export function carryRepositoryBase(base: RepositoryInventory, ours: RepositoryInventory, published: boolean): RepositoryInventory {
  const next = { ...ours };
  for (const p of repositoryDebt(base, ours, published)) {
    const value = repositoryFile(base, p);
    if (value) Object.defineProperty(next, p, { value, enumerable: true, writable: true, configurable: true });
    else delete next[p];
  }
  return next;
}

export function publishableSyncPath(p: string): boolean {
  try { return normalizeArtifactPath(p) === p && (assertPublishableArtifactPath(p), true); }
  catch { return false; }
}
export function remoteRepositoryInventory(entries: readonly RepositoryTreeEntry[]): RepositoryInventory {
  return Object.fromEntries(entries.filter(e => e.type === 'blob' &&
    (e.mode === '100644' || e.mode === '100755') && publishableSyncPath(e.path))
    .map(e => [e.path, { mode: e.mode as RepositoryFileState['mode'], sha: e.sha }]));
}

/** The same per-path decision at seed time and publication. No filesystem writes. */
export function planRepositorySync(input: {
  base: RepositoryInventory; ours: RepositoryInventory; theirs: RepositoryInventory;
  debt: ReadonlySet<string>; remoteEntries?: readonly RepositoryTreeEntry[];
}): { take: string[]; write: string[]; conflicts: string[] } {
  const { base, ours, theirs, debt } = input;
  const all = [...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])];
  const folded = new Map<string, string>();
  for (const p of [...all, ...(input.remoteEntries ?? []).map(e => e.path)]) {
    // Include directories: Foo/a and foo/b collide on a case-insensitive host.
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const existing = folded.get(prefix.toLowerCase());
      if (existing && existing !== prefix) throw new Error('Repository contains conflicting file paths');
      folded.set(prefix.toLowerCase(), prefix);
    }
  }
  const remote = input.remoteEntries ?? Object.entries(theirs).map(([path, v]) => ({ path, ...v, type: 'blob' }));
  const remoteByPath = new Map(remote.map(e => [e.path, e]));
  const parents = new Set<string>();
  for (const e of remote) {
    let end = e.path.lastIndexOf('/');
    while (end !== -1) { parents.add(e.path.slice(0, end)); end = e.path.lastIndexOf('/', end - 1); }
  }
  const take: string[] = [], write: string[] = [], conflicts: string[] = [];
  for (const p of all) {
    const exact = remoteByPath.get(p);
    let obstructed = parents.has(p) || (!!exact && (exact.type !== 'blob' || !repositoryFile(theirs, p)));
    for (let end = p.lastIndexOf('/'); !obstructed && end !== -1; end = p.lastIndexOf('/', end - 1)) {
      const ancestor = remoteByPath.get(p.slice(0, end));
      obstructed = !!ancestor && ancestor.type !== 'tree';
    }
    if (!debt.has(p)) {
      if (!sameRepositoryFile(repositoryFile(ours, p), repositoryFile(theirs, p)) || (obstructed && repositoryFile(ours, p))) take.push(p);
    } else if (!obstructed && sameRepositoryFile(repositoryFile(theirs, p), repositoryFile(ours, p))) {
      // Already present, including a remotely accepted tombstone.
    } else if (!obstructed && sameRepositoryFile(repositoryFile(theirs, p), repositoryFile(base, p))) {
      if (repositoryFile(ours, p)) write.push(p); // Publication deliberately cannot delete.
    } else {
      conflicts.push(p);
      if (!sameRepositoryFile(repositoryFile(ours, p), repositoryFile(theirs, p)) || obstructed) take.push(p);
    }
  }
  return { take, write, conflicts };
}
