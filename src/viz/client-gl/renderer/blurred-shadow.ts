import { CanvasSource, Container, NineSliceSprite, Texture } from 'pixi.js';
import { SCENE_SHADOW_COLORS, softShadowSpread } from './soft-shadow.js';

/**
 * A rounded rect's cast shadow as ONE nine-slice sprite: 9 quads, whatever
 * the corner radius, instead of a stack of tessellated rounded rects.
 *
 * The texture is the true Gaussian blur of a rounded rect, computed once on
 * the CPU per (corner radius, sigma, resolution) and shared by every shadow
 * with that corner. Only the corners vary; the edges are a 1-D profile and
 * the centre is flat, so stretching the middle slices is exact.
 *
 * A sprite rather than a per-shadow analytic shader: sprites batch with the
 * surrounding UI, while a custom mesh is its own draw call per shadow.
 *
 * Calibrated on the layered stack it replaces: that stack ran from its peak
 * at the surface edge to nothing at `spread` beyond it. A blur of the rect
 * grown by spread/2, with sigma = spread/4, crosses the same two points
 * (≈98% at the edge, ≈2% at the outer limit).
 */

interface ShadowSlices {
  texture: Texture;
  /** Corner slice size, CSS pixels. */
  slice: number;
  /** Transparent margin around the blurred rect inside the texture. */
  pad: number;
}

const slicesCache = new Map<string, ShadowSlices>();

function channels(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function gaussianKernel(sigmaPx: number): Float32Array {
  const reach = Math.ceil(3 * sigmaPx);
  const kernel = new Float32Array(reach * 2 + 1);
  let sum = 0;
  for (let i = -reach; i <= reach; i += 1) {
    const w = Math.exp(-(i * i) / (2 * sigmaPx * sigmaPx));
    kernel[i + reach] = w;
    sum += w;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i]! /= sum;
  return kernel;
}

function blurPass(source: Float32Array, size: number, kernel: Float32Array, horizontal: boolean) {
  const out = new Float32Array(source.length);
  const reach = (kernel.length - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let acc = 0;
      for (let k = -reach; k <= reach; k += 1) {
        const sx = horizontal ? x + k : x;
        const sy = horizontal ? y : y + k;
        if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue;
        acc += source[sy * size + sx]! * kernel[k + reach]!;
      }
      out[y * size + x] = acc;
    }
  }
  return out;
}

function shadowSlices(radius: number, sigma: number, resolution: number): ShadowSlices {
  const key = `${radius}|${sigma}|${resolution}`;
  const cached = slicesCache.get(key);
  if (cached) return cached;

  const reach = Math.ceil(3 * sigma);
  const pad = reach;
  const slice = pad + Math.ceil(radius) + reach;
  // Two centre pixels: the flat interior the middle slices stretch.
  const size = slice * 2 + 2;
  const px = Math.ceil(size * resolution);

  // Coverage of the rounded rect (inset by `pad`), 1px antialiased by its SDF.
  const mask = new Float32Array(px * px);
  const mid = px / 2;
  const half = ((size - pad * 2) * resolution) / 2;
  const r = Math.min(radius * resolution, half);
  for (let y = 0; y < px; y += 1) {
    for (let x = 0; x < px; x += 1) {
      const qx = Math.abs(x + 0.5 - mid) - (half - r);
      const qy = Math.abs(y + 0.5 - mid) - (half - r);
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const d = outside + Math.min(Math.max(qx, qy), 0) - r;
      mask[y * px + x] = Math.min(1, Math.max(0, 0.5 - d));
    }
  }

  let coverage = mask;
  const sigmaPx = sigma * resolution;
  if (sigmaPx >= 0.3) {
    const kernel = gaussianKernel(sigmaPx);
    coverage = blurPass(blurPass(mask, px, kernel, true), px, kernel, false);
  }

  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(px, px);
  const penumbra = channels(SCENE_SHADOW_COLORS.penumbra);
  const core = channels(SCENE_SHADOW_COLORS.core);
  for (let i = 0; i < coverage.length; i += 1) {
    const c = Math.min(1, Math.max(0, coverage[i]!));
    // The same palette the layered stack walked: penumbra outside, core in.
    image.data[i * 4] = Math.round(penumbra[0] + (core[0] - penumbra[0]) * c);
    image.data[i * 4 + 1] = Math.round(penumbra[1] + (core[1] - penumbra[1]) * c);
    image.data[i * 4 + 2] = Math.round(penumbra[2] + (core[2] - penumbra[2]) * c);
    image.data[i * 4 + 3] = Math.round(c * 255);
  }
  context.putImageData(image, 0, 0);

  const texture = new Texture({ source: new CanvasSource({ resource: canvas, resolution }) });
  const slices = { texture, slice, pad };
  slicesCache.set(key, slices);
  return slices;
}

/**
 * The shadow holder. Callers keep driving its `alpha` (entrance, inset depth)
 * as a multiplier over the peak the sprite carries. `setEdges` moves each
 * edge of the shadow independently — the projective model throws a near edge
 * further than a far one — by resizing the nine-slice, which only rewrites
 * its 9 quads: nothing is re-blurred or re-tessellated.
 */
export class BlurredShadow extends Container {
  private sprite: NineSliceSprite | null = null;
  private rect = { x: 0, y: 0, width: 0, height: 0, margin: 0 };
  private peak = 0;

  attach(sprite: NineSliceSprite, x: number, y: number, width: number, height: number, margin: number) {
    this.sprite = sprite;
    this.rect = { x, y, width, height, margin };
    this.peak = sprite.alpha;
    this.addChild(sprite);
  }

  /** Scale the shadow's density below its built peak (1 = as built). */
  setDensity(density: number) {
    if (this.sprite) this.sprite.alpha = this.peak * density;
  }

  /** Displacement of each edge from the surface's own edge, local pixels. */
  setEdges(left: number, top: number, right: number, bottom: number) {
    const sprite = this.sprite;
    if (!sprite) return;
    const { x, y, width, height, margin } = this.rect;
    const w = Math.max(1, width + right - left);
    const h = Math.max(1, height + bottom - top);
    sprite.position.set(x + left - margin, y + top - margin);
    sprite.setSize(w + margin * 2, h + margin * 2);
  }
}

/**
 * The shadow of the rounded rect (x, y, width, height, radius), peaking at
 * `alpha` under the surface.
 */
export function createBlurredShadow(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  alpha: number,
  depth = 1
): BlurredShadow {
  const holder = new BlurredShadow();
  const peak = Math.min(1, Math.max(0, alpha));
  if (typeof document === 'undefined' || peak === 0 || !(width > 0) || !(height > 0)) {
    return holder;
  }
  const spread = softShadowSpread(depth);
  const grown = spread / 2;
  const sigma = spread / 4;
  // Quarter-pixel corner keys bound the cache without a visible step.
  const corner = Math.round((Math.max(0, radius) + grown) * 4) / 4;
  const resolution = Math.min(globalThis.devicePixelRatio || 1, 2);
  const { texture, slice, pad } = shadowSlices(corner, sigma, resolution);
  const margin = grown + pad;
  const sprite = new NineSliceSprite({
    texture,
    leftWidth: slice,
    rightWidth: slice,
    topHeight: slice,
    bottomHeight: slice,
    width: width + margin * 2,
    height: height + margin * 2,
  });
  sprite.position.set(x - margin, y - margin);
  sprite.alpha = peak;
  sprite.eventMode = 'none';
  holder.attach(sprite, x, y, width, height, margin);
  return holder;
}
