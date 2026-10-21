import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { VerifyEmailBanner } from '../../auth/VerifyEmailBanner';
import { CommitmentsScreen } from '../../features/product/ContextScreens';
import { ThingsScreen } from '../../features/things/ThingsScreen';
import { CalendarScreen } from '../../screens/CalendarScreen';
import { TabBar } from '../../screens/TabBar';
import { TodayScreen } from '../../screens/TodayScreen';
import {
  ACCOUNT_A,
  NOW,
  Providers,
  denseCommitments,
  flatStyle,
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

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 3.12 })),
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
  const userText = screen.queryAllByTestId(/^m6-user-text-/);
  expect(userText.length).toBeGreaterThan(0);
  for (const node of userText) expect(node.props.numberOfLines).not.toBe(1);
}

describe('M6 dense account at AX5', () => {
  it.each(['ar', 'en', 'he'] as const)(
    'R54.2 density %s caps groups at two and keeps all four surfaces operable at AX5',
    async (language: Language) => {
      const items = denseCommitments();
      harness = await prepareM6(language, { commitments: items, searchItems: items.slice(30), truncated: true });
      const view = await render(<Providers harness={harness}><TodayScreen /></Providers>);
      await waitFor(() => expect(screen.queryByTestId('today-group-must')).not.toBeNull());
      expect(within(screen.getByTestId('today-group-must')).queryAllByTestId(/^today-item-/)).toHaveLength(2);
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
      await fireEvent.changeText(screen.getByTestId('things-search'), 'task');
      await act(async () => { jest.advanceTimersByTime(300); });
      await waitFor(() => expect(searchRequests(harness!)).toHaveLength(1));
      expect(screen.queryByTestId('m6-search-section-commitments')).not.toBeNull();
      expectUserTextUnclamped();

      await view.rerender(<Providers harness={harness}><CommitmentsScreen /></Providers>);
      await waitFor(() => expect(screen.queryByTestId('commitments-list')).not.toBeNull());
      expect(screen.queryByTestId('commitments-add')).not.toBeNull();
      expectUserTextUnclamped();
    },
  );
});

describe('M6 AX5 verification banner and tab bar', () => {
  it.each(['ar', 'en', 'he'] as const)(
    'R54.2 #739 %s keeps the full verify sentence/action and all tabs in one row',
    async (language: Language) => {
      harness = await prepareM6(language);
      await act(async () => {
        harness!.repository.emit({ ...ACCOUNT_A, emailVerified: false });
      });
      await render(
        <Providers harness={harness}>
          <VerifyEmailBanner>
            <TabBar />
          </VerifyEmailBanner>
        </Providers>,
      );
      await waitFor(() => expect(screen.queryByTestId('verify-email-banner')).not.toBeNull());

      const sentence = screen.getByTestId('m6-verify-sentence');
      expect(sentence.props.numberOfLines).not.toBe(1);
      expect(screen.getByTestId('m6-verify-action').props.accessibilityRole).toBe('button');
      expect(flatStyle(screen.getByTestId('tab-bar-row')).flexWrap).toBe('nowrap');
      for (const testID of ['tab-capture', 'tab-today', 'tab-calendar', 'tab-things', 'tab-watching']) {
        const tab = screen.getByTestId(testID);
        expect(tab.props.accessibilityRole).toBe('button');
        expect(typeof tab.props.accessibilityLabel).toBe('string');
        expect(tab.props.accessibilityLabel.length).toBeGreaterThan(0);
      }
    },
  );
});

