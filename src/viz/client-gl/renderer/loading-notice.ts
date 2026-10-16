import type { Container, Text } from 'pixi.js';
import type { RendererCtx } from '../gpu-renderer.js';
import { LOADING_CRYSTAL_COLOR } from '../activity-crystal.js';
import { GPU_COLORS } from '../theme.js';
import { attachLiveAtomaMark } from './atoma-mark.js';

/**
 * THE ONE LOADING NOTICE ON THE CANVAS: the beadless activity crystal, turning,
 * beside "Loading <what>". Its DOM twin is `AtomaLoader.tsx`; both draw the
 * frame of `activity-crystal.ts`. A view never writes a bare "Loading…": the
 * notice names what is on its way.
 */
export function drawLoadingNotice(
  ctx: Pick<RendererCtx, 'text' | 'addTicker' | 'animatedLayer'>,
  parent: Container,
  label: string,
  x: number,
  y: number,
  { size = 13, width }: { size?: number; width?: number } = {}
): Text {
  const crystal = Math.round(size * 1.45);
  const gap = Math.round(size * 0.6);
  const text = ctx.text(parent, label, x + crystal + gap, y, {
    size,
    color: GPU_COLORS.muted,
    ...(width === undefined ? {} : { width: Math.max(0, width - crystal - gap), singleLine: true }),
  });
  attachLiveAtomaMark(ctx.animatedLayer(parent, 'loading-crystal'), callback => ctx.addTicker(callback),
    x, y + (text.height - crystal) / 2, LOADING_CRYSTAL_COLOR,
    { size: crystal, bead: false, label: 'loading-atoma-crystal' });
  return text;
}

/**
 * What a whole view waits on, named. Keys are literal so the catalog contract
 * sees each one; an unlisted view falls back to the generic notice.
 */
const VIEW_LOADING_KEYS: Readonly<Record<string, string>> = {
  projects: 'loading.projects',
  runs: 'loading.runs',
  registry: 'loading.registry',
  skills: 'loading.skills',
  burnin: 'loading.burnin',
  admin: 'loading.organisations',
  journal: 'loading.journal',
  ledger: 'loading.ledger',
  sentinel: 'loading.sentinel',
  liveRuns: 'loading.liveRuns',
  settings: 'loading.settings',
};

export function viewLoadingKey(view: string, selected: { project?: boolean; run?: boolean } = {}): string {
  if (view === 'projects' && selected.project) return 'loading.project';
  if (view === 'runs' && selected.run) return 'loading.run';
  return VIEW_LOADING_KEYS[view] ?? 'common.loading';
}
