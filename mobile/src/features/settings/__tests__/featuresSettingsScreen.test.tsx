/**
 * Settings → Features («الميزات»): the core before the add-ons, a status in a
 * word for every reason the server gives, the person's switch (moved at once,
 * put back on a failure with the reason under the row), the month's usage as
 * a meter with words, ids this build has no copy for skipped — and the
 * Settings entry that exists only while the server's gate is not `off`.
 *
 * Copy is read from the locale files, never written here: the copy guards
 * scan test files too. RNTL v14: `render()` and `fireEvent` are awaited.
 */
import React from 'react';
import { Dimensions, Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { FeaturesSettingsScreen } from '../FeaturesSettingsScreen';
import { SettingsScreen } from '../../../screens/SettingsScreen';
import * as featuresEndpoints from '../../../api/endpoints/features';
import { NetworkError, NotFoundError, ServerError } from '../../../api/errors';
import type { FeatureCapabilities, FeatureCapability } from '../../../api/schemas/features';
import { featuresKey } from '../featureSettings';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import enforceFixture from '../../../api/__fixtures__/capabilities.features.enforce.json';
import offFixture from '../../../api/__fixtures__/capabilities.features.off.json';
import switchedFixture from '../../../api/__fixtures__/capabilities.features.switched.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = { uid: 'features-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };

const enforce = enforceFixture as FeatureCapabilities;
const off = offFixture as FeatureCapabilities;
const switched = switchedFixture as FeatureCapabilities;

function withFeature(body: FeatureCapabilities, id: string, over: Partial<FeatureCapability>): FeatureCapabilities {
  return { ...body, features: body.features.map(feature => (feature.id === id ? { ...feature, ...over } : feature)) };
}

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
});

afterEach(async () => {
  await cleanup();
  // A real macrotask: a write still settling when the tree comes down leaves
  // React work in flight, and RNTL v14's next `render` then mounts nothing.
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

function Probe() {
  const { s } = useApp();
  return <Text testID="probe-screen">{s.screen}</Text>;
}

async function show(node: React.ReactNode) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>{node}<Probe /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

async function showScreen(body: FeatureCapabilities) {
  jest.spyOn(featuresEndpoints, 'getFeatures').mockResolvedValue(body);
  await show(<FeaturesSettingsScreen onBack={() => {}} />);
  await waitFor(() => expect(screen.queryByTestId('feature-assistant')).not.toBeNull());
}

const statusOf = (id: string) => screen.getByTestId(`feature-${id}-status`).props.children;

describe('the list', () => {
  it('puts the core first, always on and with no switch, then the add-ons', async () => {
    await showScreen(enforce);
    expect(screen.getByTestId('features-core-label').props.children).toBe(en.featuresCoreSection);
    expect(screen.getByTestId('features-addon-label').props.children).toBe(en.featuresAddonSection);
    expect(screen.getByTestId('feature-assistant-name').props.children).toBe(en.featureAssistantName);
    expect(statusOf('assistant')).toBe(en.featuresStatusAlwaysOn);
    expect(screen.queryByTestId('feature-assistant-switch')).toBeNull();
    // The core card holds the assistant and nothing else.
    const core = screen.getByTestId('features-core');
    expect(core).toContainElement(screen.getByTestId('feature-assistant'));
    expect(core).not.toContainElement(screen.getByTestId('feature-football'));
    for (const id of ['gmail_reading', 'meeting_prep', 'goal_plans', 'memory_learning', 'memory_translation', 'search_history', 'football']) {
      expect(screen.getByTestId('features-addons')).toContainElement(screen.getByTestId(`feature-${id}`));
      expect(screen.getByTestId(`feature-${id}-switch`)).toBeTruthy();
    }
  });

  it('skips an id this build has no words for, and keeps the rest', async () => {
    await showScreen({
      ...enforce,
      features: [...enforce.features, { id: 'time_travel', tier: 'addon', enabled: true, reason: 'free_allowance', userCanDisable: true, usedPercent: 10 }],
    });
    expect(screen.queryByTestId('feature-time_travel')).toBeNull();
    expect(screen.getByTestId('feature-football')).toBeTruthy();
  });

  it('reads in Arabic when the app is in Arabic', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await showScreen(enforce);
    await waitFor(() => expect(screen.getByTestId('feature-football-name').props.children).toBe(ar.featureFootballName));
    expect(screen.getByTestId('feature-football-body').props.children).toBe(ar.featureFootballBody);
  });
});

describe('the status in a word', () => {
  const cases: [string, Partial<FeatureCapability>, keyof typeof en][] = [
    ['usable on the free allowance', { enabled: true, reason: 'free_allowance' }, 'featuresStatusOn'],
    ['usable on a subscription', { enabled: true, reason: 'entitled' }, 'featuresStatusOn'],
    ['not bought', { enabled: false, reason: 'not_entitled' }, 'featuresStatusNeedsSubscription'],
    ['the add-on spent its month', { enabled: false, reason: 'budget_spent' }, 'featuresStatusAllowanceUsed'],
    ['the free month spent', { enabled: false, reason: 'free_cap_spent' }, 'featuresStatusAllowanceUsed'],
    ['switched off by the person', { enabled: false, reason: 'user_off' }, 'featuresStatusOff'],
    ['the gate could not read its state', { enabled: false, reason: 'gate_unavailable' }, 'featuresStatusUnavailable'],
    ['a reason this build does not know, refused', { enabled: false, reason: 'solar_flare' }, 'featuresStatusUnavailable'],
    ['a reason this build does not know, usable', { enabled: true, reason: 'solar_flare' }, 'featuresStatusOn'],
  ];

  it.each(cases)('%s', async (_name, over, key) => {
    await showScreen(withFeature(enforce, 'gmail_reading', over));
    expect(statusOf('gmail_reading')).toBe(en[key]);
  });

  it('keeps the switch on for an add-on the person wants but cannot use yet, and says why', async () => {
    await showScreen(withFeature(enforce, 'memory_translation', { enabled: false, reason: 'not_entitled' }));
    const toggle = screen.getByTestId('feature-memory_translation-switch');
    expect(toggle.props.value).toBe(true);
    expect(toggle.props.accessibilityHint).toBe(en.featuresStatusNeedsSubscription);
    expect(toggle.props.accessibilityLabel).toBe(en.featureMemoryTranslationName);
  });

  it('shows the switch off only when the person turned it off', async () => {
    await showScreen(switched);
    expect(screen.getByTestId('feature-football-switch').props.value).toBe(false);
    expect(screen.getByTestId('feature-gmail_reading-switch').props.value).toBe(true);
  });
});

describe('the usage meter', () => {
  it('says how much of the month is used, with the number isolated, and nothing when there is no allowance', async () => {
    await showScreen(withFeature(enforce, 'gmail_reading', { usedPercent: 40 }));
    const meter = screen.getByTestId('feature-gmail_reading-usage');
    expect(meter.props.accessibilityRole).toBe('progressbar');
    expect(meter.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 40 });
    const text = screen.getByTestId('feature-gmail_reading-usage-text').props.children as string;
    expect(text).toBe(en.featuresUsage.replace('{percent}', '⁦40%⁩'));
    expect(meter.props.accessibilityLabel).toBe(text);
    // `usedPercent: null` (football spends nothing): no meter at all.
    expect(screen.queryByTestId('feature-football-usage')).toBeNull();
  });

  it('isolates the Latin digits inside the Arabic sentence', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await showScreen(withFeature(enforce, 'gmail_reading', { usedPercent: 40 }));
    await waitFor(() => expect(screen.getByTestId('feature-gmail_reading-usage-text').props.children)
      .toBe(ar.featuresUsage.replace('{percent}', '⁦40%⁩')));
  });
});

describe('the switch', () => {
  it('moves at once, sends one write, and takes the server answer into the cache', async () => {
    let answer!: (body: FeatureCapabilities) => void;
    const put = jest.spyOn(featuresEndpoints, 'setFeatureEnabled')
      .mockImplementation(() => new Promise<FeatureCapabilities>(resolve => { answer = resolve; }));
    await showScreen(enforce);
    await fireEvent(screen.getByTestId('feature-football-switch'), 'valueChange', false);
    // Optimistic: off before the server answered, and busy so a second tap sends nothing.
    expect(screen.getByTestId('feature-football-switch').props.value).toBe(false);
    expect(screen.getByTestId('feature-football-busy')).toBeTruthy();
    await fireEvent(screen.getByTestId('feature-football-switch'), 'valueChange', true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('football', false, { asUid: USER.uid });

    answer(switched);
    await waitFor(() => expect(statusOf('football')).toBe(en.featuresStatusOff));
    expect(screen.getByTestId('feature-football-switch').props.value).toBe(false);
    expect(screen.queryByTestId('feature-football-busy')).toBeNull();
    expect(client.getQueryData(featuresKey(USER.uid))).toEqual(switched);
  });

  it('goes back where it was when the write fails, and says why under the row', async () => {
    jest.spyOn(featuresEndpoints, 'setFeatureEnabled').mockRejectedValue(new NetworkError('offline'));
    await showScreen(enforce);
    await fireEvent(screen.getByTestId('feature-football-switch'), 'valueChange', false);
    await waitFor(() => expect(screen.queryByTestId('feature-football-failed')).not.toBeNull());
    expect(screen.getByTestId('feature-football-failed').props.children).toBe(en.trustActionFailed);
    expect(screen.getByTestId('feature-football-switch').props.value).toBe(true);
    expect(statusOf('football')).toBe(en.featuresStatusOn);
  });

  it('says a server fault in the server-fault words, not the network ones', async () => {
    jest.spyOn(featuresEndpoints, 'setFeatureEnabled').mockRejectedValue(new ServerError('boom', 500));
    await showScreen(enforce);
    await fireEvent(screen.getByTestId('feature-goal_plans-switch'), 'valueChange', false);
    await waitFor(() => expect(screen.queryByTestId('feature-goal_plans-failed')).not.toBeNull());
    expect(screen.getByTestId('feature-goal_plans-failed').props.children).toBe(en.toggleServerFailed);
    expect(screen.getByTestId('feature-goal_plans-switch').props.value).toBe(true);
  });
});

describe('loading and failing', () => {
  it('says the list could not be read, in userFacingMessage words, and offers a retry', async () => {
    const get = jest.spyOn(featuresEndpoints, 'getFeatures').mockRejectedValue(new NetworkError('offline'));
    await show(<FeaturesSettingsScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('features-error')).not.toBeNull());
    expect(screen.getByText(en.errorsNetwork)).toBeTruthy();
    get.mockResolvedValue(enforce);
    await fireEvent.press(screen.getByText(en.errorsRetry));
    await waitFor(() => expect(screen.queryByTestId('feature-assistant')).not.toBeNull());
  });
});

describe('at an ordinary text size', () => {
  it('sets the switch beside the words rather than under them', async () => {
    setFontScale(1);
    try {
      await showScreen(enforce);
      expect(screen.getByTestId('feature-football-switch')).toBeTruthy();
      expect(statusOf('football')).toBe(en.featuresStatusOn);
    } finally {
      setFontScale(2);
    }
  });
});

describe('the Settings entry', () => {
  async function showHub() {
    await show(<SettingsScreen />);
    await waitFor(() => expect(screen.queryByTestId('settings-account-card')).not.toBeNull());
  }

  it('is absent while the gate is off, and Settings looks as before', async () => {
    const get = jest.spyOn(featuresEndpoints, 'getFeatures').mockResolvedValue(off);
    await showHub();
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(client.getQueryData(featuresKey(USER.uid))).toEqual(off));
    expect(screen.queryByTestId('settings-features')).toBeNull();
  });

  it('is absent for a server that predates the route', async () => {
    jest.spyOn(featuresEndpoints, 'getFeatures').mockRejectedValue(new NotFoundError('no route'));
    await showHub();
    await waitFor(() => expect(client.getQueryData(featuresKey(USER.uid))).toEqual({ success: true, mode: 'off', features: [] }));
    expect(screen.queryByTestId('settings-features')).toBeNull();
  });

  it('is absent while the answer is unknown (failed)', async () => {
    jest.spyOn(featuresEndpoints, 'getFeatures').mockRejectedValue(new NetworkError('offline'));
    await showHub();
    await waitFor(() => expect(client.getQueryState(featuresKey(USER.uid))?.status).toBe('error'));
    expect(screen.queryByTestId('settings-features')).toBeNull();
  });

  it.each([['enforce', enforce], ['shadow', { ...enforce, mode: 'shadow' as const }]])(
    'is there in %s mode and opens the Features screen',
    async (_mode, body) => {
      jest.spyOn(featuresEndpoints, 'getFeatures').mockResolvedValue(body);
      await showHub();
      await waitFor(() => expect(screen.queryByTestId('settings-features')).not.toBeNull());
      expect(screen.getByTestId('settings-features').props.children).toBe(en.featuresTitle);
      expect(screen.getByText(en.featuresHubSub)).toBeTruthy();
      await fireEvent.press(screen.getByTestId('settings-features'));
      expect(screen.getByTestId('probe-screen').props.children).toBe('featuresSettings');
    },
  );
});
