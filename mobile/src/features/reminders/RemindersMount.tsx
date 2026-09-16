import { useCallback, useEffect, useRef } from 'react';
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
import { clearHardReceipts } from '../../lib/deviceSettings/hardReceiptQueue';
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

  /*
   * The three listeners below are installed once and have to read the *current*
   * actions, account and queries when a tap arrives, not the ones that existed
   * at mount. A ref carries them across — written from an effect rather than
   * from the render body, because a ref written during render is a value React
   * is allowed to throw away, and `react-hooks/refs` is right to say so.
   * Every reader of it is an event handler, which by definition runs after the
   * render that produced the value has committed.
   */
  const latest = useRef({ actions, accountId, today, upcoming, resync });
  useEffect(() => {
    latest.current = { actions, accountId, today, upcoming, resync };
  });

  useEffect(() => {
    void configureNotifications({
      notifChannelGeneral: t.notifChannelGeneral,
      notifChannelAwareness: t.notifChannelAwareness,
      notifChannelHard: t.notifChannelHard,
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
  //
  // Every reason runs it now, not only `user`: the reason a phone left in a
  // drawer signs out with is `session_expired`, and that is exactly the phone
  // that is about to be handed to somebody else. Only the *server* call is
  // conditional, because only it needs a credential.
  useEffect(() => onBeforeSignOut(async reason => {
    await deregisterDeviceForPush(createPushRegistrationDeps(), reason === 'user');
    if (latest.current.accountId) {
      await clearAwareness(latest.current.accountId);
      // Receipts silence the server's backup push (#198). Left behind, they
      // would speak for a phone that is no longer this account's.
      await clearHardReceipts(latest.current.accountId);
    }
  }), []);

  const handle = useCallback(async (data: unknown) => {
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
    // `plan_ready` (#194) opens the day it names on the plan screen (#195).
    else if (route.kind === 'plan') latest.current.actions.openPlan(route.planDate);
    else latest.current.actions.go('today');
  }, []);

  // Taps while the app is running. The process is alive, so the commitments
  // this reads a start off are already loaded.
  useEffect(() => {
    let subscription: { remove(): void } | undefined;
    try {
      const Notifications = notificationsModule();
      subscription = Notifications?.addNotificationResponseReceivedListener(response => {
        void handle(response.notification.request.content.data);
      });
    } catch {
      // No native module.
    }
    return () => subscription?.remove();
  }, [handle]);

  /*
   * The tap that launched the app — the force-quit case, and the one #196 asks
   * about by name.
   *
   * It waits for the commitment queries to settle, and that wait is the whole
   * point of the effect rather than a nicety. `getLastNotificationResponseAsync`
   * resolves in the first frames, long before the first list has come back, so
   * handling it immediately looked up the commitment in two empty caches, found
   * nothing, and wrote the awareness record with an *empty* start fingerprint.
   * `isAware` then compares that empty string against the real start, gets
   * false, and schedules the follow-up again — so "tap, force-quit, relaunch,
   * no follow-up" failed in exactly the way the Flutter client failed, while
   * the record sat on disk looking like it had worked.
   *
   * Settled, not loaded: a list that errored is never going to answer, and
   * waiting for it would drop the acknowledgement altogether. A commitment that
   * is in neither list is one the engine schedules nothing for either way.
   */
  const commitmentsSettled = (today.isSuccess || today.isError)
    && (upcoming.isSuccess || upcoming.isError);
  const coldStartHandled = useRef(false);

  useEffect(() => {
    if (!commitmentsSettled || coldStartHandled.current) return;
    coldStartHandled.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const Notifications = notificationsModule();
        if (!Notifications) return;
        const last = await Notifications.getLastNotificationResponseAsync();
        if (last && !cancelled) await handle(last.notification.request.content.data);
      } catch {
        // No native module.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [commitmentsSettled, handle]);

  return null;
}
