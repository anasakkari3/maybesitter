/**
 * The conflict note where a user actually meets it (UC-3.2, #186 step 7).
 *
 * ── Why this renders `Root` ──────────────────────────────────────
 *
 * The Flutter build had a working conflict detector that exactly one screen
 * called — `trust_center_screen.dart:163`, three taps inside Settings — and its
 * unit tests passed the whole time. Reachability is the thing that was missing
 * then and the thing a unit test cannot assert now, so this starts where the
 * user starts: the capture button in the tab bar, and Today's own list.
 *
 * ── It renders from the cache, with no calendar and no network ───
 *
 * Nothing here mocks `expo-calendar`. The account's calendar consent is off, so
 * `busySyncDecision` refuses to read anything, and the chips come from the
 * blocks already in AsyncStorage. That is the offline path this feature
 * promises, asserted rather than described — and it also means a regression
 * that made the chip depend on a live sync turns these red.
 *
 * ── And confirming still works ───────────────────────────────────
 *
 * The chip is informational. #186 says so and this asserts it, because a note
 * that quietly disabled a button would be the product overruling somebody about
 * their own calendar — people double-book on purpose all the time.
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
import en from '../../../i18n/locales/en.json';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { BUSY_BLOCKS_KEY } from '../../../lib/deviceSettings/calendarBusy';
import { resetBusySyncForTests } from '../useBusyCalendar';

import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'busy-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/**
 * Six hours from now, and a busy block that swallows it.
 *
 * Derived from the clock, never a literal: the edit sheet refuses a time that
 * has already passed, so a pinned instant does not merely age here — it rots
 * into a failing suite the day the wall clock walks past it.
 */
const HOUR = 3_600_000;
const AT = new Date(Date.now() + 6 * HOUR);
const MEETING_FROM = new Date(AT.getTime() - 30 * 60_000);
const MEETING_TO = new Date(AT.getTime() + 60 * 60_000);
/** A different day entirely, so nothing about it overlaps. */
const ELSEWHERE_FROM = new Date(AT.getTime() + 72 * HOUR);
const ELSEWHERE_TO = new Date(ELSEWHERE_FROM.getTime() + HOUR);

function cached(from: Date, to: Date) {
  return JSON.stringify([
    { nativeId: 'evt-1', startAt: from.toISOString(), endAt: to.toISOString(), allDay: false },
  ]);
}

function proposal() {
  return {
    version: 'v1',
    proposalId: 'p-1',
    status: 'proposed',
    items: [{
      itemId: 'i-1',
      title: 'Hand in the report',
      resolvedTime: AT.toISOString(),
      needsClarification: false,
      priority: 'high',
      priorityEstimated: false,
    }],
    provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
  };
}

function todayItem() {
  return {
    id: 'c-1',
    kind: 'task',
    title: 'Hand in the report',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'high', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: AT.toISOString(), endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: new Date(Date.now() - HOUR).toISOString(),
    updatedAt: new Date(Date.now() - HOUR).toISOString(),
    confirmedAt: new Date(Date.now() - HOUR).toISOString(),
    completedAt: null,
    droppedAt: null,
    deviceCalendarLink: null,
  };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  resetBusySyncForTests();
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [], calendarOrphans: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  // The calendar switch is off, so nothing below reads a calendar or uploads
  // anything. The chips come from the cache and from nowhere else.
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false, calendarConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function openApp() {
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
}

async function reachReview() {
  await fireEvent.press(screen.getByTestId('tab-capture'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('capture-input'), 'Hand in the report at six');
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
}

describe('on the review card', () => {
  it('shows the note when the proposed time falls inside a calendar event', async () => {
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, cached(MEETING_FROM, MEETING_TO));
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    await openApp();
    await reachReview();
    await waitFor(() => expect(screen.queryByTestId('review-busy-i-1')).not.toBeNull());
    expect(String(screen.getByTestId('review-busy-i-1').props.children))
      .toContain(en.calendarBusyConflict.split('{range}')[0]!.trim());
  });

  it('shows nothing when the calendar has something on a different day', async () => {
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, cached(ELSEWHERE_FROM, ELSEWHERE_TO));
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    await openApp();
    await reachReview();
    expect(screen.queryByTestId('review-busy-i-1')).toBeNull();
  });

  it('shows nothing when no calendar has ever been read', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    await openApp();
    await reachReview();
    expect(screen.queryByTestId('review-busy-i-1')).toBeNull();
  });

  it('still confirms, because the note is a note', async () => {
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, cached(MEETING_FROM, MEETING_TO));
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue({
      success: true,
      replayed: false,
      persisted: [{ itemId: 'i-1', commitmentId: 'c-1', title: 'Hand in the report', resolvedTime: AT.toISOString() }],
      failed: [],
    } as never);

    await openApp();
    await reachReview();
    await waitFor(() => expect(screen.queryByTestId('review-busy-i-1')).not.toBeNull());

    expect(screen.getByTestId('review-confirm').props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  });
});

describe('on Today', () => {
  it('shows the note beside a commitment that runs into a calendar event', async () => {
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, cached(MEETING_FROM, MEETING_TO));
    jest.spyOn(commitmentEndpoints, 'listToday')
      .mockResolvedValue({ items: [todayItem()], calendarOrphans: [] } as never);
    await openApp();
    await waitFor(() => expect(screen.queryByTestId('today-item-c-1')).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId('today-busy-c-1')).not.toBeNull());
  });

  it('shows nothing beside a commitment the calendar is silent about', async () => {
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, cached(ELSEWHERE_FROM, ELSEWHERE_TO));
    jest.spyOn(commitmentEndpoints, 'listToday')
      .mockResolvedValue({ items: [todayItem()], calendarOrphans: [] } as never);
    await openApp();
    await waitFor(() => expect(screen.queryByTestId('today-item-c-1')).not.toBeNull());
    expect(screen.queryByTestId('today-busy-c-1')).toBeNull();
  });
});
