import { describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { ensureCanonicalConnectorsL1, ensureCanonicalFileScribeL1 } from '../src/atoms/capability.js';
import { taskContextLines, MCP_SERVERS_GUIDANCE } from '../src/atoms/taskContext.js';
import { elementForTool, HOST_TOOL_NAMES } from '../src/contracts/toolTaxonomy.js';
import { decodeConnectorLaunch, encodeConnectorLaunch, MCP_CALL_TOOL_NAME, MCP_LIST_TOOL_NAME } from '../src/contracts/mcpConnectors.js';
import {
  boundCallResult, createMcpConnectorTools, emptyConnectorService, mcpCallToolDeclaration, mcpConnectorExecutor, mcpListToolDeclaration,
  type McpConnectorService,
} from '../src/tools/mcpConnectors.js';
import { withPreviousRunInputs } from '../src/run/taskInputs.js';
import type { ToolExecutor } from '../src/core/types.js';
import { makeTools } from './helpers/factories.js';

const SERVER_ID = '7f1c3a52-9d1e-4a55-8a4b-1f2e3d4c5b6a';
const OTHER_ID = '0b6a7c1e-2f3d-4e5a-9b8c-7d6e5f4a3b2c';

function fakeService(overrides: Partial<McpConnectorService> = {}): McpConnectorService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    servers: [
      { key: 'notes', name: 'Notes', serverId: SERVER_ID, status: 'ready' },
      { key: 'crm', name: 'CRM', serverId: OTHER_ID, status: 'unavailable', reason: 'authorization_required' },
    ],
    authorize: (_id, tool) => tool === 'delete' ? 'tool_disabled' : 'allowed',
    disabledTools: () => new Set(['delete']),
    listTools: async () => ({ tools: [
      { name: 'search', description: 'Search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'delete', description: 'Delete' },
    ], truncated: false }),
    callTool: async (_key, tool) => { calls.push(tool); return { content: [{ type: 'text', text: 'done' }] }; },
    dispose: async () => {},
    ...overrides,
  };
}

const run = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 });

describe('the two connector elements', () => {
  it('are fixed host elements with their own periodic identities', () => {
    expect(HOST_TOOL_NAMES).toEqual(['search_project_docs', MCP_LIST_TOOL_NAME, MCP_CALL_TOOL_NAME]);
    expect(elementForTool(MCP_LIST_TOOL_NAME)?.number).toBe(12);
    expect(elementForTool(MCP_CALL_TOOL_NAME)?.number).toBe(13);
    expect(mcpListToolDeclaration.element?.number).toBe(12);
    // Persisted on atom types in the shared registry: no customer name may live here.
    expect(JSON.stringify([mcpListToolDeclaration, mcpCallToolDeclaration])).not.toMatch(/notes|crm/i);
  });

  it('lists ready servers without disabled tools, and unavailable ones with a reason', async () => {
    const tools = createMcpConnectorTools(fakeService(), run());
    const listed = await tools.execute(MCP_LIST_TOOL_NAME, {}) as unknown as { ok: true; servers: Array<Record<string, unknown>> };
    expect(listed.servers[0]).toMatchObject({ server: 'notes', status: 'ready', tools: [{ name: 'search', readOnly: true }] });
    expect(listed.servers[1]).toMatchObject({ server: 'crm', status: 'unavailable' });
    expect(String(listed.servers[1]!['reason'])).toMatch(/authorized/);
  });

  it('refuses before reaching the server: unknown, unavailable, disabled tool, bad arguments', async () => {
    const service = fakeService();
    const tools = createMcpConnectorTools(service, run());
    expect(await tools.execute(MCP_CALL_TOOL_NAME, { server: 'nope', tool: 'x' })).toMatchObject({ ok: false, status: 'unknown_server' });
    expect(await tools.execute(MCP_CALL_TOOL_NAME, { server: 'crm', tool: 'x' })).toMatchObject({ ok: false, status: 'unavailable' });
    expect(await tools.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'delete' })).toMatchObject({ ok: false, status: 'tool_disabled' });
    expect(await tools.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'search', arguments: 'q' })).toMatchObject({ ok: false, status: 'invalid_request' });
    expect(service.calls).toEqual([]);
    expect(await tools.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'search', arguments: { q: 1 } })).toMatchObject({ ok: true, isError: false });
    expect(service.calls).toEqual(['search']);
  });

  it('makes a change once per run, across backends, and says what it already changed', async () => {
    let fail = false;
    const service = fakeService({ callTool: async (_key, tool) => {
      service.calls.push(tool);
      return fail ? { isError: true, content: [{ type: 'text', text: 'refused' }] } : { content: [{ type: 'text', text: `done ${service.calls.length}` }] };
    } });
    const first = createMcpConnectorTools(service, run());
    await first.execute(MCP_LIST_TOOL_NAME, {});
    expect(await first.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'create', arguments: { title: 'A', tags: ['x'] } })).toMatchObject({ ok: true });
    // A deepening rebuilds the tools over the same run's service: the change is remembered.
    const second = createMcpConnectorTools(service, run());
    const repeat = await second.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'create', arguments: { tags: ['x'], title: 'A' } });
    expect(repeat).toMatchObject({ ok: false, status: 'duplicate', previous: [{ type: 'text', text: 'done 1' }] });
    expect(service.calls).toEqual(['create']);
    // Other arguments are another change; a read-only tool may repeat.
    expect(await second.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'create', arguments: { title: 'B' } })).toMatchObject({ ok: true });
    expect(await second.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'search', arguments: { q: 1 } })).toMatchObject({ ok: true });
    expect(await second.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'search', arguments: { q: 1 } })).toMatchObject({ ok: true });
    // A tool that reported its own failure vouches for no change: it may be retried.
    fail = true;
    await second.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'create', arguments: { title: 'C' } });
    expect(await second.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'create', arguments: { title: 'C' } })).toMatchObject({ ok: true, isError: true });
    const listed = await second.execute(MCP_LIST_TOOL_NAME, {}) as unknown as { changesThisRun: { tool: string; arguments: unknown }[] };
    expect(listed.changesThisRun.map(change => change.arguments)).toEqual([{ title: 'A', tags: ['x'] }, { title: 'B' }]);
  });

  it('answers a run whose project enables no server', async () => {
    const tools = createMcpConnectorTools(emptyConnectorService(), run());
    expect(await tools.execute(MCP_LIST_TOOL_NAME, {})).toEqual({ ok: true, servers: [] });
    expect(await tools.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'x' }))
      .toMatchObject({ ok: false, status: 'unknown_server', message: expect.stringMatching(/no MCP server/) });
  });

  it('reports a timeout as one that may still have taken effect', async () => {
    const service = fakeService({ callTool: (_k, _t, _a, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
    const tools = createMcpConnectorTools(service, { ...run(), limits: { callTimeoutMs: 20 } });
    const result = await tools.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'search' });
    expect(result).toMatchObject({ ok: false, status: 'timed_out' });
    expect(JSON.stringify(result)).toMatch(/may still have taken effect/);
    // Its effect is unknown, so it is not made again in this run.
    expect(await tools.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'search' })).toMatchObject({ ok: false, status: 'duplicate' });
  });

  it('keeps text and drops media bytes within the bound', () => {
    const bounded = boundCallResult({ content: [
      { type: 'image', data: 'A'.repeat(100_000), mimeType: 'image/png' },
      { type: 'text', text: 'B'.repeat(100_000) },
    ], structuredContent: { big: 'C'.repeat(100_000) } }, 10_000);
    const text = JSON.stringify(bounded);
    expect(text).not.toContain('AAAA');
    expect(Buffer.byteLength(text)).toBeLessThan(12_000);
    expect(bounded.truncated).toBe(true);
    expect(bounded.structuredContent).toBeUndefined();
  });

  it('intercepts its two names on the host and never shadows a worker tool', async () => {
    const worker: ToolExecutor = { has: name => name === 'read_file', execute: async () => 'worker' };
    const tools = createMcpConnectorTools(fakeService(), run());
    const { executor, toolDecls } = mcpConnectorExecutor(worker, makeTools(['read_file']), tools);
    expect(toolDecls.map(tool => tool.name)).toEqual(['read_file', MCP_LIST_TOOL_NAME, MCP_CALL_TOOL_NAME]);
    expect(await executor.execute('read_file', {})).toBe('worker');
    expect(await executor.execute(MCP_CALL_TOOL_NAME, { server: 'notes', tool: 'search' })).toMatchObject({ ok: true });
    const shadowing: ToolExecutor = { has: name => name === MCP_CALL_TOOL_NAME, execute: async () => 'x' };
    expect(() => mcpConnectorExecutor(shadowing, [], tools)).toThrow(/shadow/);
    await tools.close();
    expect(executor.has(MCP_CALL_TOOL_NAME)).toBe(false);
  });
});

describe('what the run tells its planners', () => {
  const launch = {
    version: 1 as const, orgId: 'org', projectId: 'proj',
    connectors: [
      { status: 'ready' as const, serverId: SERVER_ID, key: 'notes', name: 'Notes', url: 'https://notes.example/mcp/s3cret-path', headers: { Authorization: 'Bearer secret-token' } },
      { status: 'unavailable' as const, serverId: OTHER_ID, key: 'crm', name: 'CRM', reason: 'authorization_required' as const },
    ],
  };

  it('names servers and availability, never a URL or a credential', () => {
    const task = withPreviousRunInputs({ description: 'goal' }, {}, decodeConnectorLaunch(encodeConnectorLaunch(launch)));
    const text = JSON.stringify(task);
    expect(task.inputs?.['availableMcpServers']).toEqual([
      { server: 'notes', name: 'Notes', available: true },
      { server: 'crm', name: 'CRM', available: false, reason: 'authorization_required' },
    ]);
    expect(text).not.toMatch(/secret|example/);
    expect(taskContextLines(task).join('\n')).toContain(MCP_SERVERS_GUIDANCE);
    // A resumed root's saved servers are replaced, not kept.
    expect(withPreviousRunInputs(task, {}, null).inputs?.['availableMcpServers']).toBeUndefined();
  });

  it('fails closed on a malformed hand-off', () => {
    expect(decodeConnectorLaunch(undefined)).toBeNull();
    expect(() => decodeConnectorLaunch('{')).toThrow();
    expect(() => decodeConnectorLaunch(JSON.stringify({ ...launch, connectors: [launch.connectors[0], launch.connectors[0]] }))).toThrow(/twice/);
  });
});

describe('the canonical connector molecule', () => {
  it('exists only when a run has connectors, keeps its identity and loses the tools without them', () => {
    const db = openDb(':memory:');
    const registry = new AtomRegistry(db);
    try {
      const worker = makeTools(['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'record_probe', 'fetch_url', 'validate_html']);
      const scribe = ensureCanonicalFileScribeL1(registry, worker);
      expect(ensureCanonicalConnectorsL1(registry, worker)).toBeUndefined();
      const all = [...worker, mcpListToolDeclaration, mcpCallToolDeclaration];
      const added = ensureCanonicalConnectorsL1(registry, all)!;
      expect(added.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([MCP_LIST_TOOL_NAME, MCP_CALL_TOOL_NAME, 'write_file']));
      expect(added.tools.map(tool => tool.name)).not.toContain('validate_html');
      expect(added.description).toContain('MCP servers');
      expect(added.systemPrompt).toContain(MCP_LIST_TOOL_NAME);
      const without = ensureCanonicalConnectorsL1(registry, worker)!;
      expect(without.atomId).toBe(added.atomId);
      expect(without.tools.map(tool => tool.name)).not.toContain(MCP_CALL_TOOL_NAME);
      expect(without.systemPrompt).not.toContain(MCP_CALL_TOOL_NAME);
      expect(registry.getByName(scribe.name)).toMatchObject({ version: scribe.version, tools: scribe.tools });
    } finally { db.close(); }
  });
});
