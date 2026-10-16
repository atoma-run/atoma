import {
  ATOMA_MARK_LOCAL_SIZE,
  ATOMA_MARK_MESH,
  buildAtomaMarkFrame,
  mixColor,
  type AtomaMarkPoint,
} from './brand-mark.js';

/**
 * THE SMALL CRYSTAL THAT SAYS SOMETHING IS HAPPENING.
 * ===================================================
 *
 * The brand mark's mesh and pose, flat-shaded, turning five times faster than
 * the mark (a 3 s turn against 15 s). Two surfaces draw it: the canvas, for a
 * live run's status and for every loading notice painted by a view, and the
 * DOM (`AtomaLoader`), for the overlays that wait on their own fetch. Both
 * read this one Pixi-free frame, so the two cannot turn at different rates or
 * shade differently. No offscreen textures, pointer lamps or field light: at
 * 14–28px those are invisible, and the main crystal owns the field light.
 *
 * A LIVE run's crystal keeps the bead, the brand's sign of activity inside the
 * glass. A LOADING crystal draws none: nothing is alive yet, something is
 * merely on its way.
 */

/** Turn rate relative to the brand mark. */
export const ACTIVITY_CRYSTAL_SPEED = 5;

/** The loading crystal's colour: the brand amber of the mark's top facet. */
export const LOADING_CRYSTAL_COLOR = 0xf59e0b;

/** Edge of the box the facet points are authored in (scale to the drawn size). */
export const ACTIVITY_CRYSTAL_LOCAL_SIZE = ATOMA_MARK_LOCAL_SIZE;

/** Upper bound on the facets one frame draws (the front set is smaller). */
export const ACTIVITY_CRYSTAL_FACET_SLOTS = ATOMA_MARK_MESH.facets.length;

export interface ActivityCrystalFacet {
  /** Flat x,y pairs in the 28×28 local box. */
  readonly points: readonly number[];
  readonly color: number;
}

export interface ActivityCrystalFrame {
  /** Back to front. */
  readonly facets: readonly ActivityCrystalFacet[];
  readonly bead: AtomaMarkPoint;
}

/**
 * One frame at `nowMs` (a performance clock). `still` is the reduced-motion
 * pose: it returns the rest frame rather than a slowed one.
 */
export function activityCrystalFrame(nowMs: number, color: number, still: boolean): ActivityCrystalFrame {
  const frame = buildAtomaMarkFrame(still ? 0 : nowMs * ACTIVITY_CRYSTAL_SPEED);
  const facets = frame.frontOrder.map(index => {
    const facet = frame.facets[index]!;
    const points = ATOMA_MARK_MESH.facets[index]!.points.flatMap(point => {
      const projected = frame.projected[point]!;
      return [projected.x, projected.y];
    });
    const light = Math.max(0, -facet.normal[0] * 0.38 + facet.normal[1] * 0.72 + facet.normal[2] * 1.05) / 1.33;
    const shade = light > 0.65
      ? mixColor(color, 0xffffff, (light - 0.65) * 1.4)
      : mixColor(0x000000, color, 0.4 + light * 0.85);
    return { points, color: shade };
  });
  return { facets, bead: frame.corePosition };
}

/** `#rrggbb` for a packed colour (the DOM crystal's fills). */
export function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
