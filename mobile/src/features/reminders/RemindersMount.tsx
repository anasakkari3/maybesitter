import { useEffect, useRef } from 'react';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../auth/AuthProvider';
import { onBeforeSignOut } from '../../auth/beforeSignOut';
import { messagingModule, notificationsModule } from '../../notifications/nativeModules';
import { configureNotifications } from '../../notifications/setup';
import {
  createPushRegistrationDeps,
  deregisterDeviceForPush,
  registerDeviceForPush,
} from '../../notifications/pushRegistration';
import { routeFromNotification } from '../../notifications/routeFromNotification';
import { clearAwareness, markAware } from '../../lib/deviceSettings/awarenessStore';
import { useToday, useUpcoming } from '../../api/queries';
import { startOf } from './reminderInputs';
import { useReminderSync } from './useReminderSync';

/**
 * Everything notifications need mounted, in one place (UC-3.11 #196, UC-3.0b #184).
 *
 * Renders nothing. It is mounted in `Root`, which means: signed in, onboarded,
 * for the whole session. Four things live here because each of them has to
 * outlive whatever screen the user is on.
 *
 *  1. **Setup** — the foreground handler, the Android channels and the iOS
 *     categories. None of it prompts.
 *  2. **Push registration** — after sign-in, and again whenever Firebase
 *     rotates the token. It reports the permission the device has; it never
 *     asks for one.
 *  3. **The reminder engine** — `useReminderSync`, which runs on every
 *     commitment change and once on launch.
 *  4. **Taps** — from the live listener and from the cold-start response, both
 *     through the same router.
 *
 * ── Tapping a reminder is the "I know" gesture ───────────────────
 *
 * #196's second acceptance criterion: tap, force-quit, relaunch, and no
 * follow-up is pending. So a tap writes the awareness record *before* it opens
 * anything, and then asks the engine to resync — which takes the follow-up off
 * the schedule immediately rather than at the next query invalidation. The
 * record is on disk, so the relaunch half holds even if the process dies in
 * the same second.
 */
export function RemindersMount(): null {
  const { actions, t } = useApp();
  const accountId = useAuth().user?.uid ?? null;
  const today = useToday();
  const upcoming = useUpcoming();
  const { resync } = useReminderSync();

  const latest = useRef({ actions, accountId, today, upcoming, resync });
  latest.current = { actions, accountId, today, upcoming, resync };

  useEffect(() => {
    void configureNotifications({
      notifChannelGeneral: t.notifChannelGeneral,
      notifChannelAwareness: t.notifChannelAwareness,
    });
  }, [t]);

  // Registration, and the token refresh that invalidates it. Firebase reissues
  // a token without asking, and a device row pointing at the old one is a
  // phone the server thinks it can reach and cannot.
  useEffect(() => {
    if (!accountId) return;
    const deps = createPushRegistrationDeps();
    void registerDeviceForPush(deps);

    let unsubscribe: (() => void) | undefined;
    try {
      const messaging = messagingModule();
      unsubscribe = messaging?.onTokenRefresh(messaging.getMessaging(), () => {
        void registerDeviceForPush(deps);
      });
    } catch {
      // No native messaging module: a unit test, or a build without push.
    }

    return () => unsubscribe?.();
  }, [accountId]);

  // The device row has to go while the token still works, so this runs before
  // `signOut` rather than after the uid changes. See `beforeSignOut.ts`.
  useEffect(() => onBeforeSignOut(async () => {
    await deregisterDeviceForPush(createPushRegistrationDeps());
    if (latest.current.accountId) await clearAwareness(latest.current.accountId);
  }), []);

  // Taps, live and from a cold start.
  useEffect(() => {
    let cancelled = false;
    let subscription: { remove(): void } | undefined;

    const handle = async (data: unknown) => {
      const route = routeFromNotification(data);
      const { accountId: uid, today: todayQuery, upcoming: upcomingQuery } = latest.current;
      if (route.kind === 'commitment' && uid) {
        // The start as the app currently understands it, so a commitment that
        // has since moved starts a fresh cycle rather than staying silenced.
        const known = [...(todayQuery.data?.items ?? []), ...(upcomingQuery.data?.items ?? [])]
          .find(item => item.id === route.commitmentId);
        await markAware(uid, route.commitmentId, known ? startOf(known) : null, new Date());
        latest.current.resync();
      }
      if (route.kind === 'commitment') latest.current.actions.openDetail(route.commitmentId);
      // `plan_ready` belongs to UC-3.10b (#195), which owns the plan screen.
      // Until then a plan tap opens Today, which is where the plan is shown.
      else latest.current.actions.go('today');
    };

    void (async () => {
      try {
        const Notifications = notificationsModule();
        if (!Notifications || cancelled) return;
        subscription = Notifications.addNotificationResponseReceivedListener(response => {
          void handle(response.notification.request.content.data);
        });
        // The tap that launched the app: the listener above was not installed
        // when it happened, so without this the awareness record is never
        // written for the one case #196 asks about by name.
        const last = await Notifications.getLastNotificationResponseAsync();
        if (last && !cancelled) await handle(last.notification.request.content.data);
      } catch {
        // No native module.
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  return null;
}
