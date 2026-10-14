// Operator validation against a real Linux/gVisor engine. No project data is used.
import { DockerHosting } from '../dist/launcher/hosting.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = mkdtempSync(join(tmpdir(), 'hosted-container-smoke-'));
const launcher = new DockerHosting({ root, image: process.env.ATOMA_HOSTING_IMAGE, relayImage: process.env.ATOMA_HOSTING_RELAY_IMAGE,
  user: process.getuid() === 0 ? '10001:10001' : `${process.getuid()}:${process.getgid()}` });
const identity = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID() };
const source = await launcher.prepareHosting(identity);
writeFileSync(join(source, 'server.mjs'), `import{createServer}from'node:http';import{readFileSync,writeFileSync}from'node:fs';
const file=process.env.ATOMA_DATA_DIR+'/counter';let count=0;try{count=Number(readFileSync(file,'utf8'))}catch{};
createServer(async(req,res)=>{if(req.url==='/increment'){writeFileSync(file,String(++count));res.end(String(count));return;}
if(req.url==='/isolation'){let denied=0;for(const url of ['http://172.17.0.1:4111/','https://example.com/']){try{await fetch(url,{signal:AbortSignal.timeout(1000)})}catch{denied++}}res.end(String(denied));return;}
res.end(String(count));}).listen(Number(process.env.PORT),'0.0.0.0');`);
const spec = { ...identity, kind: 'node', entry: 'server.mjs' };
let port;
async function ready() {
  const handle = await launcher.startHosting(spec); port = handle.hostPort;
  for (let i=0;i<40;i++) { try { const r=await fetch(`http://127.0.0.1:${port}/`); if(r.status===200)return; } catch {} await new Promise(r=>setTimeout(r,500)); }
  throw Error('Application did not start');
}
try {
  await ready();
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/increment`)).text(),'1');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/isolation`)).text(),'2');
  await launcher.stopHosting(identity); await ready();
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(),'1');
  assert.equal(readFileSync(join(root,identity.orgId,identity.projectId,'data','counter'),'utf8'),'1');
  await launcher.stopHosting(identity);
  writeFileSync(join(source, 'index.html'), '<h1>Hosted static site</h1>');
  spec.kind = 'static'; await ready();
  assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /Hosted static site/);
  console.log('Hosted gVisor application: HTTP, persistent data across stop/start, external and host network denial passed.');
} finally { await launcher.stopHosting(identity); }
