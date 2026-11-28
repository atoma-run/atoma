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

/** Module sources a browser refuses outright: only a build can serve them. */
const UNSERVABLE_MODULE = /\.(?:ts|tsx|mts|cts|jsx|vue|svelte)$/i;

/** True when the root page loads a module script no browser can execute as is
 * (`<script type="module" src="/src/main.ts">`): served directly, that page is
 * blank (DVF 7e71b8a6, 04abca98, 2026-11-28). Asked only of a delivery already
 * classified `static`, to choose between serving it and building it; it never
 * classifies, and it is not proof that the page works once built. A page whose
 * modules are plain JavaScript, or which loads classic scripts, keeps the path
 * that served it. */
export function rootPageNeedsBuild(root: string): boolean {
  try {
    const html = readPreviewClassifierFile(root, 'index.html');
    if (html === null) return false;
    for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
      if (!/\btype\s*=\s*["']?module\b/i.test(tag)) continue;
      const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      const address = (src?.[1] ?? src?.[2] ?? src?.[3] ?? '').split(/[?#]/)[0]!;
      if (UNSERVABLE_MODULE.test(address)) return true;
    }
    return false;
  } catch { return false; }
}
