import {
  parseNotificationLink,
  withoutNotificationLink,
  type NotificationLink,
} from '../../contracts/notificationLink.js';

/**
 * A push click, arriving in the app.
 *
 * Two doors, one link (`contracts/notificationLink.ts`): a browser with no
 * Atoma tab opens a window on the link's URL, read here once at load; a
 * browser with one gets a message from the service worker and the tab routes
 * itself, keeping whatever it had on screen. The caller resolves the link with
 * `notificationTarget`, the tray's rule.
 */

const MESSAGE_TYPE = 'atoma.notification.open';

/**
 * The link the page was opened on, removed from the address bar either way —
 * ids are not left there to be bookmarked, shared or re-opened by a reload.
 */
export function takeLaunchNotificationLink(win: Window = window): NotificationLink | null {
  const link = parseNotificationLink(win.location.search);
  if (!link) return null;
  const { pathname, search, hash } = win.location;
  win.history.replaceState(win.history.state, '', `${pathname}${withoutNotificationLink(search)}${hash}`);
  return link;
}

/** Same-origin path only: the message comes from our worker, its URL from a push payload. */
export function notificationLinkFromMessage(data: unknown): NotificationLink | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as Record<string, unknown>;
  if (message['type'] !== MESSAGE_TYPE || typeof message['url'] !== 'string') return null;
  const url = message['url'];
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  const query = url.indexOf('?');
  return query < 0 ? null : parseNotificationLink(url.slice(query));
}

/** Listens for clicks the service worker forwards; returns the stop function. */
export function listenForNotificationLinks(
  open: (link: NotificationLink) => void,
  container: ServiceWorkerContainer | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
): () => void {
  if (!container) return () => undefined;
  const onMessage = (event: MessageEvent): void => {
    const link = notificationLinkFromMessage(event.data);
    if (link) open(link);
  };
  container.addEventListener('message', onMessage);
  return () => container.removeEventListener('message', onMessage);
}
