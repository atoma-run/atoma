import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { servableWhileFrozen } from '../src/mcp/frozen.js';

/**
 * What an MCP message may do while a deployment holds writes: start nothing.
 * The tool's own `readOnlyHint` decides a `tools/call`, the annotation the
 * client is shown, read from the SDK's registered-tool map — which this also
 * pins, since a rename would quietly make every call wait.
 */
describe('servableWhileFrozen', () => {
  const server = new McpServer({ name: 'frozen', version: '1' });
  server.registerTool('verdicts', { annotations: { readOnlyHint: true } }, async () => ({ content: [] }));
  server.registerTool('run_start', { annotations: { readOnlyHint: false } }, async () => ({ content: [] }));
  server.registerTool('unannotated', {}, async () => ({ content: [] }));
  const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } });

  it('serves the protocol opening, listings, reads and read-only tools', () => {
    for (const method of ['initialize', 'ping', 'tools/list', 'resources/read', 'prompts/get', 'tasks/get', 'tasks/result', 'server/discover', 'subscriptions/listen']) {
      expect(servableWhileFrozen(server, { jsonrpc: '2.0', id: 1, method }), method).toBe(true);
    }
    expect(servableWhileFrozen(server, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(true);
    expect(servableWhileFrozen(server, call('verdicts'))).toBe(true);
    expect(servableWhileFrozen(server, { jsonrpc: '2.0', id: 9, result: {} })).toBe(true);
  });

  it('holds back whatever may start something, or cannot be classified', () => {
    expect(servableWhileFrozen(server, call('run_start'))).toBe(false);
    expect(servableWhileFrozen(server, call('unannotated'))).toBe(false);
    expect(servableWhileFrozen(server, call('no-such-tool'))).toBe(false);
    expect(servableWhileFrozen(server, { jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { taskId: 't' } })).toBe(false);
    expect(servableWhileFrozen(server, { jsonrpc: '2.0', id: 1, method: 'sampling/unknown' })).toBe(false);
    expect(servableWhileFrozen(server, [call('verdicts'), call('run_start')])).toBe(false);
    for (const garbage of [null, 'text', 42, [], {}]) expect(servableWhileFrozen(server, garbage)).toBe(false);
  });
});
