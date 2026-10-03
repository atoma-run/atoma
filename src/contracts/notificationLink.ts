/**
 * WHERE A PUSH NOTIFICATION LEADS, carried in the URL its click opens.
 *
 * The push router writes it, the service worker hands it to the app (an open
 * tab by message, otherwise as the new window's URL), and the app resolves it
 * with the same rule the notification tray uses for a row. The URL names the
 * event's SUBJECT, never a destination: whether a member may open that run,
 * and in which organisation, is decided by the client against the viewer it
 * has, exactly as the tray decides it.
 *
 * Only scope ids travel — no copy, no secret. The app strips the parameters
 * from the address bar as soon as it has read them.
 */

export interface NotificationLink {
  readonly kind: string;
  readonly orgId: string | null;
  readonly projectId: string | null;
  readonly traceId: string | null;
}

const PARAM = {
  kind: 'atomaNotification',
  orgId: 'atomaOrg',
  projectId: 'atomaProject',
  traceId: 'atomaTrace',
} as const;

const MAX_ID = 200;

export function notificationLinkUrl(link: NotificationLink): string {
  const params = new URLSearchParams();
  params.set(PARAM.kind, link.kind);
  if (link.orgId) params.set(PARAM.orgId, link.orgId);
  if (link.projectId) params.set(PARAM.projectId, link.projectId);
  if (link.traceId) params.set(PARAM.traceId, link.traceId);
  return `/?${params.toString()}`;
}

/** Null when the search carries no link; malformed ids read as absent. */
export function parseNotificationLink(search: string): NotificationLink | null {
  const params = new URLSearchParams(search);
  const kind = params.get(PARAM.kind);
  if (!kind || kind.length > MAX_ID) return null;
  const id = (key: string): string | null => {
    const value = params.get(key);
    return value && value.length <= MAX_ID ? value : null;
  };
  return {
    kind,
    orgId: id(PARAM.orgId),
    projectId: id(PARAM.projectId),
    traceId: id(PARAM.traceId),
  };
}

/** The same search with the link removed and every other parameter kept. */
export function withoutNotificationLink(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of Object.values(PARAM)) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}
