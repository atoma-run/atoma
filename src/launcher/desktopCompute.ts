import { pullComputeImage } from './computeImagePull.js';
import type { ComputeImageProgress } from '../contracts/computeSetup.js';
import { computeFreeDisk } from './computeDisk.js';
import { launcherUnitName } from './names.js';
import { COMPUTE_RUN_RESOURCES } from '../contracts/computeProject.js';
import { computeRetrievalProcess } from './computeRetrievalProcess.js';
import type { ComputeRetrievalCommand } from '../contracts/computeRetrieval.js';
import { startEgressSidecar, type EgressSidecar } from '../tools/egressSidecar.js';
import { createContainerLauncher } from './docker.js';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { workspaceProcessChannel } from '../run/workspaceProcess.js';
import { workspaceReplySchema, type WorkspaceCommand } from '../contracts/workspaceProtocol.js';
import { BUILTIN_TOOL_NAMES } from '../contracts/toolTaxonomy.js';
import { LocalContainerToolExecutor } from './localWorker.js';

const exec = promisify(execFile);
import { computeImageSchema as image, computeResourceBudgetSchema, computeWorkloadBudget, type ComputeClientSettings } from '../contracts/computeLocal.js';
const configuration = z.object({ machineId: z.string().uuid(), workspaceImage: image, workerImage: image, retrievalImage: image.optional(),
  resourceBudget: computeResourceBudgetSchema.optional(), allocationId: z.string().uuid().optional(), egress: z.boolean().optional(), recovery: z.boolean().optional() }).strict()
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
  private retrieval?: ReturnType<typeof computeRetrievalProcess>;
  private retrievalStarting?: Promise<ReturnType<typeof computeRetrievalProcess>>;
  private readonly retrievalName: string;
  private service?: ReturnType<typeof workspaceProcessChannel>;
  private worker?: LocalContainerToolExecutor;
  private starting?: Promise<LocalContainerToolExecutor>;
  private toolDrain?: Promise<void>;
  private egress?: EgressSidecar;
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
    this.retrievalName = `atoma-compute-${id}-retrieval`;
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

  static async resourceUsage(machineId: string) {
    z.string().uuid().parse(machineId);
    const owned = [await docker(['ps', '-q', '--filter', `label=dev.atoma.compute=${machineId}`])];
    for (const ownerId of [`compute-${machineId}`, `compute-preview-${machineId}`]) {
      owned.push(await docker(['ps', '-q', '--filter', `name=^/${launcherUnitName('egress-proxy', ownerId)}$`]));
    }
    const ids = [...new Set(owned.flatMap(value => value.split('\n').filter(Boolean)))];
    if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error('Invalid compute resource identity');
    if (!ids.length) return [];
    const output = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids]);
    return output.split('\n').filter(Boolean).map(line => {
      const value = z.object({ Name: z.string().max(128), CPUPerc: z.string().max(32), MemUsage: z.string().max(80), PIDs: z.string().max(20) }).parse(JSON.parse(line));
      return { workload: value.Name, cpuPercent: z.number().finite().nonnegative().parse(Number(value.CPUPerc.replace('%', ''))), memory: value.MemUsage, processes: z.number().int().nonnegative().parse(Number(value.PIDs)) };
    });
  }

  static async pullImages(config: Pick<ComputeClientSettings, 'workspaceImage' | 'workerImage' | 'retrievalImage' | 'previewImage'>, progress?: (completed: number, total: number) => void, signal?: AbortSignal, detail?: (progress: ComputeImageProgress) => void): Promise<void> {
    const images = [image.parse(config.workspaceImage), image.parse(config.workerImage), ...(config.retrievalImage ? [image.parse(config.retrievalImage)] : []), ...(config.previewImage ? [image.parse(config.previewImage)] : [])];
    let completed = 0; progress?.(completed, images.length);
    for (const reference of images) {
      signal?.throwIfAborted();
      let installed = false;
      try { await docker(['image', 'inspect', reference]); installed = true; } catch { signal?.throwIfAborted(); }
      if (!installed) {
        if (!reference.includes('@')) throw new Error('Pinned local image is unavailable');
        await pullComputeImage(reference, value => detail?.(value), signal);
      }
      progress?.(++completed, images.length);
    }
  }
  static async diagnoseClient(config: Pick<ComputeClientSettings, 'workspaceImage' | 'workerImage' | 'retrievalImage' | 'previewImage'>) {
    const diagnostic = await this.diagnose();
    if (!/Docker Desktop/i.test(diagnostic.system)) throw new Error('Docker Desktop is required; install or start Docker Desktop');
    if (process.platform === 'win32' && !/WSL2/i.test(await docker(['info', '--format', '{{.KernelVersion}}']))) {
      throw new Error('Enable Docker Desktop’s WSL2 backend before connecting');
    }
    if (diagnostic.cpus < COMPUTE_RUN_RESOURCES.cpus || diagnostic.memoryBytes < COMPUTE_RUN_RESOURCES.memoryBytes) throw new Error('Assign at least 5 CPUs and 6 GiB to Docker Desktop for tools, search and preview');
    for (const reference of [image.parse(config.workspaceImage), image.parse(config.workerImage), ...(config.retrievalImage ? [image.parse(config.retrievalImage)] : []), ...(config.previewImage ? [image.parse(config.previewImage)] : [])]) {
      const metadata: unknown = JSON.parse(await docker(['image', 'inspect', '--format', '{{json .}}', reference]));
      const inspected = z.object({ Os: z.literal('linux'), Architecture: z.enum(['amd64', 'arm64']) }).parse(metadata);
      if (inspected.Architecture !== (process.arch === 'arm64' ? 'arm64' : 'amd64')) throw new Error('Compute images must match this machine’s architecture');
    }
    const name = `atoma-compute-diagnostic-${randomUUID()}`;
    let diskBytes: number;
    try {
      const value = await docker(['run', '--name', name, '--rm', '--network', 'none', '--user', '10001:10001',
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '64m', '--memory-swap', '64m',
        '--cpus', '0.25', '--pids-limit', '32', config.workspaceImage, 'node', '-e',
        "const s=require('node:fs').statfsSync('/');process.stdout.write(String(s.bavail*s.bsize))"]);
      diskBytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(Number(value));
    } finally { await docker(['rm', '-f', name]).catch(() => undefined); }
    if (diskBytes < COMPUTE_RUN_RESOURCES.diskBytes) throw new Error('Docker Desktop needs at least 4 GiB of free Linux disk space');
    let retrievalRuntimeSha256: string | undefined;
    if (config.retrievalImage) {
      const name = `atoma-compute-retrieval-diagnostic-${randomUUID()}`;
      try {
        const response = await docker(['run', '--name', name, '--rm', '--network', 'none', '--user', '10001:10001',
          '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '2g', '--memory-swap', '2g',
          '--cpus', '1', '--pids-limit', '64', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,uid=10001,gid=10001',
          '--entrypoint', '/opt/haystack/bin/python', config.retrievalImage, '-I', '/scripts/retrieval-haystack.py', '--check-hybrid']);
        retrievalRuntimeSha256 = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(response)).sha256;
      } finally { await docker(['rm', '-f', name]).catch(() => undefined); }
    }
    return { ...diagnostic, diskBytes, ...(retrievalRuntimeSha256 ? { retrievalRuntimeSha256 } : {}) };
  }

  /** Boot-only reconciliation. The desktop single-instance owner must exclude
   * another launcher before calling this. Volumes survive for explicit recovery. */
  static async reconcile(machineId: string, workerImage?: string): Promise<void> {
    z.string().uuid().parse(machineId);
    const ids = (await docker(['ps', '-aq', '--filter', `label=dev.atoma.compute=${machineId}`])).split('\n').filter(Boolean);
    if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error('Invalid Docker reconciliation result');
    if (ids.length) await docker(['rm', '-f', ...ids]);
    if (await docker(['ps', '-aq', '--filter', `label=dev.atoma.compute=${machineId}`])) throw new Error('Compute workloads still exist');
    if (workerImage) {
      const launcher = createContainerLauncher({ image: image.parse(workerImage) });
      for (const ownerId of [`compute-${machineId}`, `compute-preview-${machineId}`]) {
      await launcher.purgeOwner('egress', ownerId);
      const proxy = launcher.unitName('egress-proxy', ownerId);
      if (await docker(['ps', '-aq', '--filter', `name=^/${proxy}$`])) throw new Error('Compute egress stop unconfirmed');
      for (const kind of ['internal', 'uplink'] as const) {
        const name = launcher.networkName({ family: 'egress', kind, ownerId });
        if (await docker(['network', 'ls', '-q', '--filter', `name=^${name}$`])) throw new Error('Compute network cleanup unconfirmed');
      }
      }
    }
    const previewVolumes = (await docker(['volume', 'ls', '-q', '--filter', `label=dev.atoma.compute=${machineId}`, '--filter', 'label=dev.atoma.compute.kind=preview'])).split('\n').filter(Boolean);
    if (previewVolumes.some(name => !/^atoma-compute-preview-[a-f0-9-]+-data$/.test(name))) throw new Error('Invalid preview volume identity');
    if (previewVolumes.length) await docker(['volume', 'rm', ...previewVolumes]);
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

  freeDiskBytes() { this.active(); return computeFreeDisk(this.serviceName); }

  async retrievalCommand(command: ComputeRetrievalCommand) {
    if (this.closing || this.config.recovery || !this.config.retrievalImage) throw new Error('Compute retrieval unavailable');
    const service = await (this.retrievalStarting ??= this.startRetrieval());
    if (this.closing) throw new Error('Compute retrieval stopped');
    return service.execute(command);
  }
  private async startRetrieval() {
    const budget = computeWorkloadBudget(this.config.resourceBudget).search;
    const cache = `atoma-compute-${this.config.machineId}-embeddings`;
    const corpus = `${this.retrievalName}-data`;
    await docker(['volume', 'create', '--label', `dev.atoma.compute=${this.config.machineId}`, corpus]);
    const corpusLabels = JSON.parse(await docker(['volume', 'inspect', '--format', '{{json .Labels}}', corpus])) as Record<string, unknown> | null;
    if (corpusLabels?.['dev.atoma.compute'] !== this.config.machineId) throw new Error('Compute corpus ownership mismatch');
    await docker(['volume', 'create', '--label', `dev.atoma.compute=${this.config.machineId}`, cache]);
    const labels = JSON.parse(await docker(['volume', 'inspect', '--format', '{{json .Labels}}', cache])) as Record<string, unknown> | null;
    if (labels?.['dev.atoma.compute'] !== this.config.machineId) throw new Error('Compute cache ownership mismatch');
    const child = spawn('docker', ['run', '--rm', '-i', '--init', '--name', this.retrievalName,
      '--label', `dev.atoma.compute=${this.config.machineId}`, '--label', 'dev.atoma.compute.kind=retrieval',
      '--label', `dev.atoma.compute.instance=${this.instanceId}`, '--network', 'none', '--user', '10001:10001',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', `${budget.memoryGiB}g`, '--memory-swap', `${budget.memoryGiB}g`,
      '--cpus', String(budget.cpus), '--env', `ATOMA_COMPUTE_RETRIEVAL_CPUS=${budget.cpus}`, '--pids-limit', '96', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,uid=10001,gid=10001',
      '--mount', `type=volume,src=${corpus},dst=/retrieval`,
      '--mount', `type=volume,src=${cache},dst=/cache`, this.config.retrievalImage!], { stdio: ['pipe', 'pipe', 'pipe'] });
    return this.retrieval = computeRetrievalProcess(child);
  }
  private async stopRetrieval(): Promise<void> {
    await this.retrievalStarting?.catch(() => undefined);
    if (!this.retrieval) return;
    const named = ['ps', '-aq', '--filter', `name=^/${this.retrievalName}$`];
    const owned = await docker([...named, '--filter', `label=dev.atoma.compute.instance=${this.instanceId}`]);
    if (owned) await docker(['rm', '-f', this.retrievalName]);
    if (await docker(named)) throw new Error('Compute retrieval stop unconfirmed');
    await this.retrieval.close(); this.retrieval = undefined;
  }

  private active() {
    if (!this.service || this.closing) throw new Error('Compute workspace unavailable');
    return this.service;
  }
  async command(command: WorkspaceCommand) {
    if (this.config.recovery && !['classify-preview', 'artifact-open', 'checkpoint-open', 'checkpoint-next', 'checkpoint-close'].includes(command.method)) {
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
      if (this.config.egress) this.egress = await startEgressSidecar({ runId: `compute-${this.config.machineId}`, image: this.config.workerImage },
        { launcher: createContainerLauncher({ image: this.config.workerImage }) });
      const worker = new LocalContainerToolExecutor({ workspaceHostPath: '/workspace/current',
        resourceBudget: computeWorkloadBudget(this.config.resourceBudget).tools,
        image: this.config.workerImage, ...(this.egress ? { egress: this.egress } : {}), containerUser: '10001:10001', forwardWorkerLogs: false,
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
      await this.egress?.stop(); this.egress = undefined;
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
    await this.stopRetrieval();
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
