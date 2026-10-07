import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GetTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { artifactFileResultSchema, artifactPageResultSchema, compactRunSchema, runViewSchema, serviceProblemSchema } from '../src/contracts/clientExperience.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { GitHubStore } from '../src/github/store.js';
import { McpHttpHost } from '../src/mcp/http.js';
import { mcpHostWiring } from '../src/mcp/server.js';
import { projectFileUri } from '../src/mcp/resources.js';
import { projectRunTaskId } from '../src/mcp/tasks.js';
import { ProjectRunCoordinator } from '../src/projects/coordinator.js';
import { ProjectService } from '../src/projects/service.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { haystackTestEnvironment } from './helpers/haystack.js';
import { ANTHROPIC_PINS } from './tier-pins.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); closeStoreHandles(); });

async function fixture(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'atoma-mcp-experience-'));
  cleanups.push(async () => { closeStoreHandles(); rmSync(root, { recursive: true, force: true }); });
  const f = projectRetrievalFixture(root);
  const driver = vi.fn(async () => 'must not launch');
  const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root,
    hostEnv: { ...haystackTestEnvironment(root), ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'private-test-key' }, driver });
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
  return { ...f, service, driver, client, call, setViewer: (v: typeof f.viewer) => { currentViewer = v; } };
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
