/* global document, HTMLButtonElement */
/**
 * `node --import tsx scripts/demo-film/film.mjs [--out dir] [--only a,b]`
 *
 * Shoots the demo film's source frames: the real GPU client, driven through
 * one continuous session on the demo world, filmed on the virtual clock.
 * Each scene writes `<out>/<scene>/<nnnn>.jpg` (3840x2160) and `film.json`
 * records the marks and clicks the compositor zooms and annotates with.
 *
 * Scenes run in order and each leaves the page where the next one starts;
 * `--only` records just the named scenes but still PLAYS the others (off
 * camera, in real time) so the state each one starts from is the same.
 */
import path from 'node:path';
import { Recorder, center, createClockMirror, domRect, hitIds, hitRect, openPage, sleep, spawnDevStack } from './engine.mjs';
import { FLAGS_CRITERIA, FLAGS_GOAL, createWorld, uuidOf } from './world.mjs';

const flagsEvent = (name) => `event.${uuidOf(`flags:${name}`)}`;

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const outDir = path.resolve(arg('--out', 'screenshots/demo-film/frames'));
const only = arg('--only', '')?.split(',').filter(Boolean) ?? [];
const previewUrl = arg('--preview-url', 'about:blank');

const mirror = createClockMirror();
const world = createWorld({ now: Date.now() });
Object.defineProperty(world, 'now', { get: () => mirror.now() });
world.previewUrl = previewUrl;

const stack = await spawnDevStack();
const { browser, page } = await openPage({ url: stack.url, world, mirror, debug: process.env.DEMO_DEBUG === '1' });
const film = new Recorder({ page, mirror, outDir });

/** Scene helper: record when selected, otherwise play the same steps unfilmed. */
function scene(name, body) {
  return { name, body };
}

async function target(prefix) {
  const found = await hitRect(page, prefix);
  if (!found) throw new Error(`no hit target ${prefix}; have ${(await hitIds(page)).join(' ')}`);
  return found;
}
async function dom(selector) {
  const found = await domRect(page, selector);
  if (!found) throw new Error(`no element ${selector}`);
  return found;
}
async function buttonRect(text) {
  const found = await page.evaluate((label) => {
    const node = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === label);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }, text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}
const union = (...rects) => {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
};

const scenes = [
  scene('arrival', async (f) => {
    await page.mouse.move(1480, 860);
    f.cursor = { x: 1480, y: 860 };
    // Long enough for the two opening lines of narration over the live crystal.
    await f.hold(13.5);
    const cont = await target('welcome.continue');
    f.mark('continue', cont);
    await f.moveTo(center(cont), 1.1);
    await f.click({ hold: 0.1 });
    f.cue('entered');
    await f.hold(3.2);
  }),

  scene('projects', async (f) => {
    const rows = await Promise.all(['p-flags', 'p-sales', 'p-estimator', 'p-shipments'].map((id) => target(`project.select.${id}`)));
    f.mark('projectList', union(...rows));
    f.mark('createForm', union(await dom('select[aria-label="Starting point"]'), await dom('.gpu-project-name'), await buttonRect('Create project')));
    for (const row of rows) await f.moveTo({ x: row.x + row.width * 0.35, y: row.y + row.height / 2 }, 0.45);
    await f.hold(0.4);
    // Show the second starting point: an existing GitHub repository.
    const starting = await dom('select[aria-label="Starting point"]');
    await f.moveTo(center(starting), 0.8);
    await f.click({ hold: 0.2 });
    await page.select('select[aria-label="Starting point"]', 'pull-request');
    f.cue('importMode');
    await f.hold(0.6);
    const source = await dom('input[aria-label="Source GitHub repository"]');
    f.mark('sourceField', source);
    await f.moveTo(center(source), 0.6);
    await f.click({ hold: 0.1 });
    await f.type('https://github.com/analytical-engines/logistics-core', 45);
    f.mark('createFormImport', union(await dom('select[aria-label="Starting point"]'), source));
    await f.hold(1.4);
    f.cue('resetMode');
    await page.select('select[aria-label="Starting point"]', 'new');
    const flags = await target('project.select.p-flags');
    await f.moveTo(center(flags), 0.9);
    await f.click({ hold: 0.1 });
    await f.hold(1.4);
  }),

  scene('compose', async (f) => {
    const goal = await dom('.gpu-project-prompt');
    const criteria = await dom('.gpu-project-criteria');
    f.mark('goal', goal);
    f.mark('criteria', criteria);
    f.mark('form', union(goal, criteria));
    await f.moveTo({ x: goal.x + 90, y: goal.y + 30 }, 0.8);
    await f.click({ hold: 0.15 });
    f.cue('typeGoal');
    await f.type(FLAGS_GOAL, 120);
    f.cue('goalTyped');
    await f.hold(0.5);
    await f.moveTo({ x: criteria.x + 80, y: criteria.y + 28 }, 0.7);
    await f.click({ hold: 0.15 });
    f.cue('typeCriteria');
    await f.type(FLAGS_CRITERIA, 75);
    f.cue('criteriaTyped');
    f.mark('criteriaFilled', await dom('.gpu-project-criteria'));
    await f.hold(1.6);
    const start = await buttonRect('Start run on Feature flags service');
    f.mark('start', start);
    await f.moveTo(center(start), 0.9);
    await f.click({ hold: 0.1 });
    f.cue('started');
    await f.hold(1.6);
    f.mark('runRow', await target('project.run.r-flags-1'));
    await f.hold(0.6);
  }),

  // Off camera: the run works for 44 seconds while the Projects view waits.
  scene('live', async (f) => {
    await f.offCamera(44);
    const row = await target('project.run.r-flags-1');
    await f.moveTo(center(row), 0.8);
    await f.click({ hold: 0.1 });
    f.cue('opened');
    await f.hold(1.8);
    f.mark('timeline', await timelineRect());
    await f.hold(6.5);
    f.mark('timelineLate', await timelineRect());
  }),

  scene('delivered', async (f) => {
    await f.offCamera(100);
    await f.hold(1.2);
    f.mark('endCard', await target(flagsEvent('acceptance-1')));
    const acceptance = await target(flagsEvent('acceptance-1'));
    f.mark('acceptanceCard', acceptance);
    await f.hold(1.4);
    await f.moveTo(center(acceptance), 1.0);
    await f.click({ hold: 0.1 });
    f.cue('acceptanceOpen');
    f.mark('detailPane', { x: 1372, y: 300, width: 530, height: 770 });
    await f.hold(2.2);
    await f.moveTo({ x: 1640, y: 760 }, 0.6);
    f.cue('scrollChecklist');
    await f.scroll(1500, 3.2);
    f.cue('checklistShown');
    f.mark('detailPaneLate', { x: 1372, y: 20, width: 530, height: 1050 });
    await f.hold(2.4);
  }),

  scene('llm', async (f) => {
    const chip = await target('run.filter.kind.llm');
    f.mark('llmChip', chip);
    await f.moveTo(center(chip), 1.0);
    await f.click({ hold: 0.1 });
    f.cue('filtered');
    await f.hold(2.2);
    f.mark('timelineLlm', await timelineRect());
    const execute = await executeCard();
    f.mark('executeCard', execute);
    await f.moveTo(center(execute), 0.9);
    await f.click({ hold: 0.1 });
    f.cue('executeOpen');
    f.mark('detailPane', { x: 1372, y: 300, width: 530, height: 770 });
    await f.hold(2.6);
    await f.moveTo({ x: 1640, y: 760 }, 0.6);
    f.cue('scrollDetail');
    await f.scroll(700, 2.2);
    await f.hold(2.0);
  }),

  scene('published', async (f) => {
    await page.keyboard.press('Escape');
    await f.hold(0.6);
    const nav = await target('nav.projects');
    await f.moveTo(center(nav), 1.0);
    await f.click({ hold: 1.2 });
    const row = await target('project.run.r-flags-1');
    f.mark('publishedRow', { ...row, width: 1920 - row.x - 40, height: row.height + 36 });
    await f.hold(3.2);
  }),

  scene('partial', async (f) => {
    for (const field of ['.gpu-project-prompt', '.gpu-project-criteria']) {
      await page.click(field);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
    }
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(f.cursor.x, f.cursor.y);
    const nav = await target('nav.projects');
    await f.moveTo(center(nav), 0.6);
    await f.click({ hold: 0.9 });
    if (!(await hitRect(page, 'project.select.p-sales'))) await f.click({ hold: 0.9 });
    const sales = await target('project.select.p-sales');
    await f.moveTo(center(sales), 0.8);
    await f.click({ hold: 1.3 });
    const row = await target('project.run.r-sales-3');
    f.mark('partialRow', { ...row, width: 1920 - row.x - 40, height: row.height + 40 });
    await f.hold(1.6);
    await f.moveTo(center(row), 0.8);
    await f.click({ hold: 0.1 });
    f.cue('runOpen');
    await f.hold(2.4);
    const cont = await target('run.partial.continue.p-sales');
    f.mark('continue', cont);
    await f.hold(2.4);
    await f.moveTo(center(cont), 0.9);
    await f.click({ hold: 0.1 });
    f.cue('continued');
    await f.hold(2.6);
    f.mark('prefilled', await dom('.gpu-project-prompt'));
  }),

  scene('settings', async (f) => {
    const orb = await target('account.menu.toggle');
    await f.moveTo(center(orb), 1.0);
    await f.click({ hold: 0.6 });
    const item = await buttonRect('Settings');
    await f.moveTo(center(item), 0.6);
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.gpu-a11y-bridge button')].find((el) => el.textContent?.trim() === 'Settings');
      if (button instanceof HTMLButtonElement) button.click();
    });
    await f.hold(1.4);
    const models = await buttonRect('LLM models');
    await f.moveTo(center(models), 0.8);
    await f.click({ hold: 0.1 });
    f.cue('models');
    await f.hold(1.0);
    f.mark('modelsForm', await dom('.gpu-org-models-form'));
    await f.hold(3.2);
    const mcp = await buttonRect('Atoma MCP');
    await f.moveTo(center(mcp), 0.8);
    await f.click({ hold: 0.1 });
    f.cue('mcp');
    await f.hold(1.0);
    f.mark('mcpPanel', await dom('.gpu-org-models-form').catch(() => ({ x: 640, y: 150, width: 800, height: 500 })));
    await f.hold(2.6);
  }),

  scene('learning', async (f) => {
    await page.keyboard.press('Escape');
    const skills = await target('nav.skills');
    await f.moveTo(center(skills), 1.0);
    await f.click({ hold: 1.4 });
    const skill = await target('skill.select.shared-molecule::serve-json-api-with-node-http');
    f.mark('skillRow', skill);
    await f.moveTo(center(skill), 0.7);
    await f.click({ hold: 2.6 });
    const registry = await target('nav.registry');
    await f.moveTo(center(registry), 0.9);
    await f.click({ hold: 1.4 });
    const water = await target('registry.atom.Water');
    f.mark('agentList', union(await target('registry.atom.Meristem'), water, await target('registry.atom.Ethane')));
    await f.moveTo(center(water), 0.7);
    await f.click({ hold: 3.0 });
  }),
];

/** The timeline column: every event card on screen, as one rect. */
async function timelineRect() {
  const rects = await page.evaluate(() => {
    const handle = globalThis.__ATOMA_GPU__;
    return handle.hitTargets().filter((entry) => entry.id.startsWith('event.')).map((row) => {
      const a = handle.projectRendererPoint(row.x, row.y);
      const b = handle.projectRendererPoint(row.x + row.width, row.y + row.height);
      return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
    }).filter((rect) => rect.y < 1080 && rect.y + rect.height > 0);
  });
  return rects.length ? union(...rects) : { x: 80, y: 260, width: 720, height: 800 };
}

/** The worker's execute call: the fourth completed call (prefilter, plan, prefilter, execute). */
async function executeCard() {
  return target(flagsEvent('llm-4'));
}

/** Unfilmed stand-in for a Recorder: same calls, real time, no frames. */
function rehearsal() {
  const r = {
    cursor: film.cursor,
    async hold(seconds) { await sleep(Math.min(seconds, 1.2) * 1000); },
    async moveTo(point) { await page.mouse.move(point.x, point.y); r.cursor = point; film.cursor = point; },
    async click({ hold = 0.35 } = {}) { await page.mouse.down(); await page.mouse.up(); await sleep(400 + hold * 500); },
    async type(text) {
      for (const char of text) {
        if (char === '\n') await page.keyboard.press('Enter');
        else await page.keyboard.sendCharacter(char);
      }
    },
    async scroll(deltaY) { await page.mouse.wheel({ deltaY }); await sleep(300); },
    cue() {},
    mark() {},
    async offCamera(seconds) {
      await film.setManual(true);
      await film.fastForward(seconds);
      await film.setManual(false);
    },
  };
  return r;
}

try {
  await sleep(2500);
  const last = only.length ? Math.max(...only.map((name) => scenes.findIndex((entry) => entry.name === name))) : scenes.length - 1;
  for (const { name, body } of scenes.slice(0, last + 1)) {
    const recording = only.length === 0 || only.includes(name);
    if (!recording) {
      await body(rehearsal(), { recording });
      await sleep(600);
      continue;
    }
    await film.begin(name);
    console.log(`scene ${name}…`);
    const started = Date.now();
    await body(film, { recording });
    await film.end();
    console.log(`scene ${name}: ${film.shots.at(-1).frames} frames in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
} catch (error) {
  console.error(error);
  await page.screenshot({ path: path.join(outDir, 'error.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await film.save();
  await browser.close();
  stack.stop();
}
