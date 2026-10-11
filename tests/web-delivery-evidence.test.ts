import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { expect, it } from 'vitest';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { startStaticServerTool, validateHtmlTool, type ServedOrigins } from '../src/tools/builtin.js';
import { parseBrowserObservation } from '../src/contracts/attestation.js';

// Counterexamples from Reading Log d6122c6b. These exercise browser behavior,
// not model compliance: runtime guidance must still be measured on live runs.
it('observes a plain-text title injection through the real input, with a safe DOM control', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-text-sink-'));
  const sandbox = new ToolSandbox(dir);
  const servedOrigins: ServedOrigins = new Map();
  try {
    const server = await startStaticServerTool({ sandbox, servedOrigins }).execute({}) as { url: string };
    for (const safe of [false, true]) {
      const render = safe
        ? "const b=document.createElement('button');b.setAttribute('aria-label',title.value);out.replaceChildren(b);"
        : 'out.innerHTML=`<button aria-label="${title.value}">Remove</button>`;';
      writeFileSync(join(dir, 'index.html'), `<input id="title"><button id="add">Add</button><div id="out"></div><script>const title=document.querySelector('#title'),out=document.querySelector('#out');document.querySelector('#add').onclick=()=>{${render}};</script>`);
      const args = { url: server.url, waitMs: 200, interactions: [
        { type: 'type', selector: '#title', text: '"><img src=x onerror="document.body.dataset.injected=1"><span x="' },
        { type: 'click', selector: '#add' },
      ], smoke: "(() => ({ok:document.body.dataset.injected!== '1' && !document.querySelector('#out img'), injected:document.body.dataset.injected==='1'}))()" };
      const observed = parseBrowserObservation(args, await validateHtmlTool({ sandbox, servedOrigins }).execute(args));
      expect(observed?.ok).toBe(safe);
    }
  } finally { await sandbox.cleanup(); rmSync(dir, { recursive: true, force: true }); }
}, 60_000);

it('distinguishes served module success from the promised direct-file launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-launch-mode-'));
  const sandbox = new ToolSandbox(dir);
  const servedOrigins: ServedOrigins = new Map();
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const action = "document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent='1';";
    writeFileSync(join(dir, 'app.mjs'), action);
    writeFileSync(join(dir, 'index.html'), '<button id="add">Add</button><output id="count">0</output><script type="module" src="app.mjs"></script>');
    const server = await startStaticServerTool({ sandbox, servedOrigins }).execute({}) as { url: string };
    const args = { url: server.url, interactions: [{ type: 'click', selector: '#add' }],
      smoke: "(() => ({ok:document.querySelector('#count').textContent==='1'}))()" };
    expect(parseBrowserObservation(args, await validateHtmlTool({ sandbox, servedOrigins }).execute(args))?.ok).toBe(true);
    const page = await browser.newPage();
    await page.goto(pathToFileURL(join(dir, 'index.html')).href);
    await page.click('#add');
    expect(await page.$eval('#count', el => el.textContent)).toBe('0');
    // A self-contained classic script supports direct opening. No blanket
    // rejection of static apps, module syntax, or HTTP serving is justified.
    writeFileSync(join(dir, 'direct.html'), `<button id="add">Add</button><output id="count">0</output><script>${action}</script>`);
    await page.goto(pathToFileURL(join(dir, 'direct.html')).href);
    await page.click('#add');
    expect(await page.$eval('#count', el => el.textContent)).toBe('1');
  } finally { await browser.close(); await sandbox.cleanup(); rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
