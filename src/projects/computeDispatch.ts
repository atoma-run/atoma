import { timed } from '../core/runtimeTiming.js';
import { previewClassificationSchema, type PreviewClassification } from '../contracts/preview.js';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { openStoreHandle } from '../core/stores.js';
import type { ProjectRun } from '../contracts/projects.js';
import type { ComputeResources, ComputeSession, ComputeRunProgress } from '../contracts/computeDevice.js';
import type { ProjectRunDriver } from './coordinator.js';
import { computeDeviceReady, type ComputeDeviceStore } from './computeDevices.js';
import type { ComputeConnection } from './computeConnection.js';
import { serveComputeBridge } from '../run/computeBridge.js';
import { COMPUTE_BRIDGE_ENV } from '../contracts/computeBridge.js';
import { remoteWorkspaceRuntime } from '../run/workspaceRpc.js';
import { receiveArtifactExport } from '../run/artifactTransfer.js';
import { declaredArtifactManifestSchema } from '../contracts/artifactManifest.js';
import { parseRunLog } from '../cli/burnin.js';
import { recordOmittedArtifacts, revalidateArtifactManifest } from './artifacts.js';
import { WorkspaceExportRefusedError } from '../contracts/workspaceProtocol.js';
import type { ComputeExecution } from '../contracts/computeProtocol.js';

function boundedFile(path: string, limit: number): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Invalid compute finalization record');
  return readFileSync(path, 'utf8');
}

const DDL = `CREATE TABLE IF NOT EXISTS compute_dispatches (
 run_id TEXT PRIMARY KEY REFERENCES project_runs(project_run_id),
 generation INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('executing','finalizing','transferred','interrupted')),
 updated_at TEXT NOT NULL
 );
CREATE TABLE IF NOT EXISTS compute_preview_observations (
 run_id TEXT PRIMARY KEY REFERENCES project_runs(project_run_id),
 classification_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS compute_result_notices (
 run_id TEXT PRIMARY KEY REFERENCES project_runs(project_run_id),
 noticed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS compute_result_waits (
 run_id TEXT PRIMARY KEY REFERENCES project_runs(project_run_id),
 since TEXT NOT NULL
);`;

/** When the files started waiting: the first driver stop after the runner
 * ended, else the journal's phase time (a driver that died left no stop). */
const WAITING_SINCE = 'MAX(d.updated_at, COALESCE(w.since, d.updated_at))';

/** This is a host-side transfer journal, never evidence of workload exit. */
export class ComputeDispatchStore {
  static open(path: string) { return new ComputeDispatchStore(openStoreHandle(path, DDL)); }
  constructor(private readonly db: Database.Database) { db.exec(DDL); }
  begin(runId: string, generation: number): void {
    this.db.prepare("INSERT INTO compute_dispatches VALUES(?,?,'executing',?)").run(runId, generation, new Date().toISOString());
  }
  phase(runId: string, generation: number, phase: 'finalizing' | 'transferred' | 'interrupted'): void {
    const changed = this.db.prepare('UPDATE compute_dispatches SET phase=?,updated_at=? WHERE run_id=? AND generation=?')
      .run(phase, new Date().toISOString(), runId, generation).changes;
    if (changed !== 1) throw new Error('Compute transfer journal unavailable');
  }
  recordPreview(runId: string, classification: PreviewClassification): void {
    const value = previewClassificationSchema.parse(classification);
    this.db.prepare('INSERT OR REPLACE INTO compute_preview_observations VALUES (?,?)').run(runId, JSON.stringify(value));
  }
  previewClassification(runId: string): PreviewClassification | undefined {
    const row = this.db.prepare('SELECT classification_json FROM compute_preview_observations WHERE run_id=?').get(runId) as { classification_json: string } | undefined;
    return row ? previewClassificationSchema.parse(JSON.parse(row.classification_json)) : undefined;
  }
  inspect(runId: string) {
    return this.db.prepare(`SELECT d.generation,d.phase,d.updated_at AS updatedAt,${WAITING_SINCE} AS waitingSince
      FROM compute_dispatches d LEFT JOIN compute_result_waits w ON w.run_id=d.run_id WHERE d.run_id=?`).get(runId) as
      { generation: number; phase: 'executing' | 'finalizing' | 'transferred' | 'interrupted'; updatedAt: string; waitingSince: string } | undefined;
  }
  /**
   * A driver let go of a run whose runner had ended, leaving its files on the
   * computer. Only the FIRST stop is kept: that is when the files started
   * waiting. Later automatic attempts on a connected computer would otherwise
   * keep moving the clock, and the requester would never be told.
   */
  transferStopped(runId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO compute_result_waits VALUES (?,?)').run(runId, new Date().toISOString());
  }
  /** Whether a device is connected and accepting work (`computeDeviceReady`). */
  deviceReady(deviceId: string): boolean { return computeDeviceReady(this.db, deviceId); }
  /** False once the shared handle was closed; the holder then reopens. */
  get usable(): boolean { return this.db.open; }
  /** Still-running runs whose files have waited since at or before `cutoff`,
   * and whose requester was not told yet; oldest first. */
  unnoticedFinalizingSince(cutoff: string, limit = 100): { runId: string; orgId: string; since: string }[] {
    return this.db.prepare(`SELECT d.run_id AS runId, r.org_id AS orgId, ${WAITING_SINCE} AS since FROM compute_dispatches d
      JOIN project_runs r ON r.project_run_id=d.run_id AND r.status='running'
      LEFT JOIN compute_result_waits w ON w.run_id=d.run_id
      WHERE d.phase='finalizing' AND ${WAITING_SINCE}<=? AND NOT EXISTS (SELECT 1 FROM compute_result_notices n WHERE n.run_id=d.run_id)
      ORDER BY since LIMIT ?`).all(cutoff, limit) as { runId: string; orgId: string; since: string }[];
  }
  /** One organisation's still-running runs whose transfer journal says `finalizing`. */
  finalizingRunsOf(orgId: string): { runId: string; orgId: string }[] {
    return this.db.prepare(`SELECT d.run_id AS runId, r.org_id AS orgId FROM compute_dispatches d
      JOIN project_runs r ON r.project_run_id=d.run_id AND r.status='running'
      WHERE d.phase='finalizing' AND r.org_id=? ORDER BY d.updated_at LIMIT 100`).all(orgId) as { runId: string; orgId: string }[];
  }
  /**
   * Claim the ONE results-waiting notice of a run: true for exactly one
   * caller, across processes and restarts. Claimed before the journal row is
   * written, so a crash between the two loses a notice rather than repeating it.
   */
  claimResultsNotice(runId: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO compute_result_notices VALUES (?,?)').run(runId, new Date().toISOString()).changes === 1;
  }
}

export class ComputeDispatchPendingError extends Error {
  /** `reachedDevice`: this attempt held the device's slot, so its close made
   * the device reconnect; a new connection then says nothing new. */
  constructor(readonly reachedDevice = false) { super('Customer compute disconnected or finalization incomplete; it resumes when the device reconnects'); }
}

/** The device's publication inventory refused the finished workspace. The same
 * tree refuses again, so finalization ends here exactly as a hosted run's
 * would: `log` is the runner's persisted result, whose spend is kept. */
export class ComputeFinalizationRefusedError extends Error {
  constructor(readonly log: string, readonly refusal: WorkspaceExportRefusedError) {
    super(refusal.message);
    this.name = 'ComputeFinalizationRefusedError';
  }
}

/** A pending dispatch keeps its row running; its cause must still be readable. */
function logPending(runId: string, stage: string, error: unknown): void {
  const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`[atoma compute] ${stage} of ${runId} remains pending: ${cause.replace(/\s+/g, ' ').slice(0, 2_000)}\n`);
}

/** The existing host child retains models, accounting and connectors. Only
 * typed workspace/tool calls cross WSS; credentials never enter the bridge. */
export class ComputeDispatcher {
  constructor(private readonly options: {
    devices: ComputeDeviceStore; journal: ComputeDispatchStore; resources: ComputeResources;
    connectionFor: (session: ComputeSession) => ComputeConnection | undefined;
  }) {}
  progress(run: ProjectRun): ComputeRunProgress | null {
    if (run.executionTarget.kind !== 'customer-device' || run.status !== 'running') return null;
    const record = this.options.journal.inspect(run.projectRunId);
    if (!record) return null;
    if (record.phase !== 'interrupted') return record.phase;
    return this.options.devices.confirmedStop(run.executionTarget.deviceId, run.projectRunId, record.generation)
      ? 'stopped' : 'stop-confirmation-pending';
  }
  readiness(run: ProjectRun) {
    let admission;
    try { admission = this.options.devices.admission({ orgId: run.orgId, principalId: run.requestedByPrincipalId }, run.projectRunId, this.options.resources); }
    catch { return { status: 'waiting' as const, reason: 'access-unavailable' as const }; }
    if (admission.status === 'ready' && !this.options.devices.supports(admission.session, 'retrieval')) return { status: 'waiting' as const, reason: 'version-incompatible' as const };
    if (admission.status === 'ready' && !this.options.connectionFor(admission.session)) return { status: 'waiting' as const, reason: 'disconnected' as const };
    return admission;
  }
  previewClassification(runId: string) { return this.options.journal.previewClassification(runId); }
  /** Best-effort: a store fault here must never replace the pending outcome. */
  private transferStopped(runId: string): void {
    try { this.options.journal.transferStopped(runId); }
    catch (error) { logPending(runId, 'waiting-since record', error); }
  }
  interruptedStopped(run: ProjectRun): boolean {
    const record = this.options.journal.inspect(run.projectRunId);
    if (run.executionTarget.kind !== 'customer-device') return false;
    if (!record) return this.options.devices.confirmedRunStop(run.executionTarget.deviceId, run.projectRunId);
    return       (record.phase === 'executing' || record.phase === 'interrupted') &&
      this.options.devices.confirmedStop(run.executionTarget.deviceId, run.projectRunId, record.generation);
  }
  /** A finished run whose transfer may be abandoned (its cancellation was
   * requested): only the transfer was left, and a launcher reported the
   * workload stopped with no slot still held for this run. */
  finishedStopped(run: ProjectRun): boolean {
    if (run.executionTarget.kind !== 'customer-device') return false;
    const phase = this.options.journal.inspect(run.projectRunId)?.phase;
    return (phase === 'finalizing' || phase === 'transferred') &&
      this.options.devices.confirmedRunStop(run.executionTarget.deviceId, run.projectRunId);
  }
  private async receive(run: ProjectRun, peer: ComputeConnection, execution: ComputeExecution, log: string, manifestPath: string) {
    const outcome = parseRunLog(log).outcome;
    if (outcome !== 'delivered' && outcome !== 'partial') return;
    const declarations = declaredArtifactManifestSchema.parse(JSON.parse(boundedFile(manifestPath, 2 * 1024 ** 2)));
    if (declarations.runId !== run.projectRunId) throw new Error('Compute artifact declaration mismatch');
    const workspace = remoteWorkspaceRuntime(command => peer.request(execution, command));
    const classification = await workspace.classifyPreview();
    const exporting = await workspace.artifactExport({ allowEmpty: outcome === 'partial',
      ...(declarations.delivery ? { delivery: declarations.delivery } : {}) });
    if (existsSync(run.hostPaths.workspacePath)) {
      // A crash may happen after atomic directory publication and before the
      // journal commit. Verify the saved bytes; never overwrite or replay tools.
      // The export that published that copy already logged its omissions.
      try { revalidateArtifactManifest({ workspaceRoot: run.hostPaths.workspacePath, manifest: exporting.manifest }); }
      finally { await exporting.close(); }
    } else {
      await receiveArtifactExport(exporting, run.hostPaths.workspacePath);
      recordOmittedArtifacts(run.hostPaths.logPath, run.projectRunId, exporting.omitted);
    }
    // Remote observations describe only the verified delivery, never platform trust.
    const admitted = classification.entry === null || exporting.manifest.files.some(file => file.path === classification.entry);
    this.options.journal.recordPreview(run.projectRunId, admitted ? classification : {
      availability: 'unavailable', kind: null, entry: null, unavailableReason: 'not-runnable',
    });
  }
  /** Whether `recover` could finish this pending transfer now, without asking
   * anyone: a key naming the connection it would use (a new one on every
   * reconnection), `transferred` when the bytes are already here, else null.
   * Advisory and read-only: `recover`'s assign rechecks every authority. A
   * device that still holds an execution slot (its own stop not yet reported,
   * or another run) is never attempted. */
  finalizationReady(run: ProjectRun): string | null {
    if (run.executionTarget.kind !== 'customer-device' || run.status !== 'running') return null;
    const record = this.options.journal.inspect(run.projectRunId);
    if (record?.phase === 'transferred') return 'transferred';
    if (record?.phase !== 'finalizing') return null;
    try {
      const session = this.options.devices.currentSession(run.executionTarget.deviceId);
      if (!session || !this.options.connectionFor(session) || !this.options.devices.unassigned(session.deviceId)) return null;
      return `connection:${session.sessionId}:${session.generation}`;
    } catch { return null; }
  }
  /** Finalization only, explicit or automatic: no model or tool invocation is resumed. */
  async recover(run: ProjectRun, manifestPath: string): Promise<string> {
    if (run.executionTarget.kind !== 'customer-device' || run.status !== 'running') throw new Error('Compute recovery requires a pending remote run');
    const record = this.options.journal.inspect(run.projectRunId);
    if (!record || !['finalizing', 'transferred'].includes(record.phase)) throw new Error('Execution was interrupted before finalization; reconcile stop and use an eligible checkpoint or start a new run');
    const log = boundedFile(run.hostPaths.logPath + '.compute-result', 64 * 1024 ** 2);
    if (record.phase === 'transferred') return log;
    const session = this.options.devices.currentSession(run.executionTarget.deviceId);
    const peer = session && this.options.connectionFor(session);
    if (!session || !peer) { logPending(run.projectRunId, 'finalization', new Error('device not connected')); throw new ComputeDispatchPendingError(); }
    const assignment = this.options.devices.assign({ orgId: run.orgId, principalId: run.requestedByPrincipalId }, session, run.projectRunId, this.options.resources);
    const execution = { runId: run.projectRunId, generation: assignment.generation };
    try {
      await peer.bind(execution, { runId: run.projectRunId, generation: record.generation });
      await this.receive(run, peer, execution, log, manifestPath);
      this.options.journal.phase(run.projectRunId, record.generation, 'transferred');
      return log;
    } catch (error) {
      if (error instanceof WorkspaceExportRefusedError) throw new ComputeFinalizationRefusedError(log, error);
      this.transferStopped(run.projectRunId);
      logPending(run.projectRunId, 'finalization', error);
      throw new ComputeDispatchPendingError(true);
    } finally { peer.close('dispatch-finished'); }
  }
  async drive(run: ProjectRun, driver: ProjectRunDriver, input: Parameters<ProjectRunDriver>[0], manifestPath: string): Promise<string> {
    if (run.executionTarget.kind !== 'customer-device') throw new Error('Compute dispatch requires a customer device receipt');
    // The coordinator has just moved the receipt to running. assign rechecks
    // authority and resources transactionally, without relying on readiness.
    const session = this.options.devices.currentSession(run.executionTarget.deviceId);
    const peer = session && this.options.connectionFor(session);
    if (!session || !peer) { logPending(run.projectRunId, 'dispatch', new Error('device not connected')); throw new ComputeDispatchPendingError(); }
    const assignment = this.options.devices.assign({ orgId: run.orgId, principalId: run.requestedByPrincipalId }, session, run.projectRunId, this.options.resources);
    const execution = { runId: run.projectRunId, generation: assignment.generation };
    let bridge: Awaited<ReturnType<typeof serveComputeBridge>> | undefined;
    let finalizing: string | undefined;
    try {
      this.options.journal.begin(run.projectRunId, execution.generation);
      input.signal?.throwIfAborted();
      await timed(input.onTiming, 'handoff', () => peer.bind(execution));
      bridge = await serveComputeBridge(call => call.channel === 'workspace'
        ? peer.request(execution, call.command) : call.channel === 'retrieval' ? peer.requestRetrieval(execution, call.command) : peer.requestTool(execution, call.command));
      const log = await driver({ ...input, signal: AbortSignal.any([peer.signal, ...(input.signal ? [input.signal] : [])]), env: { ...input.env, [COMPUTE_BRIDGE_ENV]: JSON.stringify(bridge.address) } });
      peer.signal.throwIfAborted();
      // Persist the exact return value before the network transfer. The regular
      // driver log is best-effort; this finalization record is mandatory.
      if (Buffer.byteLength(log) > 64 * 1024 ** 2) throw new Error('Compute result exceeds limit');
      writeFileSync(input.logPath + '.compute-result', log, { mode: 0o600, flush: true });
      this.options.journal.phase(run.projectRunId, execution.generation, 'finalizing');
      finalizing = log;
      await timed(input.onTiming, 'handoff', async () => {
        await peer.requestTool(execution, { method: 'drain' });
        await this.receive(run, peer, execution, log, manifestPath);
      });
      this.options.journal.phase(run.projectRunId, execution.generation, 'transferred');
      return log;
    } catch (error) {
      if (finalizing !== undefined && error instanceof WorkspaceExportRefusedError) throw new ComputeFinalizationRefusedError(finalizing, error);
      logPending(run.projectRunId, finalizing === undefined ? 'dispatch' : 'finalization', error);
      if (finalizing !== undefined) this.transferStopped(run.projectRunId);
      if (finalizing === undefined && this.options.journal.inspect(run.projectRunId)) this.options.journal.phase(run.projectRunId, execution.generation, 'interrupted');
      throw new ComputeDispatchPendingError(true);
    } finally {
      try { await bridge?.close(); } finally { peer.close(finalizing !== undefined ? 'dispatch-finished' : 'dispatch-interrupted'); }
      // Closing requests local lease teardown. It is never an exit assertion;
      // the slot remains held until a fresh launcher confirms the exact stop.
    }
  }
}
