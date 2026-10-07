import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { observeRepositoryPush } from '../src/projects/repositoryPush.js';
import { PlatformEventLog } from '../src/platform/events.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); closeStoreHandles(); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
it('ignores bots and tags and coalesces repository moves until another run starts', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
  const root = mkdtempSync(join(tmpdir(), 'atoma-push-')); roots.push(root);
  const f = projectRetrievalFixture(root), events = PlatformEventLog.open(f.dbPath);
  f.projects.transitionRepository({ orgId: f.viewer.orgId, projectId: f.project.projectId, from: 'pending', to: 'creating' });
  f.projects.transitionRepository({ orgId: f.viewer.orgId, projectId: f.project.projectId, from: 'creating', to: 'ready',
    receipt: { repositoryId: '9001', fullName: 'owner/docs', url: 'https://github.com/owner/docs', defaultBranch: 'main' } });
  const push = { repositoryId: '9001', installationId: '123', ref: 'refs/heads/main', before: 'a'.repeat(40),
    after: 'b'.repeat(40), created: false, deleted: false, forced: false, senderLogin: 'client', senderType: 'User' };
  const deps = { appSlug: 'atoma-test', store: f.projects, installationOrg: () => f.viewer.orgId,
    movedSince: (org: string, project: string, since: string) => events.repositoryMovedSince(org, project, since),
    events: (input: Parameters<PlatformEventLog['append']>[0]) => { events.append(input); } };
  observeRepositoryPush({ ...push, senderLogin: 'atoma-test[bot]' }, deps);
  observeRepositoryPush({ ...push, ref: 'refs/tags/v1' }, deps);
  observeRepositoryPush({ ...push, repositoryId: '9002' }, deps);
  expect(events.list().events).toHaveLength(0);
  observeRepositoryPush(push, deps); observeRepositoryPush(push, deps);
  expect(events.list().events).toHaveLength(1);
  vi.advanceTimersByTime(1000); f.makeRun();
  observeRepositoryPush(push, deps);
  expect(events.list().events).toHaveLength(2);
});
