import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { setAuthRepository } from '../../api/auth';
import { CaptureProvider, useCaptureFlow } from '../../features/capture/CaptureProvider';
import { ReviewScreen } from '../../screens/ReviewScreen';
import type { CaptureProposal } from '../../api/schemas/capture';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { isolateAuto } from '../../i18n/bidi';
import { formatRelativeDay } from '../../i18n/format';
import { fill, ltr } from '../../i18n/strings';
import ar from '../../i18n/locales/ar.json';
import en from '../../i18n/locales/en.json';
import he from '../../i18n/locales/he.json';
import { M4aServer, METRICS, NOW, TODAY, calendarScenario, instant, press, teardown } from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

function freeSlotProposal(slots = [
  { id: 'slot-1', date: TODAY, time: '14:00' },
  { id: 'slot-2', date: '2030-03-30', time: '12:00' },
  { id: 'slot-3', date: '2030-04-08', time: '16:30' },
]): CaptureProposal {
  return {
    version: 'v1',
    proposalId: 'proposal-free-slots',
    revision: 4,
    status: 'needs_clarification',
    items: [{
      itemId: 'item-bank',
      title: 'Visit the bank',
      resolvedTime: null,
      needsClarification: true,
      clarification: {
        questionId: 'question-time',
        field: 'time',
        questionKey: 'ask_time',
        params: { title: 'Visit the bank' },
        options: [
          ...slots.map((slot) => ({
            optionId: slot.id,
            labelKey: 'freeSlot',
            labelParams: { localDate: slot.date, localTime: slot.time },
            value: { localDate: slot.date, localTime: slot.time },
          })),
          { optionId: 'none', labelKey: 'noTime', labelParams: {}, value: {} },
        ],
        allowFreeText: true,
      },
    }],
    seeds: [],
    provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
  } as unknown as CaptureProposal;
}

function settledProposal(): CaptureProposal {
  return {
    ...freeSlotProposal(),
    revision: 5,
    status: 'proposed',
    items: [{
      ...freeSlotProposal().items[0]!,
      resolvedTime: '2030-03-29T07:00:00.000Z',
      needsClarification: false,
      clarification: null,
    }],
  } as CaptureProposal;
}

function dayPartProposal(): CaptureProposal {
  const proposal = freeSlotProposal();
  return {
    ...proposal,
    items: [{
      ...proposal.items[0]!,
      clarification: {
        questionId: 'question-time',
        field: 'time',
        questionKey: 'ask_time',
        params: { title: 'Visit the bank', date: TODAY },
        options: [
          { optionId: 'morning', labelKey: 'morning', labelParams: {}, value: { localDate: TODAY, localTime: '09:00' } },
          { optionId: 'afternoon', labelKey: 'afternoon', labelParams: {}, value: { localDate: TODAY, localTime: '14:00' } },
          { optionId: 'evening', labelKey: 'evening', labelParams: {}, value: { localDate: TODAY, localTime: '19:00' } },
          { optionId: 'none', labelKey: 'noTime', labelParams: {}, value: {} },
        ],
        allowFreeText: true,
      },
    }],
  } as CaptureProposal;
}

function Mount({ proposal }: { proposal: CaptureProposal }) {
  const { adoptProposal } = useCaptureFlow();
  useEffect(() => { adoptProposal(proposal, 'tab'); }, [adoptProposal, proposal]);
  return <ReviewScreen />;
}

function copy(bundle: unknown, key: string): string {
  const value = (bundle as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : `__missing_${key}__`;
}

let client: QueryClient | undefined;
let server: M4aServer | undefined;

async function show(proposal: CaptureProposal, language: 'ar' | 'en' | 'he' = 'en'): Promise<void> {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  const scenario = calendarScenario();
  server = new M4aServer(scenario);
  server.install();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const repository = createFakeAuthRepository({
    initialUser: { uid: 'capture-slots', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  });
  setAuthRepository(repository);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        <AuthProvider repository={repository} isDevBundle={false}>
          <AppProvider>
            <CaptureProvider><Mount proposal={proposal} /></CaptureProvider>
          </AppProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).not.toBeNull());
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  onlineManager.setOnline(true);
  await AsyncStorage.clear();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
});

afterEach(async () => {
  client?.clear();
  client = undefined;
  server = undefined;
  await teardown();
  jest.useRealTimers();
});

describe('M4a capture free slots', () => {
  it.each(['ar', 'en', 'he'] as const)('M4A-R9-003 %s renders every slot with its own day/time presentation and free-slot accessibility', async (language) => {
    await show(freeSlotProposal(), language);

    const bundles = { ar, en, he } as const;
    const bundle = bundles[language];
    const slots = [
      { id: 'slot-1', date: TODAY, time: '14:00' },
      { id: 'slot-2', date: '2030-03-30', time: '12:00' },
      { id: 'slot-3', date: '2030-04-08', time: '16:30' },
    ];

    expect(screen.getByTestId('clarify-question')).toHaveTextContent(fill(
      copy(bundle, 'yFreeSlotsAsk'),
      { title: isolateAuto('Visit the bank') },
    ));
    for (const slot of slots) {
      const option = screen.getByTestId(`clarify-option-${slot.id}`);
      const day = formatRelativeDay(new Date(instant(slot.date, '12:00')), {
        locale: language,
        timeZone: 'Asia/Jerusalem',
        now: NOW,
      });
      expect(option).toHaveTextContent(day, { exact: false });
      expect(option).toHaveTextContent(slot.time, { exact: false });
      expect(option.props.accessibilityLabel).toBe(fill(
        copy(bundle, 'yFreeSlotA11y'),
        { day, time: ltr(slot.time) },
      ));
    }
    expect(screen.queryByTestId('clarify-option-none')).not.toBeNull();
  });

  it('M4A-R9-003 invalid free-slot dates or times are not rendered as buttons', async () => {
    await show(freeSlotProposal([
      { id: 'bad-date', date: '2030-02-30', time: '14:00' },
      { id: 'bad-time', date: '2030-03-30', time: '25:00' },
      { id: 'slot-1', date: '2030-03-30', time: '12:00' },
    ]));

    expect(screen.queryByTestId('clarify-option-bad-date')).toBeNull();
    expect(screen.queryByTestId('clarify-option-bad-time')).toBeNull();
    expect(screen.queryByTestId('clarify-option-slot-1')).not.toBeNull();
  });

  it('M4A-R9-003 choosing a slot sends the unchanged clarify route with that exact option', async () => {
    await show(freeSlotProposal());
    server!.extra = (request) => request.path === '/api/mobile/capture/clarify'
      ? { status: 200, body: settledProposal() }
      : undefined;

    expect(screen.queryByTestId('clarify-option-slot-2')).not.toBeNull();
    await press('clarify-option-slot-2');
    await waitFor(() => expect(server!.matching('POST', /\/capture\/clarify$/)).toHaveLength(1));
    expect(server!.matching('POST', /\/capture\/clarify$/)[0]!.body).toEqual({
      proposalId: 'proposal-free-slots',
      revision: 4,
      itemId: 'item-bank',
      questionId: 'question-time',
      timezone: 'Asia/Jerusalem',
      referenceTime: NOW.toISOString(),
      optionId: 'slot-2',
    });
  });

  it('M4A-R9-003 not_free redraws the fresh slots returned by the server', async () => {
    await show(freeSlotProposal());
    const fresh = freeSlotProposal([
      { id: 'slot-1', date: '2030-03-30', time: '14:00' },
      { id: 'slot-2', date: '2030-03-31', time: '16:00' },
      { id: 'slot-3', date: '2030-04-01', time: '18:00' },
    ]) as CaptureProposal & { reason?: 'not_free' };
    fresh.reason = 'not_free';
    server!.extra = (request) => request.path === '/api/mobile/capture/clarify'
      ? { status: 200, body: fresh }
      : undefined;

    expect(screen.queryByTestId('clarify-option-slot-1')).not.toBeNull();
    await press('clarify-option-slot-1');
    await waitFor(() => expect(screen.getByTestId('clarify-option-slot-1')).toHaveTextContent(/14:00/));
    expect(screen.getByTestId('clarify-option-slot-2')).toHaveTextContent(/16:00/);
    expect(screen.getByTestId('clarify-option-slot-3')).toHaveTextContent(/18:00/);
  });

  it('M4A-R9-003 flag-off day-part options identify that their values are for today', async () => {
    await show(dayPartProposal());

    expect(screen.getByTestId('clarify-option-morning').props.accessibilityLabel).toContain(en.today);
    expect(screen.getByTestId('clarify-option-afternoon').props.accessibilityLabel).toContain(en.today);
    expect(screen.getByTestId('clarify-option-evening').props.accessibilityLabel).toContain(en.today);
    expect(screen.queryAllByTestId(/^clarify-option-slot-/)).toHaveLength(0);
  });
});
