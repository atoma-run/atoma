/**
 * `?wireframe=1` | `?wireframe=overlay` — the diagnostic wireframe, read once
 * at load: it wraps Pixi's GL context at init and forces the WebGL backend,
 * so changing it means reloading (`wireframeModeUrl`). Pixi-free on purpose:
 * the Scene Tuning panel reads it without pulling the renderer chunk.
 *
 * - `lines`: every Pixi draw is replaced by its triangle edges.
 * - `overlay`: the normal frame, with every triangle edge drawn over it.
 */
export type VizWireframeMode = 'lines' | 'overlay' | null;

function readMode(): VizWireframeMode {
  if (typeof location === 'undefined') return null;
  const value = new URLSearchParams(location.search).get('wireframe');
  if (value === '1' || value === 'lines') return 'lines';
  if (value === 'overlay') return 'overlay';
  return null;
}

export const VIZ_WIREFRAME_MODE = readMode();
export const VIZ_WIREFRAME = VIZ_WIREFRAME_MODE !== null;

/** The current address with the wireframe switched to `mode`. */
export function wireframeModeUrl(mode: VizWireframeMode, href: string): string {
  const url = new URL(href);
  if (mode === null) url.searchParams.delete('wireframe');
  else url.searchParams.set('wireframe', mode === 'lines' ? '1' : 'overlay');
  return url.toString();
}
