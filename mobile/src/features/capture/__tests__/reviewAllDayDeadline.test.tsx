/**
 * «بدي أدفع فاتورة الكهربا قبل آخر الشهر»: a deadline with a day and no hour
 * (closure UAT 2026-09-27, FX3).
 *
 * The server now proposes it settled — `resolvedDate` the month's last day,
 * `resolvedTime` null, no question — and confirms it as an all-day `due_by`
 * (`tests/extraction/fx3ObligationDeadline.test.ts` pins that half). The card
 * showed only «بدون وقت» for any item without a question, so the deadline the
 * person said was nowhere on it. It must read «لحد <day>».
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
  uid: 'fx3-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
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

const DEADLINE_DAY = dayKeyIn(10);

let allDayEvent = false;

function proposal() {
  return {
    version: 'v1',
    proposalId: 'p-fx3',
    status: 'proposed',
    items: [
      {
        itemId: 'bill',
        title: 'أدفع فاتورة الكهربا',
        resolvedTime: null,
        needsClarification: false,
        priority: 'normal',
        priorityEstimated: true,
        resolvedDate: DEADLINE_DAY,
        dateEstimated: false,
        ...(allDayEvent ? { allDayEvent: true } : {}),
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
  // Built when the capture is sent, so a test can set `allDayEvent` first.
  jest.spyOn(captureEndpoints, 'proposeCapture').mockImplementation(async () => proposal() as never);
});

afterEach(() => {
  allDayEvent = false;
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
  await fireEvent.changeText(screen.getByTestId('capture-input'), 'بدي أدفع فاتورة الكهربا قبل آخر الشهر');
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('review-item-bill')).not.toBeNull());
}

function textOf(testID: string): string {
  const children = screen.getByTestId(testID).props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
}

describe('an all-day deadline on the review card', () => {
  it('says which day it is due by, and neither "no time" nor an hour', async () => {
    await reachReview();
    const when = textOf('review-when-bill');
    expect(when.startsWith(ar.reviewDueByDay.split('{day}')[0]!)).toBe(true);
    expect(when).toContain(arWeekday(DEADLINE_DAY));
    expect(when).toContain(dayOfMonth(DEADLINE_DAY));
    expect(when).not.toContain(ar.noTimeYet);
    expect(when).not.toMatch(/\d{1,2}:\d{2}/);
    // The day is the one they said: no guessed-date chip.
    expect(screen.queryByTestId('review-date-estimated-bill')).toBeNull();
  });
});

describe('an appointment answered «بدون وقت محدد» on the review card (FY1 N4)', () => {
  it('is on its day with no hour — «<day> · بدون وقت» — not «لحد <day>»', async () => {
    allDayEvent = true;
    await reachReview();
    const when = textOf('review-when-bill');
    expect(when.startsWith(ar.reviewDueByDay.split('{day}')[0]!)).toBe(false);
    expect(when).toContain(arWeekday(DEADLINE_DAY));
    expect(when.endsWith(ar.noTimeYet)).toBe(true);
    expect(when).not.toMatch(/\d{1,2}:\d{2}/);
  });
});
