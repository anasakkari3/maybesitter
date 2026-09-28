/**
 * "Call mom this evening": the hour on the card is ours, and the card says so
 * (UAT round 6, D2).
 *
 * «لازم أتصل بأمي اليوم المسا وبعدين أشتري خبز» reached the review card as
 * «أتصل بأمي · اليوم · 18:00» with nothing on it. The person said «المسا»;
 * 18:00 is the product's hour for it. The server keeps the hour and sends
 * `timeEstimated` (`tests/extraction/timeEstimatedMark.test.ts` pins that
 * half); the card marks it «حزرنا الساعة», the way «حزرنا التاريخ» marks a
 * guessed day. Once the person sets the time themselves, it is theirs.
 *
 * Driven in Arabic, from the tab bar, on the proposal shape the server sends.
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
import { captureProposalSchema } from '../../../api/schemas/capture';
import guessedHour from '../../../api/__fixtures__/capture.guessedHour.json';

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
  uid: 'd2-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** `YYYY-MM-DD` in Jerusalem, `days` from now. */
function dayKeyIn(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + days * 86_400_000));
}

const DAY = dayKeyIn(10);
/** 18:00 in Jerusalem on `DAY` (UTC+3 in the autumn; the card shows the wall clock). */
const EVENING = new Date(`${DAY}T18:00:00+03:00`).toISOString();
const FIVE_PM = new Date(`${DAY}T17:00:00+03:00`).toISOString();

function proposal() {
  return {
    version: 'v1',
    proposalId: 'p-d2',
    status: 'proposed',
    items: [
      {
        // «أتصل بأمي … المسا»: a stated day, our hour.
        itemId: 'call',
        title: 'أتصل بأمي',
        resolvedTime: EVENING,
        needsClarification: false,
        priority: 'high',
        priorityEstimated: false,
        resolvedDate: DAY,
        dateEstimated: false,
        timeEstimated: true,
      },
      {
        // «الساعة 5 المسا»: the person's hour.
        itemId: 'bank',
        title: 'أروح عالبنك',
        resolvedTime: FIVE_PM,
        needsClarification: false,
        priority: 'high',
        priorityEstimated: false,
        resolvedDate: DAY,
        dateEstimated: false,
        timeEstimated: false,
      },
      {
        // «الأحد المسا»: a guessed day and a guessed hour — two guesses, two marks.
        itemId: 'doctor',
        title: 'موعد دكتور',
        resolvedTime: EVENING,
        needsClarification: false,
        priority: 'high',
        priorityEstimated: true,
        resolvedDate: DAY,
        dateEstimated: true,
        timeEstimated: true,
      },
      {
        // An older server that sends no flag at all: read as not guessed.
        itemId: 'old',
        title: 'أشتري خبز',
        resolvedTime: EVENING,
        needsClarification: false,
        priority: 'normal',
        priorityEstimated: false,
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
  // Through the schema the app ships, so a flag it dropped would never reach the card.
  jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(captureProposalSchema.parse(proposal()) as never);
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
  await fireEvent.changeText(screen.getByTestId('capture-input'), 'لازم أتصل بأمي اليوم المسا وبعدين أشتري خبز');
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('review-item-call')).not.toBeNull());
}

function textOf(testID: string): string {
  const children = screen.getByTestId(testID).props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
}

describe('a guessed hour on the review card', () => {
  it('the schema keeps the flag, and an older server without it still parses', () => {
    const parsed = captureProposalSchema.parse(proposal());
    expect(parsed.items.map((item) => item.timeEstimated)).toEqual([true, false, true, undefined]);
  });

  it('the real route response for the owner\'s sentence reaches the app with its flag', () => {
    const parsed = captureProposalSchema.parse(guessedHour);
    expect(parsed.items.map((item) => [item.title, item.timeEstimated])).toEqual([['أتصل بأمي', true], ['أشتري خبز', false]]);
  });

  it('marks the hour it shows as our guess, and says so to a screen reader', async () => {
    await reachReview();
    expect(textOf('review-when-call')).toContain('18:00');
    const mark = screen.getByTestId('review-time-estimated-call');
    expect(mark.props.accessibilityLabel).toBe(ar.reviewTimeEstimated);
    expect(textOf('review-time-estimated-call-text')).toBe(ar.reviewTimeEstimated);
    expect(screen.getByTestId('review-item-call').props.accessibilityLabel).toContain(ar.reviewTimeEstimated);
    // The day was said: no date mark, and the priority was said: no «حزرناها».
    expect(screen.queryByTestId('review-date-estimated-call')).toBeNull();
    expect(screen.queryByTestId('review-estimated-call')).toBeNull();
  });

  it('does not mark an hour the person said, nor one from a server that sends no flag', async () => {
    await reachReview();
    expect(screen.queryByTestId('review-time-estimated-bank')).toBeNull();
    expect(screen.getByTestId('review-item-bank').props.accessibilityLabel).not.toContain(ar.reviewTimeEstimated);
    expect(screen.queryByTestId('review-time-estimated-old')).toBeNull();
  });

  it('shows both marks when the day and the hour were both guessed', async () => {
    await reachReview();
    expect(screen.queryByTestId('review-time-estimated-doctor')).not.toBeNull();
    expect(screen.queryByTestId('review-date-estimated-doctor')).not.toBeNull();
    const label = screen.getByTestId('review-item-doctor').props.accessibilityLabel as string;
    expect(label).toContain(ar.reviewDateEstimated);
    expect(label).toContain(ar.reviewTimeEstimated);
  });

  it('the mark opens the edit sheet; the hour set there is theirs, and the mark goes', async () => {
    await reachReview();
    await fireEvent.press(screen.getByTestId('review-time-estimated-call'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).not.toBeNull());
    // Saved unchanged, the hour is still ours.
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).toBeNull());
    expect(screen.queryByTestId('review-time-estimated-call')).not.toBeNull();

    await fireEvent.press(screen.getByTestId('review-edit-call'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('edit-item-pick-time'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-picker')).not.toBeNull());
    await fireEvent(
      screen.getByTestId('edit-item-picker'),
      'change',
      { nativeEvent: { timestamp: Date.parse(new Date(`${DAY}T19:30:00+03:00`).toISOString()), utcOffset: 0 } },
    );
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).toBeNull());
    expect(textOf('review-when-call')).toContain('19:30');
    expect(screen.queryByTestId('review-time-estimated-call')).toBeNull();
    expect(screen.getByTestId('review-item-call').props.accessibilityLabel).not.toContain(ar.reviewTimeEstimated);
  });
});
