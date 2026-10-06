/**
 * The chat card names a clash (owner request 2026-09-30: "the agent cannot
 * describe what the commitment is if there is a collision").
 *
 * The server sends each proposal item's clashes (`conflicts`); the card shows
 * one line per clash, in the app's language, and a screen reader hears it on
 * the line and on the card's checkbox. What these hold:
 *
 *   - a named clash reads «بيتعارض مع «…» 18:00» / 'Clashes with "…" 18:00',
 *     a weekly block as its range, another day with its day;
 *   - the calendar's busy time has no title and gets none: it reads as the
 *     device chip's sentence, and not at all when that chip already says it;
 *   - a time the person moved on the card drops the line (the server measured
 *     the old one);
 *   - the route's own fixture (`capture.chatConflict.json`) reaches the card.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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
import ar from '../../../i18n/locales/ar.json';
import en from '../../../i18n/locales/en.json';
import he from '../../../i18n/locales/he.json';
import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';
import { captureChatSchema, type CaptureProposal } from '../../../api/schemas/capture';
import chatConflictFixture from '../../../api/__fixtures__/capture.chatConflict.json';
import { chatServer } from '../../../testing/captureChat';
import { stripIsolates } from '../../../i18n/bidi';
import { chatConflictLines } from '../chatConflicts';
import type { Strings } from '../../../i18n/strings';
import { openCards } from '../../../testing/understood';

const TZ = 'Asia/Jerusalem';
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = { uid: 'clash-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };

/* ── the lines themselves ──────────────────────────────────────────── */

const FRIDAY_18 = '2026-10-02T15:00:00.000Z'; // 18:00 in Jerusalem
const FRIDAY_1830 = '2026-10-02T15:30:00.000Z';
const FRIDAY_1730 = '2026-10-02T14:30:00.000Z';
const FRIDAY_19 = '2026-10-02T16:00:00.000Z';
const THURSDAY_22 = '2026-10-01T19:00:00.000Z';
const NOW = new Date('2026-09-30T09:00:00.000Z');

const dinner = (conflicts: CaptureProposal['items'][number]['conflicts']) => ({
  resolvedTime: FRIDAY_18, resolvedDate: '2026-10-02', conflicts,
});
const lines = (item: ReturnType<typeof dinner>, t: Strings, lang: 'ar' | 'en' | 'he', options: { busyChipShown?: boolean; edited?: boolean } = {}) =>
  chatConflictLines(item, options.edited ? { localDateTime: '2026-10-02T19:00' } : undefined,
    { lang, timezone: TZ, t, busyChipShown: options.busyChipShown ?? false, now: NOW }).map(stripIsolates);

describe('the clash line', () => {
  const wedding = { title: 'عرس ابن عمي', startsAt: FRIDAY_18, endsAt: FRIDAY_1830, kind: 'commitment' as const };

  it('names a saved commitment and its hour, in the app’s language', () => {
    expect(lines(dinner([wedding]), ar as Strings, 'ar')).toEqual(['بيتعارض مع «عرس ابن عمي» 18:00']);
    expect(lines(dinner([wedding]), en as Strings, 'en')).toEqual(['Clashes with "عرس ابن عمي" 18:00']);
    expect(lines(dinner([wedding]), he as Strings, 'he')).toEqual(['מתנגש עם "عرس ابن عمي" 18:00']);
  });

  it('reads a weekly block as its range, and a clash on another day with its day', () => {
    const block = { title: 'Gym', startsAt: FRIDAY_1730, endsAt: FRIDAY_19, kind: 'weekly' as const };
    expect(lines(dinner([block]), en as Strings, 'en')).toEqual(['Clashes with "Gym" 17:30–19:00']);
    const lateMatch = { title: 'Barcelona – Real Madrid', startsAt: THURSDAY_22, endsAt: FRIDAY_18, kind: 'fixture' as const };
    const [line] = lines(dinner([lateMatch]), en as Strings, 'en');
    expect(line).toMatch(/^Clashes with "Barcelona – Real Madrid" .+ · 22:00$/);
  });

  it('gives the calendar’s busy time no title, and says nothing the device chip already says', () => {
    const busy = { title: null, startsAt: FRIDAY_1730, endsAt: FRIDAY_19, kind: 'calendar_busy' as const };
    expect(lines(dinner([busy]), en as Strings, 'en')).toEqual(['Overlaps a calendar event 17:30–19:00']);
    expect(lines(dinner([busy, busy]), ar as Strings, 'ar')).toEqual(['بيتقاطع مع موعد بتقويمك 17:30–19:00']);
    expect(lines(dinner([busy]), en as Strings, 'en', { busyChipShown: true })).toEqual([]);
    // A named clash still shows beside the chip.
    expect(lines(dinner([busy, wedding]), en as Strings, 'en', { busyChipShown: true })).toEqual(['Clashes with "عرس ابن عمي" 18:00']);
  });

  it('is dropped once the person moves the time on the card', () => {
    expect(lines(dinner([wedding]), en as Strings, 'en', { edited: true })).toEqual([]);
  });
});

/* ── on the chat card ──────────────────────────────────────────────── */

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
});

afterEach(async () => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

async function openCapture(language: 'ar' | 'en') {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, language);
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
}

async function say(text: string) {
  await fireEvent.changeText(screen.getByTestId('capture-input'), text);
  await fireEvent.press(screen.getByTestId('capture-analyze'));
}

const textOf = (testID: string): string => {
  const children = screen.getByTestId(testID).props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
};

function proposalWith(conflicts: CaptureProposal['items'][number]['conflicts']): CaptureProposal {
  const at = new Date(Date.now() + 26 * 3_600_000).toISOString();
  return {
    version: 'v1', proposalId: 'p-1', status: 'proposed', seeds: [],
    items: [{ itemId: 'i-1', title: 'Dinner with my family', resolvedTime: at, needsClarification: false, conflicts }],
  };
}

describe('the chat card', () => {
  it('shows the clash line, and a screen reader hears it on the line and on the card', async () => {
    const at = new Date(Date.now() + 26 * 3_600_000).toISOString();
    const end = new Date(Date.parse(at) + 30 * 60_000).toISOString();
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(
      () => proposalWith([{ title: 'My cousin’s wedding', startsAt: at, endsAt: end, kind: 'commitment' }]),
      { reply: () => 'Dinner tomorrow. It clashes with "My cousin’s wedding". Confirm below.', engine: 'model' },
    ) as never);
    await openCapture('en');
    await say('Dinner with my family tomorrow at 6pm');
    await waitFor(() => expect(screen.queryByTestId('review-conflict-i-1-0')).not.toBeNull());

    const line = stripIsolates(textOf('review-conflict-i-1-0-text'));
    expect(line).toMatch(/^Clashes with "My cousin’s wedding" \d{2}:\d{2}$/);
    expect(screen.getByTestId('review-conflict-i-1-0').props.accessibilityLabel).toBe(line);
    expect(screen.getByTestId('review-conflict-i-1-0').props.accessible).toBe(true);
    expect(stripIsolates(screen.getByTestId('review-item-i-1').props.accessibilityLabel as string)).toContain(`, ${line}`);
    // Everything else of the card is as it was.
    expect(textOf('review-title-i-1')).toBe('Dinner with my family');
    expect(screen.queryByTestId('review-confirm')).not.toBeNull();
  });

  it('in Arabic, «بيتعارض مع …»', async () => {
    const at = new Date(Date.now() + 26 * 3_600_000).toISOString();
    const end = new Date(Date.parse(at) + 30 * 60_000).toISOString();
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(
      () => proposalWith([{ title: 'عرس ابن عمي', startsAt: at, endsAt: end, kind: 'commitment' }]),
      { reply: () => 'عشا مع أهلك بكرا. أكّد من تحت.', engine: 'model' },
    ) as never);
    await openCapture('ar');
    await say('عندي عشا مع أهلي بكرا الساعة 6 المسا');
    await waitFor(() => expect(screen.queryByTestId('review-conflict-i-1-0')).not.toBeNull());
    expect(stripIsolates(textOf('review-conflict-i-1-0-text'))).toMatch(/^بيتعارض مع «عرس ابن عمي» \d{2}:\d{2}$/);
  });

  it('an item with no clash has no line', async () => {
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => proposalWith(undefined), { engine: 'model' }) as never);
    await openCapture('en');
    await say('Dinner with my family tomorrow at 6pm');
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    expect(screen.queryByTestId('review-conflict-i-1-0')).toBeNull();
  });

  it('the route’s own clash fixture parses and reaches the card', async () => {
    const answer = captureChatSchema.parse(chatConflictFixture);
    const item = answer.proposal!.items[0]!;
    expect(item.conflicts?.map((conflict) => [conflict.kind, conflict.title])).toEqual([['weekly', 'Gym']]);
    jest.spyOn(captureEndpoints, 'chatCapture').mockResolvedValue(answer as never);
    await openCapture('en');
    await say('Remind me to call the dentist tomorrow at 5pm');
    // The route's answer says what it understood first (M2a); the cards follow «هيك صح».
    await openCards();
    await waitFor(() => expect(screen.queryByTestId(`review-conflict-${item.itemId}-0`)).not.toBeNull());
    expect(stripIsolates(textOf(`review-conflict-${item.itemId}-0-text`))).toMatch(/^Clashes with "Gym" /);
  });
});
