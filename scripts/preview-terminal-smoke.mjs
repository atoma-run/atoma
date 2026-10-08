/* global document */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { startTerminalServer } from '../dist/preview-terminal/server.mjs';
import { PreviewRouteTable, startPreviewGateway } from '../dist/preview/gatewayServer.js';
import { mintPreviewClaim, PreviewClaimRegistry } from '../dist/preview/claims.js';
import { PREVIEW_BROWSER_SANDBOX } from '../dist/contracts/preview.js';

const root = mkdtempSync(join(tmpdir(), 'atoma-terminal-browser-'));
mkdirSync(join(root, 'source'));
writeFileSync(join(root, 'source', 'input.json'), '{"value":21}');
writeFileSync(join(root, 'source', 'cli.cjs'), "process.stdout.write('RESULT:'+JSON.parse(require('fs').readFileSync('input.json')).value*2+'\\n')");
const assets = resolve('dist/preview-terminal');
let terminal, gateway, browser, control;
try {
  terminal = await startTerminalServer({ sourceRoot: join(root, 'source'), dataRoot: join(root, 'data'),
    assetsRoot: assets, bridge: join(assets, 'pty.py'), host: '127.0.0.1', port: 0 });
  let frameUrl = '';
  control = createServer((_req, res) => { res.setHeader('content-type', 'text/html');
    res.end(`<html><body style="margin:0;background:#081b24"><iframe title="CLI preview" style="width:100vw;height:100vh;border:0" sandbox="${PREVIEW_BROWSER_SANDBOX}" src="${frameUrl}"></iframe></body></html>`); });
  await new Promise((done) => control.listen(0, '127.0.0.1', done));
  const controlOrigin = `http://localhost:${control.address().port}`;
  const host = 'terminal.localhost';
  const claims = new PreviewClaimRegistry();
  const routes = new PreviewRouteTable();
  const orgId = '33333333-3333-4333-8333-333333333333';
  const projectRunId = '11111111-1111-4111-8111-111111111111';
  routes.set(host, { orgId, projectRunId, generation: 1, kind: 'node', mode: 'terminal', upstreamPort: terminal.port, allowedHosts: [] });
  gateway = await startPreviewGateway({ host: '127.0.0.1', port: 0, routes, claims, visualizerOrigin: controlOrigin, publicScheme: 'http', log: () => {} });
  const claim = mintPreviewClaim({ orgId, projectRunId, generation: 1, host, principalId: 'tester', sessionId: null }, Date.now());
  claims.register(claim);
  frameUrl = `http://${host}:${gateway.port}/#${claim.secret}`;
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 720 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(controlOrigin);
  const frameElement = await page.waitForSelector('iframe');
  const frame = await frameElement.contentFrame();
  await frame.waitForSelector('.xterm-helper-textarea');
  const text = () => frame.evaluate(() => document.querySelector('.xterm-accessibility')?.textContent ?? '');
  async function expectText(fragment) {
    await frame.waitForFunction((fragment) => document.querySelector('.xterm-accessibility')?.textContent?.includes(fragment), { timeout: 15_000 }, fragment)
      .catch(async (error) => { throw new Error(`Missing terminal output ${fragment}: ${await text()}`, { cause: error }); });
  }
  const type = async (value) => { await frame.click('.xterm-helper-textarea'); await page.keyboard.type(value); await page.keyboard.press('Enter'); };
  await expectText('[exit:0]');
  await type(`'${process.execPath}' cli.cjs`);
  await expectText('RESULT:42');
  writeFileSync(join(root, 'input.json'), '{"value":30}');
  await (await frame.$('#upload')).uploadFile(join(root, 'input.json'));
  await frame.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Imported'));
  await type(`'${process.execPath}' cli.cjs`);
  await expectText('RESULT:60');
  await type('sleep 90');
  await frame.click('#interrupt');
  await expectText('[exit:130]');
  await page.screenshot({ path: '/tmp/atoma-terminal-preview.png' });
  await page.setViewport({ width: 390, height: 760 });
  await frame.waitForFunction(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  if (errors.length) throw new Error(errors.join('\n'));
  if (readFileSync(join(root, 'source', 'input.json'), 'utf8') !== '{"value":21}') throw new Error('Modified delivered source');
  console.log('Terminal browser smoke passed: real grant, CSP, PTY, CLI, upload, Ctrl+C and narrow viewport.');
} finally {
  await browser?.close();
  await gateway?.close();
  await terminal?.close();
  await new Promise((done) => { if (!control) return done(); control.close(done); control.closeAllConnections(); });
  rmSync(root, { recursive: true, force: true });
}
