// Operator validation against a real Linux/gVisor engine. No project data is used.
// It drives the update path as production does: an update CREATES the new
// version's networks and containers (the relay and proxy joined to the
// internal network with `network connect --ip`) while the online version keeps
// serving, and only then STARTS those same objects.
import { DockerHosting, pinnedHostingAddresses } from '../dist/launcher/hosting.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = mkdtempSync(join(tmpdir(), 'hosted-container-smoke-'));
const launcher = new DockerHosting({ root, image: process.env.ATOMA_HOSTING_IMAGE, relayImage: process.env.ATOMA_HOSTING_RELAY_IMAGE,
  user: process.getuid() === 0 ? '10001:10001' : `${process.getuid()}:${process.getgid()}` });
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const project = { orgId: randomUUID(), projectId: randomUUID() };
const first = { ...project, deploymentId: randomUUID() };
const second = { ...project, deploymentId: randomUUID() };
const server = `import{createServer}from'node:http';import{readFileSync,writeFileSync}from'node:fs';
const file=process.env.ATOMA_DATA_DIR+'/counter';let count=0;try{count=Number(readFileSync(file,'utf8'))}catch{};
createServer(async(req,res)=>{if(req.url==='/increment'){writeFileSync(file,String(++count));res.end(String(count));return;}
if(req.url==='/isolation'){let denied=0;for(const url of ['http://172.17.0.1:4111/','https://example.com/']){try{await fetch(url,{signal:AbortSignal.timeout(1000)})}catch{denied++}}res.end(String(denied));return;}
res.end(String(count));}).listen(Number(process.env.PORT),'0.0.0.0');`;
for (const id of [first, second]) writeFileSync(join(await launcher.prepareHosting(id), 'server.mjs'), server);
/** Each container of a deployment: name → id and state. */
const objects = id => new Map(docker('ps', '-a', '--filter', `label=dev.atoma.deployment=${id.deploymentId}`, '--format', '{{.Names}} {{.ID}} {{.State}}')
  .split('\n').filter(Boolean).map(line => line.split(' ')).map(([name, cid, state]) => [name, { cid, state }]));
let port; let outage;
async function ready(spec) {
  const handle = await launcher.startHosting(spec); port = handle.hostPort;
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.status === 200) return; } catch {} await new Promise(r => setTimeout(r, 500)); }
  throw Error('Application did not start');
}
const get = async path => (await fetch(`http://127.0.0.1:${port}${path}`)).text();
try {
  // Create, connect, then start: the first deployment takes the update's path.
  const firstSpec = { ...first, kind: 'node', entry: 'server.mjs' };
  await launcher.createHosting(firstSpec);
  const created = objects(first);
  assert.deepEqual([...created.values()].map(o => o.state), ['created', 'created']);
  assert.deepEqual((await launcher.listHosting()).filter(id => id.projectId === project.projectId), [first]);
  await ready(firstSpec);
  // The start used the created objects: same containers, now running, at their pinned addresses.
  const started = objects(first);
  for (const [name, { cid }] of created) assert.deepEqual(started.get(name), { cid, state: 'running' }, `${name} was recreated`);
  const internal = `atoma-hosted-${first.deploymentId}-net`;
  const pinned = pinnedHostingAddresses(docker('network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}', internal));
  const address = name => docker('inspect', '--format', `{{with index .NetworkSettings.Networks ${JSON.stringify(internal)}}}{{.IPAddress}}{{end}}`, name);
  assert.equal(address(`atoma-hosted-${first.deploymentId}-app`), pinned.app);
  assert.equal(address(`atoma-hosted-${first.deploymentId}-relay`), pinned.relay);
  assert.equal(await get('/increment'), '1');
  assert.equal(await get('/isolation'), '2');
  // An update: the new version is created while the first keeps serving.
  const secondSpec = { ...second, kind: 'node', entry: 'server.mjs' };
  await launcher.createHosting(secondSpec);
  assert.equal(await get('/'), '1', 'the online version stopped serving while the update was prepared');
  assert.deepEqual(new Set((await launcher.listHosting()).filter(id => id.projectId === project.projectId).map(id => id.deploymentId)),
    new Set([first.deploymentId, second.deploymentId]));
  const prepared = objects(second);
  await launcher.stopHosting(first);
  const t0 = Date.now(); await ready(secondSpec); outage = Date.now() - t0;
  for (const [name, { cid }] of prepared) assert.equal(objects(second).get(name)?.cid, cid, `${name} was recreated`);
  // The project's data survives the version change.
  assert.equal(await get('/'), '1');
  assert.equal(readFileSync(join(root, project.orgId, project.projectId, 'data', 'counter'), 'utf8'), '1');
  await launcher.stopHosting(second);
  writeFileSync(join(root, project.orgId, project.projectId, 'releases', second.deploymentId, 'index.html'), '<h1>Hosted static site</h1>');
  await ready({ ...secondSpec, kind: 'static' });
  assert.match(await get('/'), /Hosted static site/);
} finally { await launcher.stopHosting(first); await launcher.stopHosting(second); }
// Reached only when every check passed: the stops leave nothing listed.
assert.deepEqual((await launcher.listHosting()).filter(id => id.projectId === project.projectId), [], 'objects left behind');
console.log(`Hosted gVisor application: create, connect then start of the same objects, pinned addresses, an update prepared while online (start to ready ${outage} ms), persistent data, external and host network denial passed.`);
