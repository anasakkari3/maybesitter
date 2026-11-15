/**
 * Everything the OS holds about this account's notifications, gone (C13.14, CXA13.1).
 *
 * Run before every sign-out, whatever the reason — `user`, `deleted`,
 * `session_expired`, `revoked` — because each of them can be the moment the
 * phone changes hands.
 *
 * ── Why here and not in `useReminderSync` ────────────────────────
 *
 * The sync cancels everything when the uid turns null, but it never sees the
 * uid turn null: the gate unmounts `Root`, and this feature with it, in the
 * same render. On device 17 of A's reminders stayed pending and rang after A
 * signed out. A before-sign-out task runs while the tree is still mounted.
 *
 * ── Three things, each on its own ────────────────────────────────
 *
 *  1. The pending requests, so nothing of A's rings later.
 *  2. The ones already shown, so none can be tapped once A has gone.
 *  3. The last response the native module keeps for the process. The live
 *     listener handles a tap without clearing it, so B's first mount would
 *     read A's tap as its own cold start and open A's commitment id.
 *
 * A failure in one does not skip the others; a failure in all does not keep
 * the person signed in (`beforeSignOut.ts`).
 */
import { notificationsModule } from '../../notifications/nativeModules';
import { createExpoGateway, type NotificationGateway } from '../../notifications/gateway';
import { cancelEveryReminder } from './softAwarenessEngine';

export async function forgetDeviceNotifications(
  gateway: NotificationGateway = createExpoGateway(),
): Promise<void> {
  await cancelEveryReminder(gateway).catch(() => undefined);
  const Notifications = notificationsModule();
  if (!Notifications) return;
  await Promise.resolve()
    .then(() => Notifications.dismissAllNotificationsAsync?.())
    .catch(() => undefined);
  await Promise.resolve()
    .then(() => Notifications.clearLastNotificationResponseAsync?.())
    .catch(() => undefined);
}
