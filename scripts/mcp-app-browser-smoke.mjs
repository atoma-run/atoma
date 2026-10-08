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
window.question=null; window.canAnswer=false; window.canResume=false; window.continuation=null;
window.answerRequests=[]; window.resumeRequests=[]; window.failAnswer=false; window.failResume=false;
window.successor={...window.run,projectRunId:'successor',title:'Continuation',status:'running'};
window.showQuestion=async (canAnswer=true) => {
  window.run={...window.run,projectRunId:'run',status:'partial'};
  window.question={questionId:'11111111-1111-4111-8111-111111111111',runId:'22222222-2222-4222-8222-222222222222',projectId:'33333333-3333-4333-8333-333333333333',phase:0,createdAt:'2026-10-08T00:00:00Z',answer:null,
    question:{question:'Keep both login methods? <script>window.executed=true</script>',whyClient:'Existing customers need a choice.',missingDecision:'Login policy',options:[{id:'both',label:'Keep both',consequence:'Keep local accounts.'},{id:'google',label:'Google only',consequence:'Migrate local accounts.'}]}};
  window.canAnswer=canAnswer; window.canResume=false; window.continuation=null; await window.showRun();
};
const result = value => ({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
const bridge = new AppBridge(null,{name:'Smoke host',version:'1'},{serverTools:{},serverResources:{},downloadFile:{},openLinks:{}},{hostContext:{theme:'light',locale:'fr-FR'}});
bridge.oncalltool = async ({name,arguments:args}) => {
  window.calls.push(name);
  if(window.refuse) return {isError:true,content:[{type:'text',text:'Access revoked. Reconnect Atoma.'}]};
  if(name==='atoma_run_status') return result(args.runId==='successor'?window.successor:window.run);
  if(name==='atoma_run_question') return result({projectId:args.projectId,runId:args.runId,question:args.runId==='successor'?null:window.question,
    waitingForClient:args.runId!=='successor'&&!!window.question&&!window.question.answer,canAnswer:args.runId!=='successor'&&window.canAnswer,canResume:args.runId!=='successor'&&window.canResume,nextAction:window.canAnswer?'answer':window.canResume?'resume':'none',continuation:args.runId==='successor'?null:window.continuation});
  if(name==='atoma_run_answer') {
    window.answerRequests.push(args);
    if(window.failAnswer) {window.failAnswer=false;return {isError:true,content:[{type:'text',text:'Uncertain answer response'}]};}
    window.question.answer={principalId:'44444444-4444-4444-8444-444444444444',at:'2026-10-08T00:01:00Z',value:args.answer};
    window.canAnswer=false;window.canResume=true;
    return result({question:window.question,created:true});
  }
  if(name==='atoma_run_resume') {
    window.resumeRequests.push(args);
    if(window.failResume) {window.failResume=false;return {isError:true,content:[{type:'text',text:'Resume unavailable'}]};}
    window.canResume=false;window.continuation={runId:'successor',status:'running'};
    if(window.holdResume) await new Promise(resolve=>{window.finishResume=resolve;});
    return result(window.successor);
  }
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
  // Decisions are literal, unselected, requester-gated, and resilient across the two writes.
  await page.evaluate(() => window.showQuestion(false));
  await frame.waitForFunction(() => !document.getElementById('decision').hidden);
  assert.equal(await frame.$eval('#decision-form', node => node.hidden), true);
  assert.equal(await frame.evaluate(() => window.executed), undefined);
  await page.evaluate(() => window.showQuestion());
  await frame.waitForFunction(() => !document.getElementById('decision-form').hidden);
  assert.equal(await frame.$$eval('#decision-options input:checked', nodes => nodes.length), 0);
  await page.setViewport({width:400,height:900});
  await frame.evaluate(() => {document.documentElement.style.colorScheme='dark';});
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({path:'/private/tmp/atoma-mcp-decision-narrow.png'});
  await page.setViewport({width:900,height:900});
  await frame.evaluate(() => {document.documentElement.style.colorScheme='light';});
  await frame.click('#decision-submit');
  assert.equal(await page.evaluate(() => window.answerRequests.length), 0);
  await frame.click('#decision-options input[value="both"]');
  await frame.type('#decision-text', 'Keep our existing accounts.');
  await page.evaluate(() => {window.run.title='Updated decision';return window.showRun();});
  await frame.waitForFunction(() => document.getElementById('title').textContent==='Updated decision');
  assert.equal(await frame.$eval('#decision-text', node => node.value), 'Keep our existing accounts.');
  assert.equal(await frame.$eval('#decision-options input[value="both"]', node => node.checked), true);

  await page.evaluate(() => {window.failAnswer=true;window.failResume=true;});
  await frame.click('#decision-submit');
  await frame.waitForFunction(() => document.getElementById('error').textContent==='Uncertain answer response');
  await frame.waitForFunction(() => !document.getElementById('decision-submit').disabled);
  await frame.click('#decision-submit');
  await frame.waitForFunction(() => document.getElementById('error').textContent==='Resume unavailable');
  assert.deepEqual(await page.evaluate(() => window.answerRequests[0]), await page.evaluate(() => window.answerRequests[1]));
  assert.deepEqual(await page.evaluate(() => window.answerRequests[1].answer), {optionId:'both',text:'Keep our existing accounts.'});
  assert.match(await frame.$eval('#decision-answer', node => node.textContent), /Keep both/);
  // Reconnect to an already saved answer: do not submit it again.
  await page.evaluate(() => {window.holdResume=true;return window.showRun();});
  await frame.waitForFunction(() => !document.getElementById('decision-form').hidden && document.getElementById('decision-text').hidden);
  await frame.click('#decision-submit');
  await page.waitForFunction(() => window.resumeRequests.length===2);
  assert.equal(await page.evaluate(() => window.answerRequests.length), 2);
  assert.deepEqual(await page.evaluate(() => window.resumeRequests), [{projectId:'project',runId:'run'},{projectId:'project',runId:'run'}]);
  await frame.click('#refresh');
  await frame.waitForFunction(() => !document.getElementById('decision-open').hidden);
  await page.screenshot({path:'/private/tmp/atoma-mcp-decision-smoke.png'});
  await frame.click('#decision-open');
  await frame.waitForFunction(() => document.getElementById('title').textContent==='Continuation');
  await page.evaluate(() => window.finishResume());
  assert.equal(await frame.$eval('#title', node => node.textContent), 'Continuation');
  // A text-only choice has no inferred option, and no action before the explicit submit.
  await page.evaluate(() => {window.holdResume=false;return window.showQuestion();});
  await frame.waitForFunction(() => !document.getElementById('decision-text').hidden);
  await frame.type('#decision-text', 'A different client policy');
  await frame.click('#decision-submit');
  await page.waitForFunction(() => window.answerRequests.length===3 && window.resumeRequests.length===3);
  assert.deepEqual(await page.evaluate(() => window.answerRequests[2].answer), {text:'A different client policy'});
  assert.deepEqual(errors, []);
  console.log('MCP App browser: handshake, paging, safe text/SVG, download, revoked access and explicit cancellation and client decision continuation passed');
} finally {
  await browser?.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
