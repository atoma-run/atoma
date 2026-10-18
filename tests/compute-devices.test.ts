import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AUTH_TABLES_DDL } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { ComputeDeviceStore } from '../src/projects/computeDevices.js';
import { COMPUTE_LEASE_MS, COMPUTE_PAIRING_MS, type ComputeActor } from '../src/contracts/computeDevice.js';

let db: Database.Database, projects: ProjectStore, devices: ComputeDeviceStore, now: number;
const imageDigest = `sha256:${'a'.repeat(64)}`;
const policy = { appVersions: new Set(['test-1']), imageDigests: new Set([imageDigest]) };
const capabilities = { protocol: 1 as const, appVersion: 'test-1', platform: 'darwin' as const, architecture: 'arm64' as const,
  services: ['workspace', 'tools', 'retrieval'] as ('workspace' | 'tools' | 'retrieval')[], imageDigest, cpus: 8, memoryBytes: 8 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 };
const resources = { cpus: 2, memoryBytes: 2 * 1024 ** 3, diskBytes: 1024 ** 3 };
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.exec(AUTH_TABLES_DDL);
  projects = new ProjectStore(db); now = 1_000_000;
  devices = new ComputeDeviceStore(db, policy, () => now);
});
afterEach(() => db.close());
function actor(orgId?: string): ComputeActor {
  const id = randomUUID(), org = orgId ?? randomUUID(), at = new Date().toISOString();
  if (!orgId) db.prepare('INSERT INTO auth_organisations VALUES(?,?,?)').run(org, 'Organization', at);
  db.prepare("INSERT INTO auth_principals VALUES(?,'human',?,?)").run(id, 'Member', at);
  db.prepare("INSERT INTO auth_memberships VALUES(?,?,'org:owner',?)").run(org, id, at);
  return { orgId: org, principalId: id };
}
function pairing(owner: ComputeActor) {
  const secret = randomBytes(32).toString('base64url');
  const request = devices.beginPairing({ name: 'My computer', secretHash: createHash('sha256').update(secret).digest('hex') });
  devices.confirmPairing(owner, request.code);
  return { ...devices.redeemPairing(request.code, secret), secret, code: request.code };
}
function project(owner: ComputeActor) {
  return projects.createProject({ orgId: owner.orgId, principalId: owner.principalId,
    project: { name: 'Compute', slug: `compute-${randomUUID()}`, repositoryTarget: {
      installationId: '1', owner: 'tests', name: `compute-${randomUUID()}`, visibility: 'private',
    } } });
}
function run(owner: ComputeActor, projectId: string) {
  return projects.createProjectRun({ orgId: owner.orgId, projectId, principalId: owner.principalId,
    request: { idempotencyKey: randomUUID(), goal: 'Test compute control' },
    hostPaths: { workspacePath: '/not-used/workspace', runsPath: '/not-used/runs', logPath: '/not-used/log' } })!.run.projectRunId;
}
function fixture() {
  const owner = actor(), paired = pairing(owner), p = project(owner);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const runId = run(owner, p.projectId);
  const { session } = devices.connect(paired.credential, capabilities);
  return { owner, paired, projectId: p.projectId, runId, session };
}

it('requires browser confirmation and the application secret, consumes the code once and stores no bearer plaintext', () => {
  const owner = actor(), secret = randomBytes(32).toString('base64url');
  const request = devices.beginPairing({ name: 'Desktop', secretHash: createHash('sha256').update(secret).digest('hex') });
  expect(() => devices.redeemPairing(request.code, secret)).toThrow('unavailable');
  devices.confirmPairing(owner, request.code);
  expect(() => devices.confirmPairing(owner, request.code)).toThrow('unavailable');
  expect(() => devices.redeemPairing(request.code, randomBytes(32).toString('base64url'))).toThrow('unavailable');
  const result = devices.redeemPairing(request.code, secret);
  expect(result.orgId).toBe(owner.orgId);
  expect(() => devices.redeemPairing(request.code, secret)).toThrow('unavailable');
  const stored = JSON.stringify(db.prepare('SELECT * FROM compute_devices').all());
  for (const privateValue of [result.credential, secret, request.code]) expect(stored).not.toContain(privateValue);
  expect(db.prepare('SELECT COUNT(*) AS n FROM compute_pairings').get()).toEqual({ n: 0 });
});

it('refuses expired pairings, non-members and viewers', () => {
  const owner = actor(), secret = randomBytes(32).toString('base64url');
  const request = devices.beginPairing({ name: 'Desktop', secretHash: createHash('sha256').update(secret).digest('hex') });
  expect(() => devices.confirmPairing({ ...owner, orgId: randomUUID() }, request.code)).toThrow('membership');
  db.prepare("UPDATE auth_memberships SET role='org:viewer' WHERE principal_id=?").run(owner.principalId);
  expect(() => devices.confirmPairing(owner, request.code)).toThrow('membership');
  db.prepare("UPDATE auth_memberships SET role='org:owner' WHERE principal_id=?").run(owner.principalId);
  devices.confirmPairing(owner, request.code); now += COMPUTE_PAIRING_MS;
  expect(() => devices.redeemPairing(request.code, secret)).toThrow('unavailable');
});

it('withdraws an approved but unredeemed pairing when membership is removed', () => {
  const owner = actor(), secret = randomBytes(32).toString('base64url');
  const request = devices.beginPairing({ name: 'Desktop', secretHash: createHash('sha256').update(secret).digest('hex') });
  devices.confirmPairing(owner, request.code);
  db.prepare('DELETE FROM auth_memberships WHERE org_id=? AND principal_id=?').run(owner.orgId, owner.principalId);
  db.prepare("INSERT INTO auth_memberships VALUES(?,?,'org:owner',?)").run(owner.orgId, owner.principalId, new Date().toISOString());
  expect(() => devices.redeemPairing(request.code, secret)).toThrow('unavailable');
});

it('does not let a second device credential renew or acknowledge another device’s session', () => {
  const f = fixture(), another = pairing(f.owner), assignment = devices.assign(f.owner, f.session, f.runId, resources);
  expect(() => devices.heartbeat(another.credential, f.session)).toThrow('session');
  expect(() => devices.acknowledgeStopped(another.credential, f.session, f.runId, assignment.generation)).toThrow('session');
  devices.authorizeOperation(f.session, f.runId, assignment.generation);
});

it('keeps another idle device admissible while one device holds an indeterminate workload', () => {
  const f = fixture(); devices.assign(f.owner, f.session, f.runId, resources);
  devices.disconnect(f.session);
  const second = pairing(f.owner), secondProject = project(f.owner);
  devices.grantProject(f.owner, second.deviceId, secondProject.projectId, true);
  devices.setProjectTarget(f.owner, secondProject.projectId, { target: { kind: 'customer-device', deviceId: second.deviceId }, expected: { kind: 'hosted' } });
  const session = devices.connect(second.credential, capabilities).session;
  const assignment = devices.assign(f.owner, session, run(f.owner, secondProject.projectId), resources);
  expect(assignment.state).toBe('active');
  expect(devices.inspect(f.owner, f.paired.deviceId).assignment?.state).toBe('indeterminate');
});

it('scopes device administration, project grants and runs to the organization', () => {
  const f = fixture(), foreign = actor(), foreignProject = project(foreign);
  expect(() => devices.inspect(foreign, f.paired.deviceId)).toThrow('unavailable');
  expect(() => devices.revoke(foreign, f.paired.deviceId)).toThrow('unavailable');
  expect(() => devices.grantProject(f.owner, f.paired.deviceId, foreignProject.projectId, true)).toThrow('unavailable');
  expect(() => devices.assign(foreign, f.session, run(foreign, foreignProject.projectId), resources)).toThrow('unavailable');
  devices.grantProject(f.owner, f.paired.deviceId, f.projectId, false);
  expect(() => devices.assign(f.owner, f.session, f.runId, resources)).toThrow('project');
});

it('fences duplicate connections and stale disconnects without claiming an old workload stopped', () => {
  const f = fixture(), assignment = devices.assign(f.owner, f.session, f.runId, resources);
  const next = devices.connect(f.paired.credential, capabilities).session;
  expect(next.generation).toBe(f.session.generation + 1);
  expect(() => devices.heartbeat(f.paired.credential, f.session)).toThrow('superseded');
  expect(() => devices.authorizeOperation(f.session, f.runId, assignment.generation)).toThrow();
  devices.disconnect(f.session);
  expect(devices.inspect(f.owner, f.paired.deviceId)).toMatchObject({ connected: true, assignment: { state: 'indeterminate' } });
  expect(() => devices.assign(f.owner, next, f.runId, resources)).toThrow('busy');
  expect(() => devices.authorizeOperation(next, f.runId, assignment.generation)).toThrow('execution');
});

it('retains the occupied slot after lease expiry and requires a fresh session and exact stop acknowledgement', () => {
  const f = fixture(), assignment = devices.assign(f.owner, f.session, f.runId, resources);
  now += COMPUTE_LEASE_MS;
  expect(() => devices.heartbeat(f.paired.credential, f.session)).toThrow('expired');
  // A wall-clock correction cannot undo an observed expiry, even though the
  // failed renewal transaction rolled back.
  now -= COMPUTE_LEASE_MS;
  expect(() => devices.heartbeat(f.paired.credential, f.session)).toThrow();
  expect(devices.inspect(f.owner, f.paired.deviceId)).toMatchObject({ connected: false, assignment: { state: 'indeterminate' } });
  const next = devices.connect(f.paired.credential, capabilities).session;
  expect(() => devices.acknowledgeStopped(f.paired.credential, f.session, f.runId, assignment.generation)).toThrow();
  expect(() => devices.acknowledgeStopped(f.paired.credential, next, f.runId, assignment.generation + 1)).toThrow('execution');
  devices.acknowledgeStopped(f.paired.credential, next, f.runId, assignment.generation);
  const restarted = devices.assign(f.owner, next, f.runId, resources);
  expect(restarted.generation).toBe(assignment.generation + 1);
  expect(() => devices.authorizeOperation(next, f.runId, assignment.generation)).toThrow();
  devices.authorizeOperation(next, f.runId, restarted.generation);
});

it('withdraws project access immediately and never reactivates old work when access is restored', () => {
  const f = fixture(), assignment = devices.assign(f.owner, f.session, f.runId, resources);
  devices.grantProject(f.owner, f.paired.deviceId, f.projectId, false);
  expect(() => devices.authorizeOperation(f.session, f.runId, assignment.generation)).toThrow();
  devices.grantProject(f.owner, f.paired.deviceId, f.projectId, true);
  expect(() => devices.authorizeOperation(f.session, f.runId, assignment.generation)).toThrow('execution');
});

it.each(['device', 'membership'])('permanently fences credentials on %s revocation', kind => {
  const f = fixture(), assignment = devices.assign(f.owner, f.session, f.runId, resources);
  if (kind === 'device') devices.revoke(f.owner, f.paired.deviceId);
  else {
    db.prepare("UPDATE auth_memberships SET role='org:viewer' WHERE principal_id=?").run(f.owner.principalId);
    db.prepare("UPDATE auth_memberships SET role='org:owner' WHERE principal_id=?").run(f.owner.principalId);
  }
  expect(() => devices.connect(f.paired.credential, capabilities)).toThrow('credential');
  expect(() => devices.authorizeOperation(f.session, f.runId, assignment.generation)).toThrow();
  expect(devices.inspect(f.owner, f.paired.deviceId)).toMatchObject({ revoked: true, assignment: { state: 'indeterminate' } });
});

it('does not resurrect another member’s workload after that requester loses and regains membership', () => {
  const f = fixture(), requester = actor(f.owner.orgId), runId = run(requester, f.projectId);
  const assignment = devices.assign(requester, f.session, runId, resources);
  db.prepare("UPDATE auth_memberships SET role='org:viewer' WHERE principal_id=?").run(requester.principalId);
  db.prepare("UPDATE auth_memberships SET role='org:owner' WHERE principal_id=?").run(requester.principalId);
  expect(() => devices.authorizeOperation(f.session, runId, assignment.generation)).toThrow('execution');
});

it('keeps existing work authorized when draining admission, but refuses another run', () => {
  const f = fixture(), assignment = devices.assign(f.owner, f.session, f.runId, resources);
  devices.setAccepting(f.paired.credential, f.session, false);
  devices.authorizeOperation(f.session, f.runId, assignment.generation);
  devices.acknowledgeStopped(f.paired.credential, f.session, f.runId, assignment.generation);
  expect(() => devices.assign(f.owner, f.session, f.runId, resources)).toThrow('not accepting');
});

it('refuses resource shortages and unapproved runtime versions without occupying the device', () => {
  const f = fixture();
  expect(() => devices.assign(f.owner, f.session, f.runId, { ...resources, cpus: capabilities.cpus + 1 })).toThrow('resources');
  const incompatible = devices.connect(f.paired.credential, { ...capabilities, imageDigest: `sha256:${'b'.repeat(64)}` }).session;
  expect(() => devices.assign(f.owner, incompatible, f.runId, resources)).toThrow('incompatible');
  expect(devices.inspect(f.owner, f.paired.deviceId).assignment).toBeNull();
});

it('preserves generations and active work when the store service is reconstructed', () => {
  const f = fixture(), assignment = devices.assign(f.owner, f.session, f.runId, resources);
  devices = new ComputeDeviceStore(db, policy, () => now);
  expect(devices.inspect(f.owner, f.paired.deviceId).assignment).toEqual(assignment);
  const next = devices.connect(f.paired.credential, capabilities).session;
  expect(next.generation).toBeGreaterThan(f.session.generation);
  expect(() => devices.assign(f.owner, next, f.runId, resources)).toThrow('busy');
});

it('fences across independent product-store connections after reopening the persisted database', async () => {
  const f = fixture(); devices.assign(f.owner, f.session, f.runId, resources);
  const directory = mkdtempSync(join(tmpdir(), 'atoma-compute-store-'));
  const file = join(directory, 'product.db');
  let first: Database.Database | undefined, second: Database.Database | undefined;
  try {
    await db.backup(file);
    first = new Database(file); second = new Database(file);
    const a = new ComputeDeviceStore(first, policy, () => now), b = new ComputeDeviceStore(second, policy, () => now);
    const renewed = b.connect(f.paired.credential, capabilities).session;
    expect(() => a.heartbeat(f.paired.credential, f.session)).toThrow('superseded');
    a.disconnect(f.session);
    expect(b.inspect(f.owner, f.paired.deviceId)).toMatchObject({ connected: true, assignment: { state: 'indeterminate' } });
    expect(() => a.assign(f.owner, renewed, f.runId, resources)).toThrow('busy');
    const secret = randomBytes(32).toString('base64url');
    const pending = a.beginPairing({ name: 'Second desktop', secretHash: createHash('sha256').update(secret).digest('hex') });
    b.confirmPairing(f.owner, pending.code); a.redeemPairing(pending.code, secret);
    expect(() => b.redeemPairing(pending.code, secret)).toThrow('unavailable');
  } finally { first?.close(); second?.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('refuses a finished run and keeps archived-project work indeterminate even after reopening the project', () => {
  const f = fixture(), assignment = devices.assign(f.owner, f.session, f.runId, resources);
  db.prepare("UPDATE project_runs SET status='cancelled' WHERE project_run_id=?").run(f.runId);
  expect(() => devices.authorizeOperation(f.session, f.runId, assignment.generation)).toThrow('run');
  db.prepare("UPDATE projects SET status='archived' WHERE project_id=?").run(f.projectId);
  db.prepare("UPDATE projects SET status='active' WHERE project_id=?").run(f.projectId);
  expect(devices.inspect(f.owner, f.paired.deviceId).assignment?.state).toBe('indeterminate');
});

it('pins each run target, retains legacy hosted defaults and refuses assigning a hosted receipt', () => {
  const owner = actor(), paired = pairing(owner), p = project(owner), hosted = run(owner, p.projectId);
  expect(projects.getProject(owner.orgId, p.projectId)?.executionTarget).toEqual({ kind: 'hosted' });
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  const { session } = devices.connect(paired.credential, capabilities);
  expect(() => devices.assign(owner, session, hosted, resources)).toThrow('target mismatch');
  const target = { kind: 'customer-device', deviceId: paired.deviceId };
  devices.setProjectTarget(owner, p.projectId, { target, expected: { kind: 'hosted' } });
  expect(projects.getProjectRun(owner.orgId, hosted)?.executionTarget).toEqual({ kind: 'hosted' });
  db.prepare("UPDATE project_runs SET status='failed' WHERE project_run_id=?").run(hosted);
  const remote = run(owner, p.projectId);
  expect(projects.getProjectRun(owner.orgId, remote)?.executionTarget).toEqual(target);
  expect(() => db.prepare('UPDATE project_runs SET execution_target_json=? WHERE project_run_id=?')
    .run(JSON.stringify({ kind: 'hosted' }), remote)).toThrow('immutable');
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'hosted' }, expected: target });
  expect(projects.getProjectRun(owner.orgId, remote)?.executionTarget).toEqual(target);
  const continuation = projects.createProjectRun({ orgId: owner.orgId, projectId: p.projectId, principalId: owner.principalId,
    request: { idempotencyKey: randomUUID(), goal: 'Continue remote', resumeOf: remote },
    hostPaths: { workspacePath: '/unused', runsPath: '/unused', logPath: '/unused' } })!.run;
  expect(continuation.executionTarget).toEqual(target);
});

it('requires current project-admin authority, a grant and a matching previous target', () => {
  const f = fixture(), target = { kind: 'customer-device', deviceId: f.paired.deviceId };
  expect(() => devices.setProjectTarget(f.owner, f.projectId, { target, expected: { kind: 'hosted' } })).toThrow('changed');
  const foreign = actor(), device = pairing(foreign);
  expect(() => devices.setProjectTarget(f.owner, f.projectId, { target: { kind: 'customer-device', deviceId: device.deviceId }, expected: target })).toThrow('unavailable');
  devices.grantProject(f.owner, f.paired.deviceId, f.projectId, false);
  expect(() => devices.setProjectTarget(f.owner, f.projectId, { target, expected: target })).toThrow('project');
  db.prepare("UPDATE auth_memberships SET role='org:member' WHERE principal_id=?").run(f.owner.principalId);
  expect(() => devices.setProjectTarget(f.owner, f.projectId, { target: { kind: 'hosted' }, expected: target })).toThrow('administrator');
});

it('reports device-specific admission reasons without reserving a run or blocking another device', () => {
  const f = fixture();
  expect(devices.admission(f.owner, f.runId, resources)).toEqual({ status: 'ready', session: f.session });
  expect(devices.admission(f.owner, f.runId, { ...resources, cpus: capabilities.cpus + 1 })).toMatchObject({ reason: 'resources-insufficient' });
  devices.setAccepting(f.paired.credential, f.session, false);
  expect(devices.admission(f.owner, f.runId, resources)).toMatchObject({ reason: 'not-accepting' });
  devices.setAccepting(f.paired.credential, f.session, true);
  devices.assign(f.owner, f.session, f.runId, resources);
  expect(devices.admission(f.owner, f.runId, resources)).toMatchObject({ reason: 'busy' });
  devices.disconnect(f.session);
  expect(devices.admission(f.owner, f.runId, resources)).toMatchObject({ reason: 'disconnected' });
  const next = devices.connect(f.paired.credential, { ...capabilities, appVersion: 'unsupported' }).session;
  devices.acknowledgeStopped(f.paired.credential, next, f.runId, 1);
  expect(devices.admission(f.owner, f.runId, resources)).toMatchObject({ reason: 'version-incompatible' });
  devices.revoke(f.owner, f.paired.deviceId);
  expect(devices.admission(f.owner, f.runId, resources)).toMatchObject({ reason: 'access-unavailable' });
});

it('projects only organization-owned device choices and reports machine wait reasons', () => {
  const f = fixture();
  expect(devices.projectView(f.owner, f.projectId)).toMatchObject({ canEdit: true,
    devices: [{ deviceId: f.paired.deviceId, allowed: true, availability: 'ready' }] });
  expect(() => devices.projectView(actor(), f.projectId)).toThrow('unavailable');
  devices.disconnect(f.session);
  expect(devices.projectView(f.owner, f.projectId).devices[0]?.availability).toBe('disconnected');
  devices.connect(f.paired.credential, { ...capabilities, memoryBytes: 1024 });
  expect(devices.projectView(f.owner, f.projectId).devices[0]?.availability).toBe('resources-insufficient');
  devices.grantProject(f.owner, f.paired.deviceId, f.projectId, false);
  expect(devices.projectView(f.owner, f.projectId).devices[0]?.allowed).toBe(false);
});
