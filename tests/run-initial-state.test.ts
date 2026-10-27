import { buildWorkspaceArtifactManifest } from '../src/projects/artifacts.js';
import { readRunCopyPath, encodeReadRunsIndex } from '../src/contracts/readRuns.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunInitialStateStore, initialContextEnvironment, initialStateRuntime, retainInitialWorkspace, removeInitialStateWorkspace } from '../src/run/initialState.js';
import { captureCheckpointExport } from '../src/run/checkpointExport.js';
import { RunCheckpointStore } from '../src/run/checkpoint.js';
import { localWorkspaceRuntime } from '../src/run/workspaceRuntime.js';
import { startWorkspaceProcess } from '../src/run/workspaceProcess.js';
import type { RunInitialState } from '../src/contracts/runInitialState.js';

const roots: string[] = [];
afterEach(() => { closeStoreHandles(); for (const path of roots.splice(0)) removeInitialStateWorkspace(path); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'initial-state-'))); roots.push(root);
  const source = join(root, 'source'); mkdirSync(source);
  const db = new Database(join(root, 'store.db'));
  const store = new RunInitialStateStore(db);
  return { root, source, db, store };
}
async function capture(f: ReturnType<typeof fixture>, more: Partial<RunInitialState> = {}) {
  const snapshot = await retainInitialWorkspace(f.db, captureCheckpointExport(f.source));
  const state: RunInitialState = { version: 1, runId: randomUUID(), orgId: randomUUID(), projectId: randomUUID(), principalId: 'owner',
    goal: 'Verify saved work', snapshot, environment: {}, externalConnectors: false, ...more };
  f.store.publish(state); return state;
}
describe('complete immutable initial states', () => {
  it.each([false, true])('restores all prepared bytes and modes after source mutation and deepening (workspace process=%s)', async remote => {
    const f = fixture();
    mkdirSync(join(f.source, '.github/workflows'), { recursive: true });
    mkdirSync(join(f.source, 'node_modules/lib'), { recursive: true });
    mkdirSync(join(f.source, 'empty'));
    writeFileSync(join(f.source, '.github/workflows/check.yml'), 'private workflow bytes');
    writeFileSync(join(f.source, '.atoma-probes.json'), '{"version":1,"entries":[]}');
    writeFileSync(join(f.source, '.env.local'), 'fixture-only=retained');
    writeFileSync(join(f.source, 'node_modules/lib/index.js'), 'installed dependency');
    writeFileSync(join(f.source, 'run.sh'), 'original', { mode: 0o751 });
    symlinkSync('run.sh', join(f.source, 'link'));
    const reference = randomUUID(), runId = randomUUID(), orgId = randomUUID(), projectId = randomUUID();
    const referenceRoot = join(f.source, readRunCopyPath(reference)); mkdirSync(referenceRoot, { recursive: true });
    writeFileSync(join(referenceRoot, 'reference.txt'), 'read-run bytes');
    const { manifest, hash } = buildWorkspaceArtifactManifest({ workspaceRoot: referenceRoot });
    const state = await capture(f, { runId, orgId, projectId, readRuns: { version: 1, runId, orgId, projectId,
      readRuns: [{ runId: reference, status: 'delivered', endedAt: new Date().toISOString(), workspacePath: referenceRoot, manifestHash: hash, manifest }] }, environment: initialContextEnvironment({ ATOMA_PREVIOUS_RUN_RESULTS: '{"runs":[]}', OPENAI_API_KEY: 'never-retain' }) });
    writeFileSync(join(f.source, 'run.sh'), 'source mutated'); rmSync(f.source, { recursive: true });
    const frozen = join(f.root, 'frozen'); f.store.materialize(state, frozen);
    const readRuns = { ...state.readRuns!, runId: randomUUID(), readRuns: state.readRuns!.readRuns.map(read => ({ ...read, workspacePath: join(frozen, readRunCopyPath(read.runId)) })) };
    const readIndex = join(f.root, 'reads.json'); writeFileSync(readIndex, encodeReadRunsIndex(readRuns));
    const target = join(f.root, 'verification');
    const service = remote ? startWorkspaceProcess({ root: target, readRunsIndex: readIndex }) : undefined;
    const runtime = initialStateRuntime(service?.runtime ?? localWorkspaceRuntime({ root: target, readRuns, log() {} }), f.store, state);
    try {
      await runtime.prepare(true);
      await runtime.captureReadRuns();
      expect(await runtime.checkReadRuns()).toMatchObject([{ runId: reference, changedCount: 0, missingCount: 0, touchedCount: 0, directoryTouched: false }]);
      expect(readFileSync(join(target, readRunCopyPath(reference), 'reference.txt'), 'utf8')).toBe('read-run bytes');
      expect(readFileSync(join(target, '.env.local'), 'utf8')).toBe('fixture-only=retained');
      expect(readFileSync(join(target, 'node_modules/lib/index.js'), 'utf8')).toBe('installed dependency');
      expect(readFileSync(join(target, '.github/workflows/check.yml'), 'utf8')).toBe('private workflow bytes');
      expect(readFileSync(join(target, '.atoma-probes.json'), 'utf8')).toBe('{"version":1,"entries":[]}');
      expect(lstatSync(join(target, 'run.sh')).mode & 0o777).toBe(0o751);
      expect(readlinkSync(join(target, 'link'))).toBe('run.sh');
      writeFileSync(join(target, 'run.sh'), 'verification mutation');
      await runtime.restart();
      expect(readFileSync(join(target, 'run.sh'), 'utf8')).toBe('original');
      expect(state.environment).not.toHaveProperty('OPENAI_API_KEY');
      expect(() => f.store.publish(state)).toThrow('immutable');
      expect(() => f.store.read({ sourceRunId: state.runId, orgId: randomUUID(), projectId: state.projectId })).toThrow('scope');
    } finally { await service?.close(); f.db.close(); }
  });
  it('survives checkpoint GC, then deletes bytes at expiry even without any checkpoint table', async () => {
    const f = fixture(); writeFileSync(join(f.source, '.env'), 'private fixture');
    const state = await capture(f);
    expect(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='run_checkpoints'").get()).toBeUndefined();
    f.store.expire(state.runId);
    expect(f.db.prepare('SELECT count(*) AS n FROM run_checkpoint_files').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT count(*) AS n FROM run_checkpoint_snapshots').get()).toEqual({ n: 0 });
    const next = await capture(f);
    new RunCheckpointStore(f.db.name).pruneSnapshots();
    expect(f.store.read({ sourceRunId: next.runId, orgId: next.orgId, projectId: next.projectId })).not.toBeNull();
    f.db.close();
  });
  it('expires captures which contain a read-run copy when that reference expires', async () => {
    const f = fixture(), runId = randomUUID(), orgId = randomUUID(), projectId = randomUUID(), reference = randomUUID();
    const state = await capture(f, { runId, orgId, projectId, readRuns: { version: 1, runId, orgId, projectId,
      readRuns: [{ runId: reference, status: 'delivered', endedAt: new Date().toISOString(), workspacePath: '/not-used',
        manifestHash: 'a'.repeat(64), manifest: { version: 1, source: 'workspace', files: [], totalBytes: 0 } }] } });
    f.store.expireReferences(reference);
    expect(f.store.read({ sourceRunId: state.runId, orgId, projectId })).toBeNull();
    expect(f.db.prepare('SELECT count(*) AS n FROM run_checkpoint_snapshots').get()).toEqual({ n: 0 });
    f.db.close();
  });
  it('publishes no usable state for a truncated or corrupt streamed snapshot', async () => {
    const f = fixture(); writeFileSync(join(f.source, 'file'), 'entire file');
    const exporting = captureCheckpointExport(f.source);
    await expect(retainInitialWorkspace(f.db, { ...exporting, header: { ...exporting.header, digest: '0'.repeat(64) } })).rejects.toThrow('digest');
    expect(f.db.prepare('SELECT count(*) AS n FROM run_checkpoint_files').get()).toEqual({ n: 0 });
    f.db.close();
  });
  it('closes an execution-host export even when receiver construction refuses its header', async () => {
    const f = fixture(); let closed = 0, read = false;
    await expect(retainInitialWorkspace(f.db, { header: { digest: 'invalid', rootMode: 0o700 },
      async *frames() { read = true; yield { kind: 'chunk' as const, offset: 0, bytes: Buffer.from('must not consume') }; }, close() { closed++; },
    })).rejects.toThrow();
    expect(closed).toBe(1); expect(read).toBe(false); f.db.close();
  });
  it('removes read-only captured directories without following symlinks', () => {
    const f = fixture(); mkdirSync(join(f.source, 'locked')); writeFileSync(join(f.source, 'locked/file'), 'bytes');
    chmodSync(join(f.source, 'locked'), 0o555); removeInitialStateWorkspace(f.source);
    expect(() => lstatSync(f.source)).toThrow(); f.db.close();
  });
});
