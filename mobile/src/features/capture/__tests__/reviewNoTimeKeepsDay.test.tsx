/**
 * «سجّل موعد أسنان يوم الجمعة» → «الصبح» → Review «غيّر» → «بدون وقت» →
 * «خُد هيك» (UAT round 3, N11, shots 234–237).
 *
 * The card read only «بدون وقت», while the confirm kept the dentist on Friday
 * (an event cleared of its hour stays on its day, FY1 M1) and the Calendar
 * listed it there. The server now says which items keep their day
 * (`eventOnDay`); the card names that day, «<day> · بدون وقت», the shape the
 * clarify path already uses. A task cleared of its hour loses the day on the
 * server, so its card still reads a bare «بدون وقت».
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react-native';
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
  uid: 'n11-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** `YYYY-MM-DD` in Jerusalem, `days` from now. */
function dayKeyIn(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + days * 86_400_000));
}
/** The Arabic weekday name of a day key — what the card must name. */
function arWeekday(key: string): string {
  return new Intl.DateTimeFormat('ar', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
}
function dayOfMonth(key: string): string {
  return String(Number(key.slice(8, 10)));
}

const FRIDAY = dayKeyIn(4);
/** 09:00 on FRIDAY in Jerusalem (UTC+3 in the autumn this runs in, or +2). */
function nineOn(key: string): string {
  for (const offset of [3, 2]) {
    const instant = new Date(Date.parse(`${key}T09:00:00.000Z`) - offset * 3_600_000);
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(instant);
    if (local === '09:00') return instant.toISOString();
  }
  throw new Error('no 09:00');
}

let eventOnDay = true;
/** Still waiting on its hour: the edit sheet then saves «بدون وقت» on any save. */
let stillAsking = false;

function proposal() {
  return {
    version: 'v1',
    proposalId: 'p-n11',
    status: 'proposed',
    items: [
      {
        itemId: 'dentist',
        title: 'موعد أسنان',
        // «الصبح» answered: Friday 09:00.
        resolvedTime: stillAsking ? null : nineOn(FRIDAY),
        needsClarification: stillAsking,
        priority: 'high',
        priorityEstimated: true,
        resolvedDate: FRIDAY,
        dateEstimated: false,
        ...(eventOnDay ? { eventOnDay: true } : {}),
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
  jest.spyOn(captureEndpoints, 'proposeCapture').mockImplementation(async () => proposal() as never);
});

afterEach(async () => {
  await cleanup();
  eventOnDay = true;
  stillAsking = false;
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function reachReviewAndClearTheTime() {
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
  await fireEvent.changeText(screen.getByTestId('capture-input'), 'سجّل موعد أسنان يوم الجمعة');
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('review-item-dentist')).not.toBeNull());
  // Before: Friday at 09:00.
  expect(textOf('review-when-dentist')).toMatch(/09:00/);
  await fireEvent.press(screen.getByTestId('review-edit-dentist'));
  await waitFor(() => expect(screen.queryByTestId('edit-item-no-time')).not.toBeNull());
  await fireEvent(screen.getByTestId('edit-item-no-time'), 'valueChange', true);
  await fireEvent.press(screen.getByTestId('edit-item-save'));
  await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).toBeNull());
}

function textOf(testID: string): string {
  const children = screen.getByTestId(testID).props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
}

describe('«بدون وقت» from the review edit sheet (UAT round 3, N11)', () => {
  it('an appointment keeps its day on the card: «<day> · بدون وقت»', async () => {
    await reachReviewAndClearTheTime();
    const when = textOf('review-when-dentist');
    expect(when).not.toBe(ar.noTimeYet);
    expect(when).toContain(arWeekday(FRIDAY));
    expect(when).toContain(dayOfMonth(FRIDAY));
    expect(when.endsWith(ar.noTimeYet)).toBe(true);
    expect(when).not.toMatch(/\d{1,2}:\d{2}/);
    // Not a deadline: an appointment is on its day, not due by it.
    expect(when.startsWith(ar.reviewDueByDay.split('{day}')[0]!)).toBe(false);
  });

  it('a task, which the server saves with no day, still reads a bare «بدون وقت»', async () => {
    eventOnDay = false;
    await reachReviewAndClearTheTime();
    expect(textOf('review-when-dentist')).toBe(ar.noTimeYet);
  });
});

describe('an item still asking for its hour (review M2)', () => {
  it('saved from the edit sheet without a time, it promises no day: the confirm keeps nothing of it', async () => {
    // A server that flagged it anyway (FZ2 before M2): the card must not read
    // «الجمعة · بدون وقت» for an item that cannot be confirmed as it is.
    stillAsking = true;
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
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'سجّل موعد أسنان يوم الجمعة');
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-item-dentist')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('review-edit-dentist'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-save')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).toBeNull());
    expect(textOf('review-when-dentist')).toBe(ar.noTimeYet);
  });
});
