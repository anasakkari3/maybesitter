import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import {
  NOW,
  Providers,
  TODAY,
  initialState,
  prepare,
  readySummary,
  teardown,
  type M5bHarness,
} from './harness';
import { KnowsScreen } from '../../features/settings/KnowsScreen';
import { PlanScreen } from '../../screens/PlanScreen';
import { ReadinessSettingsScreen } from '../../features/settings/ReadinessSettingsScreen';
import { TodayScreen } from '../../screens/TodayScreen';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 3.12 })),
}));

let harness: M5bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

function unclipped(testID: string): void {
  const node = screen.getByTestId(testID);
  expect(node.props.numberOfLines).not.toBe(1);
  expect(node.props.ellipsizeMode).toBeUndefined();
}

describe('M5b ar/en/he AX5 layout contracts', () => {
  it.each(['ar', 'en', 'he'] as const)('R1.2 / R4.2 / R4.3 %s keeps new rows present, wrapped, and operable at AX5', async language => {
    harness = await prepare(language, initialState({ summary: readySummary(language) }));
    await render(
      <Providers harness={harness}>
        <KnowsScreen onBack={() => {}} onMemory={() => {}} />
        <PlanScreen date={TODAY} onBack={() => {}} />
        <ReadinessSettingsScreen onBack={() => {}} />
        <TodayScreen />
      </Providers>,
    );
    await waitFor(() => expect(screen.queryByTestId('memory-summary-disclosure')).not.toBeNull());

    for (const testID of [
      'memory-summary', 'memory-summary-disclosure', 'm5b-plan-energy-effect',
      'm5b-readiness-effect', 'm5b-today-energy',
    ]) unclipped(testID);
    expect(screen.getByTestId('m5b-plan-energy-change').props.accessibilityRole).toBe('button');
    expect(screen.getByTestId('m5b-today-energy-change').props.accessibilityRole).toBe('button');
  });

  it.each(['ar', 'he'] as const)('R1.2 %s memory row actions wrap rather than clipping at AX5', async language => {
    harness = await prepare(language, initialState({ summary: { status: 'unavailable' } }));
    await render(<Providers harness={harness}><KnowsScreen onBack={() => {}} onMemory={() => {}} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-memory-row-actions-memory-1')).not.toBeNull());

    expect(screen.getByTestId('m5b-memory-row-actions-memory-1').props.style).toEqual(
      expect.objectContaining({ flexWrap: 'wrap' }),
    );
    expect(screen.queryByTestId('memory-edit-memory-1')).not.toBeNull();
    expect(screen.queryByTestId('memory-delete-memory-1')).not.toBeNull();
  });
});
