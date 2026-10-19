import { Container, type Matrix, type FederatedPointerEvent } from 'pixi.js';
import { scrollbarGeometry, scrollbarOptions } from './scroll-pane.js';

/** Routes every shared scrollbar through the same pane router as the wheel.
 * Drag state holds geometry, never display objects: scrolling can rebuild and
 * destroy the entire view before the pointer moves again.
 */
export class ScrollbarInteraction {
  private readonly previousEventMode: Container['eventMode'];

  private drag: {
    id: number;
    x: number;
    y: number;
    inverse: Matrix;
    top: number;
    grab: number;
    travel: number;
    max: number;
    current: number;
  } | null = null;

  constructor(
    private readonly root: Container,
    private readonly events: EventTarget,
    private readonly toScene: (x: number, y: number) => { x: number; y: number },
    private readonly scroll: (x: number, y: number, delta: number) => void
  ) {
    // Pixi skips passive ancestors when delivering bubbled events.
    this.previousEventMode = root.eventMode;
    root.eventMode = 'static';
    root.on('pointerdown', this.start);
    events.addEventListener('pointermove', this.move);
    events.addEventListener('pointerup', this.end);
    events.addEventListener('pointercancel', this.end);
    events.addEventListener('blur', this.blur);
  }

  private readonly start = (event: FederatedPointerEvent) => {
    // Touch already has native pan arbitration and the shared touch router.
    if (event.pointerType === 'touch' || event.button !== 0) return;
    const target = event.target;
    const options = scrollbarOptions.get(target);
    if (!options || !target.parent) return;
    const { maxScroll, scrollY, y } = options;
    const { thumbHeight: thumb, travel, thumbY: top } = scrollbarGeometry(options);
    if (travel <= 0) return;
    event.stopPropagation();
    const inverse = target.parent.getGlobalTransform().invert();
    const local = inverse.apply(this.toScene(event.clientX, event.clientY));
    this.drag = {
      id: event.pointerId, x: event.clientX, y: event.clientY, inverse,
      top: y, grab: local.y >= top && local.y <= top + thumb ? local.y - top : thumb / 2,
      travel, max: maxScroll, current: Math.max(0, Math.min(maxScroll, scrollY)),
    };
    this.seek(event.clientX, event.clientY);
  };

  private seek(x: number, y: number) {
    const drag = this.drag;
    if (!drag) return;
    const local = drag.inverse.apply(this.toScene(x, y));
    const next = Math.max(0, Math.min(drag.max,
      (local.y - drag.top - drag.grab) / drag.travel * drag.max));
    const delta = next - drag.current;
    drag.current = next;
    if (delta !== 0) this.scroll(drag.x, drag.y, delta);
  }

  private readonly move = (event: Event) => {
    const pointer = event as PointerEvent;
    if (!this.drag || pointer.pointerId !== this.drag.id) return;
    if (pointer.buttons === 0) { this.drag = null; return; }
    this.seek(pointer.clientX, pointer.clientY);
  };

  private readonly end = (event: Event) => {
    if ((event as PointerEvent).pointerId === this.drag?.id) this.drag = null;
  };

  private readonly blur = () => { this.drag = null; };

  destroy() {
    this.drag = null;
    this.root.off('pointerdown', this.start);
    this.root.eventMode = this.previousEventMode;
    this.events.removeEventListener('pointermove', this.move);
    this.events.removeEventListener('pointerup', this.end);
    this.events.removeEventListener('pointercancel', this.end);
    this.events.removeEventListener('blur', this.blur);
  }
}
