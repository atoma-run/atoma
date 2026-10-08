import Database from 'better-sqlite3';
import { createServer, type Server } from 'node:http';
import { parseRunLog } from '../src/cli/burnin.js';
import { randomUUID } from 'node:crypto';
import { cpSync, readFileSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { ARTIFACT_MANIFEST_PATH_ENV } from '../src/run/runner.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GetTaskResultSchema, CreateTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { artifactFileResultSchema, artifactPageResultSchema, compactRunSchema, runViewSchema, serviceProblemSchema, runComparisonResultSchema } from '../src/contracts/clientExperience.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { GitHubStore } from '../src/github/store.js';
import { McpHttpHost } from '../src/mcp/http.js';
import { mcpHostWiring } from '../src/mcp/server.js';
import { projectFileUri } from '../src/mcp/resources.js';
import { projectRunTaskId } from '../src/mcp/tasks.js';
import { ProjectRunCoordinator, type ProjectRunDriver, type ProjectRunPublisher } from '../src/projects/coordinator.js';
import { acquireRunLease } from '../src/mcp/runLock.js';
import { RunCheckpointStore, checkpointWorkspaceDigest } from '../src/run/checkpoint.js';
import type { RunCheckpoint } from '../src/contracts/runCheckpoint.js';
import { ProjectService } from '../src/projects/service.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { haystackTestEnvironment } from './helpers/haystack.js';
import { ANTHROPIC_PINS } from './tier-pins.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); closeStoreHandles(); });

async function fixture(legacy = false, publisherFor?: (f: ReturnType<typeof projectRetrievalFixture>) => ProjectRunPublisher) {
  const root = mkdtempSync(join(tmpdir(), 'atoma-mcp-experience-'));
  cleanups.push(async () => { closeStoreHandles(); rmSync(root, { recursive: true, force: true }); });
  const f = projectRetrievalFixture(root);
  const driver = vi.fn<ProjectRunDriver>(async () => 'must not launch');
  const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root,
    hostEnv: { ...haystackTestEnvironment(root), ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'private-test-key' }, driver,
    acquireLease: id => acquireRunLease(id, join(root, 'lease.db')),
    ...(publisherFor ? { publisher: publisherFor(f) } : {}) });
  const github = GitHubStore.open(f.dbPath);
  github.linkInstallation({ installationId: '123', orgId: f.viewer.orgId, accountId: '123', accountLogin: 'owner',
    targetType: 'Organization', repositorySelection: 'all', permissions: { contents: 'write', administration: 'write' },
    connectedByPrincipalId: f.viewer.principalId });
  const service = new ProjectService({ store: f.projects, coordinator, github });
  let currentViewer = f.viewer;
  const server: Server = createServer((req, res) => void host.handle(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  const host = new McpHttpHost({ resolveCaller: () => ({ kind: 'principal', viewer: currentViewer, tokenId: 'test' }),
    ...mcpHostWiring({ projects: { store: f.projects, service }, auth: f.auth, journal: null, operatorRuns: false }),
    allowedHosts: [`127.0.0.1:${address.port}`] });
  cleanups.push(async () => { await host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = legacy ? new LegacyClient({ name: 'text-only', version: '1' })
    : new Client({ name: 'modern-text-only', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  if (client instanceof LegacyClient) await client.connect(new LegacyTransport(url));
  else await client.connect(new StreamableHTTPClientTransport(url));
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text' })]));
    return result;
  };
  return { ...f, service, coordinator, driver, client, call, url, setViewer: (v: typeof f.viewer) => { currentViewer = v; } };
}

it('pages compact menus without full traces and preserves the legacy array text on both eras', async () => {
  const f = await fixture();
  const ids = [f.makeRun({ 'a.txt': 'a' }), f.makeRun({ 'b.txt': 'b' }), f.makeRun({ 'c.txt': 'c' })].map(item => item.run.projectRunId);
  const shape = z.object({ runs: z.array(compactRunSchema), nextCursor: z.string().nullable() });
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await f.call('atoma_project_runs', { projectId: f.project.projectId, view: 'compact', limit: 1, ...(cursor ? { cursor } : {}) });
    const page = shape.parse(result.structuredContent);
    expect(page.runs).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/artifactManifest|hostPaths|traceSummary/);
    seen.push(page.runs[0]!.projectRunId);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen.sort()).toEqual(ids.sort());
  const first = shape.parse((await f.call('atoma_project_runs', { projectId: f.project.projectId, limit: 1 })).structuredContent);
  const changed = await f.client.callTool({ name: 'atoma_project_runs', arguments: { projectId: f.project.projectId, cursor: first.nextCursor, search: 'different' } });
  expect(changed.isError).toBe(true);
  expect(z.object({ error: serviceProblemSchema }).parse(changed.structuredContent).error).toMatchObject({ code: 'invalid_input', fields: ['cursor'] });
  expect(shape.parse((await f.call('atoma_project_runs', { projectId: f.project.projectId, search: 'no matches' })).structuredContent).runs).toEqual([]);
  const projects = await f.call('atoma_projects_list', { view: 'compact', search: 'Docs', limit: 1 });
  expect(z.object({ projects: z.array(z.unknown()) }).parse(projects.structuredContent).projects).toEqual([expect.objectContaining({ projectId: f.project.projectId })]);
  for (const instance of [f, await fixture(true)]) {
    const result = await instance.call('atoma_project_runs', { projectId: instance.project.projectId });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(Array.isArray(JSON.parse(content[0]!.text!))).toBe(true);
    expect(z.object({ runs: z.array(z.unknown()) }).parse(result.structuredContent).runs).toEqual(JSON.parse(content[0]!.text!));
  }
  f.setViewer({ ...f.viewer, orgId: randomUUID(), platformAdmin: false });
  const denied = await f.client.callTool({ name: 'atoma_project_runs', arguments: { projectId: f.project.projectId, view: 'compact' } });
  expect(denied.isError).toBe(true);
});

it('reads manifest files through tools and resources, with honest text fallback, integrity and tenant isolation', async () => {
  const f = await fixture();
  const filename = 'design/été %23 #.md';
  const text = 'A model-authored <script>text</script> is data.';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLagAAAAASUVORK5CYII=', 'base64');
  const { run, layout } = f.makeRun({ [filename]: text, 'plot.png': png, 'design.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' });
  const ref = { projectId: f.project.projectId, runId: run.projectRunId };
  const page = artifactPageResultSchema.parse((await f.call('atoma_run_artifacts', { ...ref, limit: 1 })).structuredContent);
  expect(page.total).toBe(3); expect(page.nextOffset).toBe(1);
  const read = artifactFileResultSchema.parse((await f.call('atoma_run_file', { ...ref, path: filename, limit: 9 })).structuredContent);
  const rest = artifactFileResultSchema.parse((await f.call('atoma_run_file', { ...ref, path: filename, offset: read.nextTextOffset, snapshot: read.snapshot })).structuredContent);
  expect(read.text! + rest.text!).toBe(text);
  expect(read.untrusted).toBe(true);
  const uri = projectFileUri(ref.projectId, ref.runId, filename);
  expect((await f.client.readResource({ uri })).contents[0]).toMatchObject({ text });
  const image = await f.call('atoma_run_file', { ...ref, path: 'plot.png', image: true });
  expect(image.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', mimeType: 'image/png', data: png.toString('base64') })]));
  expect(image.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'resource_link', mimeType: 'image/png' })]));
  const svg = await f.client.readResource({ uri: projectFileUri(ref.projectId, ref.runId, 'design.svg') });
  expect(svg.contents[0]?.mimeType).toBe('image/svg+xml');
  writeFileSync(join(layout.workspacePath, 'unlisted.txt'), 'private');
  for (const path of ['../atoma.db', 'unlisted.txt', '.env']) {
    const refused = await f.client.callTool({ name: 'atoma_run_file', arguments: { ...ref, path } });
    expect(refused.isError).toBe(true);
    expect(z.object({ error: serviceProblemSchema }).parse(refused.structuredContent).error.nextAction).toBeTruthy();
  }
  writeFileSync(join(layout.workspacePath, filename), 'modified bytes');
  expect((await f.client.callTool({ name: 'atoma_run_file', arguments: { ...ref, path: filename, snapshot: read.snapshot } })).isError).toBe(true);
  await expect(f.client.readResource({ uri })).rejects.toThrow(/differs/);
  f.setViewer({ ...f.viewer, orgId: randomUUID(), platformAdmin: false });
  await expect(f.client.readResource({ uri: projectFileUri(ref.projectId, ref.runId, 'plot.png') })).rejects.toThrow(/not found/);
});

it('projects recorded activity into status and durable tasks without inventing percentages or delivery', async () => {
  const f = await fixture(true);
  const { run, layout } = f.makeRun();
  const ref = { projectId: f.project.projectId, runId: run.projectRunId };
  mkdirSync(layout.runsPath, { recursive: true });
  const file = join(layout.runsPath, `${run.projectRunId}.json`);
  const trace = { id: run.projectRunId, events: [{ kind: 'llm-start', ts: Date.now(), role: 'execute' }] };
  writeFileSync(file, JSON.stringify(trace));
  const result = runViewSchema.parse((await f.call('atoma_run_status', ref)).structuredContent);
  expect(result.progress).toMatchObject({ stage: 'building', evidence: 'available', source: 'trace' });
  expect(result.actions?.canCancel).toBe(true);
  const task = await (f.client as LegacyClient).request({ method: 'tasks/get', params: { taskId: projectRunTaskId(ref.projectId, ref.runId) } }, GetTaskResultSchema);
  expect(task.statusMessage).toContain('Carrying out the planned work.');
  writeFileSync(file, JSON.stringify({ ...trace, events: [...trace.events, { kind: 'acceptance', ts: Date.now(), attempt: 1, approved: false, reasoning: 'Recorded review',
    acceptor: { name: 'Root', tier: 3, role: 'root-acceptor' }, executor: { name: 'Cell', tier: 2, viaFallback: false },
    gates: [], probe: { requiresReview: false, contradiction: false }, floorCoverage: [], phaseCoverage: [], basis: 'validation-call',
    checklist: [{ id: 'c1', behaviour: 'Reads the file', kind: 'review', status: 'review', observationRefs: [], judgement: { met: false, reason: 'Still missing' } }] }] }));
  const checking = runViewSchema.parse((await f.call('atoma_run_status', ref)).structuredContent);
  expect(checking.progress).toMatchObject({ stage: 'checking', acceptanceApproved: false, criteria: [{ met: false, reason: 'Still missing' }] });
  f.projects.transitionProjectRun({ orgId: f.viewer.orgId, projectRunId: ref.runId, from: 'running', to: 'failed', error: 'Test failure' });
  expect(runViewSchema.parse((await f.call('atoma_run_status', ref)).structuredContent)).toMatchObject({ status: 'failed', progress: { stage: 'finished' }, actions: { canCancel: false } });
  writeFileSync(file, '{unfinished');
  expect(runViewSchema.parse((await f.call('atoma_run_status', ref)).structuredContent).progress).toMatchObject({ stage: 'finished', evidence: 'unavailable' });
});

it('checks saved readiness without executing, reserving work or exposing credentials', async () => {
  const f = await fixture();
  const before = readdirSync(f.root).sort();
  const result = await f.call('atoma_project_readiness', { projectId: f.project.projectId });
  expect(result.structuredContent).toMatchObject({ configured: true, canRequest: true, liveChecks: 'not-performed', problems: [] });
  expect(JSON.stringify(result)).not.toContain('private-test-key');
  expect(readdirSync(f.root).sort()).toEqual(before);
  expect(f.projects.listProjectRuns(f.viewer.orgId, f.project.projectId)).toEqual([]);
  expect(f.driver).not.toHaveBeenCalled();
  f.setViewer({ ...f.viewer, role: 'org:viewer' });
  expect((await f.call('atoma_project_readiness', { projectId: f.project.projectId })).structuredContent).toMatchObject({ configured: false, canRequest: false, configuration: null,
    problems: [expect.objectContaining({ code: 'permission_denied', retryable: false })] });
});

it.each([false, true])('compares saved inventories through a real MCP client (legacy=%s), with bounded pages and isolation', async legacy => {
  const f = await fixture(legacy);
  const base = f.makeRun({ 'same.txt': 'same', 'edit.txt': 'old', 'gone.txt': 'gone' });
  const target = f.makeRun({ 'same.txt': 'same', 'edit.txt': 'new', 'added.txt': 'new' });
  const ref = { projectId: f.project.projectId, baseRunId: base.run.projectRunId, runId: target.run.projectRunId };
  const read = async (extra: Record<string, unknown> = {}) => runComparisonResultSchema.parse((await f.call('atoma_run_compare', { ...ref, ...extra })).structuredContent);
  const first = await read({ limit: 1 });
  expect(first).toMatchObject({ evidence: 'saved_manifests', untrusted: true, total: 3, nextOffset: 1,
    base: { status: 'delivered', coverage: 'declared' }, counts: { added: 1, removed: 1, modified: 1, unchanged: 1 } });
  const second = await read({ limit: 1, offset: first.nextOffset, snapshot: first.snapshot });
  const third = await read({ limit: 1, offset: second.nextOffset, snapshot: second.snapshot });
  expect([...first.files, ...second.files, ...third.files].map(file => [file.path, file.change])).toEqual([
    ['added.txt', 'added'], ['edit.txt', 'modified'], ['gone.txt', 'removed'],
  ]);
  expect(third.nextOffset).toBeNull();
  expect(second.files[0]!.before?.size).toBe(second.files[0]!.after?.size);
  expect(second.files[0]!.before?.sha256).not.toBe(second.files[0]!.after?.sha256);
  expect((await read({ search: 'EDIT' })).files).toHaveLength(1);
  expect((await read({ baseRunId: target.run.projectRunId })).total).toBe(0);
  for (const extra of [{ snapshot: first.snapshot, search: 'changed filter' }, { limit: 101 }, { baseRunId: randomUUID() }, { projectId: randomUUID() }]) {
    expect((await f.client.callTool({ name: 'atoma_run_compare', arguments: { ...ref, ...extra } })).isError).toBe(true);
  }
  // Inventory comparison never pretends to have re-read or validated live bytes.
  writeFileSync(join(target.layout.workspacePath, 'edit.txt'), 'tampered');
  expect((await read()).snapshot).toBe(first.snapshot);
  expect((await f.client.callTool({ name: 'atoma_run_file', arguments: { projectId: ref.projectId, runId: ref.runId, path: 'edit.txt' } })).isError).toBe(true);
  expect(f.driver).not.toHaveBeenCalled();
  expect(JSON.stringify(first)).not.toContain(f.root);
  f.setViewer({ ...f.viewer, orgId: randomUUID(), platformAdmin: false });
  if (legacy) await expect(f.client.callTool({ name: 'atoma_run_compare', arguments: ref })).rejects.toThrow('session does not belong');
  else expect((await f.client.callTool({ name: 'atoma_run_compare', arguments: ref })).isError).toBe(true);
});

it.each([false, true])('pauses and resumes through MCP tasks (legacy=%s), reattaching across requests without a second launch', async legacy => {
  const f = await fixture(legacy);
  const { run, layout } = f.makeRun();
  mkdirSync(layout.workspacePath, { recursive: true });
  writeFileSync(join(layout.workspacePath, 'saved.txt'), 'validated work');
  const checkpoints = new RunCheckpointStore(f.dbPath);
  const data: RunCheckpoint = { version: 1, id: run.projectRunId, goal: run.goal,
    workspace: realpathSync(layout.workspacePath), policy: '{}',
    scope: { orgId: f.viewer.orgId, projectId: f.project.projectId, principalId: f.viewer.principalId, runId: run.projectRunId },
    actor: { name: 'Meristem', atomId: 'actor', version: 1 }, checklist: [],
    root: { plan: { subtasks: [{}, {}] }, strategy: {}, plannedPhases: 2 },
    completed: [{ output: {}, summary: 'Saved phase', producedBy: { tier: 2, name: 'Cell', viaFallback: false } }],
    workspaceDigest: checkpointWorkspaceDigest(realpathSync(layout.workspacePath)), processes: [],
    consumed: { tokens: 20, costUsd: 0.01 }, remainingMs: 300000, lastRunId: run.projectRunId };
  const owner = checkpoints.claim(data, true);
  const ref = { projectId: f.project.projectId, runId: run.projectRunId };
  const pause = await f.call('atoma_run_pause', ref);
  expect(pause.structuredContent).toMatchObject({ checkpoint: { state: 'pause_requested' } });
  await f.call('atoma_run_pause', ref);
  checkpoints.write(data, owner, 'ready', true);
  f.projects.transitionProjectRun({ orgId: f.viewer.orgId, projectRunId: run.projectRunId, from: 'running', to: 'partial', traceId: run.projectRunId, stats: { ...parseRunLog('✓ build finished'), outcome: 'partial' } });
  let finish = (_value: string) => {};
  f.driver.mockImplementation(options => new Promise<string>(resolve => {
    expect(options.extraArgs).toContain('--resume');
    finish = resolve;
    options.signal?.addEventListener('abort', () => resolve('--- run cancelled ---\n'), { once: true });
  }));
  const start = async () => {
    if (f.client instanceof LegacyClient) return (await f.client.request({ method: 'tools/call', params: {
      name: 'atoma_run_resume', arguments: ref,
    } }, CreateTaskResultSchema, { task: { ttl: 60000 } })).task;
    // The modern SDK has no tasks client yet; speak its extension on the same HTTP endpoint.
    const response = await fetch(f.url, { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'atoma_run_resume',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'atoma_run_resume', arguments: ref, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'checkpoint-test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } },
    } } }) });
    const text = await response.text();
    const frame = text.startsWith('{') ? text : text.split('\n').find(line => line.startsWith('data:') && line.includes('"id"'))!.slice(5);
    const payload = JSON.parse(frame) as { result: { taskId: string; status: string } };
    return payload.result;
  };
  try {
    const first = await start();
    expect(first.status).toBe('working');
    expect((await start()).taskId).toBe(first.taskId);
    await vi.waitFor(() => expect(f.driver).toHaveBeenCalledTimes(1));
    expect(f.projects.listProjectRuns(f.viewer.orgId, f.project.projectId)).toHaveLength(2);
    const successor = f.projects.latestContinuation(f.viewer.orgId, run.projectRunId)!;
    expect((await f.call('atoma_run_status', { ...ref, runId: successor.projectRunId })).structuredContent)
      .toMatchObject({ resumeOf: run.projectRunId });
    finish('--- run failed ---\n');
    await f.coordinator.waitForIdle();
    expect((await f.call('atoma_run_status', { ...ref, runId: successor.projectRunId })).structuredContent)
      .toMatchObject({ status: 'failed' });
  } finally {
    finish('--- run failed ---\n');
    const successor = f.projects.latestContinuation(f.viewer.orgId, run.projectRunId);
    if (successor && ['running', 'queued'].includes(successor.status)) f.coordinator.cancel(f.viewer.orgId, successor.projectRunId);
    await f.coordinator.waitForIdle();
  }
});

it('refuses checkpoint mutations across requester, project, organisation and role boundaries through MCP', async () => {
  const f = await fixture();
  const { run } = f.makeRun();
  const ref = { projectId: f.project.projectId, runId: run.projectRunId };
  for (const identity of [
    { ...f.viewer, principalId: randomUUID() },
    { ...f.viewer, orgId: randomUUID(), platformAdmin: false },
    { ...f.viewer, role: 'org:viewer' as const, platformAdmin: false },
  ]) {
    f.setViewer(identity);
    for (const name of ['atoma_run_pause', 'atoma_run_resume']) {
      if (identity.role === 'org:viewer') {
        expect((await f.client.listTools()).tools.map(tool => tool.name)).not.toContain(name);
        await expect(f.client.callTool({ name, arguments: ref })).rejects.toThrow('not found');
        continue;
      }
      const result = await f.client.callTool({ name, arguments: ref });
      expect(result.isError).toBe(true);
    }
  }
  f.setViewer(f.viewer);
  for (const name of ['atoma_run_pause', 'atoma_run_resume']) {
    expect((await f.client.callTool({ name, arguments: { ...ref, projectId: randomUUID() } })).isError).toBe(true);
    // No saved boundary: expose a structured service refusal, never start another run.
    const refused = await f.client.callTool({ name, arguments: ref });
    expect(refused.isError).toBe(true);
    expect(serviceProblemSchema.parse((refused.structuredContent as { error: unknown }).error).nextAction).toBeTruthy();
  }
  expect(f.driver).not.toHaveBeenCalled();
  expect(f.projects.listProjectRuns(f.viewer.orgId, f.project.projectId)).toHaveLength(1);
});

it.each([false, true])('requires exact client acceptance before publication and retains it across retries (legacy=%s)', async legacy => {
  let attempts = 0, remoteWrites = 0;
  const f = await fixture(legacy, state => ({ publish: async ({ run }) => {
    const reserved = state.projects.reservePublication({ orgId: run.orgId, projectRunId: run.projectRunId, idempotencyKey: `publish:${run.projectRunId}` })!;
    if (reserved.publication.status === 'published') return;
    if (++attempts === 1) throw new Error('Simulated remote outage');
    remoteWrites++;
    state.projects.transitionPublication({ orgId: run.orgId, publicationId: reserved.publication.publicationId, from: 'pending', to: 'publishing' });
    state.projects.transitionPublication({ orgId: run.orgId, publicationId: reserved.publication.publicationId, from: 'publishing', to: 'published',
      receipt: { repositoryId: '123', fullName: 'owner/docs', url: 'https://github.com/owner/docs', defaultBranch: 'main', commitSha: 'a'.repeat(40), baseSha: null } });
  } }));
  const { run } = f.makeRun({ 'index.html': '<h1>Review me</h1>' });
  const ref = { projectId: f.project.projectId, runId: run.projectRunId };
  const input = { ...ref, manifestHash: run.artifactManifestHash!, review: 'Client opened the preview, checked the heading and accepted publication.' };
  expect((await f.call('atoma_run_status', ref)).structuredContent).toMatchObject({ awaitingClientAcceptance: true, clientAcceptance: null, publication: null });
  expect((await f.client.callTool({ name: 'atoma_publication_retry', arguments: ref })).isError).toBe(true);
  expect((await f.client.callTool({ name: 'atoma_run_accept', arguments: { ...input, manifestHash: 'f'.repeat(64) } })).isError).toBe(true);
  expect(attempts).toBe(0);
  expect(f.projects.getDeliveryAcceptance(f.viewer.orgId, run.projectRunId)).toBeNull();
  expect((await f.client.callTool({ name: 'atoma_run_accept', arguments: input })).isError).toBe(true);
  const acceptance = f.projects.getDeliveryAcceptance(f.viewer.orgId, run.projectRunId)!;
  expect(acceptance).toMatchObject({ principalId: f.viewer.principalId, manifestHash: input.manifestHash, review: input.review });
  expect((await f.call('atoma_run_status', ref)).structuredContent).toMatchObject({ awaitingClientAcceptance: false, clientAcceptance: acceptance });
  await f.call('atoma_publication_retry', ref);
  await f.call('atoma_run_accept', { ...input, review: 'A retry must not overwrite the original acceptance.' });
  expect(f.projects.getDeliveryAcceptance(f.viewer.orgId, run.projectRunId)).toEqual(acceptance);
  expect(remoteWrites).toBe(1);
  expect((await f.call('atoma_run_status', ref)).structuredContent).toMatchObject({ publication: { status: 'published' } });
});

it('binds client acceptance to member authority and accepts text-only delivery without publishing', async () => {
  const f = await fixture();
  const { run } = f.makeRun({ 'result.txt': 'Reviewable' });
  const input = { projectId: f.project.projectId, runId: run.projectRunId, manifestHash: run.artifactManifestHash!, review: 'Reviewed.' };
  f.setViewer({ ...f.viewer, orgId: randomUUID(), platformAdmin: false });
  expect((await f.client.callTool({ name: 'atoma_run_accept', arguments: input })).isError).toBe(true);
  f.setViewer({ ...f.viewer, role: 'org:viewer', platformAdmin: false });
  await expect(f.client.callTool({ name: 'atoma_run_accept', arguments: input })).rejects.toThrow('not found');
  f.setViewer(f.viewer);
  expect((await f.client.callTool({ name: 'atoma_run_accept', arguments: { ...input, projectId: randomUUID() } })).isError).toBe(true);
  expect(f.projects.getDeliveryAcceptance(f.viewer.orgId, run.projectRunId)).toBeNull();
  const text = f.makeRun().run;
  f.projects.transitionProjectRun({ orgId: text.orgId, projectRunId: text.projectRunId, from: 'running', to: 'delivered', traceId: text.projectRunId, stats: parseRunLog('✓ build finished') });
  const delivered = f.projects.saveArtifactManifest(text.orgId, text.projectRunId, { version: 1, source: 'workspace', delivery: 'text', files: [], totalBytes: 0 })!;
  const accepted = await f.call('atoma_run_accept', { ...input, runId: text.projectRunId, manifestHash: delivered.artifactManifestHash! });
  expect(accepted.structuredContent).toMatchObject({ awaitingClientAcceptance: false, publication: null, clientAcceptance: { manifestHash: delivered.artifactManifestHash } });
  expect(f.driver).not.toHaveBeenCalled();
});


it.each([false, true])('starts an exact selected iteration through MCP and keeps the accepted reference (legacy=%s)', async legacy => {
  const syncRun = vi.fn(async () => { throw new Error('must not refresh the selected version'); });
  const f = await fixture(legacy, () => ({ publish: vi.fn(), syncRun }));
  const base = f.makeRun({ 'app.txt': 'reviewed version' }).run;
  f.projects.acceptDelivery(f.viewer.orgId, base.projectRunId, f.viewer.principalId,
    { manifestHash: base.artifactManifestHash!, review: 'Client checked this version.' });
  const newer = f.makeRun({ 'app.txt': 'unaccepted experiment' }).run;
  f.driver.mockImplementation(async options => {
    const seed = options.extraArgs![options.extraArgs!.indexOf('--seed') + 1]!;
    expect(seed).toBe(base.hostPaths.workspacePath);
    expect(readFileSync(join(seed, 'app.txt'), 'utf8')).toBe('reviewed version');
    const workspace = options.env!['ATOMA_BUILD_WORKSPACE']!;
    cpSync(seed, workspace, { recursive: true });
    writeFileSync(join(workspace, 'app.txt'), 'iteration from reviewed version');
    const id = options.env!['ATOMA_RUN_ID']!;
    writeFileSync(options.env![ARTIFACT_MANIFEST_PATH_ENV]!, JSON.stringify({
      version: 1, runId: id, generatedAt: new Date().toISOString(), outputs: ['app.txt'],
    }));
    const traces = options.env!['ATOMA_RUNS_DIR']!;
    mkdirSync(traces, { recursive: true });
    writeFileSync(join(traces, `${id}.json`), JSON.stringify({ id, endedAt: new Date().toISOString(), result: { summary: 'Verified' } }));
    return '✓ build finished';
  });
  const args = { projectId: f.project.projectId, baseRunId: base.projectRunId,
    goal: 'Improve the reviewed version', idempotencyKey: 'selected-version' };
  const result = await f.call('atoma_run_start', args);
  expect(result.structuredContent).toMatchObject({ status: 'delivered', baseRunId: base.projectRunId,
    seed: { kind: 'run', runId: base.projectRunId }, acceptedReferenceRunId: base.projectRunId,
    awaitingClientAcceptance: true });
  await f.call('atoma_run_start', args);
  expect(f.driver).toHaveBeenCalledTimes(1);
  expect(syncRun).not.toHaveBeenCalled();
  expect(readFileSync(join(base.hostPaths.workspacePath, 'app.txt'), 'utf8')).toBe('reviewed version');
  expect(readFileSync(join(newer.hostPaths.workspacePath, 'app.txt'), 'utf8')).toBe('unaccepted experiment');
  expect((await f.call('atoma_project_readiness', { projectId: f.project.projectId })).structuredContent)
    .toMatchObject({ acceptedReferenceRunId: base.projectRunId });
  expect((await f.client.callTool({ name: 'atoma_run_start', arguments: { ...args, baseRunId: newer.projectRunId } })).isError).toBe(true);
  expect(f.driver).toHaveBeenCalledTimes(1);
});

it('refuses a foreign, missing or changed iteration base before launching or reserving work', async () => {
  const f = await fixture();
  const base = f.makeRun({ 'app.txt': 'saved' }).run;
  const foreign = projectRetrievalFixture(f.root, { subject: 'foreign-iteration', slug: 'foreign-iteration' });
  const foreignRun = foreign.makeRun({ 'app.txt': 'foreign' }).run;
  const otherProject = projectRetrievalFixture(f.root, { slug: 'same-org-other' });
  const otherRun = otherProject.makeRun({ 'app.txt': 'other project' }).run;
  const args = { projectId: f.project.projectId, goal: 'Improve this version', idempotencyKey: 'invalid-base' };
  for (const baseRunId of [randomUUID(), foreignRun.projectRunId, otherRun.projectRunId]) {
    expect((await f.client.callTool({ name: 'atoma_run_start', arguments: { ...args, baseRunId } })).isError).toBe(true);
  }
  writeFileSync(join(base.hostPaths.workspacePath, 'app.txt'), 'tampered');
  expect((await f.client.callTool({ name: 'atoma_run_start', arguments: { ...args, baseRunId: base.projectRunId } })).isError).toBe(true);
  writeFileSync(join(base.hostPaths.workspacePath, 'app.txt'), 'saved');
  const db = new Database(f.dbPath);
  try { db.prepare('UPDATE project_runs SET bytes_expired_at=? WHERE project_run_id=?').run(new Date().toISOString(), base.projectRunId); }
  finally { db.close(); }
  expect((await f.client.callTool({ name: 'atoma_run_start', arguments: { ...args, baseRunId: base.projectRunId } })).isError).toBe(true);
  await expect(f.service.startProjectRunFromInput(f.viewer, f.project.projectId, {
    goal: args.goal, idempotencyKey: args.idempotencyKey, baseRunId: base.projectRunId, resumeOf: base.projectRunId,
  })).rejects.toThrow('invalid run payload');
  expect((await f.client.callTool({ name: 'atoma_run_start', arguments: {
    projectId: args.projectId, idempotencyKey: args.idempotencyKey, rerunOf: base.projectRunId,
    baseRunId: base.projectRunId, models: { l1: ANTHROPIC_PINS.ATOMA_MODEL_L1, l2: ANTHROPIC_PINS.ATOMA_MODEL_L2, l3: ANTHROPIC_PINS.ATOMA_MODEL_L3 },
  } })).isError).toBe(true);
  expect(f.driver).not.toHaveBeenCalled();
  expect(f.projects.listProjectRuns(f.viewer.orgId, f.project.projectId)).toHaveLength(1);
});
