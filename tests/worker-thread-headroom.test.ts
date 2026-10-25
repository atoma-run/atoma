import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { workerRunArgs } from '../src/launcher/workerProfile.js';

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
const report = () => {
  clearInterval(sampler);
  console.log('RESULT:' + JSON.stringify({
    ok: outcomes.filter((o) => o === 'ok').length,
    errors: outcomes.filter((o) => o !== 'ok'),
    peak,
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

  async function launchBrowsersUnder(pidsLimit?: string): Promise<{ ok: number; errors: string[]; peak: number }> {
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
    const command = [...args.slice(0, image), '--entrypoint', 'node', 'atoma-worker:latest', '-e', SCRIPT];
    command.splice(1, 0, '--name', name);
    command.splice(command.indexOf('-i'), 1);
    const { stdout } = await run('docker', command, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    const match = /RESULT:(\{.*\})/.exec(stdout);
    expect(match, stdout).toBeTruthy();
    return JSON.parse(match![1]!) as { ok: number; errors: string[]; peak: number };
  }

  it(`launches ${BROWSERS} concurrent Chromium trees under the production bound`, async () => {
    const result = await launchBrowsersUnder();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(BROWSERS);
    // The measured shape the bound was sized from: well over the old 256.
    expect(result.peak).toBeGreaterThan(256);
  }, 150_000);

  it('the former 256 bound reproduces run 40c20c5d\'s launch failures (control)', async () => {
    const result = await launchBrowsersUnder('256');
    expect(result.ok).toBeLessThan(BROWSERS);
    expect(result.errors.length).toBeGreaterThan(0);
  }, 150_000);
});
