import { githubAccessRequiredSchema } from '../../contracts/projects.js';
import type { VizProjectRun } from '../client/types.js';
import type { AuthUiSnapshot } from './session-controller.js';

export interface GitHubRecoveryProgress { runId: string; busy: boolean; message?: string }

export function pendingGitHubAccess(run: VizProjectRun) {
  const parsed = githubAccessRequiredSchema.safeParse(run.githubAccess);
  return parsed.success && !parsed.data.resumedRunId ? parsed.data : null;
}

export function canContinueGitHubAccess(run: VizProjectRun, auth: AuthUiSnapshot | null): boolean {
  const access = pendingGitHubAccess(run);
  const viewer = auth?.viewer;
  return !!access && !!viewer && !!viewer.activeOrganisation &&
    (!run.orgId || run.orgId === viewer.activeOrganisation.id) &&
    ['org:member', 'org:admin', 'org:owner'].includes(viewer.activeOrganisation.role) &&
    (access.phase === 'publication' || viewer.principalId === run.requestedByPrincipalId);
}

export function canRetryPublication(run: VizProjectRun, auth: AuthUiSnapshot | null): boolean {
  return run.status === 'delivered' && run.publication?.status === 'failed' &&
    (!run.orgId || run.orgId === auth?.viewer.activeOrganisation?.id) &&
    ['org:member', 'org:admin', 'org:owner'].includes(auth?.viewer.activeOrganisation?.role ?? '');
}

export function canControlCheckpoint(run: VizProjectRun, auth: AuthUiSnapshot | null): boolean {
  const viewer = auth?.viewer;
  return !!viewer?.activeOrganisation && run.orgId === viewer.activeOrganisation.id &&
    viewer.principalId === run.requestedByPrincipalId &&
    ['org:member', 'org:admin', 'org:owner'].includes(viewer.activeOrganisation.role) &&
    ((run.status === 'running' && run.checkpoint?.state === 'running' && run.checkpoint.total > 0) ||
      (run.status === 'partial' && run.checkpoint?.state === 'paused'));
}
