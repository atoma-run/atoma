/* global document */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer';
import { AuthStore } from '../dist/auth/store.js';
import { ProjectStore } from '../dist/projects/store.js';
import { ComputeDeviceStore } from '../dist/projects/computeDevices.js';
import { ComputeHttp } from '../dist/viz/computeHttp.js';
import { issueSession, sessionTokenFromCookieHeader, authCookieName, SESSION_COOKIE } from '../dist/auth/sessions.js';

const root = mkdtempSync(join(tmpdir(), 'compute-browser-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key'), '-out', join(root, 'cert'),
  '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
const db = new Database(':memory:'), auth = new AuthStore(db);
new ProjectStore(db);
const devices = new ComputeDeviceStore(db, { appVersions: new Set(), imageDigests: new Set() });
const { viewer } = auth.completeLogin({ provider: 'github', subject: 'compute-browser', displayName: 'Alex Morgan', email: null, emailVerified: false }, null);
const session = issueSession(auth, viewer, { secure: true }).token;
const secret = randomBytes(32).toString('base64url');
const pending = devices.beginPairing({ name: 'Alex’s computer', secretHash: createHash('sha256').update(secret).digest('hex') });
const server = createServer({ key: readFileSync(join(root, 'key')), cert: readFileSync(join(root, 'cert')) });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `https://127.0.0.1:${server.address().port}`;
const handler = new ComputeHttp({ devices, origin: new URL(origin), proxies: { addresses: [] }, emit: () => {}, gate: {
  enabled: true, store: auth, resolve: req => auth.resolveSession(sessionTokenFromCookieHeader(req.headers.cookie, true) ?? ''),
} });
let submittedOrigin;
server.on('request', (req, res) => {
  if (req.method === 'POST') submittedOrigin = req.headers.origin;
  void handler.handle(req, res, new URL(req.url, origin)).then(handled => { if (!handled) res.writeHead(404).end(); })
    .catch(() => res.writeHead(500).end('Unexpected failure'));
});
let browser;
try {
  browser = await puppeteer.launch({ headless: true, acceptInsecureCerts: true, args: ['--no-sandbox'] });
  await browser.setCookie({ name: authCookieName(SESSION_COOKIE, true), value: session, url: origin, secure: true, httpOnly: true });
  const page = await browser.newPage();
  for (const viewport of [{ width: 1366, height: 768 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewport(viewport); await page.goto(`${origin}/compute/pair?code=${pending.code}`);
    assert.equal(await page.$eval('h1', node => node.textContent), 'Connect this computer');
    const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth,
      targets: [...document.querySelectorAll('.actions a,.actions button')].map(node => {
        const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height };
      }) }));
    assert.ok(layout.width <= viewport.width, 'No horizontal clipping');
    assert.ok(layout.targets.every(rect => rect.width >= 44 && rect.height >= 44), 'Usable action targets');
    await page.focus('.actions a'); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BUTTON');
    if (process.env.ATOMA_COMPUTE_SCREENSHOTS) {
      mkdirSync(process.env.ATOMA_COMPUTE_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.ATOMA_COMPUTE_SCREENSHOTS, `consent-${viewport.width}.png`), fullPage: true });
    }
  }
  const [response] = await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]);
  assert.equal(response.status(), 200);
  assert.equal(submittedOrigin, origin, 'Native form preserves its exact Origin');
  assert.equal(await page.$eval('h1', node => node.textContent), 'Computer connected');
  assert.equal(devices.redeemPairing(pending.code, secret).orgId, viewer.orgId);
  for (const width of [1366, 375]) {
    await page.setViewport({ width, height: 812 });
    await page.goto(`${origin}/compute/setup`);
    assert.equal(await page.$eval('h1', node => node.textContent), 'Connect your computer');
    await page.focus('summary'); await page.keyboard.press('Enter');
    assert.equal(await page.$eval('details', node => node.open), true, 'Installation commands work by keyboard');
    assert.ok(await page.$eval('details code', node => node.textContent.includes('shasum -a 256')));
    assert.ok(await page.evaluate(width => document.documentElement.scrollWidth <= width, width), 'Setup does not clip long pinned commands');
    if (process.env.ATOMA_COMPUTE_SCREENSHOTS) await page.screenshot({
      path: join(process.env.ATOMA_COMPUTE_SCREENSHOTS, `setup-${width}.png`), fullPage: true,
    });
  }
  console.log('compute browser: compiled TLS consent, responsive layout, keyboard confirmation and proof redemption verified');
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
  rmSync(root, { recursive: true, force: true });
}
