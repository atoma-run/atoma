import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, CreateTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { isProjectRunTaskId } from '../mcp/tasks.js';

export interface AssistantMcp {
  readonly signal?: AbortSignal;
  call(name: string, args: Record<string, unknown>, task?: boolean): Promise<unknown>;
  close(): Promise<void>;
}
export class AssistantToolError extends Error {}

/** Node's fetch rewrites Host to the loopback URL. Keep the host's canonical MCP pin intact. */
function loopbackFetch(endpoint: URL, host: string, lifetime: AbortSignal): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href !== endpoint.href || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Assistant MCP requests must stay on the configured loopback endpoint');
    }
    if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new Error('Unsupported MCP request body');
    const headers = Object.fromEntries(new Headers(init?.headers));
    headers['host'] = host;
    const signal = AbortSignal.any([lifetime, ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(20_000)]);
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(url, { method: init?.method ?? 'GET', headers, signal }, incoming => {
        const status = incoming.statusCode ?? 500;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        if ([204, 205, 304].includes(status)) incoming.resume();
        resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
          { status, headers: responseHeaders }));
      });
      outgoing.on('error', reject);
      outgoing.end(init?.body);
    });
  };
}

/** Uses the installed SDK and the ONE HTTP route, including task augmentation for starts. */
export async function connectAssistantMcp(url: URL, host: string, token: string): Promise<AssistantMcp> {
  const signal = AbortSignal.timeout(75_000);
  const client = new Client({ name: 'atoma-assistant', version: '1' }, {
    capabilities: { tasks: { requests: { tools: { call: {} } } } },
  });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}`, host }, redirect: 'error' },
    fetch: loopbackFetch(url, host, signal),
  });
  try { await client.connect(transport); }
  catch (error) { await client.close().catch(() => {}); throw error; }
  return {
    signal,
    async call(name, args, task = false) {
      let result = task
        ? await client.request({ method: 'tools/call', params: { name, arguments: args, task: { ttl: 86_400_000 } } },
          z.union([CreateTaskResultSchema, CallToolResultSchema]), { timeout: 20_000 })
        : await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 20_000 });
      if ('task' in result && result.task && typeof result.task === 'object') {
        const state = result.task as { taskId: string; status: string };
        if (state.status !== 'failed' || isProjectRunTaskId(state.taskId)) return result;
        // A refused start is an immediately failed MCP task; read its real refusal before closing the session.
        result = await client.request({ method: 'tasks/result', params: { taskId: state.taskId } }, CallToolResultSchema, { timeout: 20_000 });
      }
      const reply = CallToolResultSchema.parse(result);
      const text = reply.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (reply.isError) {
        throw new AssistantToolError(text.slice(0, 2000) || 'Atoma refused this action.');
      }
      if (reply.structuredContent) return reply.structuredContent;
      try { return JSON.parse(text) as unknown; } catch { return { text }; }
    },
    async close() {
      try { await transport.terminateSession(); }
      finally { await client.close(); }
    },
  };
}
