/**
 * «استعمل بيانات الصحة» on the energy screen, against a fake HealthKit module.
 *
 * The native module is the only fake here: the adapter, the snapshot builder,
 * `apiRequest` and the shipped schema are the real ones, and the server's
 * answer is the fixture recorded from `POST /api/mobile/readiness`. So the PUT…
 * the POST body asserted below is the one the route actually accepts.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { HealthKitReadinessNativeModule } from '../../../../modules/healthkit-readiness';
import { HealthDataCard } from '../HealthDataCard';
import { HEALTH_REFRESH_MIN_INTERVAL_MS } from '../useHealthReadiness';
import { HEALTH_CONNECTION_KEY_PREFIX } from '../../../lib/deviceSettings/healthConnection';
import healthSaved from '../../../api/__fixtures__/readiness.healthSaved.json';
import fromHealth from '../../../api/__fixtures__/readiness.fromHealth.json';
import en from '../../../i18n/locales/en.json';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const UID = 'health-user';
const user = { uid: UID, email: null, emailVerified: true, displayName: null, providerIds: ['password'] };
const NOW = new Date('2026-09-25T08:00:00.000Z');
let clockMs = NOW.getTime();
const clock = () => new Date(clockMs);

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let posts: Record<string, unknown>[];
let requested: number;

type Native = HealthKitReadinessNativeModule & { reads: number; cleared: number };

function fakeHealthKit(overrides: Partial<HealthKitReadinessNativeModule> = {}): Native {
  const native: Native = {
    reads: 0,
    cleared: 0,
    isAvailable: async () => true,
    authorization: async () => ({ state: requested > 0 ? 'limited' : 'not_determined', granted: [], denied: [], checkedAt: NOW.toISOString() }),
    requestAuthorization: async () => {
      requested += 1;
      return { state: 'limited', granted: [], denied: [], checkedAt: NOW.toISOString() };
    },
    readSamples: async () => {
      native.reads += 1;
      return {
        sleep: { observedAt: '2026-09-25T05:30:00.000Z', sleepStart: '2026-09-24T22:00:00.000Z', sleepEnd: '2026-09-25T05:30:00.000Z', totalSleepMinutes: 420 },
        heart: { observedAt: '2026-09-25T06:00:00.000Z', restingHeartRate: 57, hrvMilliseconds: 48 },
        activity: { observedAt: '2026-09-25T07:55:00.000Z', stepCount: 1800 },
      };
    },
    clearLocalConnection: async () => {
      native.cleared += 1;
    },
    ...overrides,
  };
  return native;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  clockMs = NOW.getTime();
  // `gcTime: Infinity` schedules no garbage-collection timer, so a finished
  // mutation does not hold the Jest process open for its five-minute default.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  repository = createFakeAuthRepository({ initialUser: user });
  setAuthRepository(repository);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  posts = [];
  requested = 0;
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(healthSaved) };
    }
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(fromHealth) };
  }) as never;
});

afterEach(async () => {
  await cleanup();
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show(nativeModule: HealthKitReadinessNativeModule | null, platform = 'ios') {
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <HealthDataCard nativeModule={nativeModule} platform={platform} now={clock} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('Health → energy', () => {
  it('asks for Health only on the press, then sends the summary the route accepts', async () => {
    const native = fakeHealthKit();
    await show(native);
    await waitFor(() => expect(screen.getByTestId('health-connect')).toBeTruthy());
    // Mounting the screen did not raise the Health sheet.
    expect(requested).toBe(0);

    await fireEvent.press(screen.getByTestId('health-connect'));

    await waitFor(() => expect(screen.getByTestId('health-status-connected')).toBeTruthy());
    expect(requested).toBe(1);
    expect(posts).toHaveLength(1);
    const snapshot = posts[0]!.snapshot as Record<string, unknown>;
    // The body shape `POST /api/mobile/readiness` validates: a readiness-v1
    // snapshot from a native source only, never raw samples.
    expect(Object.keys(posts[0]!)).toEqual(['snapshot']);
    expect(snapshot.version).toBe('v1');
    expect(snapshot.schemaVersion).toBe('readiness-v1');
    expect(snapshot.sourceKinds).toEqual(['healthkit']);
    expect(snapshot.computedAt).toBe(NOW.toISOString());
    expect(snapshot.windowEnd).toBe(NOW.toISOString());
    expect(snapshot.windowStart).toBe('2026-09-24T08:00:00.000Z');
    expect((snapshot.derived as { readinessBand: string }).readinessBand).toBe(snapshot.band);
    expect(JSON.stringify(posts[0])).not.toMatch(/"sleepSamples"|"samples"/);
    // Remembered for this account on this phone.
    expect(await AsyncStorage.getItem(`${HEALTH_CONNECTION_KEY_PREFIX}${UID}`)).toContain('"connected":true');
    expect(screen.getByTestId('health-disconnect')).toBeTruthy();
  });

  it('shows "no data" with the way to Health when a read comes back empty (how iOS reports a refusal)', async () => {
    const native = fakeHealthKit({ readSamples: async () => ({}) });
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    await show(native);
    await waitFor(() => expect(screen.getByTestId('health-connect')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('health-connect'));

    await waitFor(() => expect(screen.getByTestId('health-status-noData')).toBeTruthy());
    expect(screen.getByText(en.readinessHealthNoData)).toBeTruthy();
    expect(posts).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('health-open'));
    expect(open).toHaveBeenCalledWith('x-apple-health://');
  });

  it('says denied, and offers Health, when the permission request itself is refused', async () => {
    const native = fakeHealthKit({
      requestAuthorization: async () => ({ state: 'denied', granted: [], denied: [], checkedAt: NOW.toISOString() }),
    });
    await show(native);
    await waitFor(() => expect(screen.getByTestId('health-connect')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('health-connect'));
    await waitFor(() => expect(screen.getByTestId('health-status-denied')).toBeTruthy());
    expect(screen.getByTestId('health-open')).toBeTruthy();
    expect(posts).toHaveLength(0);
    expect(await AsyncStorage.getItem(`${HEALTH_CONNECTION_KEY_PREFIX}${UID}`)).toBeNull();
  });

  it('says Health is unavailable on a device without it (iPad, or a build without the module), with no button', async () => {
    await show(fakeHealthKit({ isAvailable: async () => false }));
    await waitFor(() => expect(screen.getByTestId('health-status-unavailable')).toBeTruthy());
    expect(screen.queryByTestId('health-connect')).toBeNull();
  });

  it('says Health is unavailable in a build without the native module', async () => {
    await show(null);
    await waitFor(() => expect(screen.getByTestId('health-status-unavailable')).toBeTruthy());
    expect(screen.queryByTestId('health-connect')).toBeNull();
  });

  it('is not shown on Android', async () => {
    await show(fakeHealthKit(), 'android');
    expect(screen.queryByTestId('health-card')).toBeNull();
  });

  it('disconnect clears the native connection and the remembered one', async () => {
    const native = fakeHealthKit();
    await show(native);
    await waitFor(() => expect(screen.getByTestId('health-connect')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('health-connect'));
    await waitFor(() => expect(screen.getByTestId('health-disconnect')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('health-disconnect'));

    await waitFor(() => expect(screen.getByTestId('health-connect')).toBeTruthy());
    expect(native.cleared).toBe(1);
    expect(await AsyncStorage.getItem(`${HEALTH_CONNECTION_KEY_PREFIX}${UID}`)).toBeNull();
  });

  it('refreshes on return to the foreground, at most once per interval', async () => {
    const listeners: ((state: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, listener: (state: string) => void) => {
      listeners.push(listener);
      return { remove: () => undefined };
    }) as never);
    const native = fakeHealthKit();
    await show(native);
    await waitFor(() => expect(screen.getByTestId('health-connect')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('health-connect'));
    await waitFor(() => expect(posts).toHaveLength(1));
    const foreground = async () => {
      await act(async () => {
        for (const listener of listeners) listener('active');
      });
    };

    // Too soon: nothing is read.
    clockMs += HEALTH_REFRESH_MIN_INTERVAL_MS - 60_000;
    await foreground();
    expect(native.reads).toBe(1);

    clockMs += 60_000;
    await foreground();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(native.reads).toBe(2);
  });

  it('a phone that connected before reads again on open when the last read is due, without asking', async () => {
    await AsyncStorage.setItem(
      `${HEALTH_CONNECTION_KEY_PREFIX}${UID}`,
      JSON.stringify({ connected: true, lastAttemptAt: new Date(NOW.getTime() - HEALTH_REFRESH_MIN_INTERVAL_MS).toISOString() }),
    );
    requested = 1;
    const native = fakeHealthKit();
    await show(native);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(requested).toBe(1);
    await waitFor(() => expect(screen.getByTestId('health-status-connected')).toBeTruthy());
  });
});
