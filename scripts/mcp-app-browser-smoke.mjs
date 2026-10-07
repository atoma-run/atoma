// Exercise the shipped App bundle in an opaque sandbox, using the official host bridge.
/* global window, document */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';

const html = readFileSync(new URL('../dist/mcp/run-app.html', import.meta.url), 'utf8');
const host = await build({ stdin: { resolveDir: process.cwd(), contents: `
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const text = 'Untrusted <script>window.executed=true</script> text.';
const files = [{path:'notes.md',size:text.length,uri:'atoma://file/notes.md'}, {path:'drawing.svg',size:200,uri:'atoma://file/drawing.svg'}];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#5d78df"/><script>window.executed=true</script></svg>';
window.run = {projectId:'project',projectRunId:'run',title:'Delivered design',goal:'Create a design',status:'delivered',costUsd:0.125,
  actions:{canCancel:false}, progress:{stage:'finished',message:'Run delivered.',lastActivityAt:'2026-10-08T00:00:00Z',source:'trace',evidence:'available',criteria:[{id:'c1',behaviour:'The files are readable',status:'covered',met:true,reason:'Recorded review'}],criteriaTruncated:false,acceptanceApproved:true}};
window.calls=[]; window.downloads=[]; window.refuse=false;
const result = value => ({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
const bridge = new AppBridge(null,{name:'Smoke host',version:'1'},{serverTools:{},serverResources:{},downloadFile:{},openLinks:{}},{hostContext:{theme:'light',locale:'fr-FR'}});
bridge.oncalltool = async ({name,arguments:args}) => {
  window.calls.push(name);
  if(window.refuse) return {isError:true,content:[{type:'text',text:'Access revoked. Reconnect Atoma.'}]};
  if(name==='atoma_run_status') return result(window.run);
  if(name==='atoma_run_artifacts') return result({projectId:'project',runId:'run',status:'delivered',files:files.slice(args.offset||0,(args.offset||0)+1),total:2,nextOffset:args.offset ? null : 1});
  if(name==='atoma_run_file') { const body=args.path==='notes.md'?text:svg; const offset=args.offset||0;
    return result({projectId:'project',runId:'run',path:args.path,size:body.length,snapshot:'f'.repeat(64),mimeType:args.path.endsWith('.svg')?'image/svg+xml':'text/plain',kind:'text',text:body.slice(offset,offset+25),textOffset:offset,nextTextOffset:offset+25<body.length?offset+25:null,untrusted:true,uri:'atoma://file/'+args.path}); }
  if(name==='atoma_run_cancel') { window.run={...window.run,status:'cancelled',actions:{canCancel:false},progress:{...window.run.progress,stage:'finished',message:'Run cancelled.'}}; return result(window.run); }
  throw new Error('Unexpected tool '+name);
};
bridge.onreadresource = async ({uri}) => ({contents:[{uri,mimeType:uri.endsWith('.svg')?'image/svg+xml':'text/plain',text:uri.endsWith('.svg')?svg:text}]});
bridge.ondownloadfile = async request => {window.downloads.push(request);return {};};
window.showRun = async () => {await bridge.sendToolInput({arguments:{projectId:'project',runId:'run'}});await bridge.sendToolResult(result(window.run));};
bridge.oninitialized = () => {void window.showRun();};
const iframe=document.querySelector('iframe');
await bridge.connect(new PostMessageTransport(iframe.contentWindow,iframe.contentWindow));
iframe.src='/app';
` }, bundle: true, platform: 'browser', format: 'esm', write: false });
const server = createServer((req, res) => {
  if (req.url === '/app') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; connect-src 'none'" });
    res.end(html);
  } else if (req.url === '/host.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(host.outputFiles[0].text); }
  else res.end('<!doctype html><iframe title="Atoma" sandbox="allow-scripts" style="width:100%;height:850px;border:0"></iframe><script type="module" src="/host.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => { errors.push(String(error)); console.error(error); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.setViewport({ width: 900, height: 900 });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.calls?.includes('atoma_run_artifacts'));
  const frame = page.frames().find(item => item.url().endsWith('/app'));
  assert.ok(frame);
  await frame.waitForSelector('#files li');
  assert.equal(await frame.$eval('#title', node => node.textContent), 'Delivered design');
  await frame.click('#more-files');
  await frame.waitForFunction(() => document.querySelectorAll('#files li').length === 2);
  await frame.click('#files li:first-child button');
  await frame.waitForFunction(() => !document.getElementById('preview-section').hidden);
  assert.equal(await frame.$eval('#text', node => node.textContent), 'Untrusted <script>window.');
  await frame.click('#more-text');
  await frame.waitForFunction(() => document.getElementById('text').textContent.startsWith('executed'));
  await frame.click('#files li:last-child button');
  await frame.waitForFunction(() => document.getElementById('image').naturalWidth === 240);
  assert.equal(await frame.evaluate(() => window.executed), undefined);
  await frame.click('#files li:last-child button:last-child');
  await page.waitForFunction(() => window.downloads.length === 1);
  assert.equal(await page.evaluate(() => window.downloads[0].contents[0].resource.mimeType), 'image/svg+xml');
  await page.screenshot({ path: '/private/tmp/atoma-mcp-app-smoke.png' });
  await page.evaluate(() => { window.refuse = true; });
  await frame.click('#refresh');
  await frame.waitForFunction(() => !document.getElementById('error').hidden);
  assert.match(await frame.$eval('#error', node => node.textContent), /Access revoked/);
  await page.evaluate(async () => { window.refuse=false;window.run={...window.run,status:'running',actions:{canCancel:true}};await window.showRun(); });
  await frame.waitForFunction(() => !document.getElementById('cancel').hidden);
  await frame.click('#cancel');
  assert.equal(await page.evaluate(() => window.calls.filter(name => name==='atoma_run_cancel').length), 0);
  await frame.click('#cancel');
  await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('cancelled'));
  assert.equal(await page.evaluate(() => window.calls.filter(name => name==='atoma_run_cancel').length), 1);
  assert.deepEqual(errors, []);
  console.log('MCP App browser: handshake, paging, safe text/SVG, download, revoked access and explicit cancellation passed');
} finally {
  await browser?.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
