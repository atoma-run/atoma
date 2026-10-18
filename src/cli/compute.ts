import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { mkdirSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ComputeCredential } from '../launcher/computeCredential.js';
import { ComputeMachine } from '../launcher/computeMachine.js';
import { ComputeInventory } from '../launcher/computeInventory.js';
import { DesktopCompute } from '../launcher/desktopCompute.js';
import { computeClientSettingsSchema, computeImageSchema, computeLocalJournalSchema, type ComputeClientSettings } from '../contracts/computeLocal.js';
import { computeCapabilitiesSchema } from '../contracts/computeDevice.js';

const HELP = `Atoma Compute (headless, macOS / Windows)

  compute pair --server https://atoma.run --name "My computer"
               --workspace-image <image@sha256:digest> --worker-image <image@sha256:digest>
               --retrieval-image <image@sha256:digest> --preview-image <image@sha256:digest>
  compute doctor       Check Docker Desktop and installed pinned images
  compute pull         Download the explicitly configured pinned images
  compute start        Connect; commands: accept, drain, pause, stop, status
                       Ctrl+C stops workloads and exits
  compute status       Show local allocation and connection state
  compute forget       Remove this machine's local credential (idle only)

Requires Node 24 and Docker Desktop (WSL2 on Windows). No home directories
are mounted. Disconnecting stops work. Reconnection reconciles stopped workloads;
resuming an interrupted run remains explicit in Atoma. Docker settings are never changed automatically.
`;
function stateRoot(): string {
  const root = join(homedir(), '.atoma', 'compute');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== resolve(root)) throw new Error('Compute state directory must not be a link');
  if (process.platform !== 'win32' && (lstatSync(root).mode & 0o077)) throw new Error('Compute state directory must have mode 0700');
  return root;
}
function jsonFile(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid compute state');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
function settings(root: string): ComputeClientSettings { return computeClientSettingsSchema.parse(jsonFile(join(root, 'settings.json'))); }
async function post(origin: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, origin), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Pairing response unavailable');
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length; if (bytes > 8192) throw new Error('Pairing response exceeds limit');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  if (!response.ok) throw new Error(response.status === 409 ? 'pairing-pending' : 'Pairing request refused');
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function computeMain(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, server: { type: 'string' }, name: { type: 'string' },
    'no-network': { type: 'boolean' }, 'workspace-image': { type: 'string' }, 'worker-image': { type: 'string' }, 'retrieval-image': { type: 'string' }, 'preview-image': { type: 'string' },
  } });
  if (values.help) { console.log(HELP); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['pair', 'doctor', 'pull', 'start', 'status', 'forget'].includes(command ?? '')) throw new Error(HELP);
  if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('Atoma Compute requires macOS or native Windows with Docker Desktop');
  if (command !== 'pair' && Object.keys(values).length) throw new Error('Pairing options only apply to pair');
  const root = stateRoot();
  if (command === 'pair') {
    const origin = new URL(values.server ?? 'https://atoma.run').origin;
    if (!values.server || new URL(values.server).protocol !== 'https:' || new URL(values.server).username || new URL(values.server).password ||
        !['', '/'].includes(new URL(values.server).pathname) || new URL(values.server).search || new URL(values.server).hash) throw new Error('Supply an HTTPS server origin');
    const workspaceImage = computeImageSchema.parse(values['workspace-image']), workerImage = computeImageSchema.parse(values['worker-image']);
    const retrievalImage = computeImageSchema.parse(values['retrieval-image']), previewImage = computeImageSchema.parse(values['preview-image']);
    const name = z.string().trim().min(1).max(120).parse(values.name);
    const inventory = new ComputeInventory(root);
    try {
      const secret = randomBytes(32).toString('base64url');
      const pairing = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{22}$/), expiresAt: z.number(), verificationUrl: z.string().url() }).parse(
        await post(origin, '/api/compute/pairings', { name, secretHash: createHash('sha256').update(secret).digest('hex') }));
      const expected = `${origin}/compute/pair?code=${pairing.code}`;
      if (pairing.verificationUrl !== expected) throw new Error('Unexpected pairing URL');
      console.log(`Open this URL and confirm the organisation:\n${expected}`);
      const deadline = Math.min(pairing.expiresAt, Date.now() + 10 * 60_000);
      while (Date.now() < deadline) {
        await delay(3000);
        let redeemed: unknown;
        try { redeemed = await post(origin, '/api/compute/pairings/redeem', { code: pairing.code, secret }); }
        catch (error) { if (error instanceof Error && error.message === 'pairing-pending') continue; throw error; }
        const result = z.object({ deviceId: z.string().uuid(), orgId: z.string().uuid(), credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(redeemed);
        await new ComputeCredential(root, origin, result.deviceId).save(result.credential);
        const config = computeClientSettingsSchema.parse({ version: 1, origin, deviceId: result.deviceId, orgId: result.orgId, workspaceImage, workerImage, retrievalImage, previewImage, egress: !values['no-network'] });
        const temporary = join(root, `settings-${randomBytes(8).toString('hex')}.pending`);
        writeFileSync(temporary, JSON.stringify(config), { mode: 0o600, flag: 'wx', flush: true });
        renameSync(temporary, join(root, 'settings.json'));
        console.log('Paired. Grant this machine access to a project in Atoma, then run compute start.'); return;
      }
      throw new Error('Pairing expired; run pair again');
    } finally { inventory.close(); }
  }
  const config = settings(root);
  if (command === 'status') {
    const inventory = computeLocalJournalSchema.parse(jsonFile(join(root, 'inventory.json')));
    console.log(JSON.stringify({ ...inventory, resources: await DesktopCompute.resourceUsage(inventory.machineId) }, null, 2)); return;
  }
  if (command === 'forget') {
    const inventory = new ComputeInventory(root);
    try { await new ComputeCredential(root, config.origin, config.deviceId).remove(); console.log('Local credential removed. Revoke the machine in Atoma to withdraw its access.'); }
    finally { inventory.close(); }
    return;
  }
  if (command === 'pull') { await DesktopCompute.pullImages(config); console.log('Pinned images downloaded.'); return; }
  const diagnostic = await DesktopCompute.diagnoseClient(config);
  if (command === 'doctor') { console.log(JSON.stringify(diagnostic, null, 2)); return; }
  if (!config.retrievalImage || !config.previewImage) throw new Error('Pair this installation with pinned retrieval and preview images before accepting runs');
  const machine = new ComputeMachine({ stateRoot: root, workspaceImage: config.workspaceImage, workerImage: config.workerImage, retrievalImage: config.retrievalImage, previewImage: config.previewImage, egress: config.egress });
  const exiting = new AbortController();
  const stop = () => { exiting.abort(); void machine.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const capabilities = computeCapabilitiesSchema.parse({ protocol: 1, appVersion: z.object({ version: z.string().min(1) }).parse(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))).version, platform: process.platform, architecture: process.arch,
      services: ['workspace', 'tools', 'retrieval', 'preview'], imageDigest: config.workerImage.slice(config.workerImage.lastIndexOf('sha256:')), cpus: diagnostic.cpus,
      memoryBytes: diagnostic.memoryBytes, diskBytes: diagnostic.diskBytes });
    const connectionOptions = { url: config.origin.replace(/^https:/, 'wss:') + '/compute/v1',
      credential: await new ComputeCredential(root, config.origin, config.deviceId).read(), capabilities };
    let connected = await machine.connect(connectionOptions);
    console.log('Connected. Commands: accept (new runs), drain (no new runs), pause (next approved phase), stop, status. Ctrl+C stops work and exits.');
    const input = createInterface({ input: process.stdin, terminal: false });
    let controlling = false;
    input.on('line', line => {
      if (controlling) { console.log('A command is already in progress.'); return; }
      controlling = true;
      void (async () => {
        const action = line.trim();
        if (action === 'status') console.log(JSON.stringify({ allocations: machine.allocations(), transfers: machine.transferProgress(), disk: machine.diskStatus(), resources: await DesktopCompute.resourceUsage(machine.machineId()) }, null, 2));
        else if (action === 'accept' || action === 'drain') { await connected.requestControl('accepting', action === 'accept'); console.log(action === 'accept' ? 'Accepting new runs.' : 'No longer accepting new runs. Current work continues.'); }
        else if (action === 'pause' || action === 'stop') { await connected.requestControl(action); console.log(action === 'pause' ? 'Pause requested at the next approved phase.' : 'Stop requested; waiting for workload teardown.'); }
        else console.log('Commands: accept, drain, pause, stop, status.');
      })().catch((error: unknown) => console.error(error instanceof Error ? error.message : 'Compute command unavailable')).finally(() => { controlling = false; });
    });
    try {
      while (!exiting.signal.aborted) {
        if (!await connected.finished) throw new Error('Workload stop is unconfirmed. Restore Docker and run start again to reconcile.');
        if (exiting.signal.aborted) break;
        console.log('Connection ended; workloads stopped. Reconnecting to reconcile. Interrupted runs require explicit recovery in Atoma.');
        await delay(1000, undefined, { signal: exiting.signal }).catch(() => {});
        if (exiting.signal.aborted) break;
        // A failed reconnect is actionable and exits; commands with uncertain
        // effects are never retried. A fresh successful session accepts new work.
        const refreshed = await DesktopCompute.diagnoseClient(config);
        connected = await machine.connect({ ...connectionOptions, capabilities: { ...capabilities,
          cpus: refreshed.cpus, memoryBytes: refreshed.memoryBytes, diskBytes: refreshed.diskBytes } });
        console.log('Connected; accepting only fresh authorized assignments.');
      }
    } finally { input.close(); }

  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await machine.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  computeMain(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Compute failed'); process.exitCode = 1; });
}
