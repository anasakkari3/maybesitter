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
import { Text } from 'react-native';
import { afterEach, describe, expect, it } from '@jest/globals';
import { cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { OfflineBanner } from '../ui/OfflineBanner';
import { Screen, ScreenTopInsetConsumedContext } from '../../ui/screen';

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
