// Exercise the shipped App bundle in an opaque sandbox, using the official host bridge.
/* global window, document */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';

// Pin the fixture locale: CI may add translations between local smoke runs.
const html = readFileSync(new URL('../dist/mcp/run-app.html', import.meta.url), 'utf8');
const host = await build({ stdin: { resolveDir: process.cwd(), contents: `
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const text = 'Untrusted <script>window.executed=true</script> text.';
const files = [{path:'notes.md',size:text.length,uri:'atoma://file/notes.md'}, {path:'drawing.svg',size:200,uri:'atoma://file/drawing.svg'}];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#5d78df"/><script>window.executed=true</script></svg>';
window.run = {projectId:'33333333-3333-4333-8333-333333333333',projectRunId:'22222222-2222-4222-8222-222222222222',title:'Delivered design',goal:'Create a design',status:'delivered',costUsd:0.125,
  actions:{canCancel:false}, progress:{stage:'finished',message:'Run delivered.',lastActivityAt:'2026-10-08T00:00:00Z',source:'trace',evidence:'available',criteria:[{id:'c1',behaviour:'The files are readable',status:'covered',met:true,reason:'Recorded review'}],criteriaTruncated:false,acceptanceApproved:true}};
window.canAccept=true; window.acceptance=null; window.acceptRequests=[]; window.publicationRetries=[]; window.messages=[]; window.rejectMessage=false; window.failPublish=false; window.reviewUnavailable=false; window.traceOffset=0;
window.calls=[]; window.downloads=[]; window.openedLinks=[]; window.refuse=false;
window.question=null; window.canAnswer=false; window.canResume=false; window.continuation=null;
window.answerRequests=[]; window.resumeRequests=[]; window.failAnswer=false; window.failResume=false;
window.successor={...window.run,projectRunId:'55555555-5555-4555-8555-555555555555',title:'Continuation',status:'running'};
window.showQuestion=async (canAnswer=true) => {
  window.run={...window.run,projectRunId:'22222222-2222-4222-8222-222222222222',status:'partial'};
  window.question={questionId:'11111111-1111-4111-8111-111111111111',runId:'22222222-2222-4222-8222-222222222222',projectId:'33333333-3333-4333-8333-333333333333',phase:0,createdAt:'2026-10-08T00:00:00Z',answer:null,
    question:{question:'Keep both login methods? <script>window.executed=true</script>',whyClient:'Existing customers need a choice.',missingDecision:'Login policy',options:[{id:'both',label:'Keep both',consequence:'Keep local accounts.'},{id:'google',label:'Google only',consequence:'Migrate local accounts.'}]}};
  window.canAnswer=canAnswer; window.canResume=false; window.continuation=null; await window.showRun();
};
const result = value => ({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
const bridge = new AppBridge(null,{name:'Smoke host',version:'1'},{serverTools:{},serverResources:{},downloadFile:{},openLinks:{},message:{text:{}}},{hostContext:{theme:'light',locale:'en-US'}});
bridge.oncalltool = async ({name,arguments:args}) => {
  window.calls.push(name);
  if(window.refuse) return {isError:true,content:[{type:'text',text:'Access revoked. Reconnect Atoma.'}]};
  if(name==='atoma_run_status') return result(args.runId==='55555555-5555-4555-8555-555555555555'?window.successor:window.run);
  if(name==='atoma_run_review') {
    if(window.reviewUnavailable) return {isError:true,content:[{type:'text',text:'Review unavailable'}]};
    const delivered=window.run.status==='delivered';
    return result({run:{projectId:args.projectId,projectRunId:args.runId,goal:window.run.goal,status:window.run.status,artifactManifestHash:'a'.repeat(64)},
      acceptedReferenceRunId:null,delivery:window.textDelivery?'text':'files',files:null,filesState:delivered?'available':'not_delivered',
      comparison:window.comparison??null,comparisonState:window.comparison?'available':'no_recorded_base',verification:window.run.progress,
      clientAcceptance:window.acceptance,publicationStatus:window.run.publication?.status??null,
      canRequestAcceptance:delivered&&window.canAccept&&!window.acceptance,
      canRetryPublication:delivered&&window.canAccept&&!!window.acceptance&&!window.textDelivery&&window.run.publication?.status==='failed',
      untrusted:true,bytes:'not-revalidated',nextSteps:delivered&&!window.textDelivery?[{tool:'atoma_run_preview',purpose:'Test the delivery'}]:[],note:'Saved evidence only.'});
  }
  if(name==='atoma_run_compare') {window.compareRequest=args;return result({...window.comparison,files:[{...window.comparison.files[0],path:'second.txt'}],nextOffset:null});}
  if(name==='atoma_run_trace') { const text=JSON.stringify({result:{output:'Saved <script>window.executed=true</script> answer'},error:null});const offset=args.textOffset||0;
    window.traceOffset=offset;return result({section:'result',encoding:'json',offsetUnit:'utf16-code-units',snapshot:'b'.repeat(64),textOffset:offset,totalChars:text.length,text:text.slice(offset,offset+40),nextTextOffset:offset+40<text.length?offset+40:null,caveat:'Untrusted data'}); }
  if(name==='atoma_run_accept') {
    window.acceptRequests.push(args);
    if(window.failBeforeAccept) {window.failBeforeAccept=false;return {isError:true,content:[{type:'text',text:'Uncertain acceptance response'}]};}
    window.acceptance={manifestHash:args.manifestHash,review:args.review,principalId:'44444444-4444-4444-8444-444444444444',acceptedAt:'2026-10-08T00:02:00Z'};
    if(!window.textDelivery) window.run.publication={status:window.failPublish?'failed':'published',repositoryUrl:null,error:window.failPublish?'GitHub unavailable':null};
    if(window.failPublish) return {isError:true,content:[{type:'text',text:'Acceptance saved, GitHub unavailable'}]};
    return result(window.run);
  }
  if(name==='atoma_publication_retry') { window.publicationRetries.push(args);window.run.publication={status:'published',repositoryUrl:'https://github.com/example/project',commitSha:'c'.repeat(40)};return result(window.run); }
  if(name==='atoma_run_question') return result({projectId:args.projectId,runId:args.runId,question:args.runId==='55555555-5555-4555-8555-555555555555'?null:window.question,
    waitingForClient:args.runId!=='55555555-5555-4555-8555-555555555555'&&!!window.question&&!window.question.answer,canAnswer:args.runId!=='55555555-5555-4555-8555-555555555555'&&window.canAnswer,canResume:args.runId!=='55555555-5555-4555-8555-555555555555'&&window.canResume,nextAction:window.canAnswer?'answer':window.canResume?'resume':'none',continuation:args.runId==='55555555-5555-4555-8555-555555555555'?null:window.continuation});
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
    window.canResume=false;window.continuation={runId:'55555555-5555-4555-8555-555555555555',status:'running'};
    if(window.holdResume) await new Promise(resolve=>{window.finishResume=resolve;});
    return result(window.successor);
  }
  if(name==='atoma_run_artifacts' && window.customFile) return result({projectId:window.run.projectId,runId:window.run.projectRunId,status:'delivered',files:[{path:window.customFile.path,size:window.customFile.body.length}],total:1,nextOffset:null});
  if(name==='atoma_run_artifacts') return result({projectId:'33333333-3333-4333-8333-333333333333',runId:'22222222-2222-4222-8222-222222222222',status:'delivered',files:files.slice(args.offset||0,(args.offset||0)+1),total:2,nextOffset:args.offset ? null : 1});
  if(name==='atoma_run_file') { const body=window.customFile?.body ?? (args.path==='notes.md'?text:svg); const offset=args.offset||0; const pageSize=window.customFile?12000:25;
    return result({projectId:'33333333-3333-4333-8333-333333333333',runId:'22222222-2222-4222-8222-222222222222',path:args.path,size:body.length,snapshot:'f'.repeat(64),mimeType:args.path.endsWith('.svg')?'image/svg+xml':'text/plain',kind:'text',text:body.slice(offset,offset+pageSize),textOffset:offset,nextTextOffset:offset+pageSize<body.length?offset+pageSize:null,untrusted:true,uri:'atoma://file/'+args.path}); }
  if(name==='atoma_run_cancel') { window.run={...window.run,status:'cancelled',actions:{canCancel:false},progress:{...window.run.progress,stage:'finished',message:'Run cancelled.'}}; return result(window.run); }
  throw new Error('Unexpected tool '+name);
};
bridge.onreadresource = async ({uri}) => ({contents:[{uri,mimeType:uri.endsWith('.svg')?'image/svg+xml':'text/plain',text:uri.endsWith('.svg')?svg:text}]});
bridge.onopenlink = async request => {window.openedLinks.push(request);return {};};
bridge.onmessage = async request => {if(window.rejectMessage) return {isError:true};window.messages.push(request);return {};};
bridge.ondownloadfile = async request => {window.downloads.push(request);return {};};
window.showRun = async () => {await bridge.sendToolInput({arguments:{projectId:'33333333-3333-4333-8333-333333333333',runId:'22222222-2222-4222-8222-222222222222'}});await bridge.sendToolResult(result(window.run));};
bridge.oninitialized = async () => {await bridge.sendToolResult(await bridge.oncalltool({name:'atoma_run_review',arguments:{projectId:'33333333-3333-4333-8333-333333333333',runId:'22222222-2222-4222-8222-222222222222'}}));};
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
  await frame.waitForFunction(() => !document.getElementById('preview-section').hidden && document.getElementById('text').textContent.startsWith('Untrusted'));
  assert.equal(await frame.$eval('#text', node => node.textContent), 'Untrusted <script>window.');
  assert.equal(await frame.$eval('#preview-section', node => node.parentElement === document.querySelector('#files li:first-child')), true);
  assert.equal(await frame.$eval('#files li:first-child .file-toggle', node => node.getAttribute('aria-expanded')), 'true');
  await frame.click('#files li:first-child .file-toggle');
  assert.equal(await frame.$eval('#preview-section', node => node.hidden), true);
  assert.equal(await frame.$eval('#files li:first-child .file-toggle', node => node.getAttribute('aria-expanded')), 'false');
  // The disclosure is keyboard-operable and focus survives rendering.
  await page.keyboard.press('Enter');
  await frame.waitForFunction(() => document.getElementById('text').textContent.startsWith('Untrusted') && !document.getElementById('preview-section').hidden);
  assert.equal(await frame.evaluate(() => document.activeElement?.getAttribute('aria-expanded')), 'true');
  await frame.click('#more-text');
  await frame.waitForFunction(() => document.getElementById('text').textContent.startsWith('executed'));
  await frame.click('#files li:last-child button');
  await frame.waitForFunction(() => document.getElementById('image').naturalWidth === 240);
  assert.equal(await frame.evaluate(() => window.executed), undefined);
  assert.equal(await frame.$eval('#preview-section', node => node.parentElement === document.querySelector('#files li:last-child')), true);
  assert.equal(await frame.$eval('#files li:first-child .file-toggle', node => node.getAttribute('aria-expanded')), 'false');
  await frame.click('#refresh');
  await frame.waitForFunction(() => !document.getElementById('refresh').disabled);
  assert.equal(await frame.$eval('#preview-section', node => node.parentElement === document.querySelector('#files li:last-child')), true);
  assert.equal(await frame.$eval('#image', node => node.naturalWidth), 240);
  await page.setViewport({width:400,height:900});
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await frame.$eval('#files', node => node.scrollIntoView());
  await page.screenshot({path:'/private/tmp/atoma-mcp-file-expand-narrow.png'});
  await page.setViewport({width:900,height:900});
  await frame.click('#files li:last-child .file-row button:last-child');
  await page.waitForFunction(() => window.downloads.length === 1);
  assert.equal(await page.evaluate(() => window.downloads[0].contents[0].resource.mimeType), 'image/svg+xml');
  await page.screenshot({ path: '/private/tmp/atoma-mcp-app-smoke.png' });
  // Exercise the real rich reader inside the same opaque MCP sandbox.
  const readText = async (path, body) => {
    await page.evaluate((path, body) => {window.customFile={path,body};return window.showRun();}, path, body);
    await frame.waitForFunction(path => document.querySelector('#files .file-toggle')?.dataset.fileToggle===path, {}, path);
    await frame.click('#files .file-toggle');
    await frame.waitForFunction(body => document.getElementById('text').textContent===body && !document.getElementById('file-rendered').hidden, {}, body);
  };
  const markdown = '# Refund contract\n\n**Acceptance** criteria:\n\n- Keep the existing CLI\n- Check boundary values\n\n| Case | Result |\n| --- | --- |\n| 48 h | Full refund |\n\n[Documentation](https://example.com/docs)\n\n![Remote image](https://example.com/never-load.png)\n\n<script>window.executed=true</script><iframe src="https://example.com/never-load"></iframe><input id="review-consent" checked><img src=x onerror="window.executed=true">';
  await readText('contract.md', markdown);
  assert.equal(await frame.$eval('#file-rendered h1', node => node.textContent), 'Refund contract');
  assert.equal(await frame.$$eval('#file-rendered table tbody tr', nodes => nodes.length), 1);
  assert.equal(await frame.$$eval('#file-rendered script,#file-rendered iframe,#file-rendered img,#file-rendered input', nodes => nodes.length), 0);
  assert.equal(await frame.evaluate(() => window.executed), undefined);
  assert.equal(await page.evaluate(() => window.openedLinks.length), 0);
  await frame.click('#file-rendered a');
  await page.waitForFunction(() => window.openedLinks.length===1);
  assert.equal(await page.evaluate(() => window.openedLinks[0].url), 'https://example.com/docs');
  await frame.click('#file-viewer-source');
  assert.equal(await frame.$eval('#text', node => node.hidden), false);
  assert.equal(await frame.$eval('#text', node => node.textContent), markdown);
  await frame.click('#file-viewer-preview');
  await page.setViewport({width:400,height:900});
  await frame.$eval('#preview-section', node => node.scrollIntoView());
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({path:'/private/tmp/atoma-mcp-markdown-viewer.png'});
  await page.setViewport({width:900,height:900});
  const json = '{"amount":10000,"valid":true}';
  await readText('input.json', json);
  assert.equal(await frame.$eval('#file-rendered code', node => node.textContent), JSON.stringify(JSON.parse(json), null, 2));
  assert.ok(await frame.$('#file-rendered .token.property'));
  await frame.click('#file-viewer-source');
  assert.equal(await frame.$eval('#text', node => node.textContent), json);
  await readText('broken.json', '{"amount":');
  assert.match(await frame.$eval('#file-viewer-note', node => node.textContent), /could not be formatted/);
  await readText('calculate.ts', 'export const total: number = 42;');
  assert.ok(await frame.$('#file-rendered .token.keyword'));
  await readText('unsafe.html', '<script>window.executed=true</script><h1>Source only</h1>');
  assert.equal(await frame.$$eval('#file-rendered script,#file-rendered h1', nodes => nodes.length), 0);
  assert.equal(await frame.evaluate(() => window.executed), undefined);
  await frame.click('#files .file-toggle');
  await page.evaluate(() => {window.customFile=null;return window.showRun();});
  await frame.waitForFunction(() => document.querySelector('#files .file-toggle')?.dataset.fileToggle==='notes.md');
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
  // A saved receipt survives a lost/error publication response: retry only GitHub.
  await page.evaluate(() => {window.run={...window.run,status:'delivered'};return window.showRun();});
  await frame.waitForFunction(() => !document.getElementById('review-accept-form').hidden);
  await page.evaluate(() => {
    window.comparison={projectId:window.run.projectId,runId:window.run.projectRunId,baseRunId:'base',snapshot:'d'.repeat(64),evidence:'saved_manifests',untrusted:true,
      base:{status:'delivered',coverage:'declared'},target:{status:'delivered',coverage:'workspace'},counts:{added:0,modified:2,removed:0,unchanged:0},
      files:[{path:'first.txt',change:'modified',before:{size:1,sha256:'a'.repeat(64)},after:{size:2,sha256:'b'.repeat(64)}}],total:2,nextOffset:1,note:'Legacy inventory: not a repository deletion proof.'};
    return window.showRun();
  });
  await frame.waitForFunction(() => !document.getElementById('review-compare-more').hidden);
  await frame.click('#review-compare-more');
  await frame.waitForFunction(() => document.getElementById('review-comparison-files').textContent.includes('second.txt'));
  assert.equal(await page.evaluate(() => window.compareRequest.snapshot), 'd'.repeat(64));
  assert.equal(await page.evaluate(() => window.compareRequest.offset), 1);
  assert.match(await frame.$eval('#review-comparison-note', node => node.textContent), /Legacy inventory/);
  assert.equal(await page.evaluate(() => window.acceptRequests.length), 0);
  assert.equal(await frame.$eval('#review-consent', node => node.checked), false);
  await frame.type('#review-summary', 'Tested the files and checked the result.');
  assert.equal(await frame.$eval('#review-accept', node => node.disabled), true);
  await frame.click('#review-consent');
  await page.evaluate(() => window.showRun());
  await frame.waitForFunction(() => !document.getElementById('refresh').disabled);
  assert.equal(await frame.$eval('#review-summary', node => node.value), 'Tested the files and checked the result.');
  await frame.click('#review-result');
  await frame.waitForFunction(() => !document.getElementById('review-result-page').hidden);
  await frame.click('#review-result-more');
  await page.waitForFunction(() => window.traceOffset===40);
  await frame.waitForFunction(() => !document.getElementById('review-result-more').disabled);
  await frame.click('#review-result-more');
  await frame.waitForFunction(() => document.getElementById('review-result-text').textContent==='Saved <script>window.executed=true</script> answer');
  assert.equal(await frame.evaluate(() => window.executed), undefined);
  await frame.click('#review-test');
  await page.waitForFunction(() => window.messages.length===1);
  assert.match(await page.evaluate(() => window.messages[0].content[0].text), /Do not accept, publish or start another run/);
  await frame.type('#review-feedback', 'Improve the empty state.');
  await page.evaluate(() => {window.rejectMessage=true;});
  await frame.click('#review-changes');
  await frame.waitForFunction(() => document.getElementById('review-handoff-state').textContent.includes('could not send'));
  assert.match(await frame.$eval('#review-draft', node => node.value), /Improve the empty state/);
  assert.equal(await page.evaluate(() => window.calls.includes('atoma_run_start')), false);
  await page.evaluate(() => {window.failBeforeAccept=true;window.failPublish=true;});
  await frame.click('#review-accept');
  await frame.waitForFunction(() => document.getElementById('review-accept').textContent.includes('Retry the same') && !document.getElementById('review-accept').disabled);
  assert.equal(await frame.$eval('#review-summary', node => node.disabled), true);
  await frame.click('#review-accept');
  await frame.waitForFunction(() => !document.getElementById('review-retry').hidden && !document.getElementById('review-retry').disabled);
  assert.equal(await page.evaluate(() => window.acceptRequests.length), 2);
  assert.deepEqual(await page.evaluate(() => window.acceptRequests[0]), await page.evaluate(() => window.acceptRequests[1]));
  assert.equal(await page.evaluate(() => window.acceptRequests[0].manifestHash), 'a'.repeat(64));
  assert.equal(await frame.$eval('#review-accept-form', node => node.hidden), true);
  assert.match(await frame.$eval('#review-acceptance', node => node.textContent), /Tested the files/);
  await frame.click('#review-retry');
  await frame.waitForFunction(() => document.getElementById('receipt').textContent.includes('published'));
  assert.equal(await page.evaluate(() => window.acceptRequests.length), 2);
  assert.deepEqual(await page.evaluate(() => window.acceptRequests[0]), await page.evaluate(() => window.acceptRequests[1]));
  assert.equal(await page.evaluate(() => window.publicationRetries.length), 1);
  assert.match(await frame.$eval('#receipt', node => node.textContent), /merge and deployment have not been checked/);
  await page.setViewport({width:400,height:900});
  await frame.evaluate(() => {document.documentElement.style.colorScheme='dark';document.getElementById('review').scrollIntoView();});
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({path:'/private/tmp/atoma-mcp-review-narrow.png'});
  await page.setViewport({width:900,height:900});
  await frame.evaluate(() => {document.documentElement.style.colorScheme='light';});
  // A current read failure disables an otherwise eligible write. A viewer sees no accept control.
  await page.evaluate(() => {window.acceptance=null;window.run.publication=null;window.failPublish=false;window.textDelivery=true;return window.showRun();});
  await frame.waitForFunction(() => !document.getElementById('review-accept-form').hidden);
  await page.evaluate(() => {window.reviewUnavailable=true;return window.showRun();});
  await frame.waitForFunction(() => document.getElementById('review-state').textContent.includes('could not be read'));
  assert.equal(await frame.$eval('#review-accept', node => node.disabled), true);
  await page.evaluate(() => {window.reviewUnavailable=false;window.canAccept=false;return window.showRun();});
  await frame.waitForFunction(() => document.getElementById('review-accept-form').hidden);
  await page.evaluate(() => {window.canAccept=true;return window.showRun();});
  await frame.waitForFunction(() => !document.getElementById('review-accept-form').hidden);
  await frame.type('#review-summary', 'Read the text answer.');
  if (!await frame.$eval('#review-consent', node => node.checked)) await frame.click('#review-consent');
  await frame.click('#review-accept');
  await frame.waitForFunction(() => document.getElementById('review-acceptance').textContent.includes('Read the text answer'));
  assert.equal(await page.evaluate(() => window.run.publication), null);
  assert.equal(await frame.$eval('#review-test', node => node.hidden), true);
  await page.screenshot({path:'/private/tmp/atoma-mcp-review-smoke.png'});
  await page.evaluate(() => {window.textDelivery=false;window.acceptance=null;});
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
  assert.deepEqual(await page.evaluate(() => window.resumeRequests), [{projectId:'33333333-3333-4333-8333-333333333333',runId:'22222222-2222-4222-8222-222222222222'},{projectId:'33333333-3333-4333-8333-333333333333',runId:'22222222-2222-4222-8222-222222222222'}]);
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
  console.log('MCP App browser: handshake, paging, safe text/SVG, download, revoked access and explicit cancellation and client decision continuation, delivery review, explicit acceptance, publication recovery and correction handoff passed');
} finally {
  await browser?.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
