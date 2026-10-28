import { BufferImageSource, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { UI_SCROLL_SHADOW } from '../ui-layout.js';
import { CAST_SHADOW_MAX_THROW_PX } from './cast-shadow.js';

/**
 * A bounded, masked scroll region — THE way a GPU view presents content that
 * can exceed its panel. Drawing without a mask leaks scrolled content over
 * neighbouring panels and headers; scrolling without a reported max lets the
 * wheel run into the void. Both were observed on Registry/Skills and the
 * detail panes in the 2026-08-14 review; this pane is the one shared fix.
 *
 * Contract: draw into `content` using pane-local coordinates (0,0 = pane
 * top-left at scroll 0). The pane positions the layer, applies the
 * caller-owned scrollY, and masks to the pane rect on `finish()`. Cull by
 * SKIPPING draws outside [scrollY - margin, scrollY + height + margin] while
 * still advancing your layout cursor, then `extend(bottomY)` with the full
 * content bottom — the returned max scroll must reflect content that was
 * culled, or the wheel can never reach it. `finish()` also draws the shared
 * directional edge shadows when content overflows, without per-view clipping code.
 *
 * SHADOWS AND THE MASK. The mask exists to stop scrolled CONTENT leaking;
 * a surface's cast shadow legitimately reaches past that surface (up to
 * `SCROLL_PANE_SHADOW_BLEED_PX`, penumbra included), and a mask laid flush
 * against a card guillotines it — the shadow stops on a straight line no
 * light could draw. So every pane DECLARES its `air`: the free floor the view
 * guarantees around the pane on each side, where a shadow may land without
 * covering a raised neighbour. The mask grows into it under ONE rule
 * (`scrollPaneClipRect`): the top only while scrolled to the start and the
 * bottom only while scrolled to the end — then nothing but shadows can sit
 * there — and the sides always, because nothing scrolls horizontally and
 * widths are measured, never overflowing. Air over flat text (a title, a
 * caption) is still air: a shadow falls on the page the text is printed on.
 * Air is NOT the space under a raised neighbour (tabs, buttons, another
 * panel, a popup's edge): declare 0 there. A new pane decides its air when it
 * is written, not when a shadow is first seen clipped.
 */
export interface ScrollPaneOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Current scroll offset — state-owned; the pane only applies it. */
  scrollY: number;
  /** Extra space kept below the last content row (default 12). */
  bottomPadding?: number;
  /** Panes advertise hidden content with non-interactive edge shadows. */
  indicator?: 'shadows';
  /** Pane-local horizontal span of edge shadows, including free space around tiles. */
  shadowSpan?: { x: number; width: number };
  /**
   * Free floor around the pane that cast shadows may land on — see above.
   * REQUIRED, so a new pane decides it; `{}` is a decision too (the pane is
   * its panel, or raised neighbours stand on every side).
   */
  air: ScrollPaneAir;
}

export interface ScrollPaneAir {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/**
 * Farthest a cast shadow, penumbra included, reaches past its surface: the
 * capped throw plus the blurred margin of a default-depth shadow.
 */
export const SCROLL_PANE_SHADOW_BLEED_PX = CAST_SHADOW_MAX_THROW_PX + 8;

/** THE rule for growing a scroll mask into its declared air. */
export function scrollPaneClipRect(
  rect: { x: number; y: number; width: number; height: number },
  air: ScrollPaneAir,
  scrollY: number,
  maxScroll: number
): { x: number; y: number; width: number; height: number } {
  const grant = (value: number | undefined) =>
    Math.min(SCROLL_PANE_SHADOW_BLEED_PX, Math.max(0, value ?? 0));
  const top = scrollY <= 0 ? grant(air.top) : 0;
  const bottom = scrollY >= maxScroll - 0.5 ? grant(air.bottom) : 0;
  const left = grant(air.left);
  const right = grant(air.right);
  return {
    x: rect.x - left,
    y: rect.y - top,
    width: rect.width + left + right,
    height: rect.height + top + bottom,
  };
}

export interface ScrollPane {
  /** Draw here in pane-local coordinates. */
  readonly content: Container;
  readonly width: number;
  readonly height: number;
  readonly scrollY: number;
  /** True when a row spanning [topY, bottomY] pane-local is worth drawing. */
  visible(topY: number, bottomY: number): boolean;
  /** Record content extending down to this pane-local Y (culled or not). */
  extend(bottomY: number): void;
  /** Apply the mask and return the clamped max scroll for the wheel handler. */
  finish(): number;
}

const CULL_MARGIN = 48;

/** Viewport geometry and state-owned scroll offset for decorative edge cues. */
export interface ScrollShadowOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  scrollY: number;
  maxScroll: number;
}

let shadowTexture: Texture | undefined;

/** One tiny immutable texture shared by all panes, including retained timelines. */
function scrollShadowTexture(): Texture {
  if (shadowTexture) return shadowTexture;
  const width = 96;
  const height = UI_SCROLL_SHADOW.depth;
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const offset = (row * width + column) * 4;
      pixels[offset] = UI_SCROLL_SHADOW.color >> 16;
      pixels[offset + 1] = (UI_SCROLL_SHADOW.color >> 8) & 255;
      pixels[offset + 2] = UI_SCROLL_SHADOW.color & 255;
      pixels[offset + 3] = Math.round(255 * UI_SCROLL_SHADOW.opacity *
        (1 - row / (height - 1)) ** 2 * Math.sin(Math.PI * column / (width - 1)) ** 2);
    }
  }
  shadowTexture = new Texture({ source: new BufferImageSource({
    resource: pixels, width, height, alphaMode: 'no-premultiply-alpha', scaleMode: 'linear',
  }) });
  return shadowTexture;
}

/** Decorative cues never intercept input. The updater allocates nothing on scroll. */
export function drawScrollShadows(parent: Container, options: ScrollShadowOptions): (offset: number) => void {
  const { x, y, width, height, scrollY, maxScroll } = options;
  if (maxScroll <= 0 || height <= 0 || width <= 0) return () => {};
  const depth = Math.min(UI_SCROLL_SHADOW.depth, height / 2);
  const sprites = (['top', 'bottom'] as const).map(edge => {
    const shadow = new Sprite(scrollShadowTexture());
    shadow.label = `scroll-shadow-${edge}`;
    shadow.eventMode = 'none';
    shadow.width = width;
    shadow.height = depth;
    shadow.position.set(x, edge === 'top' ? y : y + height);
    if (edge === 'bottom') shadow.scale.y *= -1;
    parent.addChild(shadow);
    return shadow;
  });
  const update = (offset: number) => {
    sprites[0]!.visible = offset > 0.5;
    sprites[1]!.visible = offset < maxScroll - 0.5;
  };
  update(scrollY);
  return update;
}

export function createScrollPane(parent: Container, options: ScrollPaneOptions): ScrollPane {
  const { x, y, scrollY } = options;
  const width = Math.max(0, options.width);
  const height = Math.max(0, options.height);
  const bottomPadding = options.bottomPadding ?? 12;
  const layer = new Container();
  layer.position.set(x, y);
  const content = new Container();
  content.label = 'scroll-pane-content';
  content.position.set(0, -scrollY);
  layer.addChild(content);
  parent.addChild(layer);
  let contentBottom = 0;
  let finished = false;
  return {
    content,
    width,
    height,
    scrollY,
    visible(topY: number, bottomY: number) {
      return bottomY >= scrollY - CULL_MARGIN && topY <= scrollY + height + CULL_MARGIN;
    },
    extend(bottomY: number) {
      contentBottom = Math.max(contentBottom, bottomY);
    },
    finish() {
      if (finished) return Math.max(0, contentBottom + bottomPadding - height);
      finished = true;
      const maxScroll = Math.max(0, contentBottom + bottomPadding - height);
      const clip = scrollPaneClipRect({ x, y, width, height }, options.air, scrollY, maxScroll);
      const mask = new Graphics();
      mask.rect(clip.x, clip.y, clip.width, clip.height).fill(0xffffff);
      mask.eventMode = 'none';
      parent.addChild(mask);
      layer.mask = mask;
      const span = options.shadowSpan;
      drawScrollShadows(parent, { x: x + (span?.x ?? 0), y, width: span?.width ?? width, height, scrollY, maxScroll });
      return maxScroll;
    },
  };
}
