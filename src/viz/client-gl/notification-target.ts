import type { NotificationLink } from '../../contracts/notificationLink.js';

/** What the tray knows about the viewer when it resolves a row's destination. */
export interface NotificationViewer {
  readonly platformAdmin: boolean;
  readonly activeOrgId: string | null;
}

/**
 * Where one notification LEADS, as an activation id — or null when the app
 * holds no better surface than the row itself. The rules are deliberately
 * conservative: org-scoped destinations require the event's organisation to
 * be the viewer's ACTIVE one, because Projects and Settings render the active
 * organisation and a click that lands on the wrong org's list is worse than
 * no link. A platform admin can always reach the run corpus and the journal,
 * so their trace links cross organisations and their fallback is the journal
 * row every notification came from.
 *
 * ONE rule for both doors: a tray row and a push click (`NotificationLink`,
 * the subject a push URL carries) resolve here, so the two cannot disagree.
 */
export function notificationTarget(
  notification: NotificationLink,
  viewer: NotificationViewer
): string | null {
  const sameOrg =
    typeof notification.orgId === 'string' &&
    notification.orgId !== '' &&
    notification.orgId === viewer.activeOrgId;
  if (notification.traceId && (viewer.platformAdmin || sameOrg)) {
    return `notifications.go.run.${notification.traceId}`;
  }
  if (notification.projectId && sameOrg) {
    return `notifications.go.project.${notification.projectId}`;
  }
  if (notification.kind === 'org.member_joined' && sameOrg) {
    return 'notifications.go.view.settings';
  }
  if (notification.kind === 'github.installation_status' && sameOrg) {
    return 'notifications.go.view.projects';
  }
  // Every notification is a journal row; for the operator the journal IS the
  // detail surface of last resort. Members have no journal, so no fallback.
  if (viewer.platformAdmin) return 'notifications.go.view.journal';
  return null;
}
