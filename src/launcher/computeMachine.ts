import { ComputeInventory } from './computeInventory.js';
import { DesktopCompute, type DesktopComputeConfiguration } from './desktopCompute.js';
import { connectComputeWorkspace } from './computeClient.js';
import type { ComputeCapabilities } from '../contracts/computeDevice.js';
import type { ComputeExecution } from '../contracts/computeProtocol.js';

/** Headless lifecycle shared by a CLI and any future GUI. Ownership is acquired
 * before engine reconciliation and kept until the connection has stopped. */
export class ComputeMachine {
  private readonly inventory: ComputeInventory;
  private runtime?: DesktopCompute;
  private execution?: ComputeExecution;
  private connection?: Awaited<ReturnType<typeof connectComputeWorkspace>>;
  private connecting = false;
  private connectionAttempt?: Promise<Awaited<ReturnType<typeof connectComputeWorkspace>>>;
  private recoveryAttempt?: Promise<DesktopCompute>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: { stateRoot: string;
    workspaceImage: DesktopComputeConfiguration['workspaceImage']; workerImage: DesktopComputeConfiguration['workerImage'] }) {
    this.inventory = new ComputeInventory(options.stateRoot);
  }
  machineId(): string { return this.inventory.machineId(); }
  allocations() { return this.inventory.list(); }
  connect(options: { url: string; credential: string; capabilities: ComputeCapabilities; ca?: string }) {
    if (this.closed || this.connectionAttempt || this.connecting || this.runtime || this.recoveryAttempt) return Promise.reject(new Error('Compute machine already connected or closed'));
    this.connecting = true;
    return this.connectionAttempt = this.startConnection(options);
  }
  private async startConnection(options: { url: string; credential: string; capabilities: ComputeCapabilities; ca?: string }) {
    try {
      await DesktopCompute.reconcile(this.inventory.machineId());
      for (const row of this.inventory.list()) this.inventory.stopped(row.execution);
      if (this.closed) throw new Error('Compute connection cancelled');
      this.connection = await connectComputeWorkspace({ ...options,
        reconcile: async execution => {
          // An unknown allocation cannot establish that a previous installation
          // stopped: its engine ownership label may have belonged to another VM.
          if (this.inventory.find(execution)?.state !== 'stopped') throw new Error('Recorded compute allocation is unavailable');
        },
        assign: async execution => {
          if (this.closed) throw new Error('Compute assignment cancelled');
          const allocation = this.inventory.reserve(execution);
          this.execution = execution;
          const runtime = new DesktopCompute({ machineId: this.inventory.machineId(), allocationId: allocation.allocationId,
            workspaceImage: this.options.workspaceImage, workerImage: this.options.workerImage });
          this.runtime = runtime;
          try { await runtime.open(); this.inventory.active(execution); }
          catch (error) { this.inventory.unconfirmed(execution); throw error; }
          return { execute: command => runtime.command(command), tools: runtime.executor };
        },
        stopWorkloads: () => this.stopWorkloads(),
      });
      if (this.closed) { await this.connection.close(); throw new Error('Compute connection cancelled'); }
      return this.connection;
    } catch (error) { this.connecting = false; throw error; }
  }
  private async stopWorkloads(): Promise<void> {
    const execution = this.execution;
    try {
      await this.runtime?.close();
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
    await DesktopCompute.reconcile(this.inventory.machineId());
    for (const row of this.inventory.list()) this.inventory.stopped(row.execution);
    if (this.closed) throw new Error('Compute recovery cancelled');
    const runtime = new DesktopCompute({ machineId: this.inventory.machineId(), allocationId: allocation.allocationId,
      workspaceImage: this.options.workspaceImage, workerImage: this.options.workerImage, recovery: true });
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
