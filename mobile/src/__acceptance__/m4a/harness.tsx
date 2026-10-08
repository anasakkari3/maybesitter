import React from 'react';
import { expect, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import type { Commitment } from '../../api/schemas/common';
import { CalendarScreen } from '../../screens/CalendarScreen';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { instantAt } from '../../testing/wallClock';

export const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

export const ZONE = 'Asia/Jerusalem';
export const NOW = new Date('2030-03-29T09:00:00.000Z');
export const TODAY = '2030-03-29';

export const ACCOUNT_A: AuthUser = {
  uid: 'm4a-account-a',
  email: 'a@example.com',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

export const ACCOUNT_B: AuthUser = {
  ...ACCOUNT_A,
  uid: 'm4a-account-b',
  email: 'b@example.com',
};

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface RouteReply {
  status: number;
  body: unknown;
}

export type RouteHandler = (request: RecordedRequest) => RouteReply | Promise<RouteReply>;
export type OptionalRouteHandler = (request: RecordedRequest) => RouteReply | Promise<RouteReply> | undefined;

const googleDisconnected = {
  success: true,
  google: {
    status: 'not_connected',
    accountEmail: null,
    features: { calendar: false, gmail: false, drive: false },
    pickerAvailable: false,
    connectedAt: null,
  },
};

export const googleConnected = {
  success: true,
  google: {
    status: 'connected',
    accountEmail: 'person@example.com',
    features: { calendar: true, gmail: false, drive: false },
    pickerAvailable: false,
    connectedAt: '2030-03-01T08:00:00.000Z',
  },
};

export function trust(calendarConsent = true, uid = ACCOUNT_A.uid) {
  return {
    success: true,
    participantId: uid,
    trust: {
      version: 'v1',
      participantId: uid,
      recommendationConsent: true,
      analyticsConsent: false,
      calendarConsent,
      firstValueAt: null,
      quietMode: false,
      revokedAt: null,
      deletedAt: null,
      updatedAt: '2030-03-29T08:00:00.000Z',
    },
    exposure: { allowed: true, reason: 'pilot' },
    whatKnows: {
      version: 'v1',
      participantId: uid,
      confirmedCommitmentCount: 0,
      recommendationConsent: true,
      analyticsConsent: false,
      calendarConnected: calendarConsent,
      privateMessageIngestion: false,
      sensitiveInference: false,
      medicalProfile: false,
    },
  };
}

export const completeBusy = {
  success: true,
  blocks: [],
  complete: true,
  cutoff: null,
  unknownRanges: [],
  sources: [],
};

export interface CalendarScenario {
  today: Commitment[];
  upcoming: Commitment[];
  savedWeek: { today: string; saved: { date: string; items: { itemId: string; startsAt: string; endsAt: string }[] }[] };
  weekly: { occurrenceId: string; weeklyBlockId: string; title: string; startAt: string; endAt: string }[];
  profile: unknown;
  googleStatus: unknown;
  googleBusy: unknown;
  busy: RouteReply | Promise<RouteReply>;
  trust: unknown;
  fail: Set<string>;
  pending: Set<string>;
}

export function calendarScenario(): CalendarScenario {
  return {
    today: [],
    upcoming: [],
    savedWeek: { today: TODAY, saved: [] },
    weekly: [],
    profile: { routine: null, updatedAt: null, aiContextImport: null },
    googleStatus: googleDisconnected,
    googleBusy: {
      success: true,
      blocks: [],
      windowStart: instant(TODAY, '00:00'),
      windowEnd: instant('2030-04-12', '12:00'),
    },
    busy: { status: 200, body: completeBusy },
    // Phone-calendar consent is off unless a case is explicitly about the
    // device source. With consent on and no cache envelope, readiness must
    // fail closed rather than treating the phone as an empty calendar.
    trust: trust(false),
    fail: new Set(),
    pending: new Set(),
  };
}

export class M4aServer {
  readonly requests: RecordedRequest[] = [];

  constructor(readonly scenario: CalendarScenario, public extra?: OptionalRouteHandler) {}

  install(): void {
    (globalThis as { fetch: unknown }).fetch = jest.fn(
      async (input: string | { url?: string }, init?: RequestInit) => {
        const rawUrl = typeof input === 'string' ? input : (input.url ?? String(input));
        const url = new URL(rawUrl, 'http://localhost');
        const request: RecordedRequest = {
          method: init?.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null,
        };
        this.requests.push(request);
        const reply = await this.route(request);
        return {
          status: reply.status,
          text: async () => JSON.stringify(reply.body),
          headers: { get: () => null },
        };
      },
    ) as never;
  }

  matching(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && pattern.test(request.path));
  }

  private async route(request: RecordedRequest): Promise<RouteReply> {
    const extra = await this.extra?.(request);
    if (extra) return extra;
    if (this.scenario.pending.has(request.path)) return new Promise<RouteReply>(() => undefined);
    if (this.scenario.fail.has(request.path)) {
      return { status: 503, body: { success: false, error: 'unavailable', reason: 'unavailable' } };
    }
    if (request.path === '/api/mobile/commitments/today') {
      return { status: 200, body: { items: this.scenario.today, calendarOrphans: [] } };
    }
    if (request.path === '/api/mobile/commitments/upcoming') {
      return { status: 200, body: { items: this.scenario.upcoming } };
    }
    if (request.path === '/api/mobile/plans/week') {
      return { status: 200, body: { success: true, ...this.scenario.savedWeek } };
    }
    if (/^\/api\/mobile\/plans\/\d{4}-\d{2}-\d{2}$/.test(request.path)) {
      return { status: 404, body: { success: false, error: 'not_found', reason: 'not_found' } };
    }
    if (request.path === '/api/mobile/weekly-blocks/occurrences') {
      return {
        status: 200,
        body: {
          success: true,
          from: request.query.get('from') ?? instant(TODAY, '00:00'),
          to: request.query.get('to') ?? instant('2030-04-05', '00:00'),
          items: this.scenario.weekly,
        },
      };
    }
    if (request.path === '/api/mobile/pilot/trust') return { status: 200, body: this.scenario.trust };
    if (request.path === '/api/mobile/profile') return { status: 200, body: this.scenario.profile };
    if (request.path === '/api/mobile/integrations/google') return { status: 200, body: this.scenario.googleStatus };
    if (request.path === '/api/mobile/integrations/google/calendar') return { status: 200, body: this.scenario.googleBusy };
    if (request.path === '/api/mobile/calendar/busy') return this.scenario.busy;
    return { status: 404, body: { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' } };
  }
}

export interface M4aHarness {
  client: QueryClient;
  repository: ReturnType<typeof createFakeAuthRepository>;
  scenario: CalendarScenario;
  server: M4aServer;
}

export async function prepareCalendar(change?: (scenario: CalendarScenario) => void): Promise<M4aHarness> {
  onlineManager.setOnline(true);
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  const scenario = calendarScenario();
  change?.(scenario);
  const server = new M4aServer(scenario);
  server.install();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const repository = createFakeAuthRepository({ initialUser: ACCOUNT_A, idToken: 'm4a-token' });
  setAuthRepository(repository);
  return { client, repository, scenario, server };
}

export async function renderCalendar(harness: M4aHarness): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={harness.repository} isDevBundle={false}>
          <QueryClientProvider client={harness.client}><CalendarScreen /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId(`calendar-day-${TODAY}`)).not.toBeNull());
}

export async function press(testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(screen.getByTestId(testID)); });
}

export async function teardown(harness?: M4aHarness): Promise<void> {
  await cleanup();
  harness?.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
}

export function instant(day: string, clock: string): string {
  return instantAt(`${day}T${clock}:00`, ZONE);
}

export function commitment(
  id: string,
  start: string | null,
  options: {
    kind?: 'unscheduled' | 'due_by' | 'scheduled_event';
    end?: string | null;
    allDay?: boolean;
    postponedUntil?: string | null;
    postponed?: boolean;
  } = {},
): Commitment {
  return {
    id,
    kind: 'task',
    title: id,
    description: null,
    person: null,
    status: options.postponed ? 'postponed' : 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    category: null,
    categorySource: 'inferred',
    timeSpec: {
      kind: options.kind ?? (start ? 'scheduled_event' : 'unscheduled'),
      dueAt: start,
      endAt: options.end ?? null,
      remindAt: start,
      allDay: options.allDay ?? false,
      timezone: ZONE,
    },
    currentAckState: options.postponed ? 'postponed' : 'not_seen',
    postponedUntil: options.postponedUntil ?? null,
    createdAt: instant(TODAY, '07:00'),
    updatedAt: instant(TODAY, '07:00'),
    confirmedAt: instant(TODAY, '07:00'),
    completedAt: null,
    droppedAt: null,
    rank: 0,
    reasonCodes: [],
    deviceCalendarLink: null,
  } as Commitment;
}

export function firstFailureHint(testID: string): void {
  expect(screen.queryByTestId(testID)).not.toBeNull();
}
