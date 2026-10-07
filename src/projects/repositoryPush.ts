import type { RepositoryPush } from '../contracts/repositorySync.js';
import { eventLabel, type PlatformEventSink } from '../contracts/platformEvents.js';
import type { ProjectStore } from './store.js';

/** Notification-only observer. Correctness never depends on delivery. */
export function observeRepositoryPush(push: RepositoryPush, deps: {
  appSlug: string; store: ProjectStore; events: PlatformEventSink;
  installationOrg: (installationId: string) => string | null;
  movedSince: (orgId: string, projectId: string, since: string) => boolean;
}): void {
  if (!push.ref.startsWith('refs/heads/') || push.senderLogin === `${deps.appSlug}[bot]`) return;
  const orgId = deps.installationOrg(push.installationId);
  if (!orgId) return;
  for (const project of deps.store.projectsTrackingRepository(orgId, push.repositoryId, push.ref.slice(11))) {
    const since = (deps.store.listProjectRuns(project.orgId, project.projectId) ?? [])
      .reduce((at, run) => run.startedAt && run.startedAt > at ? run.startedAt : at, project.createdAt);
    if (deps.movedSince(project.orgId, project.projectId, since)) continue;
    deps.events({ kind: 'project.repository_moved', actorType: 'webhook', orgId: project.orgId,
      projectId: project.projectId, summary: `Repository moved outside Atoma: ${eventLabel(project.repositoryFullName ?? project.slug, 100)}`,
      detail: { sender: eventLabel(push.senderLogin, 100), before: push.before, after: push.after,
        deleted: push.deleted, forced: push.forced } });
  }
}
