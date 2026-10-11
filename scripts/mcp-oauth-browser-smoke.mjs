// Real browser coverage: fetch-based clients do not apply Referrer-Policy to form Origin.
/* global document, window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer';
import { AuthStore } from '../dist/auth/store.js';
import { McpOAuth } from '../dist/auth/mcpOAuth.js';
import { issueSession, parseCookieHeader, SESSION_COOKIE } from '../dist/auth/sessions.js';

const db = new Database(':memory:');
const store = new AuthStore(db);
const { viewer } = store.completeLogin({ provider: 'github', subject: 'browser-smoke', displayName: 'Alex Morgan', email: 'alex@example.com', emailVerified: false }, null);
store.grantPlatformAdmin(viewer.principalId);
const session = issueSession(store, viewer, { secure: false }).token;
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// Desktop clients receive the callback on a separate loopback port.
const receiver = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('Callback'));
await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${receiver.address().port}/callback`;
const metadataClientId = 'https://chatgpt.com/oauth/codex/client.json';
const oauth = new McpOAuth({ origin: new URL(base), clientAddress: () => 'local', emit: () => {},
  fetchClientMetadata: async url => ({ body: JSON.stringify({ client_id: url.href,
    client_name: url.href === metadataClientId ? 'Codex' : 'LongClient'.repeat(8), redirect_uris: [redirectUri] }) }),
  gate: { enabled: true, store, resolve: req => {
    const cookie = parseCookieHeader(req.headers.cookie).find(c => c.name === SESSION_COOKIE);
    return cookie ? store.resolveSession(cookie.value) : null;
  } },
});
let submittedOrigin;
server.on('request', (req, res) => {
  if (req.method === 'POST' && req.url === '/oauth/authorize') submittedOrigin = req.headers.origin;
  void oauth.handle(req, res, new URL(req.url, base)).then(handled => {
    if (!handled) res.writeHead(200, { 'content-type': 'text/plain' }).end('Callback');
  }).catch(() => res.writeHead(500).end('Unexpected server error'));
});
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await browser.setCookie({ name: SESSION_COOKIE, value: session, url: base });
  const registered = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Browser smoke', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) });
  assert.equal(registered.status, 201);
  const { client_id: clientId } = await registered.json();
  const verifier = 'v'.repeat(43);
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    resource: `${base}/mcp`, scope: 'mcp', state: 'browser-state' });
  const metadataQuery = new URLSearchParams(query);
  metadataQuery.set('client_id', metadataClientId);
  // Measure the actual compiled, CSP-protected page: the original consent's
  // margins and stacked copy pushed every decision below a laptop viewport.
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 680 }, { width: 390, height: 844 }]) {
    await page.setViewport(viewport);
    await page.goto(`${base}/oauth/authorize?${metadataQuery}`);
    if (process.env.ATOMA_OAUTH_SCREENSHOTS) {
      await mkdir(process.env.ATOMA_OAUTH_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.ATOMA_OAUTH_SCREENSHOTS, `consent-${viewport.width}.png`), fullPage: true });
    }
    const layout = await page.evaluate(() => {
      const rect = selector => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      };
      return { height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth,
        allow: rect('button[value="allow"]'), cancel: rect('button[value="deny"]'), switch: rect('button[value="switch"]'),
        detailsOpen: document.querySelector('details').open,
        metadata: document.querySelector('.client-source').textContent,
        permissions: document.querySelector('.permissions').innerText, notice: document.querySelector('.notice').innerText };
    });
    assert.ok(layout.width <= viewport.width, `Consent overflows horizontally at ${viewport.width}px`);
    assert.ok(layout.height <= viewport.height, `Consent needs scrolling at ${viewport.width}×${viewport.height}: ${layout.height}px`);
    for (const action of [layout.allow, layout.cancel, layout.switch]) {
      assert.ok(action.top >= 0 && action.bottom <= viewport.height, 'Every decision is visible on arrival');
      assert.ok(action.height >= 36 && action.width >= 44, 'Decisions retain usable touch targets');
    }
    assert.equal(layout.detailsOpen, false);
    assert.ok(layout.metadata.includes(metadataClientId), 'The complete client metadata URL stays visible');
    assert.match(layout.permissions, /starting runs and consuming the configured AI provider quota/);
    assert.match(layout.permissions, /Platform administrator access is included/);
    assert.match(layout.notice, /Any program there could use this name/);
    // Native disclosure works with the keyboard even though scripts are forbidden.
    await page.focus('summary');
    await page.keyboard.press('Enter');
    assert.equal(await page.$eval('details', details => details.open), true);
    assert.equal(await page.$eval('details code', code => code.innerText), redirectUri);
    await page.keyboard.press('Enter');
  }
  // Unbroken client URLs and names must remain readable at narrow/zoomed widths;
  // unusually long content may scroll vertically but never gets clipped.
  metadataQuery.set('client_id', `https://client.example/${'a'.repeat(240)}/client.json`);
  await page.setViewport({ width: 320, height: 640 });
  await page.goto(`${base}/oauth/authorize?${metadataQuery}`);
  await page.click('summary');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.focus('button[value="allow"]');
  assert.ok(await page.$eval('button[value="allow"]', button => {
    const rect = button.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  }), 'Allow remains reachable by keyboard when the page scrolls');
  await page.setViewport({ width: 1366, height: 680 });
  await page.goto(`${base}/oauth/authorize?${query}`);
  await Promise.all([page.waitForNavigation({ timeout: 5000 }), page.click('button[value="allow"]')]);
  assert.equal(submittedOrigin, base, 'Browser form must retain its same-origin Origin');
  const callback = new URL(page.url());
  assert.equal(callback.origin, new URL(redirectUri).origin);
  assert.equal(callback.pathname, '/callback');
  assert.equal(callback.searchParams.get('state'), 'browser-state');
  assert.ok(callback.searchParams.get('code'));
  const exchange = await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({
    grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri,
    code: callback.searchParams.get('code'), code_verifier: verifier, resource: `${base}/mcp`,
  }) });
  assert.equal(exchange.status, 200);
  assert.ok(store.resolveApiToken((await exchange.json()).access_token));
  await page.goto(`${base}/oauth/authorize?${query}`);
  await Promise.all([page.waitForNavigation({ timeout: 5000 }), page.click('button[value="deny"]')]);
  const denied = new URL(page.url());
  assert.equal(denied.origin, new URL(redirectUri).origin);
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  assert.equal(denied.searchParams.has('code'), false);
  await page.goto(`${base}/oauth/authorize?${query}`);
  await Promise.all([page.waitForNavigation({ timeout: 5000 }), page.click('button[value="switch"]')]);
  assert.equal(submittedOrigin, base);
  assert.equal(new URL(page.url()).pathname, '/auth/login');
  assert.equal(new URL(page.url()).searchParams.get('select_account'), '1');
  assert.equal(store.resolveSession(session), null);
  assert.ok((await browser.cookies()).some(cookie => cookie.name === 'atoma_mcp_return'));
  console.log('MCP OAuth browser consent and token exchange passed');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  receiver.closeAllConnections();
  await new Promise(resolve => receiver.close(resolve));
  db.close();
}
