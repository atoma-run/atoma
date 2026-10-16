/**
 * THE LOADING CRYSTAL: the original brand crystal — its shell shader, diamond
 * material and pose — without the bead, turning five times faster than the
 * mark. It is RENDERED ONCE by `attachAtomaMark` itself
 * (`npm run viz:loading-crystal`) into a sprite sheet, and both surfaces play
 * the frames: `AtomaLoader` in CSS, `renderer/loading-notice.ts` as a Pixi
 * sprite. A live mark per notice would cost a shell, two refraction textures
 * and a ticker each, and a DOM notice cannot reach the one canvas at all.
 *
 * Pixi-free, so the entry chunk can read it without the renderer.
 */
export const LOADING_CRYSTAL_SPRITE = {
  url: '/textures/loading-crystal.webp',
  /** Poses across one full turn (scripts/viz-loading-crystal.mjs FRAMES). */
  frames: 72,
  /** Square frame edge in the sheet (SIZE). Row 0 crystal, row 1 white pose. */
  size: 96,
  /** One turn: the mark's 15 s, five times faster. */
  turnMs: 3_000,
} as const;

/** Inline crystal (a footer, a field) and a whole section's, at twice it. */
export const LOADING_CRYSTAL_INLINE_PX = 23;
export const LOADING_CRYSTAL_SECTION_PX = 46;

/**
 * THE EXIT: the notice whitens and fades out, then the content fades in. Fast
 * on purpose — it marks the arrival, it must not delay it. Shared by the CSS
 * keyframes (`styles.css`, restated there) and the canvas.
 */
export const LOADING_LEAVE_MS = 140;
export const LOADING_ENTER_MS = 180;

/** Frame index at `nowMs`; the rest pose under reduced motion. */
export function loadingCrystalFrame(nowMs: number, still: boolean): number {
  if (still) return 0;
  const { frames, turnMs } = LOADING_CRYSTAL_SPRITE;
  return Math.floor(((nowMs % turnMs) + turnMs) % turnMs / turnMs * frames) % frames;
}

/** How white and how visible the leaving notice is, `t` in [0, 1] of the leave. */
export function loadingLeaveStyle(t: number): { white: number; opacity: number } {
  const clamped = Math.max(0, Math.min(1, t));
  const smooth = (edge0: number, edge1: number) => {
    const x = Math.max(0, Math.min(1, (clamped - edge0) / (edge1 - edge0)));
    return x * x * (3 - 2 * x);
  };
  return { white: smooth(0, 0.6), opacity: 1 - smooth(0.35, 1) };
}
