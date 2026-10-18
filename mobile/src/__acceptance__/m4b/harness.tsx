import React from 'react';
import { expect, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import type { Commitment } from '../../api/schemas/common';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { instantAt } from '../../testing/wallClock';
import { DetailsScreen } from '../../screens/DetailsScreen';
import { SheetHost } from '../../screens/Sheets';

export const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

export const ZONE = 'Asia/Jerusalem';
export const NOW = new Date('2030-03-29T09:00:00.000Z');
export const TODAY = '2030-03-29';
export const ITEM_ID = 'm4b-item';

export const ACCOUNT: AuthUser = {
  uid: 'm4b-account-a',
  email: 'm4b@example.com',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
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
  headers?: Record<string, string>;
}

export type RouteHandler = (request: RecordedRequest) => RouteReply | Promise<RouteReply | undefined> | undefined;

export class M4bServer {
  readonly requests: RecordedRequest[] = [];

  constructor(public handler?: RouteHandler) {}

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
        const reply = await this.handler?.(request) ?? defaultReply(request);
        return {
          status: reply.status,
          text: async () => JSON.stringify(reply.body),
          headers: { get: (name: string) => reply.headers?.[name] ?? reply.headers?.[name.toLowerCase()] ?? null },
        };
      },
    ) as never;
  }

  matching(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && pattern.test(request.path));
  }
}

export function capabilities(overrides: Partial<{
  externalClashHold: boolean;
  eveningImpact: boolean;
  smartPostpone: boolean;
}> = {}) {
  return {
    success: true,
    externalClashHold: true,
    eveningImpact: true,
    smartPostpone: true,
    ...overrides,
  };
}

export function instant(day: string, clock: string): string {
  return instantAt(`${day}T${clock}:00`, ZONE);
}

export function commitment(id = ITEM_ID, extra: Partial<Commitment> = {}): Commitment {
  return {
    id,
    kind: 'task',
    title: 'Write the report',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    category: null,
    categorySource: 'inferred',
    timeSpec: {
      kind: 'scheduled_event',
      dueAt: instant(TODAY, '15:00'),
      endAt: instant(TODAY, '16:00'),
      remindAt: null,
      allDay: false,
      timezone: ZONE,
    },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: instant(TODAY, '07:00'),
    updatedAt: instant(TODAY, '07:00'),
    confirmedAt: instant(TODAY, '07:00'),
    completedAt: null,
    droppedAt: null,
    rank: 0,
    reasonCodes: [],
    deviceCalendarLink: null,
    ...extra,
  } as Commitment;
}

export function footballResponse(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    providerConfigured: true,
    clubs: [{
      clubId: 'barcelona', providerTeamId: '81', competition: 'PD',
      names: { ar: '\u0628\u0631\u0634\u0644\u0648\u0646\u0629', he: '\u05d1\u05e8\u05e6\u05dc\u05d5\u05e0\u05d4', en: 'Barcelona' },
    }],
    followedClubIds: ['barcelona'],
    fixtures: [],
    ...overrides,
  };
}

export function feed(overrides: Record<string, unknown> = {}) {
  return {
    feedId: 'feed-1', label: 'School', autoAcceptDeadlines: true, status: 'ok',
    consecutiveFailures: 0, lastErrorCode: null, lastFetchedAt: instant(TODAY, '08:00'),
    nextFetchAt: instant(TODAY, '12:00'), busyBlocks: 0, pendingDeadlines: 1,
    ...overrides,
  };
}

export function deadline(overrides: Record<string, unknown> = {}) {
  return {
    itemKey: 'deadline-1', feedId: 'feed-1', title: 'Submit essay', dueAt: instant('2030-03-30', '09:00'),
    allDay: false, state: 'pending', notice: null, proposedDueAt: null,
    commitmentId: null, autoAccepted: false,
    ...overrides,
  };
}

function defaultReply(request: RecordedRequest): RouteReply {
  if (request.path === '/api/mobile/capabilities/m4b') return { status: 200, body: capabilities() };
  if (request.path === '/api/mobile/commitments/today') return { status: 200, body: { items: [commitment()], calendarOrphans: [] } };
  if (request.path === '/api/mobile/commitments/upcoming') return { status: 200, body: { items: [] } };
  if (request.path === `/api/mobile/commitments/${ITEM_ID}`) {
    return { status: 200, body: commitment(), headers: { etag: 'W/"m4b-v1"' } };
  }
  if (request.path === `/api/mobile/commitments/${ITEM_ID}/actions`) {
    return {
      status: 200,
      body: { success: true, id: ITEM_ID, commitment: commitment(ITEM_ID, { postponedUntil: instant(TODAY, '17:00') }) },
      headers: { etag: 'W/"m4b-v2"' },
    };
  }
  if (request.path === '/api/mobile/football') return { status: 200, body: footballResponse() };
  if (request.path === '/api/mobile/calendar/ics') return { status: 200, body: { success: true, feeds: [feed()], deadlines: [] } };
  if (request.path === '/api/mobile/pilot/trust') {
    return { status: 200, body: { success: true, participantId: ACCOUNT.uid, trust: { analyticsConsent: false, calendarConsent: true } } };
  }
  if (request.path === '/api/mobile/intelligence') {
    return { status: 200, body: { success: true, observations: [], suggestions: [], schedule: [] } };
  }
  if (request.path === '/api/mobile/intelligence/generate') {
    return { status: 200, body: { success: true, generated: false, reason: 'nothing_new', suggestions: [] } };
  }
  if (request.path === '/api/mobile/trust/background-activity') {
    return { status: 200, body: { success: true, paused: false, monitors: [] } };
  }
  if (request.path === '/api/mobile/held-items') {
    return { status: 200, body: { success: true, count: 0, items: [] } };
  }
  if (request.path === '/api/mobile/next-step') {
    return {
      status: 200,
      body: { success: true, participantId: ACCOUNT.uid, recommendation: { version: 'v1', proposalId: 'empty', state: 'empty', locale: 'en', primaryStep: null, explanation: null } },
    };
  }
  if (request.path === '/api/mobile/consents') {
    return { status: 200, body: { aiProcessing: { state: 'granted' }, recommendations: { state: 'granted' }, personalization: { state: 'granted' } } };
  }
  if (request.path === '/api/mobile/plans/week') return { status: 404, body: { success: false, error: 'not_found', reason: 'not_found' } };
  return { status: 404, body: { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' } };
}

export interface M4bHarness {
  client: QueryClient;
  repository: ReturnType<typeof createFakeAuthRepository>;
  server: M4bServer;
}

export async function prepare(language: 'ar' | 'en' | 'he' = 'en', handler?: RouteHandler): Promise<M4bHarness> {
  onlineManager.setOnline(true);
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS = 'true';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const repository = createFakeAuthRepository({ initialUser: ACCOUNT, idToken: 'm4b-token' });
  setAuthRepository(repository);
  const server = new M4bServer(handler);
  server.install();
  return { client, repository, server };
}

export function providers(harness: M4bHarness, child: React.ReactNode): React.ReactElement {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={harness.repository} isDevBundle={false}>
          <QueryClientProvider client={harness.client}>{child}</QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}

export async function show(harness: M4bHarness, child: React.ReactNode): Promise<void> {
  await render(providers(harness, child));
}

function OpenDetails() {
  const { actions } = useApp();
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    actions.openDetail(ITEM_ID);
  }, [actions]);
  return null;
}

export async function showDetails(harness: M4bHarness): Promise<void> {
  await show(harness, <><OpenDetails /><DetailsScreen /><SheetHost /></>);
  await waitFor(() => expect(screen.queryByTestId('details-title')).not.toBeNull());
}

export async function press(testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(screen.getByTestId(testID)); });
}

export async function accessibilityAction(testID: string, actionName: string): Promise<void> {
  await act(async () => {
    await fireEvent(screen.getByTestId(testID), 'accessibilityAction', { nativeEvent: { actionName } });
  });
}

export async function teardown(harness?: M4bHarness): Promise<void> {
  await cleanup();
  harness?.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
}

export function firstRequest(harness: M4bHarness, method: string, pattern: RegExp): RecordedRequest {
  const request = harness.server.matching(method, pattern)[0];
  expect(request).toBeDefined();
  return request!;
}
