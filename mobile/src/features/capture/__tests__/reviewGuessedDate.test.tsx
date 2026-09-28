/**
 * "Doctor on Sunday": which Sunday, and that we picked it (L4).
 *
 * The owner said «سجّل موعد دكتور يوم الأحد». The server resolved a Sunday, the
 * item waited on its hour, and the review card read only «بدون وقت» — the day
 * the product had chosen was invisible, and nothing said it was a guess. When
 * a time was given, the card named the weekday but not which week.
 *
 * Driven in Arabic, from the tab bar, on the proposal shape the server sends
 * (`resolvedDate` + `dateEstimated`, `tests/extraction/appointmentPriority.test.ts`
 * pins the server half). Dates are computed from the real clock, ten days out,
 * so "beyond tomorrow" holds on any day this suite runs.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import ar from '../../../i18n/locales/ar.json';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';

import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';

const ZONE = 'Asia/Jerusalem';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar-JO', textDirection: 'rtl' }]),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'l4-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** `YYYY-MM-DD` in Jerusalem, `days` from now. */
function dayKeyIn(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + days * 86_400_000));
}
function plus(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
/** The Arabic weekday name of a day key — what the card must name. */
function arWeekday(key: string): string {
  return new Intl.DateTimeFormat('ar', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
}
function dayOfMonth(key: string): string {
  return String(Number(key.slice(8, 10)));
}

const GUESSED_DAY = dayKeyIn(10);
const STATED_DAY = dayKeyIn(12);

function proposal() {
  return {
    version: 'v1',
    proposalId: 'p-l4',
    status: 'proposed',
    items: [
      {
        // «سجّل موعد دكتور يوم الأحد»: a guessed day, no hour yet.
        itemId: 'doctor',
        title: 'موعد دكتور',
        resolvedTime: null,
        needsClarification: true,
        priority: 'high',
        priorityEstimated: true,
        resolvedDate: GUESSED_DAY,
        dateEstimated: true,
        clarification: {
          questionId: 'q-1',
          field: 'time',
          questionKey: 'ask_time',
          params: { title: 'موعد دكتور', date: GUESSED_DAY },
          options: [
            { optionId: 'morning', labelKey: 'morning', labelParams: {}, value: { localTime: '09:00', localDate: GUESSED_DAY } },
            { optionId: 'none', labelKey: 'noTime', labelParams: {}, value: {} },
          ],
          allowFreeText: true,
        },
      },
      {
        // A day the user typed, with a time: shown in full, not called a guess.
        itemId: 'exam',
        title: 'امتحان',
        resolvedTime: `${STATED_DAY}T07:00:00.000Z`,
        needsClarification: false,
        priority: 'high',
        priorityEstimated: true,
        resolvedDate: STATED_DAY,
        dateEstimated: false,
      },
    ],
    provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
  };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
  jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function reachReview() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('tab-capture'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('capture-input'), 'سجّل موعد دكتور يوم الأحد');
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('review-item-doctor')).not.toBeNull());
}

function textOf(testID: string): string {
  const children = screen.getByTestId(testID).props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
}

describe('a guessed weekday on the review card', () => {
  it('shows the full date of the day waiting on its hour, and says the date was guessed', async () => {
    await reachReview();
    const when = textOf('review-when-doctor');
    expect(when).toContain(arWeekday(GUESSED_DAY));
    expect(when).toContain(dayOfMonth(GUESSED_DAY));
    expect(when).toContain(ar.noTimeYet);
    expect(screen.getByTestId('review-date-estimated-doctor').props.accessibilityLabel).toBe(ar.reviewDateEstimated);
    // The priority guess keeps its own chip: two guesses, two marks.
    expect(screen.queryByTestId('review-estimated-doctor')).not.toBeNull();
  });

  it('asks for the hour on that date, not just "what time"', async () => {
    await reachReview();
    const question = textOf('clarify-question');
    expect(question).toContain(arWeekday(GUESSED_DAY));
    expect(question).toContain(dayOfMonth(GUESSED_DAY));
    expect(question).not.toBe(ar.clarifyAskTime);
  });

  it('shows a stated day in full, with its time, and does not call it a guess', async () => {
    await reachReview();
    const when = textOf('review-when-exam');
    expect(when).toContain(arWeekday(STATED_DAY));
    expect(when).toContain(dayOfMonth(STATED_DAY));
    expect(screen.queryByTestId('review-date-estimated-exam')).toBeNull();
  });

  it('the chip opens the edit sheet, which offers the same weekday one week later', async () => {
    await reachReview();
    await fireEvent.press(screen.getByTestId('review-date-estimated-doctor'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).not.toBeNull());
    expect(textOf('edit-item-proposed-day')).toContain(dayOfMonth(GUESSED_DAY));

    const later = screen.getByTestId('edit-item-week-later');
    const laterDay = plus(GUESSED_DAY, 7);
    expect(later.props.accessibilityLabel).toContain(ar.editItemWeekLater.replace('{day}', arWeekday(laterDay)));
    expect(later.props.accessibilityLabel).toContain(dayOfMonth(laterDay));

    await fireEvent.press(later);
    // No hour was ever said, so the hour is asked for now, on the later day.
    await waitFor(() => expect(screen.queryByTestId('edit-item-picker')).not.toBeNull());
    expect(screen.getByTestId('edit-item-pick-date').props.accessibilityLabel).toContain(dayOfMonth(laterDay));
    // One week later is offered once; the day is now the one the user chose.
    expect(screen.queryByTestId('edit-item-week-later')).toBeNull();

    await fireEvent.press(screen.getByTestId('edit-item-save'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).toBeNull());
    expect(textOf('review-when-doctor')).toContain(dayOfMonth(laterDay));
    // Theirs now, not ours.
    expect(screen.queryByTestId('review-date-estimated-doctor')).toBeNull();
  });
});
