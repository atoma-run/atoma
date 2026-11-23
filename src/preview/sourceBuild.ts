import { previewWorkspaceHasFile, readPreviewClassifierFile } from './policy.js';

/** A supported build input, not a claim that delivery contained runnable bytes.
 * Only the isolated preview executes Vite or its configuration. No scripts from
 * package.json, trace commands, dependency installation or source writes. */
export function hasVitePreviewSource(root: string): boolean {
  try {
    if (!previewWorkspaceHasFile(root, 'index.html')) return false;
    const raw = readPreviewClassifierFile(root, 'package.json');
    if (raw === null) return false;
    const pkg: unknown = JSON.parse(raw);
    if (!pkg || typeof pkg !== 'object') return false;
    for (const key of ['dependencies', 'devDependencies'] as const) {
      const deps: unknown = (pkg as Record<string, unknown>)[key];
      if (deps && typeof deps === 'object' && typeof (deps as Record<string, unknown>)['vite'] === 'string') return true;
    }
    return false;
  } catch { return false; }
}
