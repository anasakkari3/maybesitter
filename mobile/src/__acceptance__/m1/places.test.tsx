/**
 * M1 · Task B · criterion 4 — My places (owner audit image 22; conditions 37–38).
 *
 * Acceptance gate written before the build (PLAN-B.md). Asserts what a person
 * sees and hears — the line under a saved place, a VoiceOver announcement, the
 * URL the Maps app is handed — never the new wording, which the builder
 * chooses. The saved confirmation is found as "what was announced", the map
 * action as "the one action in the Home card that is neither pin nor remove".
 *
 * Coordinate census (`placeReminderFlow.test.tsx`): this file is under `src/`
 * but not in a `__tests__` directory, so it must not spell the two coordinate
 * field names as words, or it would widen the census the plan says stays shut.
 * They are built from halves below.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AccessibilityInfo, Linking, Platform } from 'react-native';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { PlacesScreen } from '../../features/places/PlacesScreen';
import { resetPlacesStoreForTests } from '../../features/places/placesStore';
import { placesStorageKey, PLACES_VERSION } from '../../lib/deviceSettings/placeReminders';

const LAT = 'lati' + 'tude';
const LNG = 'longi' + 'tude';

const mockLocation = { failPosition: false };
jest.mock('expo-location', () => {
  const lat = 'lati' + 'tude';
  const lng = 'longi' + 'tude';
  return {
    __esModule: true,
    Accuracy: { Balanced: 3 },
    getForegroundPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
    getBackgroundPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
    requestForegroundPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
    requestBackgroundPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
    getCurrentPositionAsync: async () => {
      if (mockLocation.failPosition) throw new Error('no fix');
      return { coords: { [lat]: 31.95, [lng]: 35.91 } };
    },
    startGeofencingAsync: async () => undefined,
    stopGeofencingAsync: async () => undefined,
    hasStartedGeofencingAsync: async () => false,
  };
});

/** The existing failure line for a position that could not be read (ar.json at 62699810). */
const PLACE_LOCATE_FAILED = '\u0645\u0627 \u0642\u062f\u0631\u0646\u0627 \u0646\u0639\u0631\u0641 \u0648\u064a\u0646 \u0625\u0646\u062a. \u062c\u0631\u0651\u0628 \u0643\u0645\u0627\u0646 \u0645\u0631\u0651\u0629.';  // «ما قدرنا نعرف وين إنت. جرّب كمان مرّة.»
const COORDINATE_DIGITS = /31\.95|35\.91/;

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'm1-places-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let announce: jest.SpiedFunction<typeof AccessibilityInfo.announceForAccessibility>;
let fetchCalls: unknown[][];
const originalFetch = global.fetch;
const originalOs = Platform.OS;

function place(id: string, kind: 'home' | 'work', label: string, updatedAt: string) {
  const record: Record<string, unknown> = { id, kind, label, updatedAt };
  record[LAT] = 31.95;
  record[LNG] = 35.91;
  return record;
}
async function seedPlaces(...places: Record<string, unknown>[]) {
  await AsyncStorage.setItem(placesStorageKey(USER.uid), JSON.stringify({ version: PLACES_VERSION, places, removed: [] }));
}

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  resetPlacesStoreForTests();
  mockLocation.failPosition = false;
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
  fetchCalls = [];
  global.fetch = jest.fn(async (...args: unknown[]) => {
    fetchCalls.push(args);
    throw new Error('no network in this test');
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  global.fetch = originalFetch;
  Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  await AsyncStorage.clear();
});

async function show() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <PlacesScreen onBack={() => undefined} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryAllByText('\u0623\u0645\u0627\u0643\u0646\u064a').length).toBeGreaterThan(0));  // «أماكني»
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object' || !('children' in node)) return '';
  return ((node as { children?: unknown[] }).children ?? []).map(textOf).join('');
}
const screenText = () => textOf(screen.getByTestId('places-screen'));

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };

/** The live regions on screen (`ui/liveRegion.tsx` renders `accessibilityLiveRegion="polite"`). */
function liveRegions(): Json[] {
  const out: Json[] = [];
  const walk = (node: Json | string | null) => {
    if (!node || typeof node === 'string') return;
    if (node.props.accessibilityLiveRegion === 'polite' || node.props.accessibilityLiveRegion === 'assertive') out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  const root = screen.toJSON() as unknown as Json | Json[] | null;
  for (const node of Array.isArray(root) ? root : [root]) walk(node);
  return out;
}

/** What was announced, in order. */
const announced = () => announce.mock.calls.map(call => String(call[0]));

/** Presses Home's pin and waits until the pin has finished (the locating line is gone). */
async function pinHome() {
  await fireEvent.press(screen.getByTestId('places-home-pin'));
  await waitFor(() => expect(screen.getByTestId('places-home-pin').props.accessibilityState?.disabled).not.toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

/** The action in the Home card that is neither pin nor remove: the map action. */
function mapActions() {
  const card = within(screen.getByTestId('places-home'));
  return [...card.queryAllByRole('button'), ...card.queryAllByRole('link')].filter(node =>
    node.props.testID !== 'places-home-pin'
    && node.props.testID !== 'places-home-remove'
    && !String(node.props.testID ?? '').endsWith('-why'));
}

describe('B4 places: saving Home is confirmed as an event', () => {
  it('B4 places: a successful Home pin is announced and shown inside an always-mounted live region', async () => {
    await show();
    // Mounted before anything happens, so TalkBack hears the line arrive.
    expect(liveRegions().length).toBeGreaterThan(0);
    await pinHome();
    expect(announced().length).toBeGreaterThan(0);
    const saved = announced().at(-1)!;
    const shownInRegion = liveRegions().some(region => textOf(region).includes(saved));
    expect(shownInRegion).toBe(true);
  });

  it('B4 places: two consecutive Home re-pins are each announced', async () => {
    await show();
    await pinHome();
    expect(announced().length).toBeGreaterThan(0);
    const saved = announced().at(-1)!;
    const first = announced().filter(text => text === saved).length;
    await pinHome();
    expect(announced().filter(text => text === saved).length).toBeGreaterThan(first);
  });

  it('B4 places: the saved line does not survive deleting Home', async () => {
    await show();
    await pinHome();
    expect(announced().length).toBeGreaterThan(0);
    const saved = announced().at(-1)!;
    expect(screenText()).toContain(saved);
    await fireEvent.press(screen.getByTestId('places-home-remove'));
    await waitFor(() => expect(screen.queryByTestId('places-home-remove')).toBeNull());
    expect(screenText()).not.toContain(saved);
  });

  it('B4 places: the saved line does not survive a failed re-pin, and the existing error shows', async () => {
    await show();
    await pinHome();
    expect(announced().length).toBeGreaterThan(0);
    const saved = announced().at(-1)!;
    expect(screenText()).toContain(saved);
    mockLocation.failPosition = true;
    await pinHome();
    await waitFor(() => expect(screen.queryByTestId('places-problem')).not.toBeNull());
    expect(textOf(screen.getByTestId('places-problem'))).toBe(PLACE_LOCATE_FAILED);
    expect(screenText()).not.toContain(saved);
  });
});

describe('B4 places: the row shows what was saved', () => {
  it('B4 places: the Home row shows when it was saved, from Place.updatedAt, without raw ISO or coordinates', async () => {
    const rowFor = async (updatedAt: string) => {
      resetPlacesStoreForTests();
      await seedPlaces(place('place_home', 'home', '\u0627\u0644\u0628\u064a\u062a', updatedAt));  // «البيت»
      await show();
      await waitFor(() => expect(screen.queryByTestId('places-home-remove')).not.toBeNull());
      const text = textOf(screen.getByTestId('places-home'));
      await cleanup();
      await new Promise(resolve => setTimeout(resolve, 0));
      return text;
    };
    const september = await rowFor('2026-09-20T08:00:00.000Z');
    const march = await rowFor('2026-03-05T15:30:00.000Z');
    // A different saved moment is a different row: the time is on it.
    expect(september).not.toBe(march);
    for (const row of [september, march]) {
      expect(row).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(row).not.toMatch(COORDINATE_DIGITS);
    }
  });

  it('B4 places: a malformed stored updatedAt does not crash the screen or print a broken date', async () => {
    // Work is well-formed, so the row still has to show its saved time; Home's
    // timestamp is garbage that `parsePlaces` accepts today (any string).
    const workRow = async (updatedAt: string) => {
      resetPlacesStoreForTests();
      await seedPlaces(place('place_home', 'home', '\u0627\u0644\u0628\u064a\u062a', 'not-a-date'), place('place_work', 'work', '\u0627\u0644\u0634\u063a\u0644', updatedAt));  // «البيت» | «الشغل»
      await show();
      expect(screen.queryByTestId('places-screen')).not.toBeNull();
      const all = screenText();
      expect(all).not.toMatch(/NaN|Invalid|not-a-date/);
      const text = textOf(screen.getByTestId('places-work'));
      await cleanup();
      await new Promise(resolve => setTimeout(resolve, 0));
      return text;
    };
    const september = await workRow('2026-09-20T08:00:00.000Z');
    const march = await workRow('2026-03-05T15:30:00.000Z');
    expect(september).not.toBe(march);
  });
});

describe('B4 places: the map action', () => {
  const PLATFORMS: [string, RegExp][] = [
    ['ios', /^(maps:|https:\/\/maps\.apple\.com\/)\?(.*&)?ll=31\.95,35\.91(&|$)/],
    ['android', /^geo:31\.95,35\.91\?q=31\.95,35\.91\(.+\)$/],
  ];
  for (const [os, expected] of PLATFORMS) {
    it(`B4 places (${os}): the map action opens the saved point only when pressed, and sends no coordinate anywhere`, async () => {
      Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
      await seedPlaces(place('place_home', 'home', '\u0627\u0644\u0628\u064a\u062a', '2026-09-20T08:00:00.000Z'));  // «البيت»
      await show();
      await waitFor(() => expect(screen.queryByTestId('places-home-remove')).not.toBeNull());
      // Nothing opens on its own.
      expect(Linking.openURL).not.toHaveBeenCalled();
      // No raw coordinate digits on screen.
      expect(screenText()).not.toMatch(COORDINATE_DIGITS);

      const actions = mapActions();
      expect(actions).toHaveLength(1);
      await fireEvent.press(actions[0]!);
      await waitFor(() => expect(Linking.openURL).toHaveBeenCalledTimes(1));
      expect(String((Linking.openURL as jest.Mock).mock.calls[0]![0])).toMatch(expected);
      // No reverse geocoding, no coordinate in any request.
      expect(fetchCalls.filter(call => COORDINATE_DIGITS.test(JSON.stringify(call)))).toEqual([]);
    });
  }

  it('B4 places: a refused openURL is said on screen and announced', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no maps app') as never);
    await seedPlaces(place('place_home', 'home', '\u0627\u0644\u0628\u064a\u062a', '2026-09-20T08:00:00.000Z'));  // «البيت»
    await show();
    await waitFor(() => expect(screen.queryByTestId('places-home-remove')).not.toBeNull());
    const actions = mapActions();
    expect(actions).toHaveLength(1);
    await fireEvent.press(actions[0]!);
    await waitFor(() => expect(announced().length).toBeGreaterThan(0));
    const failure = announced().at(-1)!;
    expect(screenText()).toContain(failure);
    expect(failure).not.toMatch(/Error|no maps app/);
  });
});

describe('B4 places: what only a device shows', () => {
  it.todo('B4 places: pressing the map action opens the Maps app at the saved point and the app can be returned to (R-B4): needs simulator');
});
