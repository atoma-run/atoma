import { computeFreeDisk } from './computeDisk.js';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { computeImageSchema } from '../contracts/computeLocal.js';
import { computePreviewCommandSchema, computePreviewIdentitySchema, computePreviewReplySchema,
  type ComputePreviewIdentity, type ComputePreviewCommand, type ComputePreviewReply } from '../contracts/computePreview.js';
import { TERMINAL_DATA_BYTES } from '../contracts/launcher.js';
import { ComputePreviewPipe } from './computePreviewPipe.js';
import { createContainerLauncher } from './docker.js';
import { startEgressSidecar, type EgressSidecar } from '../tools/egressSidecar.js';
import { openComputePreviewStream } from '../preview/computeStream.js';
import { request } from 'node:http';

const exec = promisify(execFile);
const docker = async (args: string[]) => (await exec('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
const configSchema = z.object({ machineId: z.string().uuid(), allocationId: z.string().uuid(),
  workspaceImage: computeImageSchema, previewImage: computeImageSchema, workerImage: computeImageSchema }).strict();

/** One preview slot, using a disposable Linux copy and no published port.
 * Every network stream targets the fixed app port inside this exact container. */
export class DesktopPreview {
  private readonly config: z.infer<typeof configSchema>;
  private readonly identity: ComputePreviewIdentity;
  private readonly app: string;
  private readonly copier: string;
  private readonly volume: string;
  private readonly streams = new Map<string, ComputePreviewPipe>();
  private proxy?: EgressSidecar;
  private starting?: Promise<ComputePreviewReply>;
  private closure?: Promise<void>;
  private closing = false;
  private ready = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(identity: ComputePreviewIdentity, config: z.infer<typeof configSchema>) {
    this.identity = computePreviewIdentitySchema.parse(identity); this.config = configSchema.parse(config);
    this.app = `atoma-compute-preview-${identity.instanceId}`;
    this.copier = this.app + '-copy'; this.volume = this.app + '-data';
  }
  execute(identity: ComputePreviewIdentity, input: ComputePreviewCommand): Promise<ComputePreviewReply> {
    if (JSON.stringify(computePreviewIdentitySchema.parse(identity)) !== JSON.stringify(this.identity)) return Promise.reject(new Error('Preview generation unavailable'));
    const command = computePreviewCommandSchema.parse(input);
    if (command.method === 'stop') return this.close().then(() => ({ method: 'stop', value: null }));
    if (command.method === 'start') {
      if (this.starting || this.closing) return Promise.reject(new Error('Preview already started'));
      this.timer = setTimeout(() => { void this.close().catch(() => {}); }, command.hardMs); this.timer.unref();
      return this.starting = this.start(command).catch(async error => { await this.remove(); throw error; });
    }
    return this.traffic(command);
  }
  private async start(command: Extract<ComputePreviewCommand, { method: 'start' }>): Promise<ComputePreviewReply> {
    const source = `atoma-compute-${this.config.allocationId}-workspace`;
    const labels = JSON.parse(await docker(['volume', 'inspect', '--format', '{{json .Labels}}', source])) as Record<string, unknown> | null;
    if (labels?.['dev.atoma.compute'] !== this.config.machineId) throw new Error('Preview source unavailable');
    await docker(['volume', 'create', '--label', `dev.atoma.compute=${this.config.machineId}`, '--label', 'dev.atoma.compute.kind=preview', this.volume]);
    const copied = await new Promise<string>((resolve, reject) => {
      const child = spawn('docker', ['run', '--rm', '-i', '--name', this.copier, ...this.labels(), ...this.bounds('512m'),
        '--network', 'none', '--mount', `type=volume,src=${source},dst=/source,readonly`,
        '--mount', `type=volume,src=${this.volume},dst=/preview`, '--entrypoint', 'node', this.config.workspaceImage, '/app/preview-copy.mjs'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
      let text = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Preview copy deadline')); }, 60_000);
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.stdout.on('data', (bytes: Buffer) => { text += bytes.toString('utf8'); if (Buffer.byteLength(text) > 16384) { child.kill(); reject(new Error('Preview copy response too large')); } });
      child.once('error', reject); child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(text); else reject(new Error('Preview copy failed')); });
      child.stdin.end(JSON.stringify(command));
    });
    const classified = z.object({ kind: z.enum(['static', 'node']), entry: z.string().min(1).max(512) }).strict().parse(JSON.parse(copied));
    if (this.closing) throw new Error('Preview start cancelled');
    if (command.mode !== 'terminal' && command.allowedHosts.length) this.proxy = await startEgressSidecar({
      runId: `compute-preview-${this.config.machineId}`, image: this.config.workerImage, allowlist: command.allowedHosts,
    }, { launcher: createContainerLauncher({ image: this.config.workerImage }) });
    if (this.closing) throw new Error('Preview start cancelled');
    const entry = command.mode === 'terminal' ? '/opt/atoma-terminal/server.mjs'
      : classified.kind === 'static' ? '/opt/atoma-compute/static.mjs' : classified.entry;
    await docker(['run', '-d', '--init', '--name', this.app, ...this.labels(), ...this.bounds('1g'),
      '--network', this.proxy?.network ?? 'none', '--workdir', '/workspace',
      '--mount', `type=volume,src=${this.volume},dst=/workspace,volume-subpath=current${command.mode === 'terminal' ? ',readonly' : ''}`,
      '--tmpfs', `/data:rw,nosuid,nodev,size=${TERMINAL_DATA_BYTES / 1024 ** 2}m,uid=10001,gid=10001`,
      '--env', 'PORT=8080', '--env', 'HOST=0.0.0.0', '--env', 'NODE_ENV=production', '--env', 'HOME=/tmp', '--env', 'ATOMA_DATA_DIR=/data',
      ...(command.attribution ? [] : ['--env', 'ATOMA_TERMINAL_ATTRIBUTION=0']),
      ...(this.proxy ? ['--env', `HTTP_PROXY=http://${this.proxy.proxyHost}:${this.proxy.proxyPort}`, '--env', `HTTPS_PROXY=http://${this.proxy.proxyHost}:${this.proxy.proxyPort}`,
        '--env', 'NO_PROXY=127.0.0.1,localhost,::1', '--env', 'NODE_USE_ENV_PROXY=1'] : []),
      '--entrypoint', 'node', this.config.previewImage, entry]);
    const deadline = Date.now() + 60_000;
    while (!this.closing && Date.now() < deadline) {
      if (/LISTENING_ON_PORT=8080(?!\d)/.test(await docker(['logs', '--tail', '100', this.app]))) break;
      if (await docker(['inspect', '--format', '{{.State.Running}}', this.app]) !== 'true') throw new Error('Preview process exited');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (this.closing || Date.now() >= deadline) throw new Error('Preview readiness deadline');
    this.ready = true;
    const socket = await openComputePreviewStream(command => this.traffic(command));
    try {
      await new Promise<void>((resolve, reject) => {
        const probe = request({ path: '/', createConnection: () => socket, signal: AbortSignal.timeout(5000) }, res => { res.resume(); resolve(); });
        probe.once('error', reject); probe.end();
      });
    } finally { socket.destroy(); }
    const digest = await docker(['image', 'inspect', '--format', '{{.Id}}', this.config.previewImage]);
    return computePreviewReplySchema.parse({ method: 'start', value: { ...classified, imageDigest: digest } });
  }
  private labels() { return ['--label', `dev.atoma.compute=${this.config.machineId}`, '--label', 'dev.atoma.compute.kind=preview', '--label', `dev.atoma.compute.instance=${this.identity.instanceId}`]; }
  private bounds(memory: string) {
    return ['--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', memory,
      '--memory-swap', memory, '--cpus', '0.5', '--pids-limit', '128', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=1', '--log-opt', 'compress=false',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,uid=10001,gid=10001'];
  }
  private async traffic(command: ComputePreviewCommand): Promise<ComputePreviewReply> {
    if (!this.ready || this.closing) throw new Error('Preview unavailable');
    if (command.method === 'connect') {
      if (this.streams.size >= 8) throw new Error('Preview stream capacity exceeded');
      const id = randomUUID();
      this.streams.set(id, new ComputePreviewPipe(spawn('docker', ['exec', '-i', '--user', '10001:10001', this.app, 'node', '/opt/atoma-compute/relay.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] }), () => this.streams.delete(id)));
      return { method: command.method, value: id };
    }
    if (!('stream' in command)) throw new Error('Preview traffic command required');
    const pipe = this.streams.get(command.stream);
    if (command.method === 'disconnect') { pipe?.close(); this.streams.delete(command.stream); return { method: command.method, value: null }; }
    if (!pipe) throw new Error('Preview stream unavailable');
    if (command.method === 'read') return { method: command.method, value: await pipe.read() };
    if (command.method === 'write') await pipe.write(command.data);
    else await pipe.end();
    return { method: command.method, value: null };
  }
  freeDiskBytes(): Promise<number | undefined> { return this.ready && !this.closing ? computeFreeDisk(this.app) : Promise.resolve(undefined); }

  close(): Promise<void> {
    this.closing = true; clearTimeout(this.timer);
    return this.closure ??= (async () => { await this.starting?.catch(() => undefined); await this.remove(); })();
  }
  private async remove(): Promise<void> {
    this.ready = false;
    for (const pipe of this.streams.values()) pipe.close(); this.streams.clear();
    const errors: unknown[] = [];
    for (const name of [this.app, this.copier]) {
      try {
        const owned = await docker(['ps', '-aq', '--filter', `name=^/${name}$`, '--filter', `label=dev.atoma.compute.instance=${this.identity.instanceId}`]);
        if (owned) await docker(['rm', '-f', name]);
        if (await docker(['ps', '-aq', '--filter', `name=^/${name}$`])) throw new Error('Preview stop unconfirmed');
      } catch (error) { errors.push(error); }
    }
    try { await this.proxy?.stop(); this.proxy = undefined; } catch (error) { errors.push(error); }
    if (errors.length) throw new Error('Preview workload stop remains unconfirmed');
    const volume = await docker(['volume', 'ls', '-q', '--filter', `name=^${this.volume}$`, '--filter', `label=dev.atoma.compute=${this.config.machineId}`, '--filter', 'label=dev.atoma.compute.kind=preview']);
    if (volume) await docker(['volume', 'rm', this.volume]);
  }
}
