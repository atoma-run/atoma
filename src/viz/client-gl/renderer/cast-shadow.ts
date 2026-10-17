import { POINTER_LIGHT_RADIUS_PX, pointerLightFalloff } from '../pointer-light.js';
import { VIZ_VISUAL_DEPTH } from '../visual-depth.js';

/**
 * Where a surface throws its shadow: the shadow a point lamp actually casts.
 *
 * Every surface is a plane parallel to the page at altitude `z` above what it
 * stands on; the pointer lamp floats at height `H` over the cursor. Projecting
 * a corner from the lamp onto the receiver gives, exactly:
 *
 *   corner' = lamp + (corner - lamp) · H / (H - z)
 *
 * so an edge moves by (edge - lamp) · z / (H - z). That is what a shadow map
 * would compute for stacked parallel planes, without a depth pass. Two lights
 * share the scene: the lamp, close and point-like, throws a long, dense
 * shadow; the ambient key light, a broad distant sky, a short and light one.
 * Where the lamp's light falls off, its shadow fades back to the ambient one —
 * a shadow only exists where its light would have reached.
 *
 * Pure and frame-independent: the caller owns the damped `strength` and calls
 * this once per shadow per frame. Nothing here reads a clock.
 */

/**
 * The lamp's height at the identity `lightHeight` tuning, renderer pixels. Low
 * on purpose — a desk lamp bent over the page: at 240px a surface 10px high
 * threw at most 1.9px, which nobody could see (2026-10-17).
 */
export const LAMP_HEIGHT_PX = 50;
/** Altitude of a surface at depth 1 above its receiver, renderer pixels. */
export const SURFACE_ALTITUDE_PX = 10;
/**
 * The farthest any edge is thrown. Physically unbounded as the lamp nears a
 * surface (Scene Tuning reaches there), so it is capped; the scroll pane's
 * shadow bleed is derived from it.
 */
export const CAST_SHADOW_MAX_THROW_PX = 16;

/**
 * The ambient key light's share of the shipped ambient offset, and the density
 * an unlit shadow keeps. The lamp restores full density where it shines; the
 * contrast is what makes its shadow read as the lamp's. Scene Tuning overrides
 * both live (`ambientShadowReach`, `ambientShadowDensity`).
 */
export const AMBIENT_SHADOW_REACH = 0.5;
export const AMBIENT_SHADOW_DENSITY = 0.6;

export interface CastShadowInput {
  /** Surface rect in stage coordinates. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Light position, renderer pixels. */
  lightX: number;
  lightY: number;
  /** Damped pointer presence, 0..1. At 0 the result is the ambient shadow. */
  strength: number;
  /**
   * The surface's elevation: scales its altitude, hence both the ambient
   * offset and the lamp's throw. A deeper layer travels further, which is what
   * separates stacked surfaces into soft shadows instead of one smear.
   */
  depth?: number;
  /**
   * How high the lamp floats, 1 being the shipped height. A lifted lamp
   * spreads its pool WIDER and throws SHORTER shadows: one number moves both,
   * because the light's reach and its shadows' reach are the same fact.
   */
  lightHeight?: number;
  /** Ambient reach; default AMBIENT_SHADOW_REACH. */
  ambientReach?: number;
  /** Unlit density; default AMBIENT_SHADOW_DENSITY. */
  ambientDensity?: number;
}

export interface CastShadowOffset {
  x: number;
  y: number;
}

/** The ambient shadow: a fixed key light from above, all a surface has unlit. */
export function ambientShadowOffset(depth = 1, reach = AMBIENT_SHADOW_REACH): CastShadowOffset {
  return {
    x: VIZ_VISUAL_DEPTH.near.shadowX * depth * reach,
    y: VIZ_VISUAL_DEPTH.near.shadowY * depth * reach,
  };
}

/** How far each edge of a shadow moves from its surface's edge, and how dense it is. */
export interface CastShadowEdges {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Density multiplier: the ambient share unlit, 1 under the lamp. */
  density: number;
}

interface Lamp {
  strength: number;
  lightX: number;
  lightY: number;
  radius: number;
  throwRatio: number;
}

function clampThrow(value: number): number {
  return Math.max(-CAST_SHADOW_MAX_THROW_PX, Math.min(CAST_SHADOW_MAX_THROW_PX, value));
}

/**
 * The lamp as it acts on this surface, or null when only the ambient light
 * does. NaN anywhere would otherwise ride through every formula and land as a
 * (NaN, NaN) position — and a damped strength, once NaN, stays NaN, so the
 * shadow would never recover. Ambient is the honest answer to a light we
 * cannot place.
 */
function lampFor(input: CastShadowInput, depth: number): Lamp | null {
  if (
    !Number.isFinite(input.strength) ||
    !Number.isFinite(input.lightX) ||
    !Number.isFinite(input.lightY) ||
    !Number.isFinite(input.left) ||
    !Number.isFinite(input.top)
  ) {
    return null;
  }
  const strength = Math.min(1, Math.max(0, input.strength));
  if (strength === 0) return null;
  const lightHeight = input.lightHeight && input.lightHeight > 0 ? input.lightHeight : 1;
  const lampHeight = LAMP_HEIGHT_PX * lightHeight;
  // A surface at or above the lamp has no finite shadow; keep it below.
  const altitude = Math.min(SURFACE_ALTITUDE_PX * Math.max(0, depth), lampHeight * 0.8);
  return {
    strength,
    lightX: input.lightX,
    lightY: input.lightY,
    radius: POINTER_LIGHT_RADIUS_PX * lightHeight,
    throwRatio: altitude / (lampHeight - altitude),
  };
}

function finiteDepth(input: CastShadowInput): number {
  return Number.isFinite(input.depth ?? 1) ? input.depth ?? 1 : 1;
}

/**
 * The throw resolved PER EDGE, for rounded-rect shadows that can move each
 * edge on its own. Each edge is weighted by the lamp's light at its nearest
 * point: a wide card under the pointer throws its near edge and leaves its far
 * edge where the ambient light has it, instead of moving every edge by one
 * blend — which threw the far edge of a 900px row 26px out (2026-10-17).
 */
export function castShadowEdges(input: CastShadowInput): CastShadowEdges {
  const depth = finiteDepth(input);
  const rest = ambientShadowOffset(depth, input.ambientReach);
  const ambientDensity = Math.min(1, Math.max(0, input.ambientDensity ?? AMBIENT_SHADOW_DENSITY));
  const lamp = lampFor(input, depth);
  if (!lamp) {
    return { left: rest.x, right: rest.x, top: rest.y, bottom: rest.y, density: ambientDensity };
  }
  const { left, top, width, height } = input;
  const right = left + width;
  const bottom = top + height;
  const nearestX = Math.min(right, Math.max(left, lamp.lightX));
  const nearestY = Math.min(bottom, Math.max(top, lamp.lightY));
  const weight = (x: number, y: number) =>
    lamp.strength * pointerLightFalloff(Math.hypot(x - lamp.lightX, y - lamp.lightY), lamp.radius);
  const edge = (ambient: number, cast: number, w: number) =>
    ambient + (clampThrow(cast) - ambient) * w;
  return {
    // The brightest the lamp gets anywhere on the surface.
    density: ambientDensity + (1 - ambientDensity) * weight(nearestX, nearestY),
    left: edge(rest.x, (left - lamp.lightX) * lamp.throwRatio, weight(left, nearestY)),
    right: edge(rest.x, (right - lamp.lightX) * lamp.throwRatio, weight(right, nearestY)),
    top: edge(rest.y, (top - lamp.lightY) * lamp.throwRatio, weight(nearestX, top)),
    bottom: edge(rest.y, (bottom - lamp.lightY) * lamp.throwRatio, weight(nearestX, bottom)),
  };
}

export interface CastShadowTransform extends CastShadowOffset {
  /** Uniform scale of the shadow about the surface's top-left corner. */
  scale: number;
}

/**
 * The same projection as ONE transform, for shadows that cannot move their
 * edges apart (an icon's alpha silhouette, a recessed button's inner shadow).
 * They are small, so one blend for the whole surface is indistinguishable
 * from per-edge weights: the shadow is the surface scaled by H / (H - z)
 * about the lamp's foot.
 */
export function castShadowTransform(input: CastShadowInput): CastShadowTransform {
  const depth = finiteDepth(input);
  const rest = ambientShadowOffset(depth, input.ambientReach);
  const lamp = lampFor(input, depth);
  if (!lamp) return { ...rest, scale: 1 };
  const { left, top, width, height } = input;
  const gapX = Math.max(left - lamp.lightX, 0, lamp.lightX - (left + width));
  const gapY = Math.max(top - lamp.lightY, 0, lamp.lightY - (top + height));
  const blend = lamp.strength * pointerLightFalloff(Math.hypot(gapX, gapY), lamp.radius);
  const castX = clampThrow((left - lamp.lightX) * lamp.throwRatio);
  const castY = clampThrow((top - lamp.lightY) * lamp.throwRatio);
  return {
    x: rest.x + (castX - rest.x) * blend,
    y: rest.y + (castY - rest.y) * blend,
    scale: 1 + Math.min(0.5, lamp.throwRatio) * blend,
  };
}

/**
 * Which stack a surface belongs to. The tuning panel lifts these
 * independently — a button rises off the frame that groups it, that frame
 * rises off the column, the column rises off the page — so a shadow has to
 * declare which of the three it is. `card` is everything else and is left
 * alone by the panel, because cards already carry their own elevation.
 */
export type CastShadowSurface = 'button' | 'frame' | 'column' | 'card';

/** The live multiplier for a surface class. Identity tuning returns 1 flat. */
export function surfaceDepthScale(
  surface: CastShadowSurface,
  tuning: {
    buttonDepth: number;
    controlFrameDepth: number;
    columnDepth: number;
  }
): number {
  // Ratios against the shipped depth, so a slider sitting at the identity is
  // exactly a no-op no matter what the build-time depth happened to be.
  if (surface === 'button') return tuning.buttonDepth / TUNING_IDENTITY_BUTTON;
  if (surface === 'frame') return tuning.controlFrameDepth / TUNING_IDENTITY_FRAME;
  if (surface === 'column') return tuning.columnDepth / TUNING_IDENTITY_COLUMN;
  return 1;
}

/**
 * The shipped depths these knobs are ratios against. Declared here beside the
 * consumer and asserted against `TUNING_IDENTITY` by a test, so the two cannot
 * drift into a panel whose "default" silently restyles the app — which is
 * exactly what the first version of this panel did.
 */
const TUNING_IDENTITY_BUTTON = 1;
const TUNING_IDENTITY_FRAME = 0.8;
const TUNING_IDENTITY_COLUMN = 1;

export const CAST_SHADOW_IDENTITY_DEPTH = {
  button: TUNING_IDENTITY_BUTTON,
  frame: TUNING_IDENTITY_FRAME,
  column: TUNING_IDENTITY_COLUMN,
} as const;
