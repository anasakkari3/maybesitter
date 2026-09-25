/**
 * The review screen's side of the clarification dead end (first device run).
 *
 *   - A failed answer said nothing: the question quietly came back and the
 *     person could not tell whether their answer had landed.
 *   - A refused confirm always said "That didn't work", whatever the server's
 *     `failureCode` asked of them.
 *   - The question sheet was not keyed by item, so words typed for one
 *     question were still in the box when the next question appeared.
 *   - The skip pill promised "Leave it without a time" on questions that have
 *     no such answer, and then only set the question aside.
 */
import React, { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { CaptureProvider, useCaptureFlow } from '../CaptureProvider';
import { ReviewScreen } from '../../../screens/ReviewScreen';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { strings } from '../../../i18n/strings';
import type { CaptureProposal } from '../../../api/schemas/capture';
import { CaptureConfirmRefusedError, ValidationError } from '../../../api/errors';
import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const t = strings.en;
let client: QueryClient;

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();

function timeQuestion() {
  return {
    questionId: 'q-time',
    field: 'time',
    questionKey: 'ask_time',
    params: { title: 'Call Dana' },
    options: [
      { optionId: 'evening', labelKey: 'evening', labelParams: {}, value: { localTime: '19:00', localDate: tomorrow } },
      { optionId: 'none', labelKey: 'noTime', labelParams: {}, value: {} },
    ],
    allowFreeText: true,
  };
}

function dayQuestion() {
  return {
    questionId: 'q-day',
    field: 'which_day',
    questionKey: 'ask_day',
    params: { title: 'Pay rent', time: '09:00' },
    options: [{ optionId: 'tomorrow', labelKey: 'tomorrow', labelParams: {}, value: { localDate: tomorrow, localTime: '09:00' } }],
    allowFreeText: true,
  };
}

function proposal(overrides: { a?: Record<string, unknown>; b?: Record<string, unknown> } = {}): CaptureProposal {
  return {
    version: 'v1',
    proposalId: 'p-clarify',
    status: 'needs_clarification',
    items: [
      { itemId: 'item-a', title: 'Call Dana', resolvedTime: null, needsClarification: true, clarification: timeQuestion(), ...overrides.a },
      { itemId: 'item-b', title: 'Pay rent', resolvedTime: null, needsClarification: true, clarification: dayQuestion(), ...overrides.b },
    ],
    seeds: [],
    provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
  } as unknown as CaptureProposal;
}

function Mount({ start }: { start: CaptureProposal }) {
  const { adoptProposal } = useCaptureFlow();
  useEffect(() => { adoptProposal(start, 'tab'); }, [adoptProposal, start]);
  return <ReviewScreen />;
}

async function show(start: CaptureProposal = proposal()) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <AppProvider>
            <CaptureProvider>
              <Mount start={start} />
            </CaptureProvider>
          </AppProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('clarify-sheet')).toBeTruthy());
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'clarify-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  }));
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: 'clarify-user', trust: { analyticsConsent: false } } as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

it('says why an answer did not land, and keeps the question', async () => {
  jest.spyOn(captureEndpoints, 'clarifyCapture')
    .mockRejectedValue(new ValidationError('free text answered nothing', 'answer_not_understood'));
  await show();

  await fireEvent.changeText(screen.getByTestId('clarify-free-text'), 'hello');
  await fireEvent.press(screen.getByTestId('clarify-send'));

  await waitFor(() => expect(screen.getByTestId('clarify-error')).toBeTruthy());
  expect(screen.getByText(t.clarifyNotUnderstood)).toBeTruthy();
  expect(screen.getByTestId('clarify-question')).toBeTruthy();
});

it('does not carry words typed for one question into the next', async () => {
  const settledA = proposal({ a: { needsClarification: false, clarification: null, resolvedTime: inTwoDays } });
  jest.spyOn(captureEndpoints, 'clarifyCapture').mockResolvedValue(settledA as never);
  await show();

  await fireEvent.changeText(screen.getByTestId('clarify-free-text'), 'half-typed thought');
  await fireEvent.press(screen.getByTestId('clarify-option-evening'));

  await waitFor(() => expect(screen.getByText(t.clarifyAskDay)).toBeTruthy());
  expect(screen.getByTestId('clarify-free-text').props.value).toBe('');
});

it('labels the skip by what it does', async () => {
  const settledA = proposal({ a: { needsClarification: false, clarification: null, resolvedTime: inTwoDays } });
  jest.spyOn(captureEndpoints, 'clarifyCapture').mockResolvedValue(settledA as never);
  await show();
  // A time question offers "no specific time", so skipping is that answer.
  expect(screen.getByText(t.skipNoTime)).toBeTruthy();

  await fireEvent.press(screen.getByTestId('clarify-option-evening'));
  await waitFor(() => expect(screen.getByText(t.clarifyAskDay)).toBeTruthy());
  // "Which day?" has no time-less answer: the pill must not promise one.
  expect(screen.queryByText(t.skipNoTime)).toBeNull();
  expect(screen.getByText(t.clarifySkip)).toBeTruthy();
});

it('says what a refused confirm needs, from the server\'s reason', async () => {
  const ready = proposal({
    a: { needsClarification: false, clarification: null, resolvedTime: inTwoDays },
    b: { needsClarification: false, clarification: null, resolvedTime: inTwoDays },
  });
  (ready as { status: string }).status = 'proposed';
  jest.spyOn(captureEndpoints, 'confirmCapture').mockRejectedValue(new CaptureConfirmRefusedError('proposal_not_found'));
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <AppProvider>
            <CaptureProvider>
              <Mount start={ready} />
            </CaptureProvider>
          </AppProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('review-confirm')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('review-confirm'));

  await waitFor(() => expect(screen.getByTestId('review-confirm-failed')).toBeTruthy());
  expect(screen.getByText(t.captureConfirmExpired)).toBeTruthy();
  expect(screen.queryByText(t.errorsGeneric)).toBeNull();
});
