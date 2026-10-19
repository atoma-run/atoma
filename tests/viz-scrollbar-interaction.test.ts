import 'pixi.js/events';
import { Container, EventBoundary, Rectangle, FederatedPointerEvent } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import { createScrollPane, drawScrollbarThumb } from '../src/viz/client-gl/renderer/scroll-pane.js';
import { ScrollbarInteraction } from '../src/viz/client-gl/renderer/scrollbar-interaction.js';

function fixture() {
  const root = new Container();
  const pane = createScrollPane(root, { x: 20, y: 30, width: 200, height: 200, scrollY: 0, air: {} });
  pane.extend(588); // 600px content, 400px scroll, 200/3px thumb.
  pane.finish();
  const bar = root.children.find(child => child.label === 'scrollbar-thumb')!;
  const events = new EventTarget();
  const scroll = vi.fn();
  const interaction = new ScrollbarInteraction(root, events, (x, y) => ({ x: x / 2, y: y / 2 }), scroll);
  function down(y: number, extra = {}) {
    const boundary = new EventBoundary(root);
    const event = new FederatedPointerEvent(boundary);
    event.target = bar;
    event.client.set(426, y * 2);
    Object.assign(event, { button: 0, pointerType: 'mouse', pointerId: 1, ...extra });
    boundary.dispatchEvent(event, 'pointerdown');
  }
  function pointer(type: string, y: number, extra = {}) {
    events.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, buttons: 1, clientX: 900, clientY: y * 2, ...extra }));
  }
  return { root, bar, events, scroll, interaction, down, pointer };
}

describe('shared scrollbar interaction', () => {
  it('exposes a wider hit area on every shared scrollbar', () => {
    const f = fixture();
    expect(f.bar.eventMode).toBe('static');
    expect(f.bar.hitArea).toEqual(new Rectangle(-6, 0, 14, 200));
    f.interaction.destroy();
  });

  it('clicks the track, then drags beyond the pane through camera coordinates', () => {
    const f = fixture();
    f.down(130); // Centre the thumb halfway down the track.
    expect(f.scroll).toHaveBeenLastCalledWith(426, 260, 200);
    f.pointer('pointermove', 800);
    expect(f.scroll).toHaveBeenLastCalledWith(426, 260, 200);
    f.pointer('pointermove', -100);
    expect(f.scroll).toHaveBeenLastCalledWith(426, 260, -400);
    f.interaction.destroy();
  });

  it('preserves the grab point and keeps dragging after a scene rebuild', () => {
    const f = fixture();
    f.down(40);
    expect(f.scroll).not.toHaveBeenCalled();
    f.root.removeChildren().forEach(child => child.destroy({ children: true }));
    f.pointer('pointermove', 80);
    expect(f.scroll.mock.lastCall?.slice(0, 2)).toEqual([426, 80]);
    expect(f.scroll.mock.lastCall?.[2]).toBeCloseTo(120);
    f.interaction.destroy();
  });

  it.each(['pointerup', 'pointercancel', 'blur', 'lost-buttons', 'destroy'])('ends the drag on %s', reason => {
    const f = fixture();
    f.down(40);
    if (reason === 'destroy') f.interaction.destroy();
    else if (reason === 'blur') f.events.dispatchEvent(new Event('blur'));
    else if (reason === 'lost-buttons') f.pointer('pointermove', 80, { buttons: 0 });
    else f.pointer(reason, 40);
    f.pointer('pointermove', 80);
    expect(f.scroll).not.toHaveBeenCalled();
    f.interaction.destroy();
  });

  it('leaves touch panning, other pointers and secondary clicks alone', () => {
    const f = fixture();
    f.down(130, { pointerType: 'touch' });
    f.down(130, { button: 2 });
    expect(f.scroll).not.toHaveBeenCalled();
    f.down(40);
    f.pointer('pointermove', 80, { pointerId: 2 });
    expect(f.scroll).not.toHaveBeenCalled();
    f.interaction.destroy();
  });

  it('omits non-overflowing scrollbars', () => {
    const root = new Container();
    drawScrollbarThumb(root, { x: 0, y: 0, width: 100, height: 100, maxScroll: 0, scrollY: 0 });
    expect(root.children).toHaveLength(0);
  });
});
