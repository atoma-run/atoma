import type { Viewer } from '../auth/store.js';
import { ProjectHttpError } from '../projects/service.js';
import type { HostingService } from '../projects/hostingService.js';
import type { HostingSummary } from '../contracts/projectHosting.js';

/** `/api/projects/<id>/hosting` reads the status; each action below it is a same-origin POST. */
export const HOSTING_ROUTE = /^\/api\/projects\/([^/]+)\/hosting(?:\/(deploy|update|restore|stop|open))?$/;

/**
 * The browser door to a project's hosted application. Authority is the
 * service's: every write requires an organisation administrator there, the
 * one-click update and its put-back exactly as deploy and stop.
 */
export async function hostingHttp(match: RegExpMatchArray, deps: {
  viewer: Viewer | null;
  /** Answers 405 itself when the method differs. */
  methodAllowed: (method: 'GET' | 'POST') => boolean;
  /** Answers 403 itself on a cross-origin write. */
  sameOrigin: () => boolean;
  readBody: () => Promise<Buffer>;
  runtime: () => Promise<{ service: Pick<HostingService, 'status' | 'deploy' | 'update' | 'restore' | 'stop'>;
    gateway: { open(viewer: Viewer, projectId: string): string } } | null>;
  send: (status: number, body: unknown) => void;
  /**
   * The GET asked for `?history=1`. A tab from before 2026-10-26 parses the
   * status strictly and would lose its whole hosting view to an unknown
   * `history` field, so only a tab that asks receives it.
   */
  history?: boolean;
}): Promise<void> {
  const action = match[2];
  if (!deps.methodAllowed(action ? 'POST' : 'GET') || (action && !deps.sameOrigin())) return;
  const viewer = deps.viewer;
  if (!viewer) { deps.send(401, { error: 'authentication required' }); return; }
  const runtime = await deps.runtime();
  if (!runtime) { deps.send(503, { error: 'Project hosting is not configured yet' }); return; }
  try {
    const projectId = match[1]!;
    if (!action) {
      const { history, ...summary } = runtime.service.status(viewer, projectId);
      deps.send(200, deps.history && history ? { ...summary, history } : summary); return;
    }
    if (action === 'open') { deps.send(200, { url: runtime.gateway.open(viewer, projectId) }); return; }
    let body: unknown;
    try { body = JSON.parse((await deps.readBody()).toString('utf8')); }
    catch { deps.send(400, { error: 'Invalid hosting request' }); return; }
    // An action answers the status without its history, whatever the caller: the next read asks for it.
    const bare = ({ history: _history, ...summary }: HostingSummary) => summary;
    if (action === 'deploy') deps.send(202, bare(await runtime.service.deploy(viewer, projectId, body)));
    else if (action === 'update') deps.send(202, bare(await runtime.service.update(viewer, projectId, body)));
    else if (action === 'restore') deps.send(202, bare(await runtime.service.restore(viewer, projectId, body)));
    else deps.send(200, bare(await runtime.service.stop(viewer, projectId, (body as { expectedDeploymentId?: unknown } | null)?.expectedDeploymentId)));
  } catch (error) {
    if (error instanceof ProjectHttpError) deps.send(error.status, { error: error.message });
    else deps.send(503, { error: 'Hosting operation unavailable; refresh its status before retrying' });
  }
}
