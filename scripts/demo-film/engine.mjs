/* global document, window, MutationObserver */
/**
 * The capture engine: a dev stack, one browser page on the virtual clock,
 * the demo world answering the client's API calls, and a small shot
 * vocabulary (hold, move, click, type, fast-forward, mark) that records
 * frames plus the metadata the compositor needs to zoom and annotate.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { installVirtualClock } from './virtual-clock.mjs';

export const VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 2 };
export const FPS = 30;
const SUBSTEPS = 2; // 60 Hz animation time under a 30 fps film
const READY_TIMEOUT_MS = 90_000;

async function freePorts(count) {
  const servers = await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  })));
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

export async function spawnDevStack() {
  const [devPort, apiPort] = await freePorts(2);
  const script = fileURLToPath(new URL('../viz-dev.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ATOMA_VIZ_DEV_PORT: String(devPort),
      ATOMA_VIZ_API_PORT: String(apiPort),
      ATOMA_VIZ_SENTINEL: '0',
    },
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const url = `http://127.0.0.1:${devPort}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      // Vite is still starting.
    }
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error('dev stack never answered on its UI port');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { url, stop: () => child.kill('SIGTERM') };
}

/** Mirror of the page clock, so the world answers in the page's own time. */
export function createClockMirror() {
  const mirror = { virtual: Date.now(), real: Date.now(), manual: false };
  mirror.now = () => (mirror.manual ? mirror.virtual : mirror.virtual + (Date.now() - mirror.real));
  return mirror;
}

export async function openPage({ url, world, mirror, debug = false }) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on('pageerror', (error) => console.error(`pageerror: ${error.message}`));
  if (debug) {
    page.on('console', (message) => console.error(`[console:${message.type()}] ${message.text().slice(0, 300)}`));
    page.on('response', (response) => {
      if (response.status() >= 400) console.error(`[http ${response.status()}] ${response.url().slice(0, 160)}`);
    });
  }
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    // Never throw here: an intercepted request left unanswered hangs forever.
    try {
      const target = new URL(request.url());
      if (target.pathname.startsWith('/api/') || target.pathname.startsWith('/auth/')) {
        const answer = world.respond(request.method(), target.pathname, target.searchParams);
        if (answer !== undefined) {
          void request.respond({
            status: 200,
            contentType: 'application/json',
            headers: { 'cache-control': 'no-store' },
            body: JSON.stringify(answer),
          });
          return;
        }
        if (debug) console.error(`[unstubbed] ${request.method()} ${target.pathname}`);
      }
    } catch (error) {
      console.error(`stub failed: ${error.message}`);
    }
    void request.continue().catch(() => {});
  });
  await page.evaluateOnNewDocument(installVirtualClock);
  await page.evaluateOnNewDocument(() => {
    // A film has no business showing the spell checker's squiggles.
    new MutationObserver(() => {
      for (const field of document.querySelectorAll('textarea, input')) field.spellcheck = false;
    }).observe(document, { childList: true, subtree: true });
    try {
      localStorage.removeItem('atoma.viz.entered');
    } catch {
      // Storage is optional.
    }
  });
  await page.goto(`${url}/?atomaDiag=1`, { waitUntil: 'load' });
  await page.waitForSelector('.gpu-ui-host[data-gpu-backend]', { timeout: READY_TIMEOUT_MS });
  await syncMirror(page, mirror);
  return { browser, page };
}

export async function syncMirror(page, mirror) {
  const state = await page.evaluate(() => ({ now: Date.now(), manual: window.__demoClock.isManual() }));
  mirror.virtual = state.now;
  mirror.real = Date.now();
  mirror.manual = state.manual;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a page predicate from Node: page-side `waitForFunction` would ride the virtual clock. */
export async function waitFor(page, predicate, arg, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await page.evaluate(predicate, arg).catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${predicate.toString().slice(0, 120)}`);
    await sleep(100);
  }
}

/** Page-space rect of a canvas hit target (first whose id starts with `prefix`). */
export async function hitRect(page, prefix) {
  return page.evaluate((key) => {
    const handle = globalThis.__ATOMA_GPU__;
    const row = handle?.hitTargets().find((entry) => entry.id === key || entry.id.startsWith(key));
    if (!row) return null;
    const a = handle.projectRendererPoint(row.x, row.y);
    const b = handle.projectRendererPoint(row.x + row.width, row.y + row.height);
    return { id: row.id, x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  }, prefix);
}

export async function domRect(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }, selector);
}

export async function hitIds(page) {
  return page.evaluate(() => globalThis.__ATOMA_GPU__?.hitTargets().map((entry) => entry.id) ?? []);
}

const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

/**
 * A recording session. Frames are written as `<dir>/<shot>/<nnnn>.jpg`; the
 * manifest (`film.json`) lists every shot with its frame count, the marks
 * taken during it and the clicks it made, all in 1920x1080 page space.
 */
export class Recorder {
  constructor({ page, mirror, outDir, quality = 92 }) {
    this.page = page;
    this.mirror = mirror;
    this.outDir = outDir;
    this.quality = quality;
    this.shots = [];
    this.current = null;
    this.cursor = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  }

  async setManual(on) {
    await this.page.evaluate((value) => window.__demoClock.setManual(value), on);
    await syncMirror(this.page, this.mirror);
  }

  async begin(name) {
    const dir = path.join(this.outDir, name);
    await mkdir(dir, { recursive: true });
    this.current = { name, frames: 0, marks: {}, clicks: [], cues: {} };
    this.shots.push(this.current);
    await this.setManual(true);
  }

  async end() {
    await this.setManual(false);
    this.current = null;
    await this.save();
  }

  async save() {
    await writeFile(path.join(this.outDir, 'film.json'), JSON.stringify({ fps: FPS, viewport: VIEWPORT, shots: this.shots }, null, 2));
  }

  /** Advance one film frame of virtual time, then capture it. */
  async frame() {
    const now = await this.page.evaluate(async (substeps, dt) => {
      for (let i = 0; i < substeps; i++) await window.__demoClock.advance(dt);
      return Date.now();
    }, SUBSTEPS, 1000 / FPS / SUBSTEPS);
    this.mirror.virtual = now;
    this.mirror.real = Date.now();
    const shot = this.current;
    const file = path.join(this.outDir, shot.name, `${String(shot.frames).padStart(4, '0')}.jpg`);
    await this.page.screenshot({ path: file, type: 'jpeg', quality: this.quality });
    shot.frames += 1;
  }

  /** Name the current frame so the compositor can time an effect on it. */
  cue(name) {
    this.current.cues[name] = this.current.frames;
  }

  async hold(seconds) {
    const count = Math.round(seconds * FPS);
    for (let i = 0; i < count; i++) await this.frame();
  }

  /** Advance virtual time WITHOUT capturing (time passes off camera). */
  async fastForward(seconds, { chunkMs = 500, stepMs = 50 } = {}) {
    let remaining = seconds * 1000;
    while (remaining > 0) {
      const chunk = Math.min(remaining, chunkMs);
      const now = await this.page.evaluate(async (total, dt) => {
        for (let done = 0; done < total; done += dt) {
          await window.__demoClock.advance(Math.min(dt, total - done));
          await window.__demoClock.yieldReal();
        }
        return Date.now();
      }, chunk, stepMs);
      this.mirror.virtual = now;
      this.mirror.real = Date.now();
      remaining -= chunk;
      // Let the polls those timers issued be answered at the new time.
      await sleep(30);
    }
    await sleep(300);
    for (let i = 0; i < 3; i++) await this.page.evaluate(() => window.__demoClock.advance(16));
  }

  /** Time passes off camera: the shot keeps its frames, the world moves on. */
  async offCamera(seconds) {
    await this.fastForward(seconds);
  }

  /** Move the pointer to a point over `seconds`, one eased step per frame. */
  async moveTo(point, seconds = 0.8) {
    const from = { ...this.cursor };
    const count = Math.max(1, Math.round(seconds * FPS));
    for (let i = 1; i <= count; i++) {
      const u = ease(i / count);
      const x = from.x + (point.x - from.x) * u;
      const y = from.y + (point.y - from.y) * u;
      await this.page.mouse.move(x, y);
      this.cursor = { x, y };
      await this.frame();
    }
  }

  /** Scroll whatever is under the pointer by deltaY CSS px over `seconds`. */
  async scroll(deltaY, seconds = 2) {
    const count = Math.max(1, Math.round(seconds * FPS));
    for (let i = 0; i < count; i++) {
      await this.page.mouse.wheel({ deltaY: deltaY / count });
      await this.frame();
    }
  }

  async click({ hold = 0.35 } = {}) {
    this.current.clicks.push({ frame: this.current.frames, x: this.cursor.x, y: this.cursor.y });
    await this.page.mouse.down();
    await this.frame();
    await this.page.mouse.up();
    await this.hold(hold);
  }

  async clickAt(point, { move = 0.8, hold = 0.35 } = {}) {
    await this.moveTo(point, move);
    await this.click({ hold });
  }

  /** Type `text` into the focused field at `cps` characters per second. */
  async type(text, cps = 40) {
    const perFrame = cps / FPS;
    let budget = 0;
    for (let i = 0; i < text.length;) {
      budget += perFrame;
      const take = Math.max(0, Math.floor(budget));
      budget -= take;
      if (take > 0) {
        const chunk = text.slice(i, i + take);
        for (const char of chunk) {
          if (char === '\n') await this.page.keyboard.press('Enter');
          else await this.page.keyboard.sendCharacter(char);
        }
        i += take;
      }
      await this.frame();
    }
  }

  mark(name, rect) {
    if (!rect) throw new Error(`mark ${name}: no rect`);
    this.current.marks[name] = { ...rect, frame: this.current.frames };
  }
}

export const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
