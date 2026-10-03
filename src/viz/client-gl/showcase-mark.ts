// CSP: the showcase pages allow no 'unsafe-eval'; Pixi's default uniform and
// shader sync compiles code with `new Function`. This module swaps in the
// eval-free implementations and must be imported before anything renders.
import 'pixi.js/unsafe-eval';
import { Application, Container, type Ticker } from 'pixi.js';
import {
  readMarkFieldCaustic,
  readMarkFieldLight,
  writeMarkFieldCaustic,
  writeMarkFieldLight,
} from './mark-field-light.js';
import { hidePointerLight, movePointerLight, trackPointer } from './pointer-light.js';
import { ATOMA_MARK_LOCAL_CENTER, attachAtomaMark, type AtomaMarkHandle } from './renderer/atoma-mark.js';
import { createFarField } from './renderer/far-field.js';
import { prefersReducedMotion } from './renderer/motion.js';

/**
 * THE REAL CRYSTAL ON THE PUBLIC SHOWCASE PAGES.
 * ==============================================
 *
 * The same Pixi crystal as the arrival gate and the rail (`attachAtomaMark`),
 * mounted into every `[data-atoma-mark]` host the server-rendered showcase
 * draws. Each host already holds a static SVG crystal, so a browser without
 * WebGL, without JavaScript, or failing here keeps a crystal on screen: the
 * canvas only replaces the fallback once it rendered.
 *
 * ONE crystal per page is LIT (`data-atoma-receiver` names the section it
 * lights): it is drawn into a canvas covering that section, BEHIND the page's
 * content, over the app's own receiver (`createFarField`, scenery off) — so its
 * bead light and, when the pointer meets the glass, its CAUSTICS fall on the
 * background the way they fall on the arrival gate's far field. Opaque cards
 * occlude them, as filled controls do in the app.
 *
 * The field light is page-global state (`mark-field-light.ts`), and a crystal
 * with nothing to cast CLEARS it every frame. So every other crystal runs its
 * frame between a snapshot and a restore of that state: it still turns and
 * still catches the pointer on its glass, but it cannot erase the lit one's cast.
 *
 * Built on its own (`vite.showcase.config.ts`) rather than as a second input
 * of the app build: sharing the crystal module between two entries would move
 * it out of the lazy renderer chunk that `scripts/viz-build.mjs` guards.
 */

/** Crystal size as a fraction of its host's shorter side. */
const FILL = 0.92;

type AddTicker = (callback: (ticker: Ticker) => void) => void;

/** A crystal that must leave the page's field light exactly as it found it. */
function sideEffectFree(add: AddTicker): AddTicker {
  return (callback) =>
    add((ticker) => {
      const light = readMarkFieldLight().map((spill) => ({ ...spill }));
      const cast = readMarkFieldCaustic();
      try {
        callback(ticker);
      } finally {
        writeMarkFieldLight(light);
        writeMarkFieldCaustic(cast);
      }
    });
}

async function application(width: number, height: number): Promise<Application> {
  const app = new Application();
  await app.init({
    width,
    height,
    preference: ['webgl'],
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    backgroundAlpha: 0,
  });
  app.canvas.setAttribute('aria-hidden', 'true');
  app.canvas.classList.add('mark-canvas');
  return app;
}

const bobFor = (host: HTMLElement, size: number) =>
  host.dataset['atomaMark'] === 'hero' ? { bobPx: Math.round(size * 0.025), bobPeriodMs: 1800 } : undefined;

/** A crystal in its own canvas, inside its host. */
async function mountPlain(host: HTMLElement): Promise<void> {
  const width = Math.max(1, Math.round(host.clientWidth));
  const height = Math.max(1, Math.round(host.clientHeight));
  const app = await application(width, height);
  const root = new Container();
  app.stage.addChild(root);
  attachAtomaMark(
    root,
    sideEffectFree((callback) => app.ticker.add(callback)),
    width / 2 - ATOMA_MARK_LOCAL_CENTER,
    height / 2 - ATOMA_MARK_LOCAL_CENTER,
    (Math.min(width, height) * FILL) / (ATOMA_MARK_LOCAL_CENTER * 2),
    app.renderer,
    bobFor(host, height)
  );
  host.appendChild(app.canvas);
  host.classList.add('mark-live');
}

/** The lit crystal: one canvas over the whole receiver section, crystal placed at its host. */
async function mountLit(host: HTMLElement, receiver: HTMLElement): Promise<void> {
  const size = () => ({
    width: Math.max(1, Math.round(receiver.clientWidth)),
    height: Math.max(1, Math.round(receiver.clientHeight)),
  });
  const placement = () => {
    const area = receiver.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    return {
      x: box.left - area.left + box.width / 2 - ATOMA_MARK_LOCAL_CENTER,
      y: box.top - area.top + box.height / 2 - ATOMA_MARK_LOCAL_CENTER,
      scale: (Math.min(box.width, box.height) * FILL) / (ATOMA_MARK_LOCAL_CENTER * 2),
      height: box.height,
    };
  };
  const initial = size();
  const app = await application(initial.width, initial.height);
  const field = createFarField();
  if (field) app.stage.addChild(field.mesh);
  const root = new Container();
  app.stage.addChild(root);
  const at = placement();
  const mark: AtomaMarkHandle = attachAtomaMark(
    root,
    (callback) => app.ticker.add(callback),
    at.x,
    at.y,
    at.scale,
    app.renderer,
    bobFor(host, at.height)
  );
  // AFTER the crystal's own paint callback, so the receiver reads this frame's cast.
  if (field) {
    app.ticker.add((ticker) => {
      const bounds = app.canvas.getBoundingClientRect();
      field.tick(ticker.deltaMS / 1000, app.renderer.screen.width, app.renderer.screen.height,
        { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }, undefined, false);
    });
  }
  receiver.prepend(app.canvas);
  receiver.classList.add('mark-receiver-live');
  host.classList.add('mark-live');
  new ResizeObserver(() => {
    const next = size();
    app.renderer.resize(next.width, next.height);
    const moved = placement();
    mark.setPlacement(moved.x, moved.y, moved.scale);
  }).observe(receiver);
}

// The app feeds the crystal's pointer light from its canvas; here the page is
// the surface. Reduced motion still tracks (the glass answers) without the lamp.
window.addEventListener('pointermove', (event) => {
  if (prefersReducedMotion()) trackPointer(event.clientX, event.clientY);
  else movePointerLight(event.clientX, event.clientY);
}, { passive: true });
document.documentElement.addEventListener('pointerleave', () => hidePointerLight());
window.addEventListener('blur', () => hidePointerLight());

const hosts = [...document.querySelectorAll<HTMLElement>('[data-atoma-mark]')];
const lit = hosts.find((host) => host.closest('[data-atoma-receiver]'));
for (const host of hosts) {
  const receiver = host === lit ? host.closest<HTMLElement>('[data-atoma-receiver]') : null;
  (receiver ? mountLit(host, receiver) : mountPlain(host)).catch(() => {
    // No WebGL, a lost context, a blocked shader: the static crystal stays.
  });
}
