import { writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const out = join(root, 'dist/compute-desktop');
const profile = await mkdtemp(join(tmpdir(), 'atoma-desktop-smoke-'));
const fixture = join(out, 'runtime-smoke.mjs');
const harness = join(out, 'smoke.cjs');
const state = { paired: false, connected: false, accepting: true, phase: 'idle', issue: null, deviceName: 'My computer', download: null, diagnostic: null, allocations: [], transfers: [], resources: [] };
await writeFile(fixture, `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE proof (id INTEGER)'); db.close();
let state = ${JSON.stringify(state)};
const send = () => process.parentPort.postMessage({kind:'state',state});
process.parentPort.on('message', ({data}) => { if(data.command.action==='pair') state={...state,paired:true};
if(data.command.action==='stop'){process.exit(9);return;}
if(data.command.action==='prepare'||data.command.action==='connect') state={...state,connected:true,phase:'connected',diagnostic:{cpus:8,memoryBytes:8589934592,diskBytes:20000000000,hostDiskBytes:100000000000,version:'29.1.5'}};
if(data.command.action==='drain') state={...state,accepting:false};
if(data.command.action==='disconnect') state={...state,connected:false,phase:'idle'};
send();process.parentPort.postMessage({kind:'reply',id:data.id,ok:true}); });send();`);
await writeFile(harness, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
app.setPath('userData',${JSON.stringify(profile)});app.commandLine.appendSwitch('lang','en-US');
process.argv.push('--compute-smoke');require('./main.cjs');
(async()=>{await app.whenReady();let w;
for(let i=0;i<200;i++){w=BrowserWindow.getAllWindows()[0];if(w && await w.webContents.executeJavaScript('Boolean(document.querySelector("h1"))').catch(()=>false))break;await new Promise(r=>setTimeout(r,100));}
assert(w); const web=w.webContents;
for(let i=0;i<100;i++){if(await web.executeJavaScript('Boolean(document.querySelector("input"))'))break;await new Promise(r=>setTimeout(r,100));}
assert.equal(await web.executeJavaScript('typeof require'),'undefined');assert.equal(await web.executeJavaScript('typeof process'),'undefined');
assert.equal(web.getLastWebPreferences().sandbox,true);assert.equal(web.getLastWebPreferences().contextIsolation,true);
assert.equal(await web.executeJavaScript('document.querySelector("h1").textContent'),'Make this computer ready for Atoma');
await fs.writeFile(path.join(os.tmpdir(),'atoma-compute-desktop-connection.png'),(await web.capturePage()).toPNG());
assert.equal(await web.executeJavaScript('window.compute.command({action:"shell"}).then(()=>false,()=>true)'),true);
await web.executeJavaScript('window.compute.command({action:"pair",name:"My computer"})');
await web.executeJavaScript('window.compute.command({action:"prepare"})');
for(let i=0;i<50;i++){if(await web.executeJavaScript('document.querySelector("h1").textContent')==='Your computer is ready')break;await new Promise(r=>setTimeout(r,100));}
assert.equal(await web.executeJavaScript('document.querySelector("h1").textContent'),'Your computer is ready');
await web.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
await fs.writeFile(path.join(os.tmpdir(),'atoma-compute-desktop-ready.png'),(await web.capturePage()).toPNG());
await web.executeJavaScript('[...document.querySelectorAll("nav button")].find(b=>b.textContent==="Resources").click()');
await new Promise(r=>setTimeout(r,100));await fs.writeFile(path.join(os.tmpdir(),'atoma-compute-desktop-resources.png'),(await web.capturePage()).toPNG());
w.close();assert.equal(w.isVisible(),false);w.show();
assert.equal(await web.executeJavaScript('window.compute.command({action:"stop"}).then(()=>false,()=>true)'),true);
assert.equal(await web.executeJavaScript('window.compute.state().then(s=>s.issue)'),'stop-unconfirmed');
assert.equal(await web.executeJavaScript('window.compute.command({action:"disconnect"}).then(()=>false,()=>true)'),true);
await web.executeJavaScript('window.compute.command({action:"connect"})');
for(let i=0;i<50;i++){if(await web.executeJavaScript('window.compute.state().then(s=>s.connected)'))break;await new Promise(r=>setTimeout(r,100));}
assert.equal(await web.executeJavaScript('window.compute.state().then(s=>s.connected)'),true);

await web.executeJavaScript('window.compute.command({action:"disconnect"})');
app.once('will-quit',()=>console.log('Compute Electron smoke passed: embedded SQLite, sandbox, narrow IPC, pairing/preparation, resources, background close and confirmed quit.'));
setTimeout(()=>{console.error('Quit failed');app.exit(1)},10000).unref();app.quit();
})().catch(e=>{console.error(e);app.exit(1)});`);
try {
  const electron = require('electron');
  const code = await new Promise((done, reject) => {
    const child = spawn(electron, [harness], { cwd: root, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Desktop smoke timed out')); }, 60_000);
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); done(code); });
  });
  if (code !== 0) throw new Error(`Desktop smoke exited ${code}`);
} finally { await unlink(fixture); await unlink(harness); await rm(profile, { recursive: true, force: true }); }
