import { Assets, Container, Rectangle, Sprite, Texture, type Text } from 'pixi.js';
import type { RendererCtx } from '../gpu-renderer.js';
import {
  LOADING_CRYSTAL_SECTION_PX,
  LOADING_CRYSTAL_SPRITE,
  LOADING_ENTER_MS,
  LOADING_LEAVE_MS,
  loadingCrystalFrame,
  loadingLeaveStyle,
} from '../loading-crystal.js';
import { GPU_COLORS } from '../theme.js';
import { prefersReducedMotion } from './motion.js';

/**
 * THE ONE LOADING NOTICE ON THE CANVAS: the original crystal, turning, beside
 * "Loading <what>". Its DOM twin is `AtomaLoader.tsx`; both play the sheet of
 * `loading-crystal.ts`. A view never writes a bare "Loading…": the notice
 * names what is on its way.
 */

type NoticeCtx = Pick<RendererCtx, 'text' | 'measureText' | 'addTicker' | 'animatedLayer'>;

let sheet: { crystal: Texture[]; white: Texture[] } | null = null;
let sheetRequested = false;

/** Loads and slices the sheet once; the crystal shows from the frame it lands. */
function requestSheet(): void {
  if (sheet || sheetRequested || typeof window === 'undefined') return;
  sheetRequested = true;
  const { url, frames, size } = LOADING_CRYSTAL_SPRITE;
  void Assets.load<Texture>(url).then((texture) => {
    const slice = (row: number) => Array.from({ length: frames }, (_, index) =>
      new Texture({ source: texture.source, frame: new Rectangle(index * size, row * size, size, size) }));
    sheet = { crystal: slice(0), white: slice(1) };
  }).catch(() => {
    // A later notice asks again; until then the label stands alone.
    sheetRequested = false;
  });
}

interface CrystalHandle {
  readonly container: Container;
  /** 0 = the crystal, 1 = its white pose. */
  white: number;
}

/** The turning crystal, `px` square, its frames advanced by one ticker. */
function attachLoadingCrystal(ctx: NoticeCtx, parent: Container, x: number, y: number, px: number): CrystalHandle {
  requestSheet();
  const container = new Container();
  container.label = 'loading-atoma-crystal';
  container.eventMode = 'none';
  container.position.set(x, y);
  const scale = px / LOADING_CRYSTAL_SPRITE.size;
  const crystal = new Sprite();
  const white = new Sprite();
  crystal.scale.set(scale);
  white.scale.set(scale);
  container.addChild(crystal, white);
  ctx.animatedLayer(parent, 'loading-crystal').addChild(container);
  const handle: CrystalHandle = { container, white: 0 };
  const paint = () => {
    container.visible = sheet !== null;
    if (!sheet) return;
    const index = loadingCrystalFrame(performance.now(), prefersReducedMotion());
    crystal.texture = sheet.crystal[index]!;
    white.texture = sheet.white[index]!;
    white.alpha = handle.white;
    white.visible = handle.white > 0;
  };
  paint();
  ctx.addTicker(paint);
  return handle;
}

/** An inline notice: a footer loading the next page, a small field. */
export function drawLoadingNotice(
  ctx: NoticeCtx,
  parent: Container,
  label: string,
  x: number,
  y: number,
  { size = 13, width }: { size?: number; width?: number } = {}
): Text {
  const crystal = Math.round(size * 1.6);
  const gap = Math.round(size * 0.5);
  const text = ctx.text(parent, label, x + crystal + gap, y, {
    size,
    color: GPU_COLORS.muted,
    ...(width === undefined ? {} : { width: Math.max(0, width - crystal - gap), singleLine: true }),
  });
  attachLoadingCrystal(ctx, parent, x, y + (text.height - crystal) / 2, crystal);
  return text;
}

interface Box { x: number; y: number; width: number; height: number }

const SECTION_TEXT = 18;
const SECTION_GAP = 14;

/** Crystal and label as one group, centred both ways in `box`. */
function drawSectionGroup(ctx: NoticeCtx, parent: Container, label: string, box: Box) {
  const crystal = LOADING_CRYSTAL_SECTION_PX;
  const textWidth = Math.min(Math.ceil(ctx.measureText(label, { size: SECTION_TEXT })),
    Math.max(0, box.width - crystal - SECTION_GAP - 32));
  const left = box.x + Math.max(16, (box.width - crystal - SECTION_GAP - textWidth) / 2);
  const middle = box.y + Math.max(crystal / 2, box.height / 2);
  const style = { size: SECTION_TEXT, width: textWidth, singleLine: true } as const;
  const text = ctx.text(parent, label, left + crystal + SECTION_GAP, middle, { ...style, color: GPU_COLORS.muted });
  text.y = middle - text.height / 2;
  const handle = attachLoadingCrystal(ctx, parent, left, middle - crystal / 2, crystal);
  return { text, handle, textX: text.x, textY: text.y, style };
}

/** Sections that showed a notice, by key, and when they last drew it. */
const pendingSections = new Map<string, { label: string; box: Box; drawnAt: number }>();
/** Sections whose content just arrived: the notice leaves, then the content enters. */
const exits = new Map<string, { label: string; box: Box; startedAt: number }>();

/** A reveal later than this after the last notice is a return, not an arrival. */
const REVEAL_WINDOW_MS = 2_000;

/**
 * The notice for a section that has NOTHING to show yet: the crystal and its
 * label as one group, centred both ways in the section's box. A footer that
 * loads the next page stays `drawLoadingNotice`, inline, below what is read.
 * With a `key`, the section's `revealSection` plays the exit when it arrives.
 */
export function drawSectionLoading(
  ctx: NoticeCtx,
  parent: Container,
  label: string,
  box: Box,
  key?: string
): Text {
  if (key) {
    exits.delete(key);
    pendingSections.set(key, { label, box: { ...box }, drawnAt: performance.now() });
  }
  return drawSectionGroup(ctx, parent, label, box).text;
}

/**
 * The section `key` drew its content into `content`. If it was loading a
 * moment ago, the notice whitens and fades out over it, then `content` fades
 * in — fast, and on every rebuild in between from the same clock. Reduced
 * motion jumps straight to the content.
 */
export function revealSection(ctx: NoticeCtx, key: string, content: Container): void {
  const now = performance.now();
  const pending = pendingSections.get(key);
  if (pending) {
    pendingSections.delete(key);
    if (!prefersReducedMotion() && now - pending.drawnAt < REVEAL_WINDOW_MS) {
      exits.set(key, { label: pending.label, box: pending.box, startedAt: now });
    }
  }
  const exit = exits.get(key);
  const parent = content.parent;
  if (!exit || !parent) return;
  if (now - exit.startedAt >= LOADING_LEAVE_MS + LOADING_ENTER_MS) {
    exits.delete(key);
    return;
  }
  // The leaving notice sits over the content, in the content's own space.
  const overlay = new Container();
  overlay.label = 'loading-exit';
  overlay.eventMode = 'none';
  overlay.position.copyFrom(content.position);
  ctx.animatedLayer(parent, 'loading-exit').addChild(overlay);
  const group = drawSectionGroup(ctx, overlay, exit.label, exit.box);
  const whiteText = ctx.text(overlay, exit.label, group.textX, group.textY, { ...group.style, color: 0xffffff });
  const step = () => {
    const elapsed = performance.now() - exit.startedAt;
    const leave = loadingLeaveStyle(elapsed / LOADING_LEAVE_MS);
    overlay.alpha = leave.opacity;
    overlay.visible = leave.opacity > 0;
    group.handle.white = leave.white;
    whiteText.alpha = leave.white;
    content.alpha = Math.max(0, Math.min(1, (elapsed - LOADING_LEAVE_MS) / LOADING_ENTER_MS));
    if (elapsed >= LOADING_LEAVE_MS + LOADING_ENTER_MS) exits.delete(key);
  };
  step();
  ctx.addTicker(step);
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
