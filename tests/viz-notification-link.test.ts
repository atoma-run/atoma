// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  notificationLinkUrl,
  parseNotificationLink,
  withoutNotificationLink,
} from '../src/contracts/notificationLink.js';
import {
  listenForNotificationLinks,
  notificationLinkFromMessage,
  takeLaunchNotificationLink,
} from '../src/viz/client-gl/notification-link.js';
import { notificationTarget } from '../src/viz/client-gl/notification-target.js';

const link = { kind: 'run.finished', orgId: 'org-1', projectId: 'proj-1', traceId: 'trace-9' };

afterEach(() => history.replaceState(null, '', '/'));

describe('notification link', () => {
  it('round-trips the subject and drops absent ids', () => {
    expect(parseNotificationLink(new URL(notificationLinkUrl(link), 'https://x').search)).toEqual(link);
    const bare = { kind: 'announcement', orgId: null, projectId: null, traceId: null };
    expect(notificationLinkUrl(bare)).toBe('/?atomaNotification=announcement');
    expect(parseNotificationLink('?lang=fr')).toBeNull();
    expect(withoutNotificationLink('?lang=fr&atomaNotification=x&atomaTrace=t&atomaRun=r')).toBe('?lang=fr');
    const withRun = { ...link, kind: 'run.results_waiting', traceId: null, runId: 'run-3' };
    expect(parseNotificationLink(new URL(notificationLinkUrl(withRun), 'https://x').search)).toEqual(withRun);
  });

  // Review 2026-10-25: the results-waiting click opened the project's Runs but
  // not the run it was about.
  it('a results-waiting click opens the project\'s Runs on that run, from a push link or a tray row', () => {
    const viewer = { platformAdmin: false, activeOrgId: 'org-1' };
    const pushed = parseNotificationLink(new URL(notificationLinkUrl({ kind: 'run.results_waiting', orgId: 'org-1',
      projectId: 'proj-1', traceId: null, runId: 'run-3' }), 'https://x').search)!;
    expect(notificationTarget(pushed, viewer)).toBe('notifications.go.projectRuns.proj-1.run-3');
    expect(notificationTarget({ ...pushed, runId: null }, viewer)).toBe('notifications.go.projectRuns.proj-1');
    expect(notificationTarget(pushed, { ...viewer, activeOrgId: 'org-2' })).toBeNull();
  });

  it('a click on a delivered run opens that run for a member of its organisation', () => {
    expect(notificationTarget(link, { platformAdmin: false, activeOrgId: 'org-1' })).toBe(
      'notifications.go.run.trace-9'
    );
    expect(notificationTarget(link, { platformAdmin: false, activeOrgId: 'org-2' })).toBeNull();
  });

  it('reads the launch link once and removes it from the address bar', () => {
    history.replaceState({ kept: true }, '', `/${notificationLinkUrl(link).slice(1)}&lang=fr#top`);
    expect(takeLaunchNotificationLink()).toEqual(link);
    expect(location.search).toBe('?lang=fr');
    expect(location.hash).toBe('#top');
    expect(history.state).toEqual({ kept: true });
    expect(takeLaunchNotificationLink()).toBeNull();
  });

  it('accepts only our worker message carrying a same-origin path', () => {
    const url = notificationLinkUrl(link);
    expect(notificationLinkFromMessage({ type: 'atoma.notification.open', url })).toEqual(link);
    expect(notificationLinkFromMessage({ type: 'other', url })).toBeNull();
    expect(notificationLinkFromMessage({ type: 'atoma.notification.open', url: `//evil${url}` })).toBeNull();
    expect(notificationLinkFromMessage({ type: 'atoma.notification.open', url: '/' })).toBeNull();
  });

  it('forwards worker messages until stopped', () => {
    const container = new EventTarget() as unknown as ServiceWorkerContainer;
    const open = vi.fn();
    const stop = listenForNotificationLinks(open, container);
    const send = () => container.dispatchEvent(
      new MessageEvent('message', { data: { type: 'atoma.notification.open', url: notificationLinkUrl(link) } })
    );
    send();
    stop();
    send();
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(link);
  });
});
