// Measures a hosted Node update's outage on a real Docker engine through
// DockerHosting itself, with `--runtime runsc` dropped (gVisor is Linux-only).
// Usage: npx tsx records/incidents/hosted-update-outage-2026-10-25/outage.mts [--sigterm]
// Needs a local `atoma-worker:latest` (relay image, also used as the app image).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerHosting } from '../../../src/launcher/hosting.ts';
const exec = promisify(execFile);
const image = (await exec('docker', ['image', 'inspect', 'atoma-worker:latest', '--format', '{{.Id}}'])).stdout.trim();
// macOS: the temporary directory must be shared with the engine (Docker Desktop shares /private and /var/folders).
const root = mkdtempSync(join(tmpdir(), 'hosted-update-outage-'));
const run = async (args: string[]) => {
  const i = args.indexOf('--runtime'); const a = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
  return (await exec('docker', a, { timeout: 60_000 })).stdout.trim();
};
const launcher = new DockerHosting({ root, image, relayImage: image, user: `${process.getuid!()}:${process.getgid!()}`, run });
const orgId = randomUUID(), projectId = randomUUID();
// An ordinary application: no SIGTERM handler, like most generated Node servers.
const server = `import{createServer}from'node:http';createServer((q,s)=>s.end(process.env.VERSION??'v')).listen(Number(process.env.PORT),'0.0.0.0');`
  + (process.argv.includes('--sigterm') ? `process.on('SIGTERM',()=>process.exit(0));` : '');
async function release(id: { orgId: string; projectId: string; deploymentId: string }) {
  const source = await launcher.prepareHosting(id); writeFileSync(join(source, 'server.mjs'), server);
  const open = (p: string) => { chmodSync(p, 0o777); for (const e of readdirSync(p)) { const q = join(p, e); if (statSync(q).isDirectory()) open(q); } };
  open(root);
}
const ok = async (port: number) => { try { return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).status === 200; } catch { return false; } };
async function readiness(port: number, interval: number) { for (;;) { if (await ok(port)) return; await new Promise(r => setTimeout(r, interval)); } }
const t = () => performance.now();
async function online() {
  const id = { orgId, projectId, deploymentId: randomUUID() }; await release(id);
  const h = await launcher.startHosting({ ...id, kind: 'node', entry: 'server.mjs' }); await readiness(h.hostPort, 100); return id;
}
const results: Record<string, number>[] = [];
for (let round = 0; round < 3; round++) {
  // New path: create before the stop; after it, start + readiness (service polls every 250 ms).
  let old = await online();
  const next = { orgId, projectId, deploymentId: randomUUID() }; await release(next);
  const c0 = t(); await launcher.createHosting({ ...next, kind: 'node', entry: 'server.mjs' }); const created = t() - c0;
  const s0 = t(); await launcher.stopHosting(old); const s1 = t();
  const h = await launcher.startHosting({ ...next, kind: 'node', entry: 'server.mjs' }); const s2 = t();
  await readiness(h.hostPort, 250); const s3 = t();
  await launcher.stopHosting(next);
  // Old path: relay and app each with a ten-second grace, then a full creation, polled every second.
  old = await online();
  const o0 = t();
  for (const name of [`atoma-hosted-${old.deploymentId}-relay`, `atoma-hosted-${old.deploymentId}-app`]) { await run(['stop', '--time', '10', name]); await run(['rm', '-f', name]); }
  await launcher.stopHosting(old); const o1 = t();
  const later = { orgId, projectId, deploymentId: randomUUID() }; await release(later);
  const o2a = t(); const h2 = await launcher.startHosting({ ...later, kind: 'node', entry: 'server.mjs' }); const o2 = t();
  await readiness(h2.hostPort, 1000); const o3 = t();
  await launcher.stopHosting(later);
  results.push({ createdBeforeStop: created, newStop: s1 - s0, newStart: s2 - s1, newReady: s3 - s2, newOutage: s3 - s0,
    oldStop: o1 - o0, oldStart: o2 - o2a, oldReady: o3 - o2, oldOutage: (o1 - o0) + (o3 - o2a) });
  console.log(JSON.stringify(Object.fromEntries(Object.entries(results.at(-1)!).map(([k, v]) => [k, Math.round(v)]))));
}
rmSync(root, { recursive: true, force: true });
