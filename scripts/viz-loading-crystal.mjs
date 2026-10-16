#!/usr/bin/env node
/* global window */
/**
 * Render the LOADING CRYSTAL's sprite sheet from the real brand mark.
 *
 * The loading notice shows the original crystal — the same shell shader, the
 * same diamond material, the same pose — without its bead and turning five
 * times faster. A live mark per notice would cost a shell, two refraction
 * textures and a ticker each, and the DOM notices cannot reach the one canvas
 * at all (a modal sits above it). So the crystal is rendered HERE, once, by
 * `attachAtomaMark` itself on a transparent stage, and both surfaces animate
 * the frames: `AtomaLoader` in CSS, `drawLoadingNotice` as a Pixi sprite.
 *
 * The loop is a FULL turn: the silhouette repeats every quarter turn, but the
 * coloured light inside the glass does not (measured 2026-10-16), and a
 * quarter-turn loop jumped hue at its seam. At five times the mark's rate a
 * turn lasts 3 s, so FRAMES = 72 plays at 24 frames a second.
 *
 * Re-run after any change to the crystal's look:
 *
 *   npm run viz:loading-crystal
 *
 * Writes src/viz/public/textures/loading-crystal.webp: FRAMES columns of SIZE
 * px squares (twice the 46px section crystal, for 2x screens), in two rows —
 * the crystal, then its white silhouette for the exit fade.
 * Needs a Chrome; it is development tooling, never part of a check.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Keep in lockstep with LOADING_CRYSTAL_SPRITE in src/viz/client-gl/loading-crystal.ts. */
export const FRAMES = 72;
export const SIZE = 96;
/** One full turn of mark time (ATOMA_MARK_TURN_MS). */
const TURN_MS = 15_000;
const OUT = join(repoRoot, 'src/viz/public/textures/loading-crystal.webp');

const entry = `
import { Application } from 'pixi.js';
import { attachAtomaMark } from './src/viz/client-gl/renderer/atoma-mark.ts';
import { pinMarkElapsedMs, setMarkBeadVisible } from './src/viz/client-gl/renderer/mark-clock.ts';

window.renderSheet = async (frames, size, turnMs) => {
  const app = new Application();
  await app.init({ width: size, height: size, backgroundAlpha: 0, antialias: true, resolution: 1,
    preference: 'webgl', preserveDrawingBuffer: true, autoStart: false });
  setMarkBeadVisible(false);
  pinMarkElapsedMs(0);
  const ticks = [];
  // The mark is authored in a 28-unit box; leave a small margin for the rim.
  const visualScale = size * 0.9 / 28;
  // The mark scales about its local centre (14, 14): the visual centre sits
  // at position + 14 whatever the scale (ATOMA_MARK_LOCAL_CENTER).
  const offset = size / 2 - 14;
  attachAtomaMark(app.stage, (tick) => ticks.push(tick), offset, offset, visualScale, app.renderer);
  const sheet = document.createElement('canvas');
  sheet.width = frames * size;
  // Row 0: the crystal. Row 1: the same pose as a white silhouette, which the
  // notice crossfades to as it leaves (the fade to white, on both surfaces).
  sheet.height = size * 2;
  const context = sheet.getContext('2d');
  const scratch = document.createElement('canvas');
  scratch.width = size;
  scratch.height = size;
  const silhouette = scratch.getContext('2d', { willReadFrequently: true });
  // The attach-time capture of the first pose is never refreshed while that
  // pose holds, so the rest pose is drawn LAST, one full turn on (step =
  // frames), after the refraction pair has followed the turn.
  for (let step = 1; step <= frames; step += 1) {
    const index = step % frames;
    pinMarkElapsedMs(step * turnMs / frames);
    // The shell samples the PREVIOUS backdrop capture (ping-pong): settle the
    // pose over a few paints before reading it back.
    for (let paint = 0; paint < 4; paint += 1) {
      for (const tick of ticks) tick({ deltaMS: 50 });
      app.renderer.render(app.stage);
    }
    context.drawImage(app.canvas, index * size, 0);
    // The white pose follows what is SEEN, not raw coverage: the shell also
    // paints near-black back walls, invisible on the app's dark surfaces, and
    // a coverage silhouette whitened them into a larger, foreign shape.
    silhouette.clearRect(0, 0, size, size);
    silhouette.drawImage(app.canvas, 0, 0);
    const pixels = silhouette.getImageData(0, 0, size, size);
    const data = pixels.data;
    for (let offset = 0; offset < data.length; offset += 4) {
      const light = Math.max(data[offset], data[offset + 1], data[offset + 2]) / 255;
      // Sixteen levels: WebP keeps alpha lossless, and a smooth ramp of it was
      // most of the file. Banding is invisible during a 120 ms fade.
      data[offset + 3] = Math.round(data[offset + 3] * Math.min(1, light * 1.6) / 17) * 17;
      data[offset] = data[offset + 1] = data[offset + 2] = 255;
    }
    silhouette.putImageData(pixels, 0, 0);
    context.drawImage(silhouette.canvas, index * size, size);
  }
  // Lossy WebP with alpha: a fraction of the PNG for 2 x 72 frames, on
  // the first screen a visitor waits on.
  return sheet.toDataURL('image/webp', 0.8);
};
window.sheetReady = true;
`;

const work = await mkdtemp(join(tmpdir(), 'atoma-loading-crystal-'));
try {
  const bundle = await build({
    stdin: { contents: entry, resolveDir: repoRoot, loader: 'ts', sourcefile: 'loading-crystal-entry.ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'warning',
  });
  await writeFile(join(work, 'entry.js'), bundle.outputFiles[0].contents);
  await writeFile(join(work, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="entry.js"></script>');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--ignore-gpu-blocklist', '--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('[page]', error));
    await page.goto(pathToFileURL(join(work, 'index.html')).href);
    await page.waitForFunction('window.sheetReady === true', { timeout: 30_000 });
    const dataUrl = await page.evaluate((frames, size, turnMs) => window.renderSheet(frames, size, turnMs),
      FRAMES, SIZE, TURN_MS);
    await writeFile(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`loading crystal: ${FRAMES} frames of ${SIZE}px → ${OUT}`);
  } finally {
    await browser.close();
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
