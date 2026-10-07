/**
 * The «عدّل» sheet at large text (M2b, simulator AX5): side by side, the day
 * and the hour broke «9 أغسطس» inside the month's name and the save broke
 * «احفظ التعديل» inside its word; from the large layout on, each pair stacks.
 */
import React from 'react';
import { afterEach, expect, it, jest } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { cleanup, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { SummaryEditSheet } from '../SummaryEditSheet';
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

/** The direction of the row that holds `testID`. */
function rowOf(testID: string): string | undefined {
  let node = screen.getByTestId(testID).parent;
  while (node && StyleSheet.flatten(node.props.style)?.flexDirection === undefined) node = node.parent;
  return StyleSheet.flatten(node?.props.style)?.flexDirection as string | undefined;
}

it.each([
  [1, 'row'],
  [LAYOUT_MODE_FROM.large, 'column'],
  [3.1, 'column'],
])('at font scale %s the day/hour and save/cancel pairs lay out as %s', async (fontScale, direction) => {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <SummaryEditSheet kind="commitment" text="Call Dana" at="2099-08-09T09:00:00.000Z" onSave={jest.fn()} onCancel={jest.fn()} />
      </AppProvider>
    </SafeAreaProvider>,
  );
  expect(rowOf('understood-edit-time-date')).toBe(direction);
  expect(rowOf('understood-edit-save')).toBe(direction);
});
