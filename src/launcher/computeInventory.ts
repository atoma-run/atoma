import { checkpointConfirmationSchema, type CheckpointConfirmation } from '../contracts/checkpointTransfer.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { computeLocalJournalSchema, type ComputeLocalAllocation } from '../contracts/computeLocal.js';
import { computeExecutionSchema, type ComputeExecution } from '../contracts/computeProtocol.js';

/** Local operational inventory, never the product DB. Like WorkspaceVolumes,
 * an empty SQLite file is an OS-released single-owner mutex; the separately
 * fsynced journal survives a killed launcher without rollback. */
export class ComputeInventory {
  private readonly mutex: DatabaseSync;
  private readonly path: string;
  private journal: ReturnType<typeof computeLocalJournalSchema.parse>;
  private closed = false;
  private poisoned = false;
  constructor(private readonly root: string) {
    if (!isAbsolute(root) || realpathSync(root) !== resolve(root) || !lstatSync(root).isDirectory()) throw new Error('Compute state requires a real directory');
    if (process.platform !== 'win32' && (lstatSync(root).mode & 0o077) !== 0) throw new Error('Compute state must be private');
    this.path = join(root, 'inventory.json');
    const lock = join(root, 'owner.db');
    for (const file of [lock, this.path]) if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error('Invalid compute state file');
    this.mutex = new DatabaseSync(lock);
    try {
      this.mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      if (existsSync(this.path) && lstatSync(this.path).size > 1024 * 1024) throw new Error('Compute inventory exceeds limit');
      this.journal = existsSync(this.path) ? computeLocalJournalSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
        : { version: 1, machineId: randomUUID(), allocations: [] };
      // Crash or sleep never establishes process absence. Reconciliation must
      // ask the engine before acknowledging these generations to the server.
      for (const row of this.journal.allocations) if (row.state !== 'stopped') row.state = 'unconfirmed';
      this.persist();
    } catch (error) { this.mutex.close(); throw error; }
  }
  private assertOpen() { if (this.closed || this.poisoned) throw new Error('Compute inventory unavailable; restart required'); }
  private persist() {
    this.assertOpen();
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const bytes = JSON.stringify(computeLocalJournalSchema.parse(this.journal));
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
      if (process.platform !== 'win32') {
        chmodSync(this.path, 0o600);
        const directory = openSync(this.root, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } catch (error) { this.poisoned = true; throw error; }
    finally { rmSync(temporary, { force: true }); }
  }
  machineId(): string { this.assertOpen(); return this.journal.machineId; }
  list(): ComputeLocalAllocation[] { this.assertOpen(); return structuredClone(this.journal.allocations); }
  find(execution: ComputeExecution): ComputeLocalAllocation | undefined {
    computeExecutionSchema.parse(execution);
    return this.list().find(row => row.execution.runId === execution.runId && row.execution.generation === execution.generation);
  }
  reserve(input: ComputeExecution, recover?: ComputeExecution): ComputeLocalAllocation {
    this.assertOpen();
    const execution = computeExecutionSchema.parse(input);
    if (this.journal.allocations.length >= 1000) throw new Error('Compute inventory is full; retained volumes require cleanup');
    if (this.journal.allocations.some(row => row.state !== 'stopped') || this.find(execution)) throw new Error('Compute allocation requires reconciliation or a new generation');
    const source = recover ? this.find(recover) : undefined;
    if (recover && (!source || source.state !== 'stopped' || recover.runId !== execution.runId || recover.generation >= execution.generation)) throw new Error('Recovery requires a stopped earlier allocation of this run');
    const row: ComputeLocalAllocation = { execution, allocationId: source?.allocationId ?? randomUUID(), state: 'allocating', createdAt: Date.now() };
    this.journal.allocations.push(row); this.persist(); return structuredClone(row);
  }
  confirmCheckpoint(execution: ComputeExecution, input: CheckpointConfirmation): void {
    this.assertOpen();
    const row = this.row(execution);
    if (row.state !== 'active') throw new Error('Checkpoint confirmation requires an active execution');
    row.checkpoint = checkpointConfirmationSchema.parse(input); this.persist();
  }
  active(execution: ComputeExecution): void {
    this.assertOpen();
    const row = this.row(execution);
    if (row.state !== 'allocating') throw new Error('Compute allocation cannot be activated');
    row.state = 'active'; this.persist();
  }
  /** Call only after engine-confirmed teardown; no deadline path calls this. */
  stopped(execution: ComputeExecution): void {
    this.assertOpen(); const row = this.row(execution); row.state = 'stopped'; this.persist();
  }
  unconfirmed(execution: ComputeExecution): void {
    this.assertOpen(); const row = this.row(execution); row.state = 'unconfirmed'; this.persist();
  }
  private row(execution: ComputeExecution) {
    computeExecutionSchema.parse(execution);
    const row = this.journal.allocations.find(row => row.execution.runId === execution.runId && row.execution.generation === execution.generation);
    if (!row) throw new Error('Unknown compute allocation');
    return row;
  }
  close(): void { if (!this.closed) { this.closed = true; this.mutex.close(); } }
}
