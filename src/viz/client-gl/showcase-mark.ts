// CSP: the showcase pages allow no 'unsafe-eval'; Pixi's default uniform and
// shader sync compiles code with `new Function`. This module swaps in the
// eval-free implementations and must be imported before anything renders.
import 'pixi.js/unsafe-eval';
import { Application, Container } from 'pixi.js';
import { ATOMA_MARK_LOCAL_CENTER, attachAtomaMark } from './renderer/atoma-mark.js';

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
 * Built on its own (`vite.showcase.config.ts`) rather than as a second input
 * of the app build: sharing the crystal module between two entries would move
 * it out of the lazy renderer chunk that `scripts/viz-build.mjs` guards.
 */

/** Crystal size as a fraction of its host's shorter side. */
const FILL = 0.92;

async function mount(host: HTMLElement): Promise<void> {
  const width = Math.max(1, Math.round(host.clientWidth));
  const height = Math.max(1, Math.round(host.clientHeight));
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
  const root = new Container();
  app.stage.addChild(root);
  const scale = (Math.min(width, height) * FILL) / (ATOMA_MARK_LOCAL_CENTER * 2);
  const bobbing = host.dataset['atomaMark'] === 'hero';
  attachAtomaMark(
    root,
    (callback) => app.ticker.add(callback),
    width / 2 - ATOMA_MARK_LOCAL_CENTER,
    height / 2 - ATOMA_MARK_LOCAL_CENTER,
    scale,
    app.renderer,
    bobbing ? { bobPx: Math.round(height * 0.025), bobPeriodMs: 1800 } : undefined
  );
  const canvas = app.canvas;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.classList.add('mark-canvas');
  host.appendChild(canvas);
  host.classList.add('mark-live');
}

for (const host of document.querySelectorAll<HTMLElement>('[data-atoma-mark]')) {
  mount(host).catch(() => {
    // No WebGL, a lost context, a blocked shader: the static crystal stays.
  });
}
