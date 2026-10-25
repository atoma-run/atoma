import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { WORKER_PIDS_LIMIT, workerRunArgs } from '../src/launcher/workerProfile.js';

const run = promisify(execFile);

/**
 * THE WORKER'S TASK BOUND MUST FIT A PROJECT'S OWN BROWSERS (run 40c20c5d,
 * 2026-10-25). Linux `pids.max` counts threads; the Compute worker's 256 was
 * hit 9,822 times, and the project's browser suites, npm and node failed with
 * EAGAIN beside validate_html's browser and four servers.
 *
 * Drives the REAL profile: the exact `workerRunArgs` of a Compute worker
 * (read-only root, tmpfs /tmp, named-volume `current` subpath, --init,
 * network none, dropped capabilities, memory and CPU caps) on the real worker
 * image, with only the command replaced by a script that launches four
 * concurrent headless Chromium trees — the tool's browser plus three a test
 * runner might start. The same profile with the former 256 bound is the
 * control: it must reproduce the failure, or this test proves nothing.
 *
 * Skipped (not failed) without Docker and `atoma-worker:latest`, like
 * tests/container-isolation.test.ts.
 */

function dockerReady(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', 'atoma-worker:latest'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = dockerReady();
if (process.env['CI_REQUIRE_DOCKER'] === '1' && !HAVE_DOCKER) {
  throw new Error('CI worker job requires Docker and a freshly built atoma-worker:latest image');
}
const describeDocker = HAVE_DOCKER ? describe : describe.skip;

const BROWSERS = 4;

// CommonJS, run by the image's node: puppeteer resolves from /app.
const SCRIPT = `
const puppeteer = require('/app/node_modules/puppeteer');
const fs = require('node:fs');
const tasks = () => {
  let n = 0;
  for (const p of fs.readdirSync('/proc')) {
    if (!/^\\d+$/.test(p)) continue;
    try { n += Number(/Threads:\\s+(\\d+)/.exec(fs.readFileSync('/proc/' + p + '/status', 'utf8'))[1]); } catch {}
  }
  return n;
};
let peak = 0;
const sampler = setInterval(() => { peak = Math.max(peak, tasks()); }, 100);
const outcomes = Array.from({ length: ${BROWSERS} }, () => 'pending: launch or page did not finish');
const cgroup = (f) => { try { return fs.readFileSync('/sys/fs/cgroup/' + f, 'utf8'); } catch { return ''; } };
const report = () => {
  clearInterval(sampler);
  console.log('RESULT:' + JSON.stringify({
    ok: outcomes.filter((o) => o === 'ok').length,
    errors: outcomes.filter((o) => o !== 'ok'),
    peak,
    memoryPeakMiB: Math.round(Number(cgroup('memory.peak')) / 1048576),
    oomKills: Number((/oom_kill (\\d+)/.exec(cgroup('memory.events')) || [0, 0])[1]),
  }));
  process.exit(0);
};
// A starved Chromium can wedge instead of failing: bound the whole attempt.
setTimeout(report, 30000);
(async () => {
  await Promise.allSettled(outcomes.map(async (_o, i) => {
    let browser;
    try {
      browser = await puppeteer.launch({ headless: true, timeout: 20000, protocolTimeout: 20000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.goto('data:text/html,<p id=x>ok</p>');
      // Kept open a while, so the trees coexist when the sampler reads them.
      await new Promise((r) => setTimeout(r, 2000));
      outcomes[i] = (await page.$eval('#x', (e) => e.textContent)) === 'ok' ? 'ok' : 'wrong page content';
    } catch (error) {
      outcomes[i] = String(error && error.message || error).slice(0, 200);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }));
  report();
})();
`;

const SIZED_TREES = Number(process.env['ATOMA_SIZE_WORKER_TREES'] ?? 8);

// Each tree in its own node process, as Playwright workers are, on a light
// app page (1,500 rows, ~5 MB of script state); the first is the resident
// tool browser, started first and held across the others.
const SIZED_CHILD = `
const puppeteer = require('/app/node_modules/puppeteer');
(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, timeout: 30000, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    const rows = Array.from({ length: 1500 }, (_, i) => '<li><input type=checkbox><span>item ' + i + '</span><button>x</button></li>').join('');
    await page.setContent('<ul>' + rows + '</ul><script>window.__state = Array.from({ length: 50000 }, (_, i) => ({ id: i, text: "row " + i }));</script>');
    await page.click('li:nth-child(10) input');
    await new Promise((r) => setTimeout(r, 6000));
    process.stdout.write((await page.$$eval('li', (l) => l.length)) === 1500 ? 'ok' : 'wrong page content');
  } catch (e) { process.stdout.write(String(e && e.message || e).slice(0, 200)); }
  finally { if (browser) await browser.close().catch(() => {}); }
})();
`;

const SIZED_SCRIPT = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const cgroup = (f) => { try { return fs.readFileSync('/sys/fs/cgroup/' + f, 'utf8'); } catch { return ''; } };
const tasks = () => {
  let n = 0;
  for (const p of fs.readdirSync('/proc')) {
    if (!/^\\d+$/.test(p)) continue;
    try { n += Number(/Threads:\\s+(\\d+)/.exec(fs.readFileSync('/proc/' + p + '/status', 'utf8'))[1]); } catch {}
  }
  return n;
};
let peak = 0;
const sampler = setInterval(() => { peak = Math.max(peak, tasks()); }, 100);
const child = () => new Promise((resolve) => {
  const c = spawn(process.execPath, ['-e', ${JSON.stringify(SIZED_CHILD)}], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('exit', (code, signal) => resolve(out || 'exit ' + code + ' ' + signal));
});
(async () => {
  const resident = child();
  await new Promise((r) => setTimeout(r, 1500));
  const outcomes = await Promise.all([resident, ...Array.from({ length: ${SIZED_TREES} }, child)]);
  clearInterval(sampler);
  console.log('RESULT:' + JSON.stringify({
    ok: outcomes.filter((o) => o === 'ok').length,
    errors: outcomes.filter((o) => o !== 'ok'),
    peak,
    memoryPeakMiB: Math.round(Number(cgroup('memory.peak')) / 1048576),
    oomKills: Number((/oom_kill (\\d+)/.exec(cgroup('memory.events')) || [0, 0])[1]),
  }));
})();
`;

describeDocker('the Compute worker profile fits a project\'s own browsers', () => {
  const machineId = randomUUID();
  const volume = `atoma-compute-${machineId}-workspace`;
  const names: string[] = [];

  beforeAll(async () => {
    await run('docker', ['volume', 'create', volume]);
    // The launcher's own preparation creates `current`; this stands in for it.
    await run('docker', ['run', '--rm', '--user', '0:0', '--mount', `type=volume,src=${volume},dst=/v`, '--entrypoint', 'node',
      'atoma-worker:latest', '-e', "require('fs').mkdirSync('/v/current');require('fs').chownSync('/v/current',10001,10001)"]);
  }, 60_000);

  afterAll(async () => {
    for (const name of names) await run('docker', ['rm', '-f', name]).catch(() => undefined);
    await run('docker', ['volume', 'rm', '-f', volume]).catch(() => undefined);
  }, 60_000);

  type Outcome = { ok: number; errors: string[]; peak: number; memoryPeakMiB: number; oomKills: number };

  async function launchBrowsersUnder(pidsLimit?: string, script = SCRIPT): Promise<Outcome> {
    const args = workerRunArgs({
      image: 'atoma-worker:latest',
      workspaceHostPath: '/unused-with-a-volume',
      workspaceVolume: volume,
      volumeSubpath: 'current',
      computeMachineId: machineId,
      user: '10001:10001',
    });
    if (pidsLimit !== undefined) args[args.indexOf('--pids-limit') + 1] = pidsLimit;
    const name = `atoma-thread-headroom-${randomUUID().slice(0, 8)}`;
    names.push(name);
    // Same profile, another command: the image's worker would wait for a socket.
    const image = args.lastIndexOf('atoma-worker:latest');
    const command = [...args.slice(0, image), '--entrypoint', 'node', 'atoma-worker:latest', '-e', script];
    command.splice(1, 0, '--name', name);
    command.splice(command.indexOf('-i'), 1);
    const { stdout } = await run('docker', command, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    const match = /RESULT:(\{.*\})/.exec(stdout);
    expect(match, stdout).toBeTruthy();
    return JSON.parse(match![1]!) as Outcome;
  }

  it(`launches ${BROWSERS} concurrent Chromium trees under the production bound`, async () => {
    const result = await launchBrowsersUnder();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(BROWSERS);
    // The measured shape the bound was sized from: well over the old 256.
    expect(result.peak).toBeGreaterThan(256);
    expect(result.oomKills).toBe(0);
  }, 150_000);

  it('the former 256 bound reproduces run 40c20c5d\'s launch failures (control)', async () => {
    const result = await launchBrowsersUnder('256');
    expect(result.ok).toBeLessThan(BROWSERS);
    expect(result.errors.length).toBeGreaterThan(0);
  }, 150_000);

  // THE SIZED CASE, opt-in (ATOMA_SIZE_WORKER=1, ~15 s): the 2048 bound is
  // justified by Playwright's default of seven workers on a 14-CPU Docker
  // Desktop VM, so this runs eight Chromium trees (ATOMA_SIZE_WORKER_TREES
  // sets the count), each in a node process of its own as a Playwright
  // worker is, beside a resident tool browser, at the smallest Compute tools
  // budget (2 GiB, no swap). It prints what src/launcher/AGENTS.md records.
  // Not in CI: on a 4-vCPU runner it measures the runner, and memory, not
  // tasks, is what it nears.
  it.runIf(process.env['ATOMA_SIZE_WORKER'] === '1')(`the sized case: ${SIZED_TREES} trees and the tool browser`, async () => {
    const result = await launchBrowsersUnder(undefined, SIZED_SCRIPT);
    console.log(`[sized case] ${JSON.stringify(result)}`);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(SIZED_TREES + 1);
    expect(result.peak).toBeLessThan(Number(WORKER_PIDS_LIMIT));
    expect(result.oomKills).toBe(0);
  }, 150_000);
});
