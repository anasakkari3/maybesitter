/**
 * The reminder engine, wired to the app (UC-3.11, #196).
 *
 * ── When it runs, and why those moments ──────────────────────────
 *
 * Whenever the commitments, the settings or the profile's intensity change —
 * which covers every mutation, because they all invalidate the commitment
 * queries — and once on a cold start as soon as the first load lands. #196's
 * hardest acceptance criterion is the one where the app was force-quit between
 * the tap and the follow-up, and the only thing that satisfies it is a sync
 * that runs on launch against a *persisted* awareness record.
 *
 * ── It is mounted inside the signed-in tree ──────────────────────
 *
 * Reminders belong to an account. A signed-out device must not be holding
 * pending requests about somebody's week, which is also why the uid change
 * cancels them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { useApp } from '../../state/AppContext';
import { useProfile, useReminderSettings, useToday, useUpcoming } from '../../api/queries';
import { softRemindersEnabled } from '../../config/env';
import { createExpoGateway, type NotificationGateway } from '../../notifications/gateway';
import {
  EMPTY_AWARENESS,
  loadAwareness,
  type AwarenessCache,
} from '../../lib/deviceSettings/awarenessStore';
import { cancelEveryReminder, syncCommitments } from './softAwarenessEngine';
import {
  mergeById,
  quietTimeZone,
  quietWindowOf,
  toEngineSettings,
  toReminderCommitments,
} from './reminderInputs';
import type { ReminderIntensity } from './policy';
import { recordHardReceipts } from '../../lib/deviceSettings/hardReceiptQueue';
import { canScheduleExactAlarms } from '../../notifications/exactAlarms';

export interface ReminderSyncOptions {
  /** Tests hand in a fake; the app lets this default to expo-notifications. */
  gateway?: NotificationGateway;
  /** Tests hand in an answer; the app asks the `exact-alarm` module on every sync. */
  exactAlarms?: () => boolean;
}

/**
 * Keeps the OS's pending reminders in step with the account.
 *
 * Returns nothing the screens need. The one thing it exposes is `resync`, so a
 * notification tap can mark awareness and then immediately take the follow-up
 * off the schedule rather than waiting for the next query invalidation.
 */
export function useReminderSync(options: ReminderSyncOptions = {}): { resync: () => void } {
  const accountId = useAuth().user?.uid ?? null;
  const { t } = useApp();
  const today = useToday();
  const upcoming = useUpcoming();
  const settings = useReminderSettings();
  const profile = useProfile();
  const [defaultGateway] = useState(createExpoGateway);
  const gateway = options.gateway ?? defaultGateway;
  const exactAlarms = options.exactAlarms ?? canScheduleExactAlarms;
  const [loaded, setLoaded] = useState<{ uid: string | null; cache: AwarenessCache }>(
    { uid: null, cache: EMPTY_AWARENESS },
  );
  const [nudge, setNudge] = useState(0);

  /*
   * The awareness record is held *under* its uid rather than reset on a uid
   * change.
   *
   * Two reasons, and the second is the one that matters. Deriving it means the
   * previous account's record is never readable as this one's, not even for
   * the one render between the uid changing and a reset effect running —
   * which would silence this account's reminders with the other's answers
   * (#148's lesson, applied before it can happen again). And a `setState`
   * called straight from an effect body is a cascading render the linter is
   * right to refuse.
   */
  const awareness = loaded.uid === accountId ? loaded.cache : EMPTY_AWARENESS;

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void loadAwareness(accountId).then(cache => {
      if (!cancelled) setLoaded({ uid: accountId, cache });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, nudge]);

  const resync = useCallback(() => setNudge(value => value + 1), []);

  const todayItems = today.data?.items;
  const upcomingItems = upcoming.data?.items;
  const settingsData = settings.data?.reminderSettings;
  const intensity: ReminderIntensity = profile.data?.routine?.preferredReminderIntensity ?? 'softAwareness';
  const inFlight = useRef(false);
  /*
   * A change that arrived while a sync was running (#197 review, F2).
   *
   * The in-flight guard used to drop it: the effect returned early and nothing
   * ran it again, so a ceiling lowered from "Ring for Must items" to "Gentle
   * only" in the middle of a sync left the Must rings scheduled until some
   * unrelated query happened to change. Now the dropped run is remembered, and
   * the sync that was in flight reruns the effect when it finishes (`rerun`) — against
   * whatever the settings are by then.
   */
  const dirty = useRef(false);
  /*
   * Its own counter, in the sync effect's dependencies. Bumping `nudge` is not
   * enough, and was tried first: `nudge` reloads awareness, and an account with
   * nothing stored reloads the very same `EMPTY_AWARENESS` object, so React
   * sees no change and the sync never reruns — the regression test stayed red.
   */
  const [rerun, setRerun] = useState(0);

  useEffect(() => {
    // Signed out: nothing of this account stays pending on the device.
    if (!accountId) {
      void cancelEveryReminder(gateway);
      return;
    }
    /*
     * The kill switch, and the one place `cancelAll` is right.
     *
     * "Schedule nothing from now on" would leave yesterday's requests to fire
     * anyway, so a build with the switch thrown would still interrupt people —
     * which is the one thing a kill switch must not do.
     */
    if (!softRemindersEnabled()) {
      void cancelEveryReminder(gateway);
      return;
    }
    // Nothing has loaded yet. Syncing against an empty list would cancel every
    // pending reminder on every cold start, one frame before the data arrives.
    if (!settingsData || (todayItems === undefined && upcomingItems === undefined)) return;
    if (inFlight.current) {
      dirty.current = true;
      return;
    }
    inFlight.current = true;

    void syncCommitments(
      {
        commitments: toReminderCommitments(mergeById(todayItems ?? [], upcomingItems ?? [])),
        now: new Date(),
        settings: toEngineSettings(settingsData, intensity),
        quietHours: quietWindowOf(settingsData),
        timeZone: quietTimeZone(settingsData),
        awareness,
        copy: { title: t.notifSoftTitle, body: t.notifSoftBody },
        hardCopy: { title: t.notifHardTitle, body: t.notifHardBody },
        // Asked on every sync, not once: "Alarms & reminders" can be granted or
        // revoked from system settings while the app is backgrounded (#197).
        exactAlarms: exactAlarms(),
      },
      gateway,
    )
      // Filed under the account the sync ran for, captured above — not
      // whichever account is signed in by the time the OS answers.
      .then(report => recordHardReceipts(accountId, report.hardReceipts, new Date()))
      .catch(() => {
        // A failed sync leaves the OS's pending set as it was, and the next
        // commitment change runs it again. There is nobody to show it to.
      })
      .finally(() => {
        inFlight.current = false;
        if (dirty.current) {
          dirty.current = false;
          setRerun(value => value + 1);
        }
      });
  }, [accountId, todayItems, upcomingItems, settingsData, intensity, awareness, gateway, exactAlarms, t, rerun]);

  return { resync };
}
