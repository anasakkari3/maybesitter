import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { BackgroundActivityScreen } from '../WatcherScreens';
import retrying from '../../../api/__fixtures__/backgroundActivity.footballRetrying.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const MONITOR = retrying.monitors[0]!;
const NEW_ARABIC_PURPOSE = 'أشياء حسابك بتابعها إلك من جهتنا، زي مباريات فريق. تذكيرات المكان بتشتغل عالتلفون، وإيقاف المتابعة هون ما بأثّر عليها.';
const OLD_ARABIC_PURPOSE = 'شوف وتحكّم بالمتابعات المضبوطة لحسابك.';

let mockActivity = { paused: false, monitors: [MONITOR] };

jest.mock('../../../api/queries', () => ({
  useFootballSettings: () => ({ data: null, isPending: false, isFetching: false, error: null, refetch: jest.fn() }),
}));
jest.mock('../useWatchers', () => ({
  useBackgroundActivity: () => ({ data: mockActivity, isPending: false, isFetching: false, error: null, refetch: jest.fn() }),
  useBackgroundAttribution: () => ({
    data: { actions: [], orphanCount: 0 }, isPending: false, isFetching: false, error: null, refetch: jest.fn(),
  }),
  useWatcherAction: () => ({
    mutate: jest.fn(), mutateAsync: jest.fn(), reset: jest.fn(), isPending: false, error: null,
  }),
  useSetBackgroundActivityPaused: () => ({
    mutate: jest.fn(), mutateAsync: jest.fn(), reset: jest.fn(), isPending: false, error: null,
  }),
}));

beforeEach(async () => {
  mockActivity = { paused: false, monitors: [MONITOR] };
  await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

afterEach(async () => {
  await cleanup();
  jest.clearAllMocks();
  await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

async function show(language: 'ar' | 'en', paused: boolean) {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  mockActivity = { paused, monitors: [MONITOR] };
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <BackgroundActivityScreen />
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('the watch state belongs to server watches', () => {
  it.each([
    [false, '1 watch is active'],
    [true, '1 watch is followed and paused'],
  ])('uses the %s pause state in the watch-count sentence', async (paused, expected) => {
    await show('en', paused);

    await waitFor(() => expect(screen.getByTestId('background-watch-state').props.children).toBe(expected));
  });
});

describe('the page purpose', () => {
  it('names server-side account watches and keeps place reminders explicitly separate', async () => {
    await show('ar', false);

    await waitFor(() => expect(screen.queryByText(NEW_ARABIC_PURPOSE)).not.toBeNull());
    expect(screen.queryByText(OLD_ARABIC_PURPOSE)).toBeNull();
  });
});
