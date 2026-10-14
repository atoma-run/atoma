/* global document */
// Local real-browser check against a forwarded hosting-browser smoke relay.
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { createHostingGateway } from '../dist/projects/hostingGateway.js';
const root = mkdtempSync(join(tmpdir(),'browser-gateway-ui-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
const row = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID(), state:'ready', browser:true, createdAt:new Date().toISOString(), hostPort:Number(process.argv[2]) };
let host;
const viewer = { orgId:row.orgId, principalId:randomUUID() };
const gateway = createHostingGateway({deps:{store:{list:()=>[row]}},host:()=>host,status:()=>({})},'https://atoma.run',()=>true);
const server = createServer({key:readFileSync(join(root,'key.pem')),cert:readFileSync(join(root,'cert.pem'))});
server.on('request',(req,res)=>gateway.server.emit('request',req,res));
server.on('upgrade',(req,socket,head)=>gateway.server.emit('upgrade',req,socket,head));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
host=`localhost:${server.address().port}`;
const browser=await puppeteer.launch({headless:true,acceptInsecureCerts:true,args:['--ignore-certificate-errors']});
try {
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(gateway.open(viewer,row.projectId));
  await page.waitForFunction(()=>!document.getElementById('status'));
  await page.goto(`https://${host}/.atoma/browser/`);
  await page.waitForFunction(()=>document.body.dataset.connected==='true',{timeout:20000});
  assert.equal(await page.$eval('canvas',el=>el.width),1280);
  await page.waitForFunction(()=>{const canvas=document.querySelector('canvas');const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let light=0;for(let i=0;i<data.length;i+=16)if(data[i]>150&&data[i+1]>150&&data[i+2]>150)light++;return light>10000;},{timeout:20000});
  assert.deepEqual(errors,[]);
  await page.screenshot({path:process.argv[3]??'/tmp/atoma-hosted-browser.png'});
  await Promise.all([page.waitForNavigation(), page.click('a[href="/"]')]);
  assert.match(await page.$eval('body',el=>el.textContent), /Hosted browser fixture ready/);
  await page.goto(`https://${host}/.atoma/browser/`);
  await page.waitForFunction(()=>document.body.dataset.connected==='true',{timeout:20000});
  gateway.claims.revokePrincipal(viewer.principalId);
  await page.waitForFunction(()=>document.body.dataset.connected==='false',{timeout:10000});
  console.log('PASS: private HTTPS claim, real noVNC canvas, CSP, WebSocket and logout disconnect.');
} finally {
  await browser.close();gateway.server.emit('close');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});
}
