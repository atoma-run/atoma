import { COMPUTE_RUN_RESOURCES, computeProjectViewSchema, type ComputeProjectView } from '../contracts/computeProject.js';
import { executionTargetSchema, executionTargetSettingSchema } from '../contracts/executionTarget.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { openStoreHandle } from '../core/stores.js';
import { COMPUTE_LEASE_MS, COMPUTE_PAIRING_MS, computeActorSchema, computeCapabilitiesSchema,
  computeResourcesSchema, computeSessionSchema, type ComputeResources, type ComputeActor, type ComputeCapabilities, type ComputeSession, type ComputeAssignment, type ComputeAdmission } from '../contracts/computeDevice.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const pairingCode = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const secretHash = z.string().regex(/^[a-f0-9]{64}$/);
const nameSchema = z.string().trim().min(1).max(120).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
const DDL = `
CREATE TABLE IF NOT EXISTS compute_pairings (
 code_hash TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, name TEXT NOT NULL,
 expires_at INTEGER NOT NULL, org_id TEXT, principal_id TEXT
);
CREATE TABLE IF NOT EXISTS compute_devices (
 device_id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES auth_organisations(org_id),
 principal_id TEXT NOT NULL REFERENCES auth_principals(principal_id), name TEXT NOT NULL,
 credential_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
 accepting INTEGER NOT NULL DEFAULT 1 CHECK(accepting IN (0,1)),
 session_id TEXT, connection_generation INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
 capabilities TEXT, execution_generation INTEGER NOT NULL DEFAULT 0,
 run_id TEXT UNIQUE, project_id TEXT, assignment_state TEXT CHECK(assignment_state IN ('active','indeterminate')),
 CHECK((run_id IS NULL AND project_id IS NULL AND assignment_state IS NULL) OR
       (run_id IS NOT NULL AND project_id IS NOT NULL AND assignment_state IS NOT NULL)),
 FOREIGN KEY(run_id,org_id) REFERENCES project_runs(project_run_id,org_id),
 FOREIGN KEY(project_id,org_id) REFERENCES projects(project_id,org_id)
);
CREATE TABLE IF NOT EXISTS compute_device_machines (
 device_id TEXT PRIMARY KEY REFERENCES compute_devices(device_id), machine_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS compute_stop_reports (
 device_id TEXT NOT NULL REFERENCES compute_devices(device_id), run_id TEXT NOT NULL REFERENCES project_runs(project_run_id),
 generation INTEGER NOT NULL, stopped_at INTEGER NOT NULL, PRIMARY KEY(device_id,run_id,generation)
);
CREATE TABLE IF NOT EXISTS compute_device_projects (
 device_id TEXT NOT NULL REFERENCES compute_devices(device_id), project_id TEXT NOT NULL REFERENCES projects(project_id),
 PRIMARY KEY(device_id,project_id)
);
CREATE TRIGGER IF NOT EXISTS compute_member_removed AFTER DELETE ON auth_memberships BEGIN
 UPDATE compute_devices SET revoked=1, session_id=NULL, lease_until=0, connection_generation=connection_generation+1,
 assignment_state=CASE WHEN run_id IS NULL THEN NULL ELSE 'indeterminate' END
 WHERE org_id=OLD.org_id AND principal_id=OLD.principal_id;
 UPDATE compute_devices SET assignment_state='indeterminate' WHERE run_id IN
 (SELECT project_run_id FROM project_runs WHERE org_id=OLD.org_id AND requested_by_principal_id=OLD.principal_id);
 DELETE FROM compute_pairings WHERE org_id=OLD.org_id AND principal_id=OLD.principal_id;
END;
CREATE TRIGGER IF NOT EXISTS compute_member_downgraded AFTER UPDATE OF role ON auth_memberships
WHEN NEW.role='org:viewer' BEGIN
 UPDATE compute_devices SET revoked=1, session_id=NULL, lease_until=0, connection_generation=connection_generation+1,
 assignment_state=CASE WHEN run_id IS NULL THEN NULL ELSE 'indeterminate' END
 WHERE org_id=NEW.org_id AND principal_id=NEW.principal_id;
 UPDATE compute_devices SET assignment_state='indeterminate' WHERE run_id IN
 (SELECT project_run_id FROM project_runs WHERE org_id=NEW.org_id AND requested_by_principal_id=NEW.principal_id);
 DELETE FROM compute_pairings WHERE org_id=NEW.org_id AND principal_id=NEW.principal_id;
END;
CREATE TRIGGER IF NOT EXISTS compute_project_archived AFTER UPDATE OF status ON projects
WHEN NEW.status='archived' BEGIN
 UPDATE compute_devices SET assignment_state='indeterminate' WHERE project_id=NEW.project_id AND run_id IS NOT NULL;
END;`;

class ComputeSessionExpired extends Error {}

interface DeviceRow {
  device_id: string; org_id: string; principal_id: string; name: string; revoked: number; accepting: number;
  session_id: string | null; connection_generation: number; lease_until: number; capabilities: string | null;
  execution_generation: number; run_id: string | null; project_id: string | null; assignment_state: 'active' | 'indeterminate' | null;
}

/** Private control-plane domain. No network entrypoint and no engine access.
 * Uses the existing product connection, after auth/project schema initialization. */
export class ComputeDeviceStore {
  static open(dbPath: string, policy: { appVersions: ReadonlySet<string>; imageDigests: ReadonlySet<string> }): ComputeDeviceStore {
    if (!dbPath) throw new Error('ComputeDeviceStore requires the selected product DB path');
    return new ComputeDeviceStore(openStoreHandle(dbPath, DDL), policy);
  }

  constructor(private readonly db: Database.Database, private readonly policy: {
    appVersions: ReadonlySet<string>; imageDigests: ReadonlySet<string>;
  }, private readonly now: () => number = Date.now) { db.exec(DDL); }

  private member(actor: ComputeActor): string {
    computeActorSchema.parse(actor);
    const row = this.db.prepare('SELECT role FROM auth_memberships WHERE org_id=? AND principal_id=?')
      .get(actor.orgId, actor.principalId) as { role: string } | undefined;
    if (!row || row.role === 'org:viewer') throw new Error('Compute membership unavailable');
    return row.role;
  }
  private device(id: string): DeviceRow {
    const row = this.db.prepare('SELECT * FROM compute_devices WHERE device_id=?').get(id) as DeviceRow | undefined;
    if (!row) throw new Error('Compute device unavailable');
    return row;
  }
  private manage(actor: ComputeActor, id: string): DeviceRow {
    const role = this.member(actor), device = this.device(id);
    if (device.org_id !== actor.orgId || (device.principal_id !== actor.principalId && !['org:owner', 'org:admin'].includes(role))) {
      throw new Error('Compute device unavailable');
    }
    return device;
  }
  private authenticated(credential: string): DeviceRow {
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('Compute credential unavailable');
    const row = this.db.prepare('SELECT * FROM compute_devices WHERE credential_hash=?').get(digest(credential)) as DeviceRow | undefined;
    if (!row || row.revoked) throw new Error('Compute credential unavailable');
    this.member({ orgId: row.org_id, principalId: row.principal_id });
    return row;
  }
  private session(session: ComputeSession): DeviceRow {
    computeSessionSchema.parse(session);
    const row = this.device(session.deviceId);
    this.member({ orgId: row.org_id, principalId: row.principal_id });
    if (row.revoked || row.session_id !== session.sessionId || row.connection_generation !== session.generation) {
      throw new Error('Compute session expired or superseded');
    }
    if (row.lease_until <= this.now()) throw new ComputeSessionExpired('Compute session expired');
    return row;
  }
  private fenceExpiry<T>(session: ComputeSession, operation: () => T): T {
    try { return operation(); }
    catch (error) {
      // Outside the failed transaction: rollback must not undo the expiry fence.
      if (error instanceof ComputeSessionExpired) this.disconnect(session);
      throw error;
    }
  }
  private credentialSession(credential: string, session: ComputeSession): DeviceRow {
    if (this.authenticated(credential).device_id !== session.deviceId) throw new Error('Compute session unavailable');
    return this.session(session);
  }

  pairingDescription(code: string): { name: string } {
    pairingCode.parse(code);
    const row = this.db.prepare('SELECT name FROM compute_pairings WHERE code_hash=? AND expires_at>? AND org_id IS NULL')
      .get(digest(code), this.now()) as { name: string } | undefined;
    if (!row) throw new Error('Compute pairing unavailable');
    return row;
  }
  list(actor: ComputeActor) {
    const role = this.member(actor), admin = ['org:owner', 'org:admin'].includes(role);
    const rows = this.db.prepare('SELECT device_id FROM compute_devices WHERE org_id=? AND (? OR principal_id=?) ORDER BY name,device_id LIMIT 100')
      .all(actor.orgId, Number(admin), actor.principalId) as { device_id: string }[];
    return rows.map(row => this.inspect(actor, row.device_id));
  }
  private hostedAllowed(principalId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM auth_platform_admins WHERE principal_id=?').get(principalId));
  }
  projectView(actor: ComputeActor, projectId: string): ComputeProjectView {
    const role = this.member(actor);
    const project = this.db.prepare("SELECT execution_target_json FROM projects WHERE project_id=? AND org_id=? AND status='active'")
      .get(z.string().uuid().parse(projectId), actor.orgId) as { execution_target_json: string | null } | undefined;
    if (!project) throw new Error('Compute project unavailable');
    return computeProjectViewSchema.parse({ projectId, target: project.execution_target_json ? JSON.parse(project.execution_target_json) : { kind: 'hosted' },
      hostedAllowed: this.hostedAllowed(actor.principalId), canEdit: ['org:owner', 'org:admin'].includes(role), devices: this.list(actor).map(device => {
        const row = this.device(device.deviceId);
        const caps = row.capabilities ? computeCapabilitiesSchema.parse(JSON.parse(row.capabilities)) : undefined;
        const availability = device.revoked ? 'access-unavailable' : !device.connected ? 'disconnected' : device.assignment ? 'busy'
          : !device.accepting ? 'not-accepting' : !caps || !this.policy.appVersions.has(caps.appVersion) || !this.policy.imageDigests.has(caps.imageDigest) || !caps.services?.includes('retrieval')
            ? 'version-incompatible' : caps.cpus < COMPUTE_RUN_RESOURCES.cpus || caps.memoryBytes < COMPUTE_RUN_RESOURCES.memoryBytes || caps.diskBytes < COMPUTE_RUN_RESOURCES.diskBytes
              ? 'resources-insufficient' : 'ready';
        return { deviceId: device.deviceId, name: device.name, revoked: device.revoked, availability,
          allowed: Boolean(this.db.prepare('SELECT 1 FROM compute_device_projects WHERE device_id=? AND project_id=?').get(device.deviceId, projectId)) };
      }) });
  }
  beginPairing(input: { secretHash: string; name: string }): { code: string; expiresAt: number } {
    const hash = secretHash.parse(input.secretHash), name = nameSchema.parse(input.name);
    return this.db.transaction(() => {
      const now = this.now();
      this.db.prepare('DELETE FROM compute_pairings WHERE expires_at<=?').run(now);
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM compute_pairings').get() as { n: number }).n >= 512) throw new Error('Compute pairing capacity exceeded');
      const code = randomBytes(16).toString('base64url'), expiresAt = now + COMPUTE_PAIRING_MS;
      this.db.prepare('INSERT INTO compute_pairings(code_hash,secret_hash,name,expires_at) VALUES(?,?,?,?)').run(digest(code), hash, name, expiresAt);
      return { code, expiresAt };
    }).immediate();
  }
  /** Caller supplies an authenticated browser identity and explicit organization confirmation. */
  confirmPairing(actor: ComputeActor, code: string): void {
    pairingCode.parse(code);
    this.db.transaction(() => {
      this.member(actor);
      const result = this.db.prepare('UPDATE compute_pairings SET org_id=?,principal_id=? WHERE code_hash=? AND expires_at>? AND org_id IS NULL')
        .run(actor.orgId, actor.principalId, digest(code), this.now());
      if (result.changes !== 1) throw new Error('Compute pairing unavailable');
    }).immediate();
  }
  redeemPairing(code: string, secret: string): { deviceId: string; credential: string; orgId: string } {
    pairingCode.parse(code);
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Compute pairing unavailable');
    return this.db.transaction(() => {
      const pairing = this.db.prepare('SELECT * FROM compute_pairings WHERE code_hash=? AND secret_hash=? AND expires_at>?')
        .get(digest(code), digest(secret), this.now()) as { name: string; org_id: string | null; principal_id: string | null } | undefined;
      if (!pairing?.org_id || !pairing.principal_id) throw new Error('Compute pairing unavailable');
      this.member({ orgId: pairing.org_id, principalId: pairing.principal_id });
      const deviceId = randomUUID(), credential = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO compute_devices(device_id,org_id,principal_id,name,credential_hash) VALUES(?,?,?,?,?)')
        .run(deviceId, pairing.org_id, pairing.principal_id, pairing.name, digest(credential));
      this.db.prepare('DELETE FROM compute_pairings WHERE code_hash=?').run(digest(code));
      return { deviceId, credential, orgId: pairing.org_id };
    }).immediate();
  }
  /** Admin preference with optimistic concurrency; no run is moved by this edit. */
  setProjectTarget(actor: ComputeActor, projectId: string, input: unknown): void {
    const { target, expected } = executionTargetSettingSchema.parse(input);
    this.db.transaction(() => {
      if (!['org:owner', 'org:admin'].includes(this.member(actor))) throw new Error('Compute project administrator required');
      const project = this.db.prepare("SELECT execution_target_json FROM projects WHERE project_id=? AND org_id=? AND status='active'")
        .get(projectId, actor.orgId) as { execution_target_json: string | null } | undefined;
      if (!project) throw new Error('Compute project unavailable');
      const previous = executionTargetSchema.parse(project.execution_target_json ? JSON.parse(project.execution_target_json) : { kind: 'hosted' });
      if (JSON.stringify(previous) !== JSON.stringify(expected)) throw new Error('Compute target changed; reload before saving');
      if (target.kind === 'hosted' && !this.hostedAllowed(actor.principalId)) throw new Error('Hosted execution requires a platform administrator');
      if (target.kind === 'customer-device') {
        const device = this.device(target.deviceId);
        if (device.org_id !== actor.orgId || device.revoked) throw new Error('Compute device unavailable');
        this.member({ orgId: device.org_id, principalId: device.principal_id });
        this.projectAllowed(device, projectId);
      }
      this.db.prepare('UPDATE projects SET execution_target_json=?,updated_at=? WHERE project_id=? AND org_id=?')
        .run(JSON.stringify(target), new Date(this.now()).toISOString(), projectId, actor.orgId);
    }).immediate();
  }
  grantProject(actor: ComputeActor, deviceId: string, projectId: string, allowed: boolean): void {
    this.db.transaction(() => {
      const row = this.manage(actor, deviceId);
      if (row.revoked || !this.db.prepare("SELECT 1 FROM projects WHERE project_id=? AND org_id=? AND status='active'").get(projectId, actor.orgId)) {
        throw new Error('Compute project unavailable');
      }
      if (allowed) this.db.prepare('INSERT OR IGNORE INTO compute_device_projects VALUES(?,?)').run(deviceId, projectId);
      else {
        this.db.prepare('DELETE FROM compute_device_projects WHERE device_id=? AND project_id=?').run(deviceId, projectId);
        // Regranting never reactivates an old workload.
        this.db.prepare("UPDATE compute_devices SET assignment_state='indeterminate' WHERE device_id=? AND project_id=? AND run_id IS NOT NULL")
          .run(deviceId, projectId);
      }
    }).immediate();
  }
  revoke(actor: ComputeActor, deviceId: string): void {
    this.db.transaction(() => {
      this.manage(actor, deviceId);
      this.db.prepare(`UPDATE compute_devices SET revoked=1,session_id=NULL,lease_until=0,connection_generation=connection_generation+1,
        assignment_state=CASE WHEN run_id IS NULL THEN NULL ELSE 'indeterminate' END WHERE device_id=?`).run(deviceId);
    }).immediate();
  }
  /** A credential remains bound to its persistent local engine inventory. */
  bindMachine(credential: string, machineId: string): void {
    z.string().uuid().parse(machineId);
    this.db.transaction(() => {
      const row = this.authenticated(credential);
      this.db.prepare('INSERT OR IGNORE INTO compute_device_machines VALUES(?,?)').run(row.device_id, machineId);
      const bound = this.db.prepare('SELECT machine_id FROM compute_device_machines WHERE device_id=?').pluck().get(row.device_id);
      if (bound !== machineId) throw new Error('Compute machine inventory changed; pair this installation again');
    }).immediate();
  }
  connect(credential: string, input: ComputeCapabilities): { session: ComputeSession; leaseUntil: number; recovery: ComputeAssignment | null } {
    const capabilities = computeCapabilitiesSchema.parse(input);
    return this.db.transaction(() => {
      const row = this.authenticated(credential), sessionId = randomUUID(), leaseUntil = this.now() + COMPUTE_LEASE_MS;
      this.db.prepare(`UPDATE compute_devices SET session_id=?,connection_generation=connection_generation+1,lease_until=?,capabilities=?,
        assignment_state=CASE WHEN run_id IS NULL THEN NULL ELSE 'indeterminate' END WHERE device_id=?`)
        .run(sessionId, leaseUntil, JSON.stringify(capabilities), row.device_id);
      return { session: { deviceId: row.device_id, sessionId, generation: row.connection_generation + 1 }, leaseUntil,
        recovery: row.run_id ? { runId: row.run_id, projectId: row.project_id!, generation: row.execution_generation, state: 'indeterminate' as const } : null };
    }).immediate();
  }
  validateSession(session: ComputeSession): void {
    this.fenceExpiry(session, () => { this.session(session); });
  }
  /** Read-only reauthentication. Reattaching never extends a lease or changes a generation. */
  validateResume(credential: string, session: ComputeSession, machineId: string): void {
    this.fenceExpiry(session, () => {
      const row = this.credentialSession(credential, session);
      const bound = this.db.prepare('SELECT machine_id FROM compute_device_machines WHERE device_id=?').pluck().get(row.device_id);
      if (bound !== machineId) throw new Error('Compute machine inventory changed; pair this installation again');
    });
  }
  heartbeat(credential: string, session: ComputeSession): number {
    return this.fenceExpiry(session, () => this.db.transaction(() => {
      this.credentialSession(credential, session);
      const until = this.now() + COMPUTE_LEASE_MS;
      this.db.prepare('UPDATE compute_devices SET lease_until=? WHERE device_id=?').run(until, session.deviceId);
      return until;
    }).immediate());
  }
  disconnect(session: ComputeSession): void {
    this.db.prepare(`UPDATE compute_devices SET session_id=NULL,lease_until=0,
      assignment_state=CASE WHEN run_id IS NULL THEN NULL ELSE 'indeterminate' END
      WHERE device_id=? AND session_id=? AND connection_generation=?`).run(session.deviceId, session.sessionId, session.generation);
  }
  setAccepting(credential: string, session: ComputeSession, accepting: boolean): void {
    this.fenceExpiry(session, () => this.db.transaction(() => {
      this.credentialSession(credential, session);
      this.db.prepare('UPDATE compute_devices SET accepting=? WHERE device_id=?').run(Number(accepting), session.deviceId);
    }).immediate());
  }
  /** Host-only socket lookup; assign still checks receipt and tenant authority. */
  currentSession(deviceId: string): ComputeSession | undefined {
    const row = this.device(deviceId);
    if (!row.session_id || row.revoked || row.lease_until <= this.now()) return undefined;
    return { deviceId, sessionId: row.session_id, generation: row.connection_generation };
  }
  /** Readiness is advisory; assign repeats every check inside its write transaction. */
  admission(actor: ComputeActor, runId: string, input: ComputeResources): ComputeAdmission {
    const resources = computeResourcesSchema.parse(input);
    this.member(actor);
    const run = this.db.prepare("SELECT project_id, execution_target_json FROM project_runs WHERE project_run_id=? AND org_id=? AND requested_by_principal_id=? AND status='queued'")
      .get(runId, actor.orgId, actor.principalId) as { project_id: string; execution_target_json: string | null } | undefined;
    if (!run) throw new Error('Compute run unavailable');
    const target = executionTargetSchema.parse(run.execution_target_json ? JSON.parse(run.execution_target_json) : { kind: 'hosted' });
    if (target.kind !== 'customer-device') throw new Error('Compute run target mismatch');
    let row: DeviceRow;
    try {
      row = this.device(target.deviceId);
      if (row.org_id !== actor.orgId || row.revoked) throw new Error('Unavailable');
      this.member({ orgId: row.org_id, principalId: row.principal_id });
      this.projectAllowed(row, run.project_id);
    } catch { return { status: 'waiting', reason: 'access-unavailable' }; }
    if (!row.session_id || row.lease_until <= this.now()) {
      if (row.session_id) this.disconnect({ deviceId: row.device_id, sessionId: row.session_id, generation: row.connection_generation });
      return { status: 'waiting', reason: 'disconnected' };
    }
    if (row.run_id) return { status: 'waiting', reason: 'busy' };
    if (!row.accepting) return { status: 'waiting', reason: 'not-accepting' };
    const capabilities = computeCapabilitiesSchema.parse(JSON.parse(row.capabilities!));
    if (!this.policy.appVersions.has(capabilities.appVersion) || !this.policy.imageDigests.has(capabilities.imageDigest)) {
      return { status: 'waiting', reason: 'version-incompatible' };
    }
    if (capabilities.cpus < resources.cpus || capabilities.memoryBytes < resources.memoryBytes || capabilities.diskBytes < resources.diskBytes) {
      return { status: 'waiting', reason: 'resources-insufficient' };
    }
    return { status: 'ready', session: { deviceId: row.device_id, sessionId: row.session_id, generation: row.connection_generation } };
  }
  /** Host-only admission. A receipt must already exist; no device can invent a run. */
  assign(actor: ComputeActor, session: ComputeSession, runId: string, resources: ComputeResources): ComputeAssignment {
    computeResourcesSchema.parse(resources);
    return this.fenceExpiry(session, () => this.db.transaction(() => {
      this.member(actor);
      const row = this.session(session);
      const run = this.db.prepare("SELECT project_id, execution_target_json FROM project_runs WHERE project_run_id=? AND org_id=? AND requested_by_principal_id=? AND status IN ('queued','running')")
        .get(runId, actor.orgId, actor.principalId) as { project_id: string; execution_target_json: string | null } | undefined;
      if (!run || row.org_id !== actor.orgId) throw new Error('Compute run unavailable');
      const target = executionTargetSchema.parse(run.execution_target_json ? JSON.parse(run.execution_target_json) : { kind: 'hosted' });
      if (target.kind !== 'customer-device' || target.deviceId !== row.device_id) throw new Error('Compute run target mismatch');
      this.projectAllowed(row, run.project_id);
      const capabilities = computeCapabilitiesSchema.parse(JSON.parse(row.capabilities!));
      if (!this.policy.appVersions.has(capabilities.appVersion) || !this.policy.imageDigests.has(capabilities.imageDigest)) throw new Error('Compute version incompatible');
      if (capabilities.cpus < resources.cpus || capabilities.memoryBytes < resources.memoryBytes || capabilities.diskBytes < resources.diskBytes) {
        throw new Error('Compute resources insufficient');
      }
      if (!row.accepting) throw new Error('Compute device is not accepting runs');
      if (row.run_id) throw new Error('Compute device is busy; stop reconciliation required');
      this.db.prepare("UPDATE compute_devices SET execution_generation=execution_generation+1,run_id=?,project_id=?,assignment_state='active' WHERE device_id=?")
        .run(runId, run.project_id, row.device_id);
      return { runId, projectId: run.project_id, generation: row.execution_generation + 1, state: 'active' as const };
    }).immediate());
  }
  private projectAllowed(row: DeviceRow, projectId: string): void {
    if (!this.db.prepare(`SELECT 1 FROM compute_device_projects g JOIN projects p ON p.project_id=g.project_id
      WHERE g.device_id=? AND p.project_id=? AND p.org_id=? AND p.status='active'`).get(row.device_id, projectId, row.org_id)) {
      throw new Error('Compute project unavailable');
    }
  }
  authorizeOperation(session: ComputeSession, runId: string, generation: number): void {
    this.fenceExpiry(session, () => {
      const row = this.session(session);
      if (row.run_id !== runId || row.execution_generation !== generation || row.assignment_state !== 'active') throw new Error('Compute execution unavailable');
      this.projectAllowed(row, row.project_id!);
      const requester = this.db.prepare("SELECT requested_by_principal_id FROM project_runs WHERE project_run_id=? AND org_id=? AND project_id=? AND status IN ('queued','running')")
        .pluck().get(runId, row.org_id, row.project_id) as string | undefined;
      if (!requester) throw new Error('Compute run unavailable');
      this.member({ orgId: row.org_id, principalId: requester });
    });
  }
  /** A fresh authenticated launcher reports this exact workload stopped.
   * Expiry alone never calls this and never releases a device slot. */
  acknowledgeStopped(credential: string, session: ComputeSession, runId: string, generation: number): void {
    this.fenceExpiry(session, () => this.db.transaction(() => {
      const row = this.credentialSession(credential, session);
      if (row.run_id !== runId || row.execution_generation !== generation) throw new Error('Compute execution unavailable');
      this.db.prepare('INSERT OR IGNORE INTO compute_stop_reports VALUES(?,?,?,?)').run(row.device_id, runId, generation, this.now());
      this.db.prepare('UPDATE compute_devices SET run_id=NULL,project_id=NULL,assignment_state=NULL WHERE device_id=?').run(row.device_id);
    }).immediate());
  }
  authorizePreview(session: ComputeSession, runId: string): void {
    this.fenceExpiry(session, () => {
      const device = this.session(session);
      const run = this.db.prepare(`SELECT project_id,execution_target_json FROM project_runs
        WHERE project_run_id=? AND org_id=? AND status IN ('running','delivered')`).get(runId, device.org_id) as
        { project_id: string; execution_target_json: string | null } | undefined;
      if (!run) throw new Error('Compute preview unavailable');
      const target = executionTargetSchema.parse(run.execution_target_json ? JSON.parse(run.execution_target_json) : { kind: 'hosted' });
      if (target.kind !== 'customer-device' || target.deviceId !== device.device_id) throw new Error('Compute preview unavailable');
      this.projectAllowed(device, run.project_id);
    });
  }
  supports(session: ComputeSession, service: 'retrieval' | 'preview'): boolean {
    this.validateSession(session);
    const row = this.session(session);
    return !!computeCapabilitiesSchema.parse(JSON.parse(row.capabilities!)).services?.includes(service);
  }
  executionOrganisation(session: ComputeSession, runId: string, generation: number): string {
    this.authorizeOperation(session, runId, generation);
    return this.session(session).org_id;
  }
  confirmedStop(deviceId: string, runId: string, generation: number): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM compute_stop_reports WHERE device_id=? AND run_id=? AND generation=?').get(deviceId, runId, generation));
  }
  /** Covers a crash after assignment and before the dispatch journal insert.
   * A recorded stop is necessary, and a newer assignment must not be live. */
  confirmedRunStop(deviceId: string, runId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM compute_stop_reports s
      WHERE s.device_id=? AND s.run_id=? AND NOT EXISTS
      (SELECT 1 FROM compute_devices d WHERE d.device_id=s.device_id AND d.run_id=s.run_id)
      LIMIT 1`).get(deviceId, runId));
  }
  inspect(actor: ComputeActor, deviceId: string) {
    const row = this.manage(actor, deviceId), connected = !row.revoked && row.session_id !== null && row.lease_until > this.now();
    return { deviceId, name: row.name, orgId: row.org_id, principalId: row.principal_id,
      revoked: Boolean(row.revoked), connected, accepting: Boolean(row.accepting),
      assignment: row.run_id ? { runId: row.run_id, projectId: row.project_id!, generation: row.execution_generation,
        state: connected ? row.assignment_state! : 'indeterminate' as const } : null };
  }
}
