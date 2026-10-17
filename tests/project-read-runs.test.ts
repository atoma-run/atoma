import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRunLog } from '../src/cli/burnin.js';
import { READ_RUNS_ENV, MAX_READ_RUN_BYTES, MAX_READ_RUN_FILES } from '../src/contracts/readRuns.js';
import { formatRunStatsEpilogue } from '../src/contracts/runStats.js';
import type { PlatformEventInput } from '../src/contracts/platformEvents.js';
import type { RunCheckpoint } from '../src/contracts/runCheckpoint.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { PlatformSettingsStore } from '../src/platform/settings.js';
import { GitHubStore } from '../src/github/store.js';
import { McpHttpHost } from '../src/mcp/http.js';
import { acquireRunLease } from '../src/mcp/runLock.js';
import { mcpHostWiring } from '../src/mcp/server.js';
import { assertPublishableArtifactPath } from '../src/projects/artifacts.js';
import { Conversations } from '../src/projects/conversations.js';
import { ProjectRunCoordinator, projectRunHostLayout, type ProjectRunDriver } from '../src/projects/coordinator.js';
import { ProjectRetrievalLaunchStore } from '../src/projects/retrievalLaunch.js';
import { retentionPlan } from '../src/projects/retention.js';
import { ProjectService } from '../src/projects/service.js';
import { assertPreviewCopyablePath, assertPreviewServablePath } from '../src/preview/policy.js';
import { RunCheckpointStore, checkpointWorkspaceDigest } from '../src/run/checkpoint.js';
import { readReadRunsIndex } from '../src/run/readRuns.js';
import { ARTIFACT_MANIFEST_PATH_ENV } from '../src/run/runner.js';
import { AssistantStore } from '../src/viz/assistantStore.js';
import { haystackTestEnvironment } from './helpers/haystack.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { retrievalContext } from './helpers/projectRetrievalCorpus.js';
import { ANTHROPIC_PINS } from './tier-pins.js';

/**
 * READ RUNS through the doors a request crosses — docs/decisions/read-runs-2026-10-17.md:
 * the MCP over HTTP in both protocol eras, the real coordinator and store on a
 * real SQLite file, the child replaced at the driver seam. What the child is
 * handed is decoded with the run process's own reader.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  closeStoreHandles();
});

const OVERRIDES = { l1: 'api:anthropic:claude-haiku-4-5', l2: 'api:anthropic:claude-sonnet-4-5', l3: 'api:anthropic:claude-opus-4-5' };

async function fixture(legacy = false) {
  // Retention refuses a symlinked ancestor; macOS aliases tmpdir() through /private.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-read-runs-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const f = projectRetrievalFixture(root);
  const driver = vi.fn<ProjectRunDriver>(async () => 'must not launch');
  const hostEnv = { ...haystackTestEnvironment(root), ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'private-test-key' };
  const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root, hostEnv, driver,
    acquireLease: id => acquireRunLease(id, join(root, 'lease.db')) });
  cleanups.push(async () => { await coordinator.waitForIdle(); coordinator.stopQueue(); });
  const github = GitHubStore.open(f.dbPath);
  github.linkInstallation({ installationId: '123', orgId: f.viewer.orgId, accountId: '123', accountLogin: 'owner',
    targetType: 'Organization', repositorySelection: 'all', permissions: { contents: 'write', administration: 'write' },
    connectedByPrincipalId: f.viewer.principalId });
  const journal: PlatformEventInput[] = [];
  const service = new ProjectService({ store: f.projects, coordinator, github, events: event => { journal.push(event); } });
  const chats = new Database(':memory:');
  cleanups.push(() => { chats.close(); });
  const conversations = new Conversations(new AssistantStore(chats), service);
  const server: Server = createServer((req, res) => void host.handle(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  const host = new McpHttpHost({ resolveCaller: () => ({ kind: 'principal', viewer: f.viewer, tokenId: 'test' }),
    ...mcpHostWiring({ conversations, projects: { store: f.projects, service }, auth: f.auth, journal: null, operatorRuns: false }),
    allowedHosts: [`127.0.0.1:${address.port}`] });
  cleanups.push(async () => { await host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = legacy ? new LegacyClient({ name: 'read-runs', version: '1' })
    : new Client({ name: 'read-runs-modern', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  if (client instanceof LegacyClient) await client.connect(new LegacyTransport(url));
  else await client.connect(new StreamableHTTPClientTransport(url));
  cleanups.push(() => client.close());
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const text = (result: Awaited<ReturnType<typeof call>>) => JSON.stringify(result.content);
  return { ...f, root, hostEnv, driver, coordinator, service, journal, client, call, text };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** What a finished run the child completed leaves behind: its own files, the copies it was given, a trace. */
function completes(f: Fixture, seen: Array<Parameters<ProjectRunDriver>[0]>) {
  f.driver.mockImplementation(async options => {
    seen.push(options);
    const workspace = options.env!['ATOMA_BUILD_WORKSPACE']!;
    const id = options.env!['ATOMA_RUN_ID']!;
    mkdirSync(join(workspace, 'browser'), { recursive: true });
    writeFileSync(join(workspace, 'browser/collect.js'), 'restored');
    // What the run process would have copied: never part of the delivery.
    mkdirSync(join(workspace, '.atoma-runs', id), { recursive: true });
    writeFileSync(join(workspace, '.atoma-runs', id, 'collect.js'), 'a reference copy');
    writeFileSync(options.env![ARTIFACT_MANIFEST_PATH_ENV]!, JSON.stringify({
      version: 1, runId: id, generatedAt: new Date().toISOString(), outputs: ['browser/collect.js'] }));
    const traces = options.env!['ATOMA_RUNS_DIR']!;
    mkdirSync(traces, { recursive: true });
    writeFileSync(join(traces, `${id}.json`), JSON.stringify({ id, endedAt: new Date().toISOString(), result: { summary: 'Restored' } }));
    return '✓ build finished';
  });
}

function runCount(f: Fixture): number {
  return f.projects.listProjectRuns(f.viewer.orgId, f.project.projectId)!.length;
}

describe('a run that reads other runs, through the MCP', () => {
  it.each([false, true])('lists the parameter and hands the child a private index of the exact saved files (legacy=%s)', async legacy => {
    const f = await fixture(legacy);
    const older = f.makeRun({ 'browser/collect.js': 'the bytes of run 50019ee0' }).run;
    const seed = f.makeRun({ 'browser/collect.js': 'the bytes of the seed' }).run;
    const tools = (await f.client.listTools()).tools;
    const parameter = tools.find(tool => tool.name === 'atoma_run_start')!.inputSchema.properties!['readRunIds'] as {
      type: string; maxItems: number; description: string };
    expect(parameter).toMatchObject({ type: 'array', maxItems: 3 });
    expect(parameter.description).toContain('Copied with their modes to .atoma-runs/<runId>/<path> before work starts');
    // The caps, what a later run reads, and the requests it cannot join (review 2026-10-17).
    expect(parameter.description).toContain(`at most 64 MiB and ${MAX_READ_RUN_FILES} files together`);
    expect(parameter.description).toContain('a comparison rerun or continuation reads the same runs again');
    expect(parameter.description).toContain('Not with rerunOf or resumeOf');
    const seen: Array<Parameters<ProjectRunDriver>[0]> = [];
    completes(f, seen);
    const args = { projectId: f.project.projectId, goal: 'Restore browser/collect.js to the bytes of the older run.',
      idempotencyKey: 'restore-older', readRunIds: [seed.projectRunId, older.projectRunId] };
    const result = await f.call('atoma_run_start', args);
    expect(result.isError, f.text(result)).not.toBe(true);
    const sorted = [older.projectRunId, seed.projectRunId].sort();
    expect(result.structuredContent).toMatchObject({ status: 'delivered', readRunIds: sorted });
    expect(seen).toHaveLength(1);
    const env = seen[0]!.env!;
    const indexPath = env[READ_RUNS_ENV]!;
    // Outside the workspace the worker mounts, private to the host user.
    const workspace = env['ATOMA_BUILD_WORKSPACE']!;
    expect(relative(workspace, indexPath).startsWith('..')).toBe(true);
    expect(statSync(indexPath).mode & 0o777).toBe(0o600);
    const index = readReadRunsIndex(indexPath);
    expect(index).toMatchObject({ orgId: f.viewer.orgId, projectId: f.project.projectId, runId: env['ATOMA_RUN_ID'] });
    expect(index.readRuns.map(entry => entry.runId)).toEqual(sorted);
    for (const read of [older, seed]) {
      expect(index.readRuns.find(entry => entry.runId === read.projectRunId)).toEqual({ runId: read.projectRunId,
        status: 'delivered', endedAt: read.endedAt, workspacePath: read.hostPaths.workspacePath,
        manifestHash: read.artifactManifestHash, manifest: read.artifactManifest });
    }
    // The run's own row, its status payload and the journal name the ids, never text.
    const row = f.projects.getProjectRun(f.viewer.orgId, env['ATOMA_RUN_ID']!)!;
    expect(row.readRunIds).toEqual(sorted);
    expect(f.journal.find(event => event.kind === 'run.started')?.detail).toEqual({ readRunIds: sorted });
    // Delivered without the copies: the inventory, publication, preview and corpus share one exclusion.
    expect(row.artifactManifest!.files.map(file => file.path)).toEqual(['browser/collect.js']);
    const copy = `.atoma-runs/${row.projectRunId}/collect.js`;
    expect(() => assertPublishableArtifactPath(copy)).toThrow('excluded');
    expect(() => assertPreviewCopyablePath(copy)).toThrow();
    expect(() => assertPreviewServablePath(copy)).toThrow();
    // An exact retry re-attaches; the same key naming other runs is another request.
    expect((await f.call('atoma_run_start', args)).isError).not.toBe(true);
    expect(f.driver).toHaveBeenCalledTimes(1);
    const conflict = await f.call('atoma_run_start', { ...args, readRunIds: [older.projectRunId] });
    expect(conflict.isError).toBe(true);
    expect(f.text(conflict)).toContain('409');
    expect(f.driver).toHaveBeenCalledTimes(1);
  });

  it('leaves the copies out of the next run\'s document corpus, which the same inventory selects', async () => {
    const f = await fixture();
    const finished = join(f.root, 'finished-workspace');
    mkdirSync(join(finished, 'docs'), { recursive: true });
    writeFileSync(join(finished, 'docs', 'guide.md'), '# Guide\n\nHow the collector restarts.\n');
    mkdirSync(join(finished, '.atoma-runs', randomUUID(), 'docs'), { recursive: true });
    for (const name of readdirSync(join(finished, '.atoma-runs'))) {
      writeFileSync(join(finished, '.atoma-runs', name, 'docs', 'guide.md'), '# Old guide\n\nThe read run\'s version.\n');
    }
    const next = f.makeRun();
    const launch = await ProjectRetrievalLaunchStore.open(f.dbPath).prepare(next.run.projectRunId, null, retrievalContext(), finished);
    expect(launch.manifest.documents.map(document => document.path)).toEqual(['docs/guide.md']);
  });

  it.each([false, true])('refuses read runs beside a shared approval before any side effect (legacy=%s)', async legacy => {
    const f = await fixture(legacy);
    const older = f.makeRun({ 'a.txt': 'a' }).run;
    const before = runCount(f);
    const result = await f.call('atoma_run_start', { projectId: f.project.projectId, goal: 'Restore a.txt',
      readRunIds: [older.projectRunId], conversationApproval: { conversationId: randomUUID(), proposalId: randomUUID(),
        requestId: randomUUID(), version: 0, confirmation: 'Approved.' } });
    expect(result.isError).toBe(true);
    expect(f.text(result)).toContain('without run overrides');
    expect(f.driver).not.toHaveBeenCalled();
    expect(runCount(f)).toBe(before);
  });

  it('refuses a foreign, other-project, comparison, expired, oversized, too-many-files or changed read run before reserving anything', async () => {
    const f = await fixture();
    const kept = f.makeRun({ 'a.txt': 'saved' }).run;
    const foreign = projectRetrievalFixture(f.root, { subject: 'foreign-reader', slug: 'foreign-reader' }).makeRun({ 'a.txt': 'x' }).run;
    const otherProject = projectRetrievalFixture(f.root, { slug: 'same-org-other' }).makeRun({ 'a.txt': 'y' }).run;
    // A comparison rerun's saved files compare models, never a version to read.
    const rerunId = randomUUID();
    f.projects.createProjectRun({ orgId: f.viewer.orgId, projectId: f.project.projectId, principalId: f.viewer.principalId,
      projectRunId: rerunId, request: { rerunOf: kept.projectRunId, idempotencyKey: rerunId, models: OVERRIDES },
      origin: { goal: kept.goal, acceptance: null }, hostPaths: kept.hostPaths });
    f.projects.transitionProjectRun({ orgId: f.viewer.orgId, projectRunId: rerunId, from: 'queued', to: 'running' });
    f.projects.completeProjectRun({ orgId: f.viewer.orgId, projectRunId: rerunId, traceId: rerunId,
      stats: parseRunLog('✓ build finished'), manifest: kept.artifactManifest! });
    const expired = f.makeRun({ 'a.txt': 'expired' }).run;
    const oversized = f.makeRun({ 'a.txt': 'small on disk' }).run;
    const crowded = f.makeRun({ 'a.txt': 'small on disk' }).run;
    const db = new Database(f.dbPath);
    try {
      db.prepare('UPDATE project_runs SET bytes_expired_at = ? WHERE project_run_id = ?').run(new Date().toISOString(), expired.projectRunId);
      // Both caps read the saved manifests, before a byte is hashed.
      const files = Array.from({ length: 7 }, (_, i) => ({ path: `big-${i}.bin`, size: 10 * 1024 * 1024, sha256: 'a'.repeat(64), mode: '100644' }));
      const manifest = { version: 1, files, totalBytes: 70 * 1024 * 1024 };
      expect(manifest.totalBytes).toBeGreaterThan(MAX_READ_RUN_BYTES);
      db.prepare('UPDATE project_runs SET artifact_manifest_json = ?, artifact_manifest_hash = ? WHERE project_run_id = ?')
        .run(JSON.stringify(manifest), 'b'.repeat(64), oversized.projectRunId);
      // Bytes alone admitted 100,000 one-byte files a run (review 2026-10-17): with `kept`, one file over the cap.
      const many = Array.from({ length: MAX_READ_RUN_FILES }, (_, i) => ({ path: `f${String(i).padStart(6, '0')}.txt`, size: 1, sha256: 'c'.repeat(64), mode: '100644' }));
      db.prepare('UPDATE project_runs SET artifact_manifest_json = ?, artifact_manifest_hash = ? WHERE project_run_id = ?')
        .run(JSON.stringify({ version: 1, source: 'workspace', files: many, totalBytes: many.length }), 'd'.repeat(64), crowded.projectRunId);
    } finally { db.close(); }
    const changed = f.makeRun({ 'a.txt': 'saved' }).run;
    writeFileSync(join(changed.hostPaths.workspacePath, 'a.txt'), 'changed after delivery');
    const before = runCount(f);
    const start = (readRunIds: string[]) => f.call('atoma_run_start', { projectId: f.project.projectId,
      goal: 'Compare with that run', idempotencyKey: randomUUID(), readRunIds });
    for (const [readRun, why] of [[randomUUID(), 'retained delivered or partial run'], [foreign.projectRunId, 'retained delivered or partial run'],
      [otherProject.projectRunId, 'retained delivered or partial run'], [rerunId, 'not a comparison rerun'],
      [expired.projectRunId, 'retained delivered or partial run'], [oversized.projectRunId, 'saved bytes together'],
      [crowded.projectRunId, `${MAX_READ_RUN_FILES + 1} saved files together; at most ${MAX_READ_RUN_FILES}`],
      [changed.projectRunId, 'unavailable or changed']] as const) {
      const result = await start([kept.projectRunId, readRun]);
      expect(result.isError, readRun).toBe(true);
      expect(f.text(result)).toContain('409');
      expect(f.text(result)).toContain(why);
    }
    // A continuation reads what its source read; a rerun, what its origin read.
    await expect(f.service.startProjectRunFromInput(f.viewer, f.project.projectId, { goal: 'Continue', idempotencyKey: randomUUID(),
      resumeOf: kept.projectRunId, readRunIds: [kept.projectRunId] })).rejects.toThrow('invalid run payload');
    expect((await f.call('atoma_run_start', { projectId: f.project.projectId, idempotencyKey: randomUUID(), rerunOf: kept.projectRunId,
      models: OVERRIDES, readRunIds: [kept.projectRunId] })).isError).toBe(true);
    expect(f.driver).not.toHaveBeenCalled();
    expect(runCount(f)).toBe(before);
  });
});

describe('a run that reads other runs, in the coordinator', () => {
  it.each([false, true])('keeps a queued run\'s read runs across a restart and refuses one whose bytes changed (changed=%s)', async changed => {
    const f = await fixture();
    const read = f.makeRun({ 'a.txt': 'saved version' }).run;
    // One slot, held by another organisation: the start waits in the queue.
    PlatformSettingsStore.open(f.dbPath).set({ 'run.concurrentMax': 1 }, null);
    const lockPath = join(f.root, 'queue-lease.db');
    const holder = await acquireRunLease('busy', lockPath, { orgId: randomUUID() });
    const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: f.root, hostEnv: f.hostEnv,
      driver: f.driver, acquireLease: (id, scope) => acquireRunLease(id, lockPath, scope) });
    try {
      const queued = await coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId, projectId: f.project.projectId,
        request: { goal: 'Compare with the saved version', idempotencyKey: randomUUID(), readRunIds: [read.projectRunId] } });
      expect(queued).toMatchObject({ status: 'queued', readRunIds: [read.projectRunId] });
      coordinator.stopQueue();
      holder.release();
      if (changed) writeFileSync(join(read.hostPaths.workspacePath, 'a.txt'), 'changed while queued');
      const script = `
        import { ProjectRunCoordinator } from './src/projects/coordinator.ts';
        import { ProjectStore } from './src/projects/store.ts';
        import { acquireRunLease } from './src/mcp/runLock.ts';
        const coordinator = new ProjectRunCoordinator({
          store: ProjectStore.open(${JSON.stringify(f.dbPath)}), dbPath: ${JSON.stringify(f.dbPath)},
          projectsRoot: ${JSON.stringify(f.root)}, hostEnv: ${JSON.stringify(f.hostEnv)},
          acquireLease: (id, scope) => acquireRunLease(id, ${JSON.stringify(lockPath)}, scope),
          driver: async (options) => { console.log('READ_RUNS:' + options.env.${READ_RUNS_ENV}); throw new Error('test driver ended'); },
        });
        coordinator.reconcileInterrupted();
        await coordinator.waitForIdle();
        coordinator.stopQueue();
      `;
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
      expect(child.status, child.stderr).toBe(0);
      const row = f.projects.getProjectRun(f.viewer.orgId, queued.projectRunId)!;
      expect(row.readRunIds).toEqual([read.projectRunId]);
      if (changed) {
        expect(child.stdout).not.toContain('READ_RUNS:');
        expect(row.status).toBe('failed');
      } else {
        const indexPath = /READ_RUNS:(\S+)/.exec(child.stdout)![1]!;
        expect(readReadRunsIndex(indexPath).readRuns.map(entry => entry.runId)).toEqual([read.projectRunId]);
      }
      expect(f.driver).not.toHaveBeenCalled();
      // The list is a fact about the request: no writer may change it.
      const db = new Database(f.dbPath);
      try {
        expect(() => db.prepare('UPDATE project_runs SET read_run_ids_json = NULL WHERE project_run_id = ?').run(queued.projectRunId))
          .toThrow('immutable');
      } finally { db.close(); }
    } finally { coordinator.stopQueue(); holder.release(); }
  });

  it('does not re-attach a live request naming other runs, and holds every run a live run reads from retention', async () => {
    const f = await fixture();
    const first = f.makeRun({ 'a.txt': 'first' }).run;
    const second = f.makeRun({ 'a.txt': 'second' }).run;
    let release = (_value: string) => {};
    f.driver.mockImplementation(options => new Promise<string>(resolve => {
      release = resolve;
      options.signal?.addEventListener('abort', () => resolve('--- run cancelled ---\n'), { once: true });
    }));
    const request = { goal: 'Compare', idempotencyKey: randomUUID(), readRunIds: [first.projectRunId] };
    const live = await f.coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId, projectId: f.project.projectId, request });
    await vi.waitFor(() => expect(f.driver).toHaveBeenCalledTimes(1));
    // The same goal under a fresh key re-attaches only when it reads the same runs.
    expect((await f.coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId, projectId: f.project.projectId,
      request: { ...request, idempotencyKey: randomUUID() } })).projectRunId).toBe(live.projectRunId);
    await expect(f.coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId, projectId: f.project.projectId,
      request: { ...request, idempotencyKey: randomUUID(), readRunIds: [second.projectRunId] } })).rejects.toThrow(/limit reached/);
    const db = new Database(f.dbPath);
    try {
      db.prepare("UPDATE project_runs SET created_at='2025-01-01T00:00:00Z', ended_at='2025-01-02T00:00:00Z' WHERE status='delivered'").run();
      const plan = retentionPlan(db, f.root, undefined, new Date('2026-10-17T00:00:00Z'));
      expect(plan.find(row => row.runId === first.projectRunId)?.held).toBe('active read run');
      expect(plan.find(row => row.runId === second.projectRunId)?.held).not.toBe('active read run');
    } finally { db.close(); }
    release('--- run failed ---\n');
    await f.coordinator.waitForIdle();
  });

  it('a comparison rerun reads what its origin read, and is refused once one of those expired', async () => {
    const f = await fixture();
    const read = f.makeRun({ 'browser/collect.js': 'the bytes to restore' }).run;
    const seen: Array<Parameters<ProjectRunDriver>[0]> = [];
    completes(f, seen);
    const origin = await f.service.startProjectRunFromInput(f.viewer, f.project.projectId, {
      goal: 'Restore browser/collect.js', idempotencyKey: randomUUID(), readRunIds: [read.projectRunId] }) as { projectRunId: string };
    await f.coordinator.waitForIdle();
    expect(f.projects.getProjectRun(f.viewer.orgId, origin.projectRunId)?.status).toBe('delivered');
    const rerun = await f.service.startProjectRunFromInput(f.viewer, f.project.projectId, {
      rerunOf: origin.projectRunId, idempotencyKey: randomUUID(), models: OVERRIDES }) as { projectRunId: string; readRunIds?: string[] };
    expect(rerun.readRunIds).toEqual([read.projectRunId]);
    await f.coordinator.waitForIdle();
    expect(seen).toHaveLength(2);
    expect(readReadRunsIndex(seen[1]!.env![READ_RUNS_ENV]!).readRuns.map(entry => entry.runId)).toEqual([read.projectRunId]);
    const db = new Database(f.dbPath);
    try { db.prepare('UPDATE project_runs SET bytes_expired_at = ? WHERE project_run_id = ?').run(new Date().toISOString(), read.projectRunId); }
    finally { db.close(); }
    await expect(f.service.startProjectRunFromInput(f.viewer, f.project.projectId, {
      rerunOf: origin.projectRunId, idempotencyKey: randomUUID(), models: OVERRIDES })).rejects.toThrow('which this run read, have expired');
    expect(seen).toHaveLength(2);
  });

  it('a continuation reads what its source read, from the stored manifests, whatever their bytes became', async () => {
    const f = await fixture();
    const read = f.makeRun({ 'a.txt': 'saved version' }).run;
    const id = randomUUID();
    const layout = projectRunHostLayout(f.root, f.viewer.orgId, f.project.projectId, id);
    f.projects.createProjectRun({ orgId: f.viewer.orgId, projectId: f.project.projectId, principalId: f.viewer.principalId, projectRunId: id,
      request: { goal: 'Compare with the saved version', idempotencyKey: id, readRunIds: [read.projectRunId], depth: 'deep' },
      hostPaths: { workspacePath: layout.workspacePath, runsPath: layout.runsPath, logPath: layout.logPath } });
    f.projects.transitionProjectRun({ orgId: f.viewer.orgId, projectRunId: id, from: 'queued', to: 'running' });
    mkdirSync(join(layout.workspacePath, '.atoma-runs', read.projectRunId), { recursive: true });
    writeFileSync(join(layout.workspacePath, '.atoma-runs', read.projectRunId, 'a.txt'), 'saved version');
    await ProjectRetrievalLaunchStore.open(f.dbPath).prepare(id, null, retrievalContext());
    const checkpoints = new RunCheckpointStore(f.dbPath);
    const data: RunCheckpoint = { version: 1, id, goal: 'Compare with the saved version', workspace: realpathSync(layout.workspacePath), policy: '{}',
      scope: { orgId: f.viewer.orgId, projectId: f.project.projectId, principalId: f.viewer.principalId, runId: id },
      actor: { name: 'Meristem', atomId: 'actor', version: 1 }, checklist: [],
      root: { plan: { subtasks: [{}, {}] }, strategy: {}, plannedPhases: 2 },
      completed: [{ output: {}, summary: 'Saved phase', producedBy: { tier: 2, name: 'Cell', viaFallback: false } }],
      workspaceDigest: checkpointWorkspaceDigest(realpathSync(layout.workspacePath)), processes: [],
      consumed: { tokens: 20, costUsd: 0.01 }, remainingMs: 300000, lastRunId: id };
    const owner = checkpoints.claim(data, true);
    checkpoints.write(data, owner, 'ready', true);
    f.projects.transitionProjectRun({ orgId: f.viewer.orgId, projectRunId: id, from: 'running', to: 'partial', traceId: id,
      stats: { ...parseRunLog('✓ build finished'), outcome: 'partial' } });
    // The read run's bytes go; the continuation's copy is in its sealed workspace.
    const db = new Database(f.dbPath);
    try { db.prepare('UPDATE project_runs SET bytes_expired_at = ? WHERE project_run_id = ?').run(new Date().toISOString(), read.projectRunId); }
    finally { db.close(); }
    rmSync(read.hostPaths.workspacePath, { recursive: true, force: true });
    const seen: Array<Parameters<ProjectRunDriver>[0]> = [];
    f.driver.mockImplementation(async options => { seen.push(options); return '--- run failed ---\n'; });
    const continued = await f.service.controlCheckpoint(f.viewer, f.project.projectId, id, 'resume') as { projectRunId: string; readRunIds?: string[] };
    expect(continued.readRunIds).toEqual([read.projectRunId]);
    await f.coordinator.waitForIdle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.extraArgs).toContain('--resume');
    const index = readReadRunsIndex(seen[0]!.env![READ_RUNS_ENV]!);
    expect(index).toMatchObject({ runId: continued.projectRunId, readRuns: [{ runId: read.projectRunId, manifestHash: read.artifactManifestHash }] });
    // Its identity is its source's list: the same continuation request finds it again.
    expect(f.projects.findProjectRunForRequest(f.viewer.orgId, f.project.projectId, f.viewer.principalId, {
      resumeOf: id, goal: 'Compare with the saved version', depth: 'deep',
      idempotencyKey: f.projects.getProjectRun(f.viewer.orgId, continued.projectRunId)!.requestKey })?.projectRunId).toBe(continued.projectRunId);
  });
});

describe('the copies once a run that read them ends', () => {
  // A finished run's copies only kept another run's bytes past that run's own
  // retention; one that can still be continued keeps them, and holds the runs
  // it read from retention (review 2026-10-17).
  it.each([
    { end: 'delivered', status: 'delivered', state: undefined, kept: false },
    { end: 'failed', status: 'failed', state: undefined, kept: false },
    { end: 'paused', status: 'partial', state: 'paused', kept: true },
    { end: 'interrupted', status: 'failed', state: 'recoverable', kept: true },
  ] as const)('$end: removes them unless the run can be continued, and holds the read run while it can', async ({ end, status, state, kept }) => {
    const f = await fixture();
    const read = f.makeRun({ 'a.txt': 'saved version' }).run;
    const checkpoints = new RunCheckpointStore(f.dbPath);
    f.driver.mockImplementation(async options => {
      const env = options.env!;
      const id = env['ATOMA_RUN_ID']!;
      const workspace = env['ATOMA_BUILD_WORKSPACE']!;
      // What the run process copied, and what the run restored from it.
      mkdirSync(join(workspace, '.atoma-runs', read.projectRunId), { recursive: true });
      writeFileSync(join(workspace, '.atoma-runs', read.projectRunId, 'a.txt'), 'saved version');
      writeFileSync(join(workspace, 'a.txt'), 'saved version');
      mkdirSync(env['ATOMA_RUNS_DIR']!, { recursive: true });
      if (end === 'paused' || end === 'interrupted') {
        const data: RunCheckpoint = { version: 1, id, goal: options.goal, workspace: realpathSync(workspace), policy: '{}',
          scope: { orgId: f.viewer.orgId, projectId: f.project.projectId, principalId: f.viewer.principalId, runId: id },
          actor: { name: 'Meristem', atomId: 'actor', version: 1 }, checklist: [],
          root: { plan: { subtasks: [{}, {}] }, strategy: {}, plannedPhases: 2 },
          completed: [{ output: {}, summary: 'Saved first phase', producedBy: { tier: 2, name: 'Cell', viaFallback: false } }],
          workspaceDigest: checkpointWorkspaceDigest(realpathSync(workspace)), processes: [],
          consumed: { tokens: 20, costUsd: 0.01 }, remainingMs: 300000, lastRunId: id };
        const owner = checkpoints.claim(data, true);
        checkpoints.write(data, owner, 'ready', true);
        if (end === 'interrupted') {
          checkpoints.beginSegment(data, Date.now() + 300000);
          checkpoints.boundary(data, owner);
          const connection = new Database(f.dbPath);
          connection.prepare('UPDATE run_checkpoints SET pid=? WHERE id=?').run(2000000000, id);
          connection.close();
        }
      }
      if (end === 'failed' || end === 'interrupted') throw new Error('worker interrupted');
      writeFileSync(options.env![ARTIFACT_MANIFEST_PATH_ENV]!, JSON.stringify({
        version: 1, runId: id, generatedAt: new Date().toISOString(), outputs: ['a.txt'] }));
      writeFileSync(join(env['ATOMA_RUNS_DIR']!, `${id}.json`), JSON.stringify({ id, endedAt: new Date().toISOString(),
        result: { output: {}, summary: 'Restored', ...(end === 'paused' ? { refusal: 'Paused before final acceptance' } : {}) } }));
      return formatRunStatsEpilogue({ ...parseRunLog('✓ build finished'), outcome: end === 'paused' ? 'partial' : 'delivered' });
    });
    const started = await f.coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId, projectId: f.project.projectId,
      request: { goal: 'Restore a.txt to the saved version', idempotencyKey: randomUUID(), readRunIds: [read.projectRunId] } });
    await f.coordinator.waitForIdle();
    const ended = f.projects.getProjectRun(f.viewer.orgId, started.projectRunId)!;
    expect(ended.status).toBe(status);
    expect(f.coordinator.checkpointStatus(ended)?.state).toBe(state);
    expect(existsSync(join(ended.hostPaths.workspacePath, '.atoma-runs'))).toBe(kept);
    // Never the run's own files, and never the read run's.
    expect(existsSync(join(ended.hostPaths.workspacePath, 'a.txt'))).toBe(true);
    expect(existsSync(join(read.hostPaths.workspacePath, 'a.txt'))).toBe(true);
    if (status === 'delivered') expect(ended.artifactManifest!.files.map(file => file.path)).toEqual(['a.txt']);
    const db = new Database(f.dbPath);
    try {
      db.prepare("UPDATE project_runs SET created_at='2025-01-01T00:00:00Z', ended_at='2025-01-02T00:00:00Z' WHERE project_run_id = ?")
        .run(read.projectRunId);
      const plan = retentionPlan(db, f.root, undefined, new Date('2026-10-17T00:00:00Z'));
      expect(plan.find(row => row.runId === read.projectRunId)?.held === 'active read run').toBe(kept);
    } finally { db.close(); }
  });
});
