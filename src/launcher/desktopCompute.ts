import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { workspaceProcessChannel } from '../run/workspaceProcess.js';
import { workspaceReplySchema, type WorkspaceCommand } from '../contracts/workspaceProtocol.js';
import { BUILTIN_TOOL_NAMES } from '../contracts/toolTaxonomy.js';
import { LocalContainerToolExecutor } from './localWorker.js';

const exec = promisify(execFile);
const image = z.string().regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9._/:-]*@)?sha256:[a-f0-9]{64}$/);
const configuration = z.object({ machineId: z.string().uuid(), workspaceImage: image, workerImage: image,
  allocationId: z.string().uuid().optional(), recovery: z.boolean().optional() }).strict()
  .refine(value => !value.recovery || Boolean(value.allocationId), 'Recovery requires a recorded allocation identity');
export type DesktopComputeConfiguration = z.infer<typeof configuration>;

async function docker(args: string[]): Promise<string> {
  const { stdout } = await exec('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

/** Docker Desktop profile, deliberately not advertised as production gVisor.
 * No host paths, secrets, engine socket or caller-authored Docker options enter
 * a workload. A private control container owns snapshots and workspace changes. */
export class DesktopCompute {
  private readonly instanceId = randomUUID();
  private readonly workspaceVolume: string;
  private readonly snapshotVolume: string;
  private readonly serviceName: string;
  private service?: ReturnType<typeof workspaceProcessChannel>;
  private worker?: LocalContainerToolExecutor;
  private starting?: Promise<LocalContainerToolExecutor>;
  private toolDrain?: Promise<void>;
  private closing = false;
  private closure?: Promise<void>;
  private readRunCopies = false;
  private opening?: Promise<void>;
  private readonly config: DesktopComputeConfiguration;

  constructor(input: DesktopComputeConfiguration) {
    this.config = configuration.parse(input);
    const id = this.config.allocationId ?? randomUUID();
    this.workspaceVolume = `atoma-compute-${id}-workspace`;
    this.snapshotVolume = `atoma-compute-${id}-snapshots`;
    this.serviceName = `atoma-compute-${id}-control`;
  }

  static async diagnose() {
    const parsed: unknown = JSON.parse(await docker(['info', '--format', '{{json .}}']));
    const info = z.object({ OSType: z.literal('linux'), NCPU: z.number().int().positive(),
      MemTotal: z.number().positive(), ServerVersion: z.string(), OperatingSystem: z.string() }).parse(parsed);
    if (Number(info.ServerVersion.split('.')[0]) < 28) throw new Error('Docker Engine 28 or newer is required');
    if (info.NCPU < 2 || info.MemTotal < 4 * 1024 ** 3) throw new Error('Docker requires at least 2 CPUs and 4 GiB RAM');
    return { cpus: info.NCPU, memoryBytes: info.MemTotal, version: info.ServerVersion, system: info.OperatingSystem,
      isolation: 'desktop-containers' as const };
  }

  /** Boot-only reconciliation. The desktop single-instance owner must exclude
   * another launcher before calling this. Volumes survive for explicit recovery. */
  static async reconcile(machineId: string): Promise<void> {
    z.string().uuid().parse(machineId);
    const ids = (await docker(['ps', '-aq', '--filter', `label=dev.atoma.compute=${machineId}`])).split('\n').filter(Boolean);
    if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error('Invalid Docker reconciliation result');
    if (ids.length) await docker(['rm', '-f', ...ids]);
    if (await docker(['ps', '-aq', '--filter', `label=dev.atoma.compute=${machineId}`])) throw new Error('Compute workloads still exist');
  }

  open(): Promise<void> {
    if (this.opening || this.closing) return Promise.reject(new Error('Compute workspace already opened or closed'));
    return this.opening = this.initialize().catch(async error => {
      this.closing = true;
      await this.stopControl();
      throw error;
    });
  }

  private async initialize(): Promise<void> {
    await DesktopCompute.diagnose();
    for (const volume of [this.workspaceVolume, this.snapshotVolume]) {
      if (!this.config.recovery) await docker(['volume', 'create', '--label', `dev.atoma.compute=${this.config.machineId}`, volume]);
      const labels = JSON.parse(await docker(['volume', 'inspect', '--format', '{{json .Labels}}', volume])) as Record<string, unknown> | null;
      if (labels?.['dev.atoma.compute'] !== this.config.machineId) throw new Error('Compute volume ownership mismatch');
    }
    const child = spawn('docker', ['run', '--rm', '-i', '--init', '--name', this.serviceName,
      '--label', `dev.atoma.compute=${this.config.machineId}`, '--label', 'dev.atoma.compute.kind=control',
      '--label', `dev.atoma.compute.instance=${this.instanceId}`,
      '--env', 'ATOMA_WORKSPACE_SOURCE_ROOT=/snapshots/sources',
      '--network', 'none', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--memory', '512m', '--memory-swap', '512m', '--cpus', '0.5', '--pids-limit', '64',
      '--mount', `type=volume,src=${this.workspaceVolume},dst=/workspace`,
      '--mount', `type=volume,src=${this.snapshotVolume},dst=/snapshots`,
      this.config.workspaceImage], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.service = workspaceProcessChannel(child, { onLog: () => {} });
    await this.service.runtime.validateSources();
  }

  private active() {
    if (!this.service || this.closing) throw new Error('Compute workspace unavailable');
    return this.service;
  }
  async command(command: WorkspaceCommand) {
    if (this.config.recovery && !['artifact-open', 'checkpoint-open', 'checkpoint-next', 'checkpoint-close'].includes(command.method)) {
      throw new Error('Compute recovery permits export only');
    }
    if (command.method === 'restart') {
      if (!this.toolDrain) throw new Error('Compute restart requires confirmed tool drain');
      await this.toolDrain;
    }
    const reply = workspaceReplySchema.parse(await this.active().command(command));
    if (command.method === 'bind-sources') this.readRunCopies = Boolean(command.sources.readRuns);
    if (command.method === 'restart') await this.nextAttempt();
    return reply;
  }
  private async tools(): Promise<LocalContainerToolExecutor> {
    this.active();
    if (this.config.recovery) throw new Error('Compute recovery cannot execute tools');
    if (this.toolDrain) throw new Error('Compute tools drained; explicit next attempt required');
    return this.starting ??= (async () => {
      // This check runs on the Linux filesystem, while no worker holds it.
      const legacy = await this.active().runtime.ensureReadRuns();
      if (legacy) throw new Error('Legacy read-run copy layout requires a new run');
      const worker = new LocalContainerToolExecutor({ workspaceHostPath: '/workspace/current',
        image: this.config.workerImage, containerUser: '10001:10001', forwardWorkerLogs: false,
        managedWorkspace: { volume: this.workspaceVolume, machineId: this.config.machineId, readOnlyRunCopies: this.readRunCopies } });
      this.worker = worker;
      await worker.start();
      return worker;
    })();
  }
  readonly executor = {
    has: (name: string) => !this.config.recovery && (BUILTIN_TOOL_NAMES as readonly string[]).includes(name),
    execute: async (name: string, args: Record<string, unknown>) => {
      if (!this.executor.has(name)) throw new Error('Compute tool unavailable');
      return (await this.tools()).execute(name, args);
    },
    drain: () => this.drain(),
  };
  drain(): Promise<void> {
    return this.toolDrain ??= (async () => {
      await this.starting?.catch(() => undefined);
      await this.worker?.drain();
      this.worker = undefined; this.starting = undefined;
    })();
  }
  /** Explicit next-attempt activation after a host-acknowledged drain. */
  async nextAttempt(): Promise<void> {
    this.active();
    if (this.config.recovery) throw new Error('Compute recovery cannot resume execution');
    if (!this.toolDrain) throw new Error('Compute tools must be drained first');
    await this.toolDrain; this.toolDrain = undefined;
  }
  close(): Promise<void> { return this.closure ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.closing = true;
    await this.opening?.catch(() => undefined);
    await this.drain();
    await this.stopControl();
    // Managed volumes deliberately persist until checkpoint/delivery retention
    // decides they are disposable. Closing a window never deletes work.
  }
  private async stopControl(): Promise<void> {
    const named = ['ps', '-aq', '--filter', `name=^/${this.serviceName}$`];
    const owned = await docker([...named, '--filter', `label=dev.atoma.compute.instance=${this.instanceId}`]);
    if (!owned) {
      if (await docker(named)) throw new Error('Compute control belongs to another launcher instance');
      await this.service?.close(); this.service = undefined; return;
    }
    try { await docker(['rm', '-f', this.serviceName]); }
    catch {
      if (await docker(['ps', '-aq', '--filter', `name=^/${this.serviceName}$`])) throw new Error('Compute control stop unconfirmed');
    }
    if (await docker(['ps', '-aq', '--filter', `name=^/${this.serviceName}$`])) throw new Error('Compute control still exists');
    await this.service?.close();
    this.service = undefined;
  }
}
