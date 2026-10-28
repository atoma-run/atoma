import { describe, expect, it } from 'vitest';
import { scrollEdges } from '../src/viz/client-gl/scroll-shadows.js';

const viewport = { clientHeight: 100, scrollHeight: 300, scrollTop: 0,
  clientWidth: 100, scrollWidth: 300, scrollLeft: 0 };

describe('native scroll edge visibility', () => {
  it('advertises only content beyond each visible edge', () => {
    expect(scrollEdges(viewport)).toEqual({ top: false, bottom: true, left: false, right: true });
    expect(scrollEdges({ ...viewport, scrollTop: 100, scrollLeft: 100 }))
      .toEqual({ top: true, bottom: true, left: true, right: true });
    expect(scrollEdges({ ...viewport, scrollTop: 200, scrollLeft: 200 }))
      .toEqual({ top: true, bottom: false, left: true, right: false });
  });
  it('hides every cue for fitting, hidden or subpixel overflow', () => {
    const none = { top: false, bottom: false, left: false, right: false };
    expect(scrollEdges({ ...viewport, scrollHeight: 100.5, scrollWidth: 100.5 })).toEqual(none);
    expect(scrollEdges({ ...viewport, clientHeight: 0, clientWidth: 0 })).toEqual(none);
  });
  it('clamps elastic overscroll and tolerates fractional endpoints', () => {
    expect(scrollEdges({ ...viewport, scrollTop: -20, scrollLeft: -20 })).toEqual(scrollEdges(viewport));
    expect(scrollEdges({ ...viewport, scrollTop: 500, scrollLeft: 500 }))
      .toEqual({ top: true, bottom: false, left: true, right: false });
    expect(scrollEdges({ ...viewport, scrollTop: 199.8, scrollLeft: 199.8 }))
      .toEqual({ top: true, bottom: false, left: true, right: false });
  });
  it('maps negative RTL offsets to physical left and right edges', () => {
    expect(scrollEdges(viewport, true)).toEqual({ top: false, bottom: true, left: true, right: false });
    expect(scrollEdges({ ...viewport, scrollLeft: -200 }, true))
      .toEqual({ top: false, bottom: true, left: false, right: true });
  });
});
