import { Container, Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  createScrollPane,
  drawScrollShadows,
  SCROLL_PANE_SHADOW_BLEED_PX,
  scrollPaneClipRect,
} from '../src/viz/client-gl/renderer/scroll-pane.js';

const rect = { x: 100, y: 200, width: 400, height: 300 };
const air = { top: 16, right: 8, bottom: 12, left: 4 };

describe('scroll pane air', () => {
  it('grows into the top only at scroll start and the bottom only at scroll end', () => {
    expect(scrollPaneClipRect(rect, air, 0, 500)).toEqual({ x: 96, y: 184, width: 412, height: 316 });
    expect(scrollPaneClipRect(rect, air, 120, 500)).toEqual({ x: 96, y: 200, width: 412, height: 300 });
    expect(scrollPaneClipRect(rect, air, 500, 500)).toEqual({ x: 96, y: 200, width: 412, height: 312 });
  });

  it('grants both ends when nothing scrolls', () => {
    expect(scrollPaneClipRect(rect, air, 0, 0)).toEqual({ x: 96, y: 184, width: 412, height: 328 });
  });

  it('caps every side at the reach of a shadow and ignores negative air', () => {
    const clip = scrollPaneClipRect(rect, { top: 400, left: -10 }, 0, 0);
    expect(clip.y).toBe(rect.y - SCROLL_PANE_SHADOW_BLEED_PX);
    expect(clip.x).toBe(rect.x);
  });

  it('keeps the historical flush mask when a pane declares no air', () => {
    expect(scrollPaneClipRect(rect, {}, 0, 0)).toEqual(rect);
  });

  it('masks the pane layer with the grown rect', () => {
    const parent = new Container();
    const pane = createScrollPane(parent, { ...rect, scrollY: 0, air });
    pane.extend(1000);
    pane.finish();
    const mask = pane.content.parent?.mask as Graphics;
    expect(mask).toBeInstanceOf(Graphics);
    const bounds = mask.getLocalBounds();
    expect({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
      .toEqual({ x: 96, y: 184, width: 412, height: 300 + 16 });
  });
});


describe('scroll edge shadow fade', () => {
  it('fades symmetrically from the centre to transparent horizontal edges', () => {
    const parent = new Container();
    drawScrollShadows(parent, { x: 10, y: 20, width: 5, height: 40, scrollY: 10, maxScroll: 20 });
    for (const edge of ['top', 'bottom']) {
      const shadow = parent.getChildByLabel(`scroll-shadow-${edge}`) as Sprite;
      const pixels = shadow.texture.source.resource as Uint8Array;
      const width = shadow.texture.width;
      const alpha = (x: number, y = 0) => pixels[(y * width + x) * 4 + 3]!;
      expect(alpha(0)).toBe(0);
      expect(alpha(width - 1)).toBe(0);
      expect(alpha(20)).toBe(alpha(width - 21));
      expect(alpha(48)).toBeGreaterThan(alpha(20));
      expect(alpha(48)).toBeCloseTo(255 * 0.72, 0);
      expect(alpha(48, shadow.texture.height - 1)).toBe(0);
      expect(shadow.eventMode).toBe('none');
      expect(shadow.getBounds().width).toBe(5);
    }
  });

  it('centres the shadow over a tile span without changing the content mask', () => {
    const parent = new Container();
    const pane = createScrollPane(parent, {
      x: 100, y: 20, width: 208, height: 100, scrollY: 0, air: { right: 10 },
      indicator: 'shadows', shadowSpan: { x: 156, width: 60 },
    });
    pane.extend(300);
    pane.finish();
    const shadow = parent.getChildByLabel('scroll-shadow-bottom') as Sprite;
    expect(shadow.x).toBe(256);
    expect(shadow.width).toBe(60);
    expect((pane.content.parent!.mask as Graphics).getLocalBounds().width).toBe(218);
  });
  it('updates retained edges without allocating and keeps the texture alive across scene rebuilds', () => {
    const root = new Container();
    const update = drawScrollShadows(root, { ...rect, maxScroll: 500, scrollY: 0 });
    const [top, bottom] = root.children as Sprite[];
    expect([top!.visible, bottom!.visible]).toEqual([false, true]);
    update(250);
    expect([top!.visible, bottom!.visible]).toEqual([true, true]);
    update(600);
    expect([top!.visible, bottom!.visible]).toEqual([true, false]);
    const texture = top!.texture;
    root.destroy({ children: true, context: true });
    const next = new Container();
    drawScrollShadows(next, { ...rect, maxScroll: 500, scrollY: 0 });
    expect((next.children[0] as Sprite).texture).toBe(texture);
    expect(texture.destroyed).toBe(false);
    const fitting = new Container();
    drawScrollShadows(fitting, { ...rect, maxScroll: 0, scrollY: 0 });
    expect(fitting.children).toHaveLength(0);
  });

});
