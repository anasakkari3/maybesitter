/**
 * expo-location, expo-task-manager and the notification a region crossing
 * posts — the only file that touches them (closure CL4).
 *
 * Resolved lazily, like `notifications/nativeModules.ts` and for the same
 * reason: a build without the module, or a screen test, must still start. A
 * missing place reminder is a degradation; a white screen at launch is not.
 * Every function here answers rather than throws.
 */
import { Linking } from 'react-native';
import { notificationsModule } from '../../notifications/nativeModules';
import { AWARENESS_CATEGORY_ID, AWARENESS_CHANNEL_ID } from '../../notifications/channels';
import { loadArmed, saveArmed } from '../../lib/deviceSettings/placeReminders';
import { handleGeofenceEvent, PLACE_REMINDER_TASK, type GeofenceDeps, type PlaceNotification, type Region } from './placeReminderEngine';

type LocationModule = typeof import('expo-location');
type TaskManagerModule = typeof import('expo-task-manager');

export function locationModule(): LocationModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-location') as LocationModule;
  } catch {
    return null;
  }
}

function taskManagerModule(): TaskManagerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-task-manager') as TaskManagerModule;
  } catch {
    return null;
  }
}

/**
 * What the phone lets MaybeSitter do with location.
 *
 * `foreground` is enough to save a place ("where I am now"); only `always`
 * lets a region fire while the app is closed. `unavailable` is a build or a
 * test with no location module.
 */
export type LocationAccess = 'unavailable' | 'undetermined' | 'denied' | 'foreground' | 'always';

interface PermissionLike { granted?: boolean; status?: string; canAskAgain?: boolean }

export function accessFrom(foreground: PermissionLike | null, background: PermissionLike | null): LocationAccess {
  if (!foreground) return 'unavailable';
  if (!foreground.granted) return foreground.status === 'denied' ? 'denied' : 'undetermined';
  return background?.granted ? 'always' : 'foreground';
}

export async function getLocationAccess(): Promise<LocationAccess> {
  const Location = locationModule();
  if (!Location) return 'unavailable';
  try {
    const foreground = await Location.getForegroundPermissionsAsync();
    const background = foreground.granted ? await Location.getBackgroundPermissionsAsync() : null;
    return accessFrom(foreground, background);
  } catch {
    return 'unavailable';
  }
}

/** Asks for "While Using" — when somebody saves a place — and answers with where things stand. */
export async function requestForegroundAccess(): Promise<LocationAccess> {
  const Location = locationModule();
  if (!Location) return 'unavailable';
  try {
    const current = await getLocationAccess();
    if (current !== 'undetermined') return current;
    await Location.requestForegroundPermissionsAsync();
    return await getLocationAccess();
  } catch {
    return 'unavailable';
  }
}

/**
 * Asks for "Always" — only when the first arrive/leave reminder is saved, with
 * the line on screen that says why. On iOS this is the system's upgrade
 * prompt; on Android 11+ the system sends the person to the permission page.
 */
export async function requestAlwaysAccess(): Promise<LocationAccess> {
  const Location = locationModule();
  if (!Location) return 'unavailable';
  try {
    const foreground = await requestForegroundAccess();
    if (foreground !== 'foreground') return foreground;
    await Location.requestBackgroundPermissionsAsync();
    return await getLocationAccess();
  } catch {
    return 'unavailable';
  }
}

export function openLocationSettings(): void {
  void Linking.openSettings().catch(() => undefined);
}

/** Where the phone is now, or null. Only ever kept on the phone. */
export async function currentPosition(): Promise<{ latitude: number; longitude: number } | null> {
  const Location = locationModule();
  if (!Location) return null;
  try {
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const { latitude, longitude } = position.coords;
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
  } catch {
    return null;
  }
}

/**
 * Hands the OS exactly these regions, or stops watching when there are none.
 * Returns whether the OS took them — false without "Always", which is what
 * the paused state is drawn from.
 */
export async function applyRegions(regions: readonly Region[]): Promise<boolean> {
  const Location = locationModule();
  if (!Location) return false;
  try {
    if (regions.length === 0) {
      if (await Location.hasStartedGeofencingAsync(PLACE_REMINDER_TASK)) {
        await Location.stopGeofencingAsync(PLACE_REMINDER_TASK);
      }
      return true;
    }
    await Location.startGeofencingAsync(PLACE_REMINDER_TASK, regions.map(region => ({ ...region })));
    return true;
  } catch {
    return false;
  }
}

/** Posts the reminder: now, or at the end of quiet hours. Filed with the gentle reminders, so it has their buttons. */
export async function postPlaceNotification(notification: PlaceNotification): Promise<void> {
  const Notifications = notificationsModule();
  if (!Notifications) return;
  await Notifications.scheduleNotificationAsync({
    identifier: notification.identifier,
    content: {
      title: notification.title,
      body: notification.body,
      // Ids only: the tap router opens the commitment from this.
      data: { commitmentId: notification.commitmentId, kind: 'place_reminder' },
      categoryIdentifier: AWARENESS_CATEGORY_ID,
    },
    trigger: notification.at
      ? { type: Notifications.SchedulableTriggerInputTypes.DATE, date: notification.at, channelId: AWARENESS_CHANNEL_ID }
      : { channelId: AWARENESS_CHANNEL_ID },
  });
}

export const geofenceDeps: GeofenceDeps = {
  load: loadArmed,
  save: saveArmed,
  notify: postPlaceNotification,
  now: () => new Date(),
};

/**
 * From `index.ts`, at module scope, before the app registers: the OS wakes
 * the app for a region crossing with no React tree. Never throws.
 */
export function definePlaceReminderTask(): void {
  try {
    taskManagerModule()?.defineTask(PLACE_REMINDER_TASK, async body => {
      await handleGeofenceEvent(body, geofenceDeps);
    });
  } catch {
    // No native module.
  }
}
