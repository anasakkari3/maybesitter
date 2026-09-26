import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../auth/AuthProvider';
import { onBeforeSignOut } from '../../auth/beforeSignOut';
import { useReminderSettings, useToday, useUpcoming } from '../../api/queries';
import type { Commitment } from '../../api/schemas/common';
import { fill } from '../../i18n/strings';
import { notificationsModule } from '../../notifications/nativeModules';
import { clearPlaceReminders, loadArmed, saveArmed, type Place } from '../../lib/deviceSettings/placeReminders';
import { quietTimeZone, quietWindowOf } from '../reminders/reminderInputs';
import {
  desiredArmed,
  emptyArmed,
  regionIdentifier,
  regionsFor,
  withArmedLock,
  type NotificationCopy,
} from './placeReminderEngine';
import { applyRegions } from './nativeLocation';
import { forgetPlaces, refreshLocationAccess, useLocationAccess, usePlaces } from './placesStore';

export interface ReconcileInput {
  accountId: string;
  commitments: readonly Commitment[];
  places: readonly Place[];
  copy: NotificationCopy;
  quiet: { start: string; end: string } | null;
  timeZone: string;
}

export interface ReconcileEffects {
  applyRegions: typeof applyRegions;
  cancelScheduled(identifier: string): Promise<void>;
}

/**
 * Brings what the OS watches in line with the account (closure CL4).
 *
 * Regions are handed over only when they changed: every hand-over makes both
 * platforms report the current side again, which the engine absorbs, but
 * there is no reason to make them. A hand-over that failed — no "Always" yet —
 * is not recorded, so the next pass (the app coming back to the front after
 * the person changed the setting) tries again.
 */
export function reconcilePlaceReminders(input: ReconcileInput, effects: ReconcileEffects): Promise<{ regions: number; registered: boolean }> {
  return withArmedLock(async () => {
    const stored = await loadArmed();
    const previous = stored && stored.accountId === input.accountId ? stored : emptyArmed(input.accountId);
    const entries = desiredArmed(input.commitments, input.places, previous.entries, input.copy);
    const regions = regionsFor(entries, input.places);
    const signature = JSON.stringify(regions);

    // A reminder moved by quiet hours whose commitment has since closed must
    // not ring at 07:00 anyway.
    const kept = new Set(entries.map(entry => entry.commitmentId));
    for (const gone of previous.entries) {
      if (!kept.has(gone.commitmentId)) {
        try {
          await effects.cancelScheduled(regionIdentifier(gone.commitmentId));
        } catch {
          // Nothing pending.
        }
      }
    }

    let registered = previous.registered;
    if (signature !== previous.registered) {
      registered = (await effects.applyRegions(regions)) ? signature : null;
    }
    await saveArmed({
      ...previous,
      accountId: input.accountId,
      quiet: input.quiet,
      timeZone: input.timeZone,
      entries,
      registered,
    });
    return { regions: regions.length, registered: registered === signature };
  });
}

const realEffects: ReconcileEffects = {
  applyRegions,
  async cancelScheduled(identifier) {
    await notificationsModule()?.cancelScheduledNotificationAsync(identifier);
  },
};

/**
 * Renders nothing. Mounted in `Root` beside `RemindersMount`, for the whole
 * signed-in session: re-arms on every change to the lists, to the places or
 * to quiet hours, and whenever the app comes back to the front (the person
 * may have just changed the location permission in Settings).
 */
export function PlaceRemindersMount(): null {
  const { t } = useApp();
  const accountId = useAuth().user?.uid ?? null;
  const today = useToday();
  const upcoming = useUpcoming();
  const settings = useReminderSettings();
  const { loaded, places } = usePlaces(accountId);
  const [foreground, setForeground] = useForegroundTick();
  // A grant to "Always" re-arms at once rather than at the next foreground.
  const access = useLocationAccess();

  const arrive = t.placeNotifArrive;
  const leave = t.placeNotifLeave;
  const settingsData = settings.data?.reminderSettings;

  useEffect(() => {
    if (!accountId || !loaded || !today.data || !upcoming.data) return;
    void reconcilePlaceReminders({
      accountId,
      commitments: [...today.data.items, ...upcoming.data.items],
      places,
      copy: { arrive: place => fill(arrive, { place }), leave: place => fill(leave, { place }) },
      quiet: settingsData ? quietWindowOf(settingsData) : null,
      timeZone: settingsData ? quietTimeZone(settingsData) : 'UTC',
    }, realEffects);
  }, [accountId, loaded, places, today.data, upcoming.data, arrive, leave, settingsData, foreground, access]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      void refreshLocationAccess();
      setForeground();
    });
    return () => subscription.remove();
  }, [setForeground]);

  const current = useRef(accountId);
  useEffect(() => {
    current.current = accountId;
  }, [accountId]);

  // Sign-out and account deletion: stop watching, and leave no pin behind.
  useEffect(() => onBeforeSignOut(async () => {
    const uid = current.current;
    await withArmedLock(async () => {
      const stored = await loadArmed();
      for (const entry of stored?.entries ?? []) {
        try {
          await realEffects.cancelScheduled(regionIdentifier(entry.commitmentId));
        } catch {
          // Nothing pending.
        }
      }
      await applyRegions([]);
      if (uid) {
        await clearPlaceReminders(uid);
        forgetPlaces(uid);
      }
    });
  }), []);

  return null;
}

function useForegroundTick(): [number, () => void] {
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick(value => value + 1), []);
  return [tick, bump];
}
