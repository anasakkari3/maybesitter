/**
 * Place reminders from the screens a person reaches them on (closure CL4).
 *
 * Drives the real details screen and the real review-card edit sheet, and
 * asserts at the endpoint module — the boundary that builds the request — so
 * the guarantee is about what leaves the phone: `{ kind, placeId, label }` and
 * never a coordinate, while the pin itself lands in on-device storage.
 */
import React from 'react';
import { ScrollView } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { DetailsScreen } from '../../../screens/DetailsScreen';
import { EditProposalItemSheet } from '../../capture/EditProposalItemSheet';
import { toServerEdits } from '../../capture/editPayload';
import type { CaptureItemEdit } from '../../capture/captureMachine';
import type { CaptureProposalItem } from '../../../api/schemas/capture';
import type { Commitment } from '../../../api/schemas/common';
import { loadPlaces, savePlaces, type Place } from '../../../lib/deviceSettings/placeReminders';
import { HOME_ID, removePlace, resetPlacesStoreForTests } from '../placesStore';
import { reconcilePlaceReminders } from '../PlaceRemindersMount';
import { applyRegions, geofenceDeps, isWatchingPlaces } from '../nativeLocation';
import { GEOFENCE_ENTER, GEOFENCE_EXIT, MAX_REGIONS, handleGeofenceEvent, regionIdentifier } from '../placeReminderEngine';
import { resetWatchStatusForTests } from '../placeReminderStatus';
import { PlacesScreen } from '../PlacesScreen';
import en from '../../../i18n/locales/en.json';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';

type Perm = { granted: boolean; status: string };
const mockLocation = {
  foreground: { granted: false, status: 'undetermined' } as Perm,
  background: { granted: false, status: 'undetermined' } as Perm,
  grantForeground: true,
  grantBackground: true,
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
  getCurrentPositionAsync: async () => {
    mockLocation.calls.push('position');
    return { coords: { latitude: 32.0853, longitude: 34.7818 } };
  },
  startGeofencingAsync: async () => undefined,
  stopGeofencingAsync: async () => undefined,
  hasStartedGeofencingAsync: async () => false,
}));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'place-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const ID = 'c-77';
const HOME: Place = { id: HOME_ID, kind: 'home', label: 'Home', latitude: 32.0853, longitude: 34.7818, updatedAt: '2026-09-20T08:00:00.000Z' };
const COORDINATE = /lat|lng|lon|coord|radius|32\.08|34\.78/i;

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function commitment(extra: Partial<Commitment> = {}): Commitment {
  return {
    id: ID, kind: 'task', title: 'Buy bread', description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '2026-09-20T08:00:00.000Z', updatedAt: '2026-09-20T08:00:00.000Z',
    confirmedAt: '2026-09-20T08:00:00.000Z', completedAt: null, droppedAt: null,
    ...extra,
  } as Commitment;
}

function OpenDetails() {
  const { actions } = useApp();
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    actions.openDetail(ID);
  }, [actions]);
  return null;
}

function wrap(child: React.ReactNode) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>{child}</QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}

async function showDetails(data: Commitment) {
  jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data, etag: 'W/"v1"' } as never);
  await render(wrap(<><OpenDetails /><DetailsScreen /></>));
  await waitFor(() => expect(screen.queryByTestId('details-place')).not.toBeNull());
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.clear();
  resetPlacesStoreForTests();
  resetWatchStatusForTests();
  mockLocation.foreground = { granted: false, status: 'undetermined' };
  mockLocation.background = { granted: false, status: 'undetermined' };
  mockLocation.grantForeground = true;
  mockLocation.grantBackground = true;
  mockLocation.calls = [];
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('on the commitment', () => {
  it('"when I leave" + "where I am now" sends kind, place id and name — and the pin stays on the phone', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment').mockResolvedValue({ data: commitment(), etag: 'W/"v2"' } as never);
    await showDetails(commitment());
    await fireEvent.press(screen.getByTestId('details-place-add'));
    // Before the first save: the line that says why "Always" will be asked.
    await waitFor(() => expect(screen.getByTestId('place-always-why')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('place-kind-leave'));
    await fireEvent.press(screen.getByTestId('place-pick-here'));
    await fireEvent.changeText(screen.getByTestId('place-here-name'), 'Gym');
    await fireEvent.press(screen.getByTestId('details-place-save'));
    await waitFor(() => expect(patch).toHaveBeenCalled());

    const body = patch.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).toEqual({ locationTrigger: { kind: 'leave', placeId: expect.stringMatching(/^place_[a-f0-9]+$/), label: 'Gym' } });
    expect(JSON.stringify(body)).not.toMatch(COORDINATE);

    const [saved] = await loadPlaces(USER.uid);
    expect(saved).toMatchObject({ label: 'Gym', latitude: 32.0853, longitude: 34.7818 });
    expect((body.locationTrigger as { placeId: string }).placeId).toBe(saved!.id);
    // While Using when the place is saved; Always only after the reminder is.
    await waitFor(() => expect(mockLocation.calls).toEqual(['requestForeground', 'position', 'requestBackground']));
  });

  it('opening «ذكّرني لما أوصل / لما أطلع» brings the form into view above the pinned actions (FX1)', async () => {
    // UAT 2026-09-27 (shot 78): below Details' four pinned actions the form
    // opened out of sight, so the first tap looked like it did nothing.
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
    await showDetails(commitment());
    await fireEvent(screen.getByTestId('details-place'), 'layout', { nativeEvent: { layout: { x: 16, y: 640, width: 358, height: 90 } } });
    expect(scrollTo).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('details-place-add'));
    await waitFor(() => expect(screen.getByTestId('place-kind-leave')).toBeTruthy());
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ y: 632 })));
  });

  it('the place-name field closes the keyboard with «تم» (review I1)', async () => {
    await showDetails(commitment());
    await fireEvent.press(screen.getByTestId('details-place-add'));
    await waitFor(() => expect(screen.getByTestId('place-pick-here')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('place-pick-here'));
    await waitFor(() => expect(screen.getByTestId('place-here-name')).toBeTruthy());
    expect(screen.getByTestId('place-here-name').props.returnKeyType).toBe('done');
  });

  it('a saved place is offered as a choice, and nothing asks for location to use it', async () => {
    await savePlaces(USER.uid, [HOME]);
    mockLocation.foreground = { granted: true, status: 'granted' };
    mockLocation.background = { granted: true, status: 'granted' };
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment').mockResolvedValue({ data: commitment(), etag: 'W/"v2"' } as never);
    await showDetails(commitment());
    await fireEvent.press(screen.getByTestId('details-place-add'));
    await waitFor(() => expect(screen.getByTestId(`place-pick-${HOME_ID}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`place-pick-${HOME_ID}`));
    await fireEvent.press(screen.getByTestId('details-place-save'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0]![1]).toEqual({ locationTrigger: { kind: 'arrive', placeId: HOME_ID, label: 'Home' } });
    expect(mockLocation.calls).not.toContain('position');
  });

  it('refusing location says so, offers Settings, and sends nothing', async () => {
    mockLocation.grantForeground = false;
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment');
    await showDetails(commitment());
    await fireEvent.press(screen.getByTestId('details-place-add'));
    await fireEvent.press(screen.getByTestId('place-pick-here'));
    await fireEvent.changeText(screen.getByTestId('place-here-name'), 'Gym');
    await fireEvent.press(screen.getByTestId('details-place-save'));
    await waitFor(() => expect(screen.getByTestId('details-place-problem').props.children).toBe(en.placeDenied));
    await waitFor(() => expect(screen.getByTestId('place-open-settings')).toBeTruthy());
    expect(patch).not.toHaveBeenCalled();
  });

  it('shows what is set, and says "Paused" when location is not "Always"', async () => {
    await savePlaces(USER.uid, [HOME]);
    mockLocation.foreground = { granted: true, status: 'granted' };
    await showDetails(commitment({ locationTrigger: { kind: 'arrive', placeId: HOME_ID, label: 'Home' } }));
    await waitFor(() => expect(screen.getByTestId('details-place-summary').props.children).toBe('When you arrive: Home'));
    await waitFor(() => expect(screen.getByTestId('details-place-paused')).toBeTruthy());
  });

  it('is not paused with "Always"', async () => {
    await savePlaces(USER.uid, [HOME]);
    mockLocation.foreground = { granted: true, status: 'granted' };
    mockLocation.background = { granted: true, status: 'granted' };
    await showDetails(commitment({ locationTrigger: { kind: 'arrive', placeId: HOME_ID, label: 'Home' } }));
    await waitFor(() => expect(screen.getByTestId('details-place-summary')).toBeTruthy());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByTestId('details-place-paused')).toBeNull();
  });

  it('a place saved on another phone is named as such', async () => {
    await showDetails(commitment({ locationTrigger: { kind: 'leave', placeId: 'place_elsewhere', label: 'Office' } }));
    await waitFor(() => expect(screen.getByTestId('details-place-other-phone')).toBeTruthy());
  });

  it('a place removed on this phone says so, not "another phone", and offers another place', async () => {
    await savePlaces(USER.uid, [HOME]);
    await removePlace(USER.uid, HOME_ID);
    resetPlacesStoreForTests();
    mockLocation.foreground = { granted: true, status: 'granted' };
    mockLocation.background = { granted: true, status: 'granted' };
    await showDetails(commitment({ locationTrigger: { kind: 'leave', placeId: HOME_ID, label: 'Home' } }));
    await waitFor(() => expect(screen.getByTestId('details-place-gone').props.children).toBe(en.placeReminderPlaceGone));
    expect(screen.queryByTestId('details-place-other-phone')).toBeNull();
    await fireEvent.press(screen.getByTestId('details-place-repick'));
    // The same direction, a place still to choose.
    expect(screen.getByTestId('place-kind-leave').props.accessibilityState?.checked).toBe(true);
    expect(screen.getByTestId('details-place-save').props.accessibilityState?.disabled).toBe(true);
  });

  describe('what the reminder is doing on this phone', () => {
    const trigger = { kind: 'arrive' as const, placeId: HOME_ID, label: 'Home' };
    const reconcile = (commitments: Commitment[]) => reconcilePlaceReminders({
      accountId: USER.uid, commitments, places: [HOME],
      copy: { arrive: place => `Arrived: ${place}`, leave: place => `Left: ${place}` },
      quiet: null, timeZone: 'UTC',
    }, { applyRegions, isWatching: isWatchingPlaces, cancelScheduled: async () => undefined });

    beforeEach(async () => {
      await savePlaces(USER.uid, [HOME]);
      mockLocation.foreground = { granted: true, status: 'granted' };
      mockLocation.background = { granted: true, status: 'granted' };
    });

    it('past the twenty-region cap it says it is waiting for a free slot', async () => {
      const others = Array.from({ length: MAX_REGIONS }, (_, index) => commitment({ id: `other-${index}`, locationTrigger: trigger }));
      await reconcile([...others, commitment({ locationTrigger: trigger })]);
      await showDetails(commitment({ locationTrigger: trigger }));
      // Twenty-one commitments through the store: slower than the rest under load.
      await waitFor(() => expect(screen.getByTestId('details-place-waiting').props.children).toBe(en.placeReminderWaiting), { timeout: 4000 });
      expect(screen.queryByTestId('details-place-paused')).toBeNull();
    });

    it('within the cap it says nothing extra', async () => {
      await reconcile([commitment({ locationTrigger: trigger })]);
      await showDetails(commitment({ locationTrigger: trigger }));
      await waitFor(() => expect(screen.getByTestId('details-place-summary')).toBeTruthy());
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(screen.queryByTestId('details-place-waiting')).toBeNull();
      expect(screen.queryByTestId('details-place-fired')).toBeNull();
    });

    it('once it rang it says so: once only', async () => {
      await reconcile([commitment({ locationTrigger: trigger })]);
      const deps = { ...geofenceDeps, notify: async () => undefined };
      const region = { identifier: regionIdentifier(ID) };
      await handleGeofenceEvent({ data: { eventType: GEOFENCE_EXIT, region } }, deps);
      expect(await handleGeofenceEvent({ data: { eventType: GEOFENCE_ENTER, region } }, deps)).toBe('fired');
      await showDetails(commitment({ locationTrigger: trigger }));
      await waitFor(() => expect(screen.getByTestId('details-place-fired').props.children).toBe(en.placeReminderFired));
    });

    it('after a relaunch, before any reconcile, the stored state is read', async () => {
      const others = Array.from({ length: MAX_REGIONS }, (_, index) => commitment({ id: `other-${index}`, locationTrigger: trigger }));
      await reconcile([...others, commitment({ locationTrigger: trigger })]);
      resetWatchStatusForTests();
      await showDetails(commitment({ locationTrigger: trigger }));
      await waitFor(() => expect(screen.getByTestId('details-place-waiting')).toBeTruthy(), { timeout: 4000 });
    });
  });

  it('removing sends null', async () => {
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment').mockResolvedValue({ data: commitment(), etag: 'W/"v2"' } as never);
    await showDetails(commitment({ locationTrigger: { kind: 'leave', placeId: 'place_elsewhere', label: 'Office' } }));
    await fireEvent.press(screen.getByTestId('details-place-remove'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0]![1]).toEqual({ locationTrigger: null });
  });
});

describe('on the review card', () => {
  const item = {
    itemId: 'item-1', title: 'Buy bread', resolvedTime: null, priority: 'normal', needsClarification: false,
  } as unknown as CaptureProposalItem;

  it('the chosen place travels in the edit, and the confirm payload carries only the three fields', async () => {
    await savePlaces(USER.uid, [HOME]);
    mockLocation.foreground = { granted: true, status: 'granted' };
    mockLocation.background = { granted: true, status: 'granted' };
    const changes: CaptureItemEdit[] = [];
    await render(wrap(<EditProposalItemSheet item={item} edit={undefined} onChange={next => changes.push(next)} onClose={() => undefined} />));
    await fireEvent.press(screen.getByTestId('edit-item-place-add'));
    await waitFor(() => expect(screen.getByTestId(`place-pick-${HOME_ID}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`place-pick-${HOME_ID}`));
    await fireEvent.press(screen.getByTestId('edit-item-place-use'));
    await waitFor(() => expect(screen.getByTestId('edit-item-place-summary')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    expect(changes[0]?.locationTrigger).toEqual({ kind: 'arrive', placeId: HOME_ID, label: 'Home' });

    // Even a trigger that somehow carried a pin loses it on the way out.
    const leaky = { 'item-1': { locationTrigger: { ...changes[0]!.locationTrigger!, latitude: 32.08, longitude: 34.78 } as never } };
    const payload = toServerEdits(leaky, 'UTC');
    expect(payload).toEqual([{ itemId: 'item-1', locationTrigger: { kind: 'arrive', placeId: HOME_ID, label: 'Home' } }]);
    expect(JSON.stringify(payload)).not.toMatch(COORDINATE);
  });

  it('removing it is kept as a value, so it survives the merge and is not sent', async () => {
    const changes: CaptureItemEdit[] = [];
    const edit: CaptureItemEdit = { locationTrigger: { kind: 'arrive', placeId: HOME_ID, label: 'Home' } };
    await render(wrap(<EditProposalItemSheet item={item} edit={edit} onChange={next => changes.push(next)} onClose={() => undefined} />));
    await fireEvent.press(screen.getByTestId('edit-item-place-remove'));
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    expect(changes[0]?.locationTrigger).toBeNull();
    expect(toServerEdits({ 'item-1': changes[0]! }, 'UTC')).toEqual([]);
  });
});

describe('My places', () => {
  it('Home is set from where the phone is, and asks only "While Using"', async () => {
    await render(wrap(<PlacesScreen onBack={() => undefined} />));
    expect(screen.getByTestId('places-home-state').props.children).toBe(en.xNotSet);
    await fireEvent.press(screen.getByTestId('places-home-pin'));
    await waitFor(() => expect(screen.getByTestId('places-home-state').props.children).toBe(en.placeSet));
    expect(screen.getByTestId('places-home-remove').props.accessibilityLabel).toBe('Remove Home');
    expect(await loadPlaces(USER.uid)).toEqual([expect.objectContaining({ id: HOME_ID, kind: 'home', label: 'Home', latitude: 32.0853 })]);
    expect(mockLocation.calls).toEqual(['requestForeground', 'position']);
  });

  it('a named place is added and can be removed', async () => {
    mockLocation.foreground = { granted: true, status: 'granted' };
    await render(wrap(<PlacesScreen onBack={() => undefined} />));
    expect(screen.getByTestId('places-add-here').props.accessibilityState?.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('places-new-name'), 'Gym');
    await fireEvent.press(screen.getByTestId('places-add-here'));
    await waitFor(() => expect(screen.getByText('Gym')).toBeTruthy());
    const [gym] = await loadPlaces(USER.uid);
    // A screen reader hears which place each "Remove" removes.
    expect(screen.getByTestId(`places-remove-${gym!.id}`).props.accessibilityLabel).toBe('Remove Gym');
    await fireEvent.press(screen.getByTestId(`places-remove-${gym!.id}`));
    await waitFor(() => expect(screen.queryByText('Gym')).toBeNull());
    expect(await loadPlaces(USER.uid)).toEqual([]);
  });

  it('a refusal says so and offers the phone settings', async () => {
    mockLocation.grantForeground = false;
    await render(wrap(<PlacesScreen onBack={() => undefined} />));
    await fireEvent.press(screen.getByTestId('places-work-pin'));
    await waitFor(() => expect(screen.getByTestId('places-denied')).toBeTruthy());
    expect(screen.getByTestId('places-problem').props.children).toBe(en.placeDenied);
  });
});

/**
 * The static half of "no coordinate is ever sent": the only files that may
 * name a latitude are the on-device store and the place feature's native and
 * store modules — and none of them may import the networking layer.
 */
describe('where a coordinate may appear in the app', () => {
  const SRC = join(__dirname, '../../..');
  const ALLOWED = new Set([
    'lib/deviceSettings/placeReminders.ts',
    'features/places/nativeLocation.ts',
    'features/places/placesStore.ts',
    'features/places/placeReminderEngine.ts',
  ]);
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === '__tests__' || name === '__fixtures__' ? [] : files(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it('only in the files that keep pins on the phone', () => {
    const naming = files(SRC)
      .filter(path => /\b(latitude|longitude)\b/.test(readFileSync(path, 'utf8')))
      .map(path => relative(SRC, path))
      .sort();
    expect(naming.filter(path => !ALLOWED.has(path))).toEqual([]);
  });

  it('and none of those reaches the networking layer', () => {
    for (const path of ALLOWED) {
      const source = readFileSync(join(SRC, path), 'utf8');
      expect(`${path}:${/from '(\.\.\/)+api\/(client|endpoints|queries)/.test(source)}`).toBe(`${path}:false`);
    }
  });
});
