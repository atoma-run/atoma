import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Viewer } from '../auth/store.js';
import { assistantRequestSchema, conversationReadSchema } from '../contracts/assistant.js';
import type { AssistantService } from './assistant.js';
import type { AssistantMcp } from './assistantMcp.js';
import { AssistantConflict } from './assistantStore.js';

/** Browser door. No caller-selected tools, identity, credentials or MCP URL. Models come from connected accounts. */
export async function assistantHttp(req: IncomingMessage, res: ServerResponse, deps: {
  resolve: () => Viewer | null;
  sameOrigin: () => boolean;
  readBody: () => Promise<Buffer>;
  connect: () => Promise<AssistantMcp>;
  service: AssistantService;
}): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'GET' && req.method !== 'POST') { send(405, { error: 'Method not allowed' }); return; }
  if (req.method === 'POST' && !deps.sameOrigin()) return;
  const viewer = deps.resolve();
  if (!viewer) { send(401, { error: 'Authentication required' }); return; }
  if (viewer.role === 'org:viewer') { send(403, { error: 'A member role is required' }); return; }
  let input;
  let read;
  try {
    input = req.method === 'POST' ? assistantRequestSchema.parse(JSON.parse((await deps.readBody()).toString('utf8'))) : null;
    const params = new URL(req.url!, 'http://localhost').searchParams;
    read = conversationReadSchema.parse(input ? { projectId: input.projectId, conversationId: input.conversationId } : {
      projectId: params.get('projectId'), ...(params.has('conversationId') ? { conversationId: params.get('conversationId') } : {}),
      ...(params.has('before') ? { before: Number(params.get('before')) } : {}),
    });
  } catch { send(400, { error: 'Invalid assistant request' }); return; }
  let mcp: AssistantMcp | undefined;
  try {
    mcp = await deps.connect();
    const scope = deps.service.scope(viewer, read.projectId, read.conversationId);
    if (input) scope.conversationId = await deps.service.request(scope, input, mcp);
    const result = await deps.service.view(scope, mcp, read.before);
    // Re-resolve after remote work: a logout or organisation switch must not return old-scope data.
    const fresh = deps.resolve();
    if (!fresh || fresh.principalId !== viewer.principalId || fresh.orgId !== viewer.orgId || fresh.role === 'org:viewer') {
      send(401, { error: 'The session changed' }); return;
    }
    send(200, result);
  } catch (error) {
    send(error instanceof AssistantConflict ? 409 : 503, {
      error: error instanceof AssistantConflict ? error.message : 'The assistant could not reach Atoma. Please try again.',
    });
  } finally {
    await mcp?.close().catch(() => {});
  }
}
