import React from 'react';
import { StyleSheet, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { IntelligencePanel } from '../../features/goals/IntelligencePanel';
import { PlanScreen } from '../../screens/PlanScreen';
import {
  NOW,
  Providers,
  TODAY,
  initialState,
  outcome,
  panelHandler,
  planEnvelope,
  planWithBasis,
  prepare,
  teardown,
  type M5bHarness,
  type RouteHandler,
} from './harness';

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

describe('M5b-2a AX5 and locale contracts', () => {
  it.each(['ar', 'en', 'he'] as const)('R1 / R2 %s keeps the learned card and plan basis wrapped and operable at AX5', async language => {
    const panel = panelHandler({ observations: [outcome('locale', 'postponed')] });
    const handler: RouteHandler = request => {
      if (request.path === `/api/mobile/plans/${TODAY}` && request.method === 'GET') {
        return { status: 200, body: planEnvelope(planWithBasis()) };
      }
      return panel(request);
    };
    harness = await prepare(language, initialState(), handler);
    await render(<Providers harness={harness}><View>
      <IntelligencePanel onChanged={() => undefined} />
      <PlanScreen date={TODAY} onBack={() => undefined} />
    </View></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-learned')).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m5b-learned'));

    unclipped('m5b-learned');
    unclipped('m5b-learned-row-locale');
    unclipped('m5b-plan-memory-basis');
    expect(screen.getByTestId('m5b-learned-wrong-locale').props.accessibilityRole).toBe('button');
    expect(screen.getByTestId('m5b-plan-memory-basis-fix').props.accessibilityRole).toBe('button');

    const rowStyle = StyleSheet.flatten(screen.getByTestId('m5b-learned-row-locale').props.style);
    const basisStyle = StyleSheet.flatten(screen.getByTestId('m5b-plan-memory-basis').props.style);
    expect(rowStyle?.flexWrap ?? 'wrap').toBe('wrap');
    expect(basisStyle?.flexWrap ?? 'wrap').toBe('wrap');
  });
});
