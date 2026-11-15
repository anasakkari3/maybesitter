/**
 * The offline banner clears the status bar (UAT 2026-09-30, u45).
 *
 * Relaunched with the network off on Android, «بدون إنترنت…» was drawn across
 * the clock: the banner is the first thing under Root on an edge-to-edge
 * display and had no top inset, while the verify-email banner under it
 * cleared the status bar a second time. The banner takes the inset while it
 * shows and tells what it wraps, so nothing below adds it again.
 */
import React, { useContext } from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { Dimensions, StyleSheet, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import ar from '../../i18n/locales/ar.json';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { OfflineBanner } from '../ui/OfflineBanner';
import { Screen, ScreenTopInsetConsumedContext } from '../../ui/screen';

// The real hook, so a fontScale set below reaches `useLayoutMode`.
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 411, height: 923 },
  insets: { top: 38, left: 0, right: 0, bottom: 24 },
};

function Probe() {
  return <Text testID="probe">{String(useContext(ScreenTopInsetConsumedContext))}</Text>;
}

async function show() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <OfflineBanner>
          <Probe />
          <Screen testID="frame"><Text>body</Text></Screen>
        </OfflineBanner>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('frame')).not.toBeNull());
}

const paddingTop = (id: string) => (StyleSheet.flatten(screen.getByTestId(id).props.style) as { paddingTop?: number }).paddingTop;

afterEach(async () => {
  await cleanup();
  onlineManager.setOnline(true);
});

describe('the offline banner and the status bar', () => {
  it('offline: the banner starts below the status bar, and the screen does not clear it again', async () => {
    onlineManager.setOnline(false);
    await show();
    expect(paddingTop('offline-banner')).toBe(38 + 10);
    expect(screen.getByTestId('probe').props.children).toBe('true');
    expect(paddingTop('frame')).toBe(0);
  });

  it('online: no banner, and the screen keeps the inset', async () => {
    onlineManager.setOnline(true);
    await show();
    expect(screen.queryByTestId('offline-banner')).toBeNull();
    expect(screen.getByTestId('probe').props.children).toBe('false');
    expect(paddingTop('frame')).toBe(38);
  });
});

/*
 * The A3 review lengthened the banner's sentence (nothing pressed is sent
 * while offline). At the largest text size it must still be read whole: the
 * card stacks, and the line wraps rather than being cut to a line count.
 */
describe('the offline banner at the largest text size', () => {
  afterEach(async () => {
    const window = { width: 411, height: 923, scale: 3, fontScale: 1 };
    Dimensions.set({ window, screen: window });
    await AsyncStorage.clear();
  });

  it('says the whole Arabic sentence, wrapped, with nothing cut', async () => {
    const window = { width: 411, height: 923, scale: 3, fontScale: 3.12 };
    Dimensions.set({ window, screen: window });
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    onlineManager.setOnline(false);
    await show();
    await waitFor(() => expect(screen.getByTestId('offline-banner-text').props.children).toBe(ar.offline));
    const line = screen.getByTestId('offline-banner-text');
    expect(line.props.numberOfLines).toBeUndefined();
    // The card stacks, so the sentence has the banner's whole width.
    type Node = { props: Record<string, unknown>; parent: Node | null };
    let stacked = false;
    for (let at: Node | null = line as unknown as Node; at; at = at.parent) {
      const style = StyleSheet.flatten(at.props.style as never) as { flexDirection?: string } | undefined;
      if (style?.flexDirection === 'column') { stacked = true; break; }
    }
    expect(stacked).toBe(true);
    // And it stays a short sentence: no longer than two clauses after «بدون إنترنت.».
    expect(ar.offline.length).toBeLessThanOrEqual(72);
  });
});
