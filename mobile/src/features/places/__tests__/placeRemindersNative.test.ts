/**
 * Place reminders against the native seams (closure CL4): the permission
 * states, handing regions to the OS and taking them back, the task defined at
 * the entry point posting the notification, and sign-out leaving nothing.
 *
 * expo-location and expo-task-manager are replaced by fakes that record what
 * they were asked, so each case reads as the call the app made.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import type { Commitment } from '../../../api/schemas/common';
import { routeFromNotification } from '../../../notifications/routeFromNotification';
import {
  ARMED_KEY,
  clearPlaceReminders,
  loadArmed,
  loadPlaces,
  placesStorageKey,
  savePlaces,
  type Place,
} from '../../../lib/deviceSettings/placeReminders';
import {
  accessFrom,
  applyRegions,
  definePlaceReminderTask,
  postPlaceNotification,
  requestAlwaysAccess,
} from '../nativeLocation';
import { GEOFENCE_ENTER, GEOFENCE_EXIT, PLACE_REMINDER_TASK, regionIdentifier } from '../placeReminderEngine';
import { reconcilePlaceReminders, type ReconcileEffects } from '../PlaceRemindersMount';
import { HOME_ID, pinPlaceHere, resetPlacesStoreForTests } from '../placesStore';

type Perm = { granted: boolean; status: string };
const mockLocation = {
  foreground: { granted: false, status: 'undetermined' } as Perm,
  background: { granted: false, status: 'undetermined' } as Perm,
  grantForeground: true,
  grantBackground: true,
  started: false,
  calls: [] as string[],
};

jest.mock('expo-location', () => ({
  __esModule: true,
  Accuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: async () => mockLocation.foreground,
  getBackgroundPermissionsAsync: async () => mockLocation.background,
  requestForegroundPermissionsAsync: async () => {
    mockLocation.calls.push('requestForeground');
    mockLocation.foreground = mockLocation.grantForeground ? { granted: true, status: 'granted' } : { granted: false, status: 'denied' };
    return mockLocation.foreground;
  },
  requestBackgroundPermissionsAsync: async () => {
    mockLocation.calls.push('requestBackground');
    mockLocation.background = mockLocation.grantBackground ? { granted: true, status: 'granted' } : { granted: false, status: 'denied' };
    return mockLocation.background;
  },
  getCurrentPositionAsync: async () => ({ coords: { latitude: 32.0853, longitude: 34.7818 } }),
  startGeofencingAsync: jest.fn(async () => {
    if (!mockLocation.background.granted) throw new Error('Background location permission is required');
    mockLocation.started = true;
  }),
  stopGeofencingAsync: jest.fn(async () => { mockLocation.started = false; }),
  hasStartedGeofencingAsync: async () => mockLocation.started,
}));

const mockTasks = new Map<string, (body: unknown) => Promise<void>>();
jest.mock('expo-task-manager', () => ({
  __esModule: true,
  defineTask: (name: string, executor: (body: unknown) => Promise<void>) => { mockTasks.set(name, executor); },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Location = require('expo-location') as { startGeofencingAsync: jest.Mock; stopGeofencingAsync: jest.Mock };

const HOME: Place = { id: HOME_ID, kind: 'home', label: 'Home', latitude: 32.0853, longitude: 34.7818, updatedAt: '2026-09-20T08:00:00.000Z' };

function commitment(id: string, extra: Partial<Commitment> = {}): Commitment {
  return {
    id, kind: 'task', title: `Title ${id}`, description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '2026-09-20T08:00:00.000Z', updatedAt: '2026-09-20T08:00:00.000Z',
    confirmedAt: '2026-09-20T08:00:00.000Z', completedAt: null, droppedAt: null,
    ...extra,
  } as Commitment;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetPlacesStoreForTests();
  mockLocation.foreground = { granted: false, status: 'undetermined' };
  mockLocation.background = { granted: false, status: 'undetermined' };
  mockLocation.grantForeground = true;
  mockLocation.grantBackground = true;
  mockLocation.started = false;
  mockLocation.calls = [];
  Location.startGeofencingAsync.mockClear();
  Location.stopGeofencingAsync.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the permission states', () => {
  it('maps the two answers onto what the screens draw', () => {
    expect(accessFrom(null, null)).toBe('unavailable');
    expect(accessFrom({ granted: false, status: 'undetermined' }, null)).toBe('undetermined');
    expect(accessFrom({ granted: false, status: 'denied' }, null)).toBe('denied');
    expect(accessFrom({ granted: true, status: 'granted' }, { granted: false, status: 'denied' })).toBe('foreground');
    expect(accessFrom({ granted: true, status: 'granted' }, { granted: true, status: 'granted' })).toBe('always');
  });

  it('"Always" is asked after "While Using", never instead of it', async () => {
    expect(await requestAlwaysAccess()).toBe('always');
    expect(mockLocation.calls).toEqual(['requestForeground', 'requestBackground']);
  });

  it('refusing "While Using" asks nothing more', async () => {
    mockLocation.grantForeground = false;
    expect(await requestAlwaysAccess()).toBe('denied');
    expect(mockLocation.calls).toEqual(['requestForeground']);
  });

  it('refusing only "Always" leaves While Using — the paused state', async () => {
    mockLocation.grantBackground = false;
    expect(await requestAlwaysAccess()).toBe('foreground');
  });

  it('saving a place is where "While Using" is asked, and a refusal saves nothing', async () => {
    mockLocation.grantForeground = false;
    expect(await pinPlaceHere('u1', { id: HOME_ID, kind: 'home', label: 'Home' })).toEqual({ ok: false, reason: 'denied' });
    expect(await loadPlaces('u1')).toEqual([]);
    expect(mockLocation.calls).toEqual(['requestForeground']);
  });

  it('a granted place is pinned where the phone is, on this phone only', async () => {
    const pinned = await pinPlaceHere('u1', { id: HOME_ID, kind: 'home', label: 'Home' }, () => new Date('2026-09-20T08:00:00.000Z'));
    expect(pinned).toEqual({ ok: true, place: HOME });
    expect(await loadPlaces('u1')).toEqual([HOME]);
    expect(mockLocation.calls).toEqual(['requestForeground']);
  });
});

describe('the regions the OS holds', () => {
  const effects = (overrides: Partial<ReconcileEffects> = {}) => ({
    applyRegions: jest.fn(applyRegions),
    cancelScheduled: jest.fn(async (_identifier: string) => undefined),
    ...overrides,
  });
  const input = (commitments: Commitment[]) => ({
    accountId: 'u1', commitments, places: [HOME],
    copy: { arrive: (place: string) => `Arrived: ${place}`, leave: (place: string) => `Left: ${place}` },
    quiet: null, timeZone: 'UTC',
  });
  const withTrigger = commitment('c1', { locationTrigger: { kind: 'arrive', placeId: HOME_ID, label: 'Home' } });

  beforeEach(() => {
    mockLocation.foreground = { granted: true, status: 'granted' };
    mockLocation.background = { granted: true, status: 'granted' };
  });

  it('a new reminder is handed over once; the same lists again change nothing', async () => {
    const fx = effects();
    expect(await reconcilePlaceReminders(input([withTrigger]), fx)).toEqual({ regions: 1, registered: true });
    expect(Location.startGeofencingAsync).toHaveBeenCalledWith(PLACE_REMINDER_TASK, [{
      identifier: regionIdentifier('c1'), latitude: HOME.latitude, longitude: HOME.longitude,
      radius: 150, notifyOnEnter: true, notifyOnExit: true,
    }]);
    await reconcilePlaceReminders(input([withTrigger]), fx);
    expect(Location.startGeofencingAsync).toHaveBeenCalledTimes(1);
  });

  it('a commitment done, dropped or deleted leaves the lists and the watch, and its deferred ring is cancelled', async () => {
    const fx = effects();
    await reconcilePlaceReminders(input([withTrigger]), fx);
    await reconcilePlaceReminders(input([commitment('c1', { status: 'completed', locationTrigger: withTrigger.locationTrigger! })]), fx);
    expect(Location.stopGeofencingAsync).toHaveBeenCalledTimes(1);
    expect(fx.cancelScheduled).toHaveBeenCalledWith(regionIdentifier('c1'));
    expect((await loadArmed())?.entries).toEqual([]);
  });

  it('removing the trigger stops the watch too', async () => {
    const fx = effects();
    await reconcilePlaceReminders(input([withTrigger]), fx);
    await reconcilePlaceReminders(input([commitment('c1')]), fx);
    expect(mockLocation.started).toBe(false);
  });

  it('without "Always" the hand-over fails, is not recorded, and is tried again once it is granted', async () => {
    mockLocation.background = { granted: false, status: 'denied' };
    const fx = effects();
    expect(await reconcilePlaceReminders(input([withTrigger]), fx)).toEqual({ regions: 1, registered: false });
    mockLocation.background = { granted: true, status: 'granted' };
    expect(await reconcilePlaceReminders(input([withTrigger]), fx)).toEqual({ regions: 1, registered: true });
    expect(Location.startGeofencingAsync).toHaveBeenCalledTimes(2);
  });

  it('the task defined at the entry point posts the reminder when the phone crosses into the place', async () => {
    const schedule = jest.spyOn(Notifications, 'scheduleNotificationAsync').mockResolvedValue('id');
    await reconcilePlaceReminders(input([withTrigger]), effects());
    definePlaceReminderTask();
    const task = mockTasks.get(PLACE_REMINDER_TASK)!;
    const region = { identifier: regionIdentifier('c1'), latitude: HOME.latitude, longitude: HOME.longitude, radius: 150 };
    await task({ data: { eventType: GEOFENCE_EXIT, region }, error: null });
    expect(schedule).not.toHaveBeenCalled();
    await task({ data: { eventType: GEOFENCE_ENTER, region }, error: null });
    expect(schedule).toHaveBeenCalledTimes(1);
    const request = schedule.mock.calls[0]![0] as { content: { title: string; body: string; data: unknown } };
    expect(request.content.title).toBe('Title c1');
    expect(request.content.body).toBe('Arrived: Home');
    // The tap opens that commitment.
    expect(routeFromNotification(request.content.data)).toEqual({ kind: 'commitment', commitmentId: 'c1' });
  });
});

describe('the notification', () => {
  it('now, on the gentle-reminder channel, with ids only in its data', async () => {
    const schedule = jest.spyOn(Notifications, 'scheduleNotificationAsync').mockResolvedValue('id');
    await postPlaceNotification({ identifier: 'place-reminder.c1', title: 'Buy bread', body: 'Left: Work', commitmentId: 'c1', at: null });
    expect(schedule).toHaveBeenCalledWith({
      identifier: 'place-reminder.c1',
      content: {
        title: 'Buy bread', body: 'Left: Work',
        data: { commitmentId: 'c1', kind: 'place_reminder' },
        categoryIdentifier: 'com.maybesitter.notification.category.awareness',
      },
      trigger: { channelId: 'maybesitter_awareness' },
    });
  });

  it('at the end of quiet hours when they moved it', async () => {
    const schedule = jest.spyOn(Notifications, 'scheduleNotificationAsync').mockResolvedValue('id');
    const at = new Date('2026-09-21T07:00:00.000Z');
    await postPlaceNotification({ identifier: 'place-reminder.c1', title: 'x', body: 'y', commitmentId: 'c1', at });
    expect((schedule.mock.calls[0]![0] as { trigger: unknown }).trigger).toEqual({ type: 'date', date: at, channelId: 'maybesitter_awareness' });
  });
});

describe('sign-out and account deletion', () => {
  it('leave no pin and nothing armed behind', async () => {
    await savePlaces('u1', [HOME]);
    await AsyncStorage.setItem(ARMED_KEY, JSON.stringify({ version: 1, accountId: 'u1', entries: [] }));
    await clearPlaceReminders('u1');
    expect(await AsyncStorage.getItem(placesStorageKey('u1'))).toBeNull();
    expect(await AsyncStorage.getItem(ARMED_KEY)).toBeNull();
  });
});
