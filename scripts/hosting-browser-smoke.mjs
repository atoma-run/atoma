import { execFileSync } from 'node:child_process';
// Run on the Linux hosting machine against the fixed browser image; no live scraping.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { DockerHosting } from '../dist/launcher/hosting.js';
const root = mkdtempSync(join(tmpdir(), 'atoma-browser-smoke-'));
const id = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID() };
const launcher = new DockerHosting({ root, image: process.env.ATOMA_HOSTING_IMAGE, browserImage: process.env.ATOMA_HOSTING_BROWSER_IMAGE,
  relayImage: process.env.ATOMA_HOSTING_RELAY_IMAGE, user: `${process.getuid()}:${process.getgid()}` });
const app = `
const http = require('node:http');
const fs = require('node:fs');
async function cdp(method, params={}) {
  const pages = await (await fetch(process.env.ATOMA_BROWSER_URL+'/json/list')).json();
  const ws = new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.close();reject(Error('CDP timeout'))},15000);
    ws.onopen=()=>ws.send(JSON.stringify({id:1,method,params}));
    ws.onerror=()=>{clearTimeout(timer);reject(Error('CDP failed'))};
    ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id===1){clearTimeout(timer);ws.close();m.error?reject(Error(m.error.message)):resolve(m.result)}};
  });
}
http.createServer(async(req,res)=>{
 try {
  if(req.url==='/fixture') {res.end('<title>Human verification fixture</title><button onclick="localStorage.verified=1">Continue fixture</button>');return;}
  if(req.url==='/navigate') {await cdp('Page.navigate',{url:'http://127.0.0.1:8082/fixture'}); res.end('ok');return;}
  if(req.url==='/verify-fixture') {await cdp('Runtime.evaluate',{expression:'document.querySelector("button").click()'});fs.writeFileSync('/data/offers.json','[{"id":"fixture-1"}]');res.end('ok');return;}
  if(req.url==='/state') {res.end(JSON.stringify(await cdp('Runtime.evaluate',{expression:'localStorage.verified',returnByValue:true})));return;}
  if(req.url==='/private-network') { const proxy = new URL(process.env.ATOMA_BROWSER_PROXY); const probe=http.request({hostname:proxy.hostname,port:proxy.port,path:'http://169.254.169.254/latest/meta-data/'},up=>{res.end(String(up.statusCode));up.resume()}); probe.on('error',()=>res.writeHead(500).end());probe.end();return; }
  if(req.url==='/network') {await cdp('Page.navigate',{url:'https://example.com/'});res.end('ok');return;}
  if(req.url==='/network-state') {res.end(JSON.stringify(await cdp('Runtime.evaluate',{expression:'document.title',returnByValue:true})));return;}
  res.end('Hosted browser fixture ready');
 }catch(e){res.writeHead(500).end(String(e))}
}).listen(Number(process.env.PORT),process.env.HOST);
`;
let handle;
async function get(path = '/') { return fetch(`http://127.0.0.1:${handle.hostPort}${path}`, { signal: AbortSignal.timeout(20000) }); }
async function waitFor(check) {
  for (let i=0;i<60;i++) { try { if(await check()) return; } catch { /* startup */ } await new Promise(r=>setTimeout(r,1000)); }
  throw Error('Readiness timed out');
}
try {
  const source = await launcher.prepareHosting(id); mkdirSync(source,{recursive:true}); writeFileSync(join(source,'server.cjs'),app);
  handle = await launcher.startHosting({...id,kind:'node',browser:true,entry:'server.cjs'});
  await waitFor(async()=> (await get()).ok);
  assert.equal((await get('/.atoma/browser/vnc.html')).status,200);
  assert.equal((await get('/json/version')).status,200); // App's ordinary route, never CDP JSON.
  assert.equal(await (await get('/json/version')).text(),'Hosted browser fixture ready');
  assert.equal(await (await get('/private-network')).text(),'403');
  await new Promise((resolve,reject)=>{ const ws=new WebSocket(`ws://127.0.0.1:${handle.hostPort}/.atoma/browser/websockify`, ['binary']); const timer=setTimeout(()=>{ws.close();reject(Error('Desktop websocket timed out'))},10000); ws.onmessage=()=>{clearTimeout(timer);ws.close();resolve()};ws.onerror=()=>{clearTimeout(timer);reject(Error('Desktop websocket failed'))}; });
  assert.equal((await get('/navigate')).status,200);
  await new Promise(r=>setTimeout(r,1000));
  assert.equal((await get('/verify-fixture')).status,200);
  assert.match(await (await get('/state')).text(), /"value":"1"/);
  console.log('First browser and synthetic checkpoint passed; restarting');
  await launcher.stopHosting(id);
  handle = await launcher.startHosting({...id,kind:'node',browser:true,entry:'server.cjs'});
  await waitFor(async()=> (await get()).ok);
  await get('/navigate'); await new Promise(r=>setTimeout(r,1000));
  assert.match(await (await get('/state')).text(), /"value":"1"/);
  assert.equal(readFileSync(join(root,id.orgId,id.projectId,'data/offers.json'),'utf8'),'[{"id":"fixture-1"}]');
  await get('/network');
  await waitFor(async()=> (await (await get('/network-state')).text()).includes('Example Domain'));
  if (process.env.ATOMA_BROWSER_SMOKE_HOLD === '1') {
    await get('/navigate');
    writeFileSync('/tmp/atoma-browser-smoke-ready.json', JSON.stringify(handle));
    console.log('Browser UI fixture available for three minutes');
    await new Promise(resolve => setTimeout(resolve,180000));
  }
  console.log('PASS: headed browser, desktop WebSocket, CDP isolation, synthetic manual checkpoint, persisted profile/data, denied private network, public HTTPS.');
} catch (error) {
  for (const args of [['logs', '--tail', '100', `atoma-hosted-${id.deploymentId}-app`], ['inspect', '--format', '{{.State.Status}}', `atoma-hosted-${id.deploymentId}-app`]]) { try { console.error(execFileSync('docker', args, { encoding: 'utf8' })); } catch { /* diagnostic only */ } }
  throw error;
} finally { await launcher.stopHosting(id); rmSync(root,{recursive:true,force:true}); }
