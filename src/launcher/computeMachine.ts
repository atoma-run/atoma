import { computeDiagnosticLog } from './computeDiagnosticLog.js';
import type { ComputeResourceBudget } from '../contracts/computeLocal.js';
import { COMPUTE_DISK_RESERVE_BYTES } from './computeDisk.js';
import { COMPUTE_RUN_RESOURCES } from '../contracts/computeProject.js';
import { ComputeTransfers } from './computeTransfers.js';
import { DesktopPreview } from './desktopPreview.js';
import type { ComputePreviewIdentity, ComputePreviewCommand } from '../contracts/computePreview.js';
import { ComputeInventory } from './computeInventory.js';
import { DesktopCompute, type DesktopComputeConfiguration } from './desktopCompute.js';
import { connectComputeWorkspace } from './computeClient.js';
import type { ComputeCapabilities } from '../contracts/computeDevice.js';
import type { ComputeExecution } from '../contracts/computeProtocol.js';

/** Headless lifecycle shared by a CLI and any future GUI. Ownership is acquired
 * before engine reconciliation and kept until the connection has stopped. */
export class ComputeMachine {
  private diskTimer?: ReturnType<typeof setInterval>;
  private checkingDisk = false;
  private freeDisk?: number;
  private readonly transfers = new ComputeTransfers();
  private readonly inventory: ComputeInventory;
  private budget?: ComputeResourceBudget;
  private runtime?: DesktopCompute;
  private preview?: DesktopPreview;
  private execution?: ComputeExecution;
  private connection?: Awaited<ReturnType<typeof connectComputeWorkspace>>;
  private connecting = false;
  private connectionAttempt?: Promise<Awaited<ReturnType<typeof connectComputeWorkspace>>>;
  private recoveryAttempt?: Promise<DesktopCompute>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: { stateRoot: string; resourceBudget?: () => Promise<ComputeResourceBudget>;
    workspaceImage: DesktopComputeConfiguration['workspaceImage']; workerImage: DesktopComputeConfiguration['workerImage']; retrievalImage?: DesktopComputeConfiguration['retrievalImage']; previewImage?: string; egress?: boolean }) {
    this.inventory = new ComputeInventory(options.stateRoot);
  }
  resourceBudget() { return this.budget; }
  machineId(): string { return this.inventory.machineId(); }
  allocations() { return this.inventory.list(); }
  transferProgress() { return this.transfers.list(); }
  diskStatus() { return { freeBytes: this.freeDisk ?? null, reserveBytes: COMPUTE_DISK_RESERVE_BYTES }; }
  connect(options: { url: string; credential: string; capabilities: ComputeCapabilities; ca?: string; onDisconnect?: () => void }) {
    // A new socket is allowed only after the old lease's engine teardown.
    // The inventory lock remains held; no previous execution is reactivated.
    if (!this.closed && this.connection?.state() === 'stopped') {
      this.connection = undefined; this.connectionAttempt = undefined;
      this.runtime = undefined; this.execution = undefined; this.connecting = false;
    }
    if (this.closed || this.connectionAttempt || this.connecting || this.runtime || this.recoveryAttempt) return Promise.reject(new Error('Compute machine already connected or closed'));
    this.connecting = true;
    return this.connectionAttempt = this.startConnection(options);
  }
  private async startConnection(options: { url: string; credential: string; capabilities: ComputeCapabilities; ca?: string; onDisconnect?: () => void }) {
    try {
      await DesktopCompute.reconcile(this.inventory.machineId(), this.options.workerImage);
      for (const row of this.inventory.list()) this.inventory.stopped(row.execution);
      if (this.closed) throw new Error('Compute connection cancelled');
      this.connection = await connectComputeWorkspace({ ...options, diagnostic: computeDiagnosticLog(this.options.stateRoot), machineId: this.inventory.machineId(),
        reconcile: async execution => {
          // The authenticated credential is bound to this inventory's machine
          // identity. Boot just proved every workload under that identity absent,
          // including an assignment lost before its first frame reached us.
          if (!this.inventory.find(execution)) {
            this.inventory.reserve(execution); this.inventory.stopped(execution);
          }
          if (this.inventory.find(execution)?.state !== 'stopped') throw new Error('Recorded compute allocation is unavailable');
        },
        assign: async (execution, recover) => {
          if (this.closed) throw new Error('Compute assignment cancelled');
          const allocation = this.inventory.reserve(execution, recover);
          this.execution = execution;
          this.budget = await this.options.resourceBudget?.();
          const runtime = new DesktopCompute({ machineId: this.inventory.machineId(), allocationId: allocation.allocationId,
            resourceBudget: this.budget, workspaceImage: this.options.workspaceImage, workerImage: this.options.workerImage, retrievalImage: this.options.retrievalImage, recovery: Boolean(recover), egress: this.options.egress });
          this.runtime = runtime;
          try {
            await runtime.open();
            this.freeDisk = await runtime.freeDiskBytes();
            if (this.freeDisk < (recover ? COMPUTE_DISK_RESERVE_BYTES : COMPUTE_RUN_RESOURCES.diskBytes)) throw new Error('Insufficient free Linux disk space');
            this.inventory.active(execution);
          }
          catch (error) { this.inventory.unconfirmed(execution); throw error; }
          return { execute: async command => {
            if (command.method === 'checkpoint-confirmed') {
              this.inventory.confirmCheckpoint(execution, command.confirmation);
              return { method: command.method, value: null };
            }
            const reply = await runtime.command(command);
            this.transfers.observe(command, reply);
            return reply;
          }, ...(recover ? {} : { tools: runtime.executor, retrieval: command => runtime.retrievalCommand(command) }) };
        },
        preview: (identity, command) => this.previewCommand(identity, command),
        stopWorkloads: () => this.stopWorkloads(),
      });
      if (this.closed) { await this.connection.close(); throw new Error('Compute connection cancelled'); }
      this.diskTimer = setInterval(() => { void this.checkDisk(); }, 10_000); this.diskTimer.unref();
      return this.connection;
    } catch (error) { this.connecting = false; throw error; }
  }
  private async previewCommand(identity: ComputePreviewIdentity, command: ComputePreviewCommand) {
    if (this.closed || !this.options.previewImage) throw new Error('Compute preview unavailable');
    if (command.method === 'start') {
      if (this.preview) throw new Error('Compute preview slot occupied');
      const allocation = [...this.inventory.list()].filter(row => row.execution.runId === identity.runId)
        .sort((a, b) => b.execution.generation - a.execution.generation)[0];
      if (!allocation || allocation.state === 'unconfirmed' || allocation.state === 'allocating') throw new Error('Compute preview source unavailable');
      this.preview = new DesktopPreview(identity, { machineId: this.inventory.machineId(), allocationId: allocation.allocationId,
        workspaceImage: this.options.workspaceImage, workerImage: this.options.workerImage, previewImage: this.options.previewImage });
    }
    const preview = this.preview;
    if (!preview) throw new Error('Compute preview unavailable');
    try {
      const result = await preview.execute(identity, command);
      if (command.method === 'stop') this.preview = undefined;
      return result;
    } catch (error) {
      // A refused start removed its containers; kept, the slot refused every
      // later start until the app restarted (2026-10-23).
      if (command.method === 'start' && this.preview === preview) this.preview = undefined;
      throw error;
    }
  }
  private async checkDisk(): Promise<void> {
    const connection = this.connection;
    if (this.checkingDisk || this.closed || !connection || connection.state() !== 'active') return;
    if (this.runtime && this.execution && this.inventory.find(this.execution)?.state !== 'active') return;
    this.checkingDisk = true;
    try {
      const available = this.runtime ? await this.runtime.freeDiskBytes() : await this.preview?.freeDiskBytes();
      if (connection !== this.connection) return;
      if (available !== undefined) {
        this.freeDisk = available;
        if (available < COMPUTE_DISK_RESERVE_BYTES) await connection.close();
      }
    } catch { await connection.close(); }
    finally { this.checkingDisk = false; }
  }
  private async stopWorkloads(): Promise<void> {
    clearInterval(this.diskTimer); this.diskTimer = undefined;
    const execution = this.execution;
    this.transfers.interrupted();
    try {
      const stopped = await Promise.allSettled([this.runtime?.close(), this.preview?.close()]);
      if (stopped.some(result => result.status === 'rejected')) throw new Error('Compute workload stop unconfirmed');
      this.preview = undefined;
      if (execution) this.inventory.stopped(execution);
    } catch (error) {
      if (execution) this.inventory.unconfirmed(execution);
      throw error;
    }
  }
  /** Engine-confirmed read-only recovery. The caller must acquire a fresh
   * server generation before exposing these exports through a remote channel. */
  recover(execution: ComputeExecution): Promise<DesktopCompute> {
    if (this.closed || this.connectionAttempt || this.connecting || this.runtime || this.recoveryAttempt) return Promise.reject(new Error('Compute recovery requires an idle owner'));
    return this.recoveryAttempt = this.startRecovery(execution);
  }
  private async startRecovery(execution: ComputeExecution): Promise<DesktopCompute> {
    const allocation = this.inventory.find(execution);
    if (!allocation) throw new Error('Compute allocation unavailable');
    await DesktopCompute.reconcile(this.inventory.machineId(), this.options.workerImage);
    for (const row of this.inventory.list()) this.inventory.stopped(row.execution);
    if (this.closed) throw new Error('Compute recovery cancelled');
    const runtime = new DesktopCompute({ machineId: this.inventory.machineId(), allocationId: allocation.allocationId,
      workspaceImage: this.options.workspaceImage, workerImage: this.options.workerImage, retrievalImage: this.options.retrievalImage, recovery: true });
    this.execution = execution; this.runtime = runtime;
    await runtime.open(); return runtime;
  }
  close(): Promise<void> { return this.closing ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.closed = true;
    try {
      await this.connectionAttempt?.catch(() => undefined);
      await this.recoveryAttempt?.catch(() => undefined);
      const confirmed = await this.connection?.close();
      if (confirmed === false) throw new Error('Compute workload stop remains unconfirmed');
      await this.stopWorkloads();
    } finally { this.inventory.close(); }
  }
}
