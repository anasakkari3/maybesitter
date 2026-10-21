import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { CommitmentsScreen } from '../../features/product/ContextScreens';
import { ThingsScreen } from '../../features/things/ThingsScreen';
import { CalendarScreen } from '../../screens/CalendarScreen';
import { TodayScreen } from '../../screens/TodayScreen';
import {
  NOW,
  Providers,
  denseCommitments,
  prepareM6,
  searchRequests,
  teardown,
  type Language,
  type M6Harness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M6Harness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

function expectUserTextUnclamped(): void {
  const userText = screen.queryAllByTestId(/^m6-(user-text|calendar-title)-/) /* GA-M6-AMEND-3: the calendar's titles carry the gate's own m6-calendar-title id */;
  expect(userText.length).toBeGreaterThan(0);
  for (const node of userText) expect(node.props.numberOfLines).not.toBe(1);
}

describe('M6 dense account at default text size', () => {
  it.each(['ar', 'en', 'he'] as const)(
    'R54.2 density %s keeps Today, Plan, My things and search bounded and operable',
    async (language: Language) => {
      const items = denseCommitments();
      harness = await prepareM6(language, { commitments: items, searchItems: items.slice(30), truncated: true });
      const view = await render(<Providers harness={harness}><TodayScreen /></Providers>);
      await waitFor(() => expect(screen.queryByTestId('today-group-must')).not.toBeNull());

      const must = within(screen.getByTestId('today-group-must'));
      expect(must.queryAllByTestId(/^today-item-/)).toHaveLength(3);
      expect(
        screen.queryByTestId('today-primary-complete') ?? screen.queryByTestId('next-step-accept'),
      ).not.toBeNull();
      expectUserTextUnclamped();

      await view.rerender(<Providers harness={harness}><CalendarScreen /></Providers>);
      await waitFor(() => expect(screen.queryByTestId('calendar-week-card')).not.toBeNull());
      expect(screen.queryByTestId('calendar-plan-week')).not.toBeNull();
      expectUserTextUnclamped();

      await view.rerender(<Providers harness={harness}><ThingsScreen /></Providers>);
      await waitFor(() => expect(screen.queryByTestId('things-commitments')).not.toBeNull());
      expect(screen.queryByTestId('things-commitments')).not.toBeNull();
      expectUserTextUnclamped();

      await fireEvent.changeText(screen.getByTestId('things-search'), 'task');
      await act(async () => { jest.advanceTimersByTime(300); });
      await waitFor(() => expect(searchRequests(harness!)).toHaveLength(1));
      expect(screen.queryByTestId('m6-search-section-commitments')).not.toBeNull();
      expect(screen.queryByTestId('things-search')).not.toBeNull();
      expectUserTextUnclamped();

      await view.rerender(<Providers harness={harness}><CommitmentsScreen /></Providers>);
      await waitFor(() => expect(screen.queryByTestId('commitments-list')).not.toBeNull());
      expect(screen.queryByTestId('commitments-add')).not.toBeNull();
      expectUserTextUnclamped();
    },
  );
});

