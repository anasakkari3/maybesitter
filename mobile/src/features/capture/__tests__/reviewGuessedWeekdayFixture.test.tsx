/**
 * The owner's literal sentence, on the response the route really sends (L4,
 * fix round 1, I-3).
 *
 * `reviewGuessedDate.test.tsx` drives a hand-built proposal. This one drives
 * the two fixtures `tests/mobile/exportMobileApiFixtures.test.ts` records from
 * the real handlers for «سجّل موعد دكتور يوم الأحد»: a single
 * `needs_clarification` item with `resolvedTime: null`, a guessed
 * `resolvedDate`, and an `ask_time` question carrying that date — then the
 * same item answered. Each is parsed with the schema the app ships before the
 * screen sees it, so a shape the schema refuses fails here, not on a phone.
 * This is the #493 lesson: test the status the server actually emits.
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
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';

import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';
import { captureProposalSchema } from '../../../api/schemas/capture';
import guessed from '../../../api/__fixtures__/capture.guessedWeekday.json';
import clarified from '../../../api/__fixtures__/capture.guessedWeekdayClarified.json';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar-JO', textDirection: 'rtl' }]),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'l4-fixture-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** The Arabic weekday name of a day key — what the card must name. */
function arWeekday(key: string): string {
  return new Intl.DateTimeFormat('ar', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
}
function dayOfMonth(key: string): string {
  return String(Number(key.slice(8, 10)));
}


const DAY = guessed.items[0]!.resolvedDate!;

function proposal() {
  return captureProposalSchema.parse(guessed);
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
  await waitFor(() => expect(screen.queryByTestId(`review-item-${guessed.items[0]!.itemId}`)).not.toBeNull());
}

function textOf(testID: string): string {
  const children = screen.getByTestId(testID).props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
}

describe('«سجّل موعد دكتور يوم الأحد», as the route answers it', () => {
  it('parses, asks for the hour on the guessed Sunday, and marks both guesses', async () => {
    expect(guessed.status).toBe('needs_clarification');
    await reachReview();
    const itemId = guessed.items[0]!.itemId;
    const question = textOf('clarify-question');
    expect(question).toContain(arWeekday(DAY));
    expect(question).toContain(dayOfMonth(DAY));
    expect(textOf(`review-when-${itemId}`)).toContain(dayOfMonth(DAY));
    expect(screen.queryByTestId(`review-date-estimated-${itemId}`)).not.toBeNull();
    expect(screen.queryByTestId(`review-estimated-${itemId}`)).not.toBeNull();
  });

  it('after the hour is picked, the day is still shown as a guess', async () => {
    const clarifySpy = jest.spyOn(captureEndpoints, 'clarifyCapture')
      .mockImplementation(async () => captureProposalSchema.parse(clarified));
    await reachReview();
    const itemId = guessed.items[0]!.itemId;
    await fireEvent.press(screen.getByTestId('clarify-option-morning'));
    await fireEvent.press(screen.getByTestId('clarify-send'));
    await waitFor(() => expect(clarifySpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).toBeNull());
    expect(screen.queryByTestId(`review-date-estimated-${itemId}`)).not.toBeNull();
  });
});
