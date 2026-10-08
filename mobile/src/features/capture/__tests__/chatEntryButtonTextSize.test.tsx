/**
 * «ضيف هدف» at large text (M3b, simulator AX5): beside its arrow the button
 * was squeezed to «..». From the large layout on, it takes its own line and
 * the arrow sits under it.
 */
import React from 'react';
import { afterEach, expect, it, jest } from '@jest/globals';
import { cleanup, render, screen, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { ChatEntryButton } from '../ChatEntryButton';
import { LAYOUT_MODE_FROM } from '../../../theme/textScale';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const useWindowDimensions = require('react-native/Libraries/Utilities/useWindowDimensions').default as jest.Mock;
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
afterEach(async () => { await cleanup(); });

it.each([
  [1, true],
  [LAYOUT_MODE_FROM.large, false],
  [3.1, false],
])('at font scale %s the button sits beside its arrow: %s', async (fontScale, beside) => {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <ChatEntryButton entry="goal" testID="goals-add" />
      </AppProvider>
    </SafeAreaProvider>,
  );
  const row = screen.getByTestId('goals-add-disclosure');
  expect(within(row).queryByTestId('goals-add') !== null).toBe(beside);
  // Either way the arrow is there, and the button is one control.
  expect(screen.getByTestId('goals-add-why')).toBeTruthy();
  expect(screen.getAllByTestId('goals-add')).toHaveLength(1);
});
