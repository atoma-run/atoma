import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  createScrollPane,
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
