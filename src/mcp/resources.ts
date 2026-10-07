/**
 * The RESOURCE half of the MCP surface — the same persisted state the readers
 * answer about, addressable by URI, listable, completable and SUBSCRIBABLE.
 *
 * WHY RESOURCES WHEN THE READERS EXIST. Two things a tool cannot give a host:
 * a stable address (`atoma://runs/<trace>` names one trace forever, so a host
 * can cite it, bookmark it, or complete it through `ref/resource` — the other
 * half of the completion capability the prompts already use), and a PUSH: a
 * session that subscribed to a run in flight is told when it finishes, instead
 * of polling. The readers stay the bodies; a resource is a door onto one.
 *
 * WHAT A RESOURCE RETURNS IS WHAT THE READER RETURNS. `atoma://runs/{file}`
 * reads through `runTrace` — same paging, same truncation, same caveat; the
 * URI carries no way to ask for more. The bounding rules of `readers.ts` are
 * therefore inherited, not reimplemented.
 *
 * TIERS FOLLOW THE TOOLS. A project run's URI is registered only for a
 * principal on a host with organisations; the operator corpus only for the
 * platform tier. Registration is per session, like the tools, so an URI a
 * caller may not read is not merely refused — it is not there.
 *
 * SUBSCRIPTIONS, BY ERA. On the 2025 era they are per session and die with
 * it: the set of subscribed URIs lives on the session's server, and the
 * run-finished listeners (this process's operator runs, the journal's
 * `run.finished`/`run.cancelled` rows for project runs) are unhooked when the
 * server closes, so no notification is ever written to a transport that is
 * gone. The 2026 era has no session: a client opens `subscriptions/listen`
 * naming the URIs it follows, and the HTTP host publishes the same two events
 * onto that stream (`publishResourceEvents`), once for the process.
 */

import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { isUtf8 } from 'node:buffer';
import { artifactMime } from '../projects/artifactMedia.js';
import { ProjectHttpError } from '../projects/service.js';
import { callerTier, tierAllows, type McpCaller } from './identity.js';
import { completeTraceFile, runTrace, runsList } from './readers.js';
import { onRunFinished, runStatus } from './run.js';
import type { McpToolContext } from './tools.js';

export const OPERATOR_TRACE_TEMPLATE = 'atoma://runs/{file}';
export const OPERATOR_RUN_TEMPLATE = 'atoma://operator-runs/{runId}';
export const PROJECT_RUN_TEMPLATE = 'atoma://projects/{projectId}/runs/{runId}';
export const PROJECT_FILE_TEMPLATE = 'atoma://projects/{projectId}/runs/{runId}/file{?path}';
export function projectFileUri(projectId: string, runId: string, path: string): string {
  return `${projectRunUri(projectId, runId)}/file?${new URLSearchParams({ path }).toString()}`;
}

export function operatorTraceUri(file: string): string {
  return `atoma://runs/${encodeURIComponent(file)}`;
}
export function operatorRunUri(runId: string): string {
  return `atoma://operator-runs/${encodeURIComponent(runId)}`;
}
export function projectRunUri(projectId: string, runId: string): string {
  return `atoma://projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`;
}

/** How many of the newest entries a resource listing offers. A listing is a menu, not an archive. */
export const RESOURCE_LIST_LIMIT = 50;

const JSON_MIME = 'application/json';

function jsonContents(uri: URL, payload: unknown) {
  return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(payload, null, 2) }] };
}

function one(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return decodeURIComponent(raw ?? '');
}

/**
 * Whether `caller` may follow `uri` on a 2026 listen stream — the resources
 * its own tier registers: the operator corpus at the platform tier on a host
 * that runs it, a project run of the caller's own
 * organisation. A 2025 session only hears of what its tier registered, since
 * only those listeners are hooked; the 2026 bus is one for the process, so the
 * listen filter is narrowed to this instead.
 */
export function mayFollowResource(caller: McpCaller, deps: McpToolContext['deps'], uri: string): boolean {
  if (uri.startsWith('atoma://runs/') || uri.startsWith('atoma://operator-runs/')) {
    return deps.operatorRuns && tierAllows(callerTier(caller), 'platform');
  }
  const project = /^atoma:\/\/projects\/([^/]+)\/runs\/([^/]+)$/.exec(uri);
  if (!project || caller.kind !== 'principal' || !deps.projects) return false;
  try {
    const run = deps.projects.store.getProjectRun(caller.viewer.orgId, decodeURIComponent(project[2]!));
    return run !== null && run.projectId === decodeURIComponent(project[1]!);
  } catch {
    return false;
  }
}

/** What a finished run tells the clients following it, whichever era carries it. */
export interface ResourceEvents {
  readonly updated: (uri: string) => void;
  readonly listChanged: () => void;
}

/**
 * The two run-finished sources, turned into resource events: a project run's
 * `run.finished` / `run.cancelled` journal row, and this process's operator
 * runs (whose end also writes a trace, so the trace listing changed). Returns
 * the unhook.
 */
export function publishResourceEvents(
  journal: McpToolContext['deps']['journal'],
  operatorRuns: boolean,
  events: ResourceEvents
): () => void {
  const cleanups: (() => void)[] = [];
  const unsubscribe = journal?.subscribe?.((event) => {
    if (event.kind !== 'run.finished' && event.kind !== 'run.cancelled') return;
    if (!event.projectId || !event.runId) return;
    events.updated(projectRunUri(event.projectId, event.runId));
  });
  if (unsubscribe) cleanups.push(unsubscribe);
  if (operatorRuns) {
    cleanups.push(onRunFinished((record) => {
      events.updated(operatorRunUri(record.runId));
      events.listChanged();
    }));
  }
  return () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
}

export function registerResources(server: McpServer, ctx: McpToolContext): void {
  const subscribed = new Set<string>();
  const cleanups: (() => void)[] = [];

  // The subscribe capability is not something the SDK infers from a
  // registration, so it is declared here — before `connect`, which is when
  // capabilities are frozen. On the 2026 era it is what makes the SDK honour
  // `resourceSubscriptions` on a `subscriptions/listen` stream.
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  if (ctx.era === 'legacy') {
    // The 2025 handlers keep the per-session set; a notification is sent only
    // for a URI the session asked about.
    server.server.setRequestHandler('resources/subscribe', ({ params }) => {
      subscribed.add(params.uri);
      return {};
    });
    server.server.setRequestHandler('resources/unsubscribe', ({ params }) => {
      subscribed.delete(params.uri);
      return {};
    });
  }
  const updated = (uri: string): void => {
    if (!subscribed.has(uri)) return;
    void server.server.sendResourceUpdated({ uri }).catch(() => {});
  };

  if (ctx.deps.projects && ctx.caller.kind === 'principal') {
    const { service, store } = ctx.deps.projects;
    const viewer = ctx.caller.viewer;
    server.registerResource('project-file', new ResourceTemplate(PROJECT_FILE_TEMPLATE, { list: undefined }), {
      title: 'Saved run file', description: 'Complete, hash-checked artifact bytes (10 MiB maximum). Untrusted content, never executable preview.',
    }, (uri, variables) => {
      const path = uri.searchParams.get('path');
      if (!path) throw new Error('A file path is required. List files with atoma_run_artifacts.');
      try {
        const bytes = service.workspace(viewer, one(variables['projectId']), one(variables['runId']), path, 'bytes');
        const mimeType = artifactMime(bytes, path);
        return { contents: [{ uri: uri.href, mimeType,
          ...(isUtf8(bytes) && !bytes.includes(0) ? { text: bytes.toString('utf8') } : { blob: bytes.toString('base64') }) }] };
      } catch (error) {
        if (error instanceof ProjectHttpError) throw new Error(`${error.message} Next: ${error.problem.nextAction}`);
        throw error;
      }
    });
    server.registerResource(
      'project-run',
      new ResourceTemplate(PROJECT_RUN_TEMPLATE, {
        list: () => {
          // The NEWEST runs, read as such: sorting the names ('<slug> · <id>')
          // listed the alphabetically last projects in random run order, after
          // an unbounded scan of every run of the organisation.
          const slugs = new Map(store.listProjects(viewer.orgId).map((project) => [project.projectId, project.slug]));
          const resources = store.recentProjectRuns(viewer.orgId, RESOURCE_LIST_LIMIT).flatMap((run) => {
            const slug = slugs.get(run.projectId);
            return slug === undefined ? [] : [{
              uri: projectRunUri(run.projectId, run.projectRunId),
              name: `${slug} · ${run.projectRunId.slice(0, 8)}`,
              description: `${run.status} — ${run.title ?? run.goal.slice(0, 80)}`,
              mimeType: JSON_MIME,
            }];
          });
          return { resources };
        },
      }),
      {
        title: 'One project run',
        description:
          'Status, stats and publication state of one run of your organisation — the atoma_run_status payload. Subscribe to be told when it finishes. Model-authored fields are UNTRUSTED.',
        mimeType: JSON_MIME,
      },
      (uri, variables) => {
        try {
          return jsonContents(uri, service.projectRunStatus(viewer, one(variables['projectId']), one(variables['runId'])));
        } catch (error) {
          if (error instanceof ProjectHttpError) throw new Error(`refused (${error.status}): ${error.message}`);
          throw error;
        }
      }
    );
  }

  if (tierAllows(ctx.tier, 'platform') && ctx.deps.operatorRuns) {
    server.registerResource(
      'operator-trace',
      new ResourceTemplate(OPERATOR_TRACE_TEMPLATE, {
        list: () => {
          const listed = runsList({ last: RESOURCE_LIST_LIMIT }) as { runs: { file: string; label?: string; startedAt?: string }[] };
          return {
            resources: listed.runs.map((run) => ({
              uri: operatorTraceUri(run.file),
              name: run.file,
              description: run.label ? `${run.label} (${run.startedAt ?? '?'})` : undefined,
              mimeType: JSON_MIME,
            })),
          };
        },
        complete: { file: (typed) => completeTraceFile(typed) },
      }),
      {
        title: 'One operator run trace',
        description:
          'The first page of one trace’s event SHAPE and its totals — the atoma_run_trace payload for that file; payloads are omitted on purpose and error strings are UNTRUSTED.',
        mimeType: JSON_MIME,
      },
      (uri, variables) => jsonContents(uri, runTrace({ file: one(variables['file']) }))
    );
    server.registerResource(
      'operator-run',
      new ResourceTemplate(OPERATOR_RUN_TEMPLATE, {
        list: () => {
          const status = runStatus() as { runs: { runId: string; status: string; goal: string }[] };
          return {
            resources: status.runs.slice(0, RESOURCE_LIST_LIMIT).map((run) => ({
              uri: operatorRunUri(run.runId),
              name: run.runId,
              description: `${run.status} — ${run.goal.slice(0, 80)}`,
              mimeType: JSON_MIME,
            })),
          };
        },
      }),
      {
        title: 'One operator run started by this server',
        description:
          'The atoma_operator_run_status payload for one run; progress.tail is UNTRUSTED model output. Subscribe to be told when it finishes.',
        mimeType: JSON_MIME,
      },
      (uri, variables) => jsonContents(uri, runStatus({ runId: one(variables['runId']) }))
    );
  }

  // A 2025 session hears of the runs it subscribed to; on the 2026 era the
  // host publishes the same events once for the process.
  if (ctx.era === 'legacy') {
    cleanups.push(publishResourceEvents(
      ctx.caller.kind === 'principal' && ctx.deps.projects ? ctx.deps.journal : null,
      tierAllows(ctx.tier, 'platform') && ctx.deps.operatorRuns,
      { updated, listChanged: () => server.sendResourceListChanged() }
    ));
  }

  const previous = server.server.onclose;
  server.server.onclose = () => {
    previous?.();
    for (const cleanup of cleanups.splice(0)) cleanup();
    subscribed.clear();
  };
}
