import React from 'react';
import { expect, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests } from '../../api/auth';
import { ApiProvider } from '../../api/ui/ApiProvider';
import type { AuthUser } from '../../auth/types';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { CalendarSettingsScreen } from '../../features/settings/CalendarSettingsScreen';
import { BusyCalendarHost, resetBusySyncForTests } from '../../features/calendar/useBusyCalendar';
import { resetCalendarSyncForTests } from '../../features/calendar/useDeviceCalendarSync';
import { IntelligencePanel } from '../../features/goals/IntelligencePanel';
import { GoogleIntegrationScreen } from '../../features/google/GoogleIntegrationScreen';
import { CaptureProvider } from '../../features/capture/CaptureProvider';
import { DetailsScreen } from '../../screens/DetailsScreen';

const ASYNC_STORAGE_IMPLEMENTATIONS = {
  getItem: jest.mocked(AsyncStorage.getItem).getMockImplementation(),
  setItem: jest.mocked(AsyncStorage.setItem).getMockImplementation(),
  multiRemove: jest.mocked(AsyncStorage.multiRemove).getMockImplementation(),
};

export const ZONE = 'Asia/Jerusalem';
export const NOW = new Date('2030-03-29T09:00:00.000Z');
export const TODAY = '2030-03-29';

export const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

export const ACCOUNT_A: AuthUser = {
  uid: 'm5a-account-a',
  email: 'a@example.com',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

export const ACCOUNT_B: AuthUser = {
  ...ACCOUNT_A,
  uid: 'm5a-account-b',
  email: 'b@example.com',
};

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

export interface RouteReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type RouteHandler = (request: RecordedRequest) => RouteReply | Promise<RouteReply | undefined> | undefined;

interface ScanCounts {
  messagesRead: number;
  messagesSkippedBulk?: number;
  messagesUnavailable: number;
  messagesTrimmed: number;
  observationsFound: number;
  addedFromEmail: number;
}

interface ScanWindow extends ScanCounts {
  scanId: string;
  from: string;
  until: string;
  startedAt: string;
}

interface RunningScan extends ScanWindow {
  status: 'running';
  origin: 'manual' | 'backfill';
  waiting: { reason: 'daily_ai_limit' | 'rate_limit'; resumesAt: string } | null;
}

interface CompleteScan extends ScanWindow {
  status: 'complete';
  origin: 'manual' | 'backfill';
  finishedAt: string;
}

interface FailedScan extends ScanWindow {
  status: 'failed';
  origin: 'manual' | 'backfill';
  failedAt: string;
  failure: 'reconnect_needed' | 'source_unavailable' | 'analysis_unavailable' | 'monitoring_off' | 'daily_limit';
}

export type ScanStatus = RunningScan | CompleteScan | FailedScan | null;

interface DailyWindow extends ScanWindow {
  day: string;
}

export type DailyStatus =
  | (Omit<RunningScan, 'origin'> & DailyWindow)
  | (Omit<CompleteScan, 'origin'> & DailyWindow)
  | (Omit<FailedScan, 'origin'> & DailyWindow)
  | { status: 'held'; reason: 'no_timezone'; heldAt: string }
  | null;

export interface QueuedScan {
  scanId: string;
  origin: 'manual' | 'backfill';
  from: string;
  until: string;
  acceptedAt: string;
}

export interface M5aState {
  calendarChoice: boolean;
  emailSources: boolean;
  calendarChoiceState: 'purging' | 'active';
  calendarEnrolled: boolean;
  sourceStatus: 'active' | 'revoked' | null;
  sources: Record<string, unknown>[];
  scanManual: ScanStatus;
  scanQueued: QueuedScan | null;
  scanDaily: DailyStatus;
  added: Record<string, unknown>[];
  addedNextCursor: string | null;
  monitor: {
    enabled: boolean;
    lastSuccessAt: string | null;
    error: 'source_unavailable' | 'analysis_unavailable' | null;
    m5Enrolled: boolean;
    waiting: { reason: 'daily_ai_limit' | 'rate_limit'; resumesAt: string } | null;
  };
  trustConsent: boolean;
}

export function initialState(overrides: Partial<M5aState> = {}): M5aState {
  return {
    calendarChoice: true,
    emailSources: true,
    calendarChoiceState: 'active',
    calendarEnrolled: true,
    sourceStatus: 'active',
    sources: [],
    scanManual: null,
    scanQueued: null,
    scanDaily: null,
    added: [],
    addedNextCursor: null,
    monitor: { enabled: false, lastSuccessAt: null, error: null, m5Enrolled: false, waiting: null },
    trustConsent: true,
    ...overrides,
  };
}

function headersOf(value: HeadersInit | undefined): Record<string, string> {
  const answer: Record<string, string> = {};
  if (!value) return answer;
  const headers = new Headers(value);
  headers.forEach((item, name) => { answer[name.toLowerCase()] = item; });
  return answer;
}

export class M5aServer {
  readonly requests: RecordedRequest[] = [];

  constructor(public state = initialState(), public handler?: RouteHandler) {}

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
          headers: headersOf(init?.headers),
        };
        this.requests.push(request);
        const reply = await this.handler?.(request) ?? this.route(request);
        return {
          status: reply.status,
          text: async () => JSON.stringify(reply.body),
          headers: { get: (name: string) => reply.headers?.[name] ?? reply.headers?.[name.toLowerCase()] ?? null },
        };
      },
    ) as never;
  }

  matching(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter(request => request.method === method && pattern.test(request.path));
  }

  private route(request: RecordedRequest): RouteReply {
    const { state } = this;
    if (request.path === '/api/mobile/capabilities/m5a') {
      return { status: 200, body: { success: true, calendarChoice: state.calendarChoice, emailSources: state.emailSources } };
    }
    if (request.path === '/api/mobile/capabilities/m4b') {
      return { status: 200, body: { success: true, externalClashHold: true, eveningImpact: true, smartPostpone: true } };
    }
    if (request.path === '/api/mobile/settings/calendar') {
      return { status: 200, body: { success: true, calendarSettings: { writeTarget: 'off', updatedAt: null } } };
    }
    if (request.path === '/api/mobile/pilot/trust') {
      if (request.method === 'POST') {
        const body = request.body as { type?: string; granted?: boolean } | null;
        if (body?.type === 'set_calendar_consent' && typeof body.granted === 'boolean') state.trustConsent = body.granted;
      }
      return { status: 200, body: trustResponse(state.trustConsent) };
    }
    if (request.path === '/api/mobile/commitments/today') {
      return { status: 200, body: { items: [], calendarOrphans: [] } };
    }
    if (request.path === '/api/mobile/commitments/upcoming') return { status: 200, body: { items: [] } };
    if (request.path === '/api/mobile/commitments/added-1') {
      return { status: 200, body: commitmentWithProvenance(), headers: { etag: 'W/"m5a-v1"' } };
    }
    if (request.path === '/api/mobile/integrations/google') return { status: 200, body: googleStatus() };
    if (request.path === '/api/mobile/integrations/google/calendar') {
      return { status: 200, body: { success: true, blocks: [], windowStart: null, windowEnd: null } };
    }
    if (request.path === '/api/mobile/calendar/choice' && request.method === 'POST') {
      return { status: 200, body: { success: true, state: state.calendarChoiceState, enrolledAt: '2030-03-29T08:00:00.000Z' } };
    }
    if (request.path === '/api/mobile/calendar/choice') {
      return {
        status: 200,
        body: {
          success: true,
          enrolled: state.calendarEnrolled,
          state: state.calendarEnrolled ? state.calendarChoiceState : null,
          sourceStatus: state.sourceStatus,
          sourceEpoch: state.sourceStatus ? 7 : null,
        },
      };
    }
    if (request.path === '/api/mobile/calendar/busy/sources') {
      return { status: 200, body: { success: true, sources: state.sources } };
    }
    if (request.path === '/api/mobile/calendar/busy/register') {
      return { status: 200, body: { success: true, sourceId: 'device:m5a-phone' } };
    }
    if (request.path === '/api/mobile/calendar/busy/intent') {
      const body = request.body as { intentId?: string } | null;
      return { status: 200, body: { success: true, opId: 'op-1', epoch: 7, intentId: body?.intentId ?? 'intent-1' } };
    }
    if (request.path === '/api/mobile/calendar/busy' && request.method === 'POST') {
      return {
        status: 200,
        body: {
          success: true,
          blocks: 0,
          source: {
            sourceId: 'device:m5a-phone',
            lastSyncedAt: NOW.toISOString(),
            windowStart: '2030-03-29T00:00:00.000Z',
            windowEnd: '2030-04-26T00:00:00.000Z',
          },
        },
      };
    }
    if (request.path === '/api/mobile/calendar/busy' && request.method === 'DELETE') {
      return { status: 200, body: { success: true, deleted: 0 } };
    }
    if (request.path === '/api/mobile/calendar/busy') {
      return { status: 200, body: { success: true, blocks: [], complete: true, cutoff: null, unknownRanges: [], sources: [] } };
    }
    if (request.path === '/api/mobile/intelligence') {
      return { status: 200, body: { success: true, observations: [], suggestions: [], schedule: [] } };
    }
    if (request.path === '/api/mobile/consents') {
      return {
        status: 200,
        body: {
          aiProcessing: { state: 'granted' },
          recommendations: { state: 'granted' },
          personalization: { state: 'granted' },
        },
      };
    }
    if (request.path === '/api/mobile/intelligence/sources/gmail/monitor') {
      const body = request.body as { enabled?: boolean; enrollM5?: boolean } | null;
      if (request.method === 'POST' && typeof body?.enabled === 'boolean') state.monitor.enabled = body.enabled;
      if (request.method === 'POST' && body?.enrollM5) state.monitor.m5Enrolled = true;
      return { status: 200, body: { success: true, ...state.monitor } };
    }
    if (request.path === '/api/mobile/intelligence/sources/gmail/scan' && request.method === 'GET') {
      return {
        status: 200,
        body: { success: true, manual: state.scanManual, queuedManual: state.scanQueued, daily: state.scanDaily },
      };
    }
    if (request.path === '/api/mobile/intelligence/sources/gmail/scan') {
      const body = request.body as { m5?: boolean } | null;
      if (body?.m5) {
        return {
          status: 200,
          body: { success: true, scan: state.scanManual ?? runningScan(), queuedManual: state.scanQueued },
        };
      }
      return {
        status: 200,
        body: { success: true, messagesRead: 0, observations: [], scan: { status: 'complete', messagesVisited: 0 } },
      };
    }
    if (request.path === '/api/mobile/intelligence/added' && request.method === 'GET') {
      return { status: 200, body: { success: true, items: state.added, nextCursor: state.addedNextCursor } };
    }
    if (/^\/api\/mobile\/intelligence\/added\/[^/]+$/.test(request.path) && request.method === 'DELETE') {
      state.added = state.added.filter(item => item.autoAddId !== decodeURIComponent(request.path.split('/').at(-1) ?? ''));
      return { status: 200, body: { success: true } };
    }
    if (request.path === '/api/mobile/trust/background-activity') {
      return { status: 200, body: { success: true, paused: false, monitors: [] } };
    }
    return { status: 404, body: { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' } };
  }
}

export function trustResponse(calendarConsent: boolean, uid = ACCOUNT_A.uid) {
  return {
    success: true,
    participantId: uid,
    trust: {
      version: 'v1', participantId: uid, recommendationConsent: true, analyticsConsent: false,
      calendarConsent, firstValueAt: null, quietMode: false, revokedAt: null, deletedAt: null,
      updatedAt: '2030-03-29T08:00:00.000Z',
    },
    exposure: { allowed: true, reason: 'pilot' },
    whatKnows: {
      version: 'v1', participantId: uid, confirmedCommitmentCount: 0,
      recommendationConsent: true, analyticsConsent: false, calendarConnected: calendarConsent,
      privateMessageIngestion: false, sensitiveInference: false, medicalProfile: false,
    },
  };
}

export function googleStatus() {
  return {
    success: true,
    google: {
      status: 'connected', accountEmail: 'person@example.com',
      features: { calendar: true, gmail: true, drive: false }, pickerAvailable: false,
      connectedAt: '2030-03-01T08:00:00.000Z',
    },
  };
}

export function runningScan(overrides: Partial<RunningScan> = {}): RunningScan {
  return {
    scanId: 'scan-manual-1', status: 'running', origin: 'manual', from: '2030-03-22T09:00:00.000Z', until: NOW.toISOString(),
    startedAt: '2030-03-29T08:30:00.000Z', messagesRead: 3, messagesUnavailable: 0,
    messagesTrimmed: 0, observationsFound: 1, addedFromEmail: 0, waiting: null,
    ...overrides,
  };
}

export function completeScan(overrides: Partial<CompleteScan> = {}): CompleteScan {
  return {
    scanId: 'scan-manual-1', status: 'complete', origin: 'manual', from: '2030-03-22T09:00:00.000Z', until: NOW.toISOString(),
    startedAt: '2030-03-29T08:00:00.000Z', finishedAt: '2030-03-29T08:20:00.000Z',
    messagesRead: 7, messagesUnavailable: 1, messagesTrimmed: 2, observationsFound: 3,
    addedFromEmail: 1, ...overrides,
  };
}

export function failedScan(failure: 'reconnect_needed' | 'source_unavailable' | 'analysis_unavailable' | 'monitoring_off' | 'daily_limit') {
  return {
    scanId: 'scan-manual-1', status: 'failed' as const, origin: 'manual' as const,
    from: '2030-03-22T09:00:00.000Z', until: NOW.toISOString(),
    startedAt: '2030-03-29T08:00:00.000Z', failedAt: '2030-03-29T08:10:00.000Z', failure,
    messagesRead: 3, messagesUnavailable: 0, messagesTrimmed: 0,
    observationsFound: 1, addedFromEmail: 0,
  };
}

export function addedItem(overrides: Record<string, unknown> = {}) {
  return {
    autoAddId: 'auto-1', commitmentId: 'added-1', title: 'Send the report',
    startsAt: '2030-03-30T08:00:00.000Z', evidence: 'I will send it tomorrow at 11',
    at: '2030-03-29T08:00:00.000Z', status: 'open', removable: true, ...overrides,
  };
}

export function commitmentWithProvenance(include = true) {
  return {
    id: 'added-1', kind: 'task', title: 'Send the report', description: null, person: null,
    status: 'active', priority: { level: 'normal', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: {
      kind: 'scheduled_event', dueAt: '2030-03-30T08:00:00.000Z', endAt: '2030-03-30T08:30:00.000Z',
      remindAt: null, allDay: false, timezone: ZONE,
    },
    currentAckState: 'not_seen', postponedUntil: null, createdAt: '2030-03-29T08:00:00.000Z',
    updatedAt: '2030-03-29T08:00:00.000Z', confirmedAt: '2030-03-29T08:00:00.000Z',
    completedAt: null, droppedAt: null, rank: 0, reasonCodes: [], deviceCalendarLink: null,
    ...(include ? { addedFrom: { kind: 'email_self_reply', evidence: 'I will send it tomorrow at 11' } } : {}),
  };
}

export interface M5aHarness {
  client: QueryClient;
  repository: ReturnType<typeof createFakeAuthRepository>;
  server: M5aServer;
}

export async function prepare(
  language: 'ar' | 'en' | 'he' = 'en',
  state = initialState(),
  handler?: RouteHandler,
): Promise<M5aHarness> {
  onlineManager.setOnline(true);
  resetBusySyncForTests();
  resetCalendarSyncForTests();
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  jest.spyOn(SecureStore, 'setItemAsync');
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  process.env.EXPO_PUBLIC_FEATURE_CALENDAR_READ = 'true';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const repository = createFakeAuthRepository({ initialUser: ACCOUNT_A, idToken: 'm5a-token' });
  const server = new M5aServer(state, handler);
  server.install();
  return { client, repository, server };
}

export function Providers({ harness, children }: { harness: M5aHarness; children: React.ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={harness.repository} isDevBundle={false}>
          <ApiProvider client={harness.client}>{children}</ApiProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}

export async function showCalendar(harness: M5aHarness, withHost = true) {
  return render(
    <Providers harness={harness}>
      {withHost ? <BusyCalendarHost /> : null}
      <CalendarSettingsScreen onBack={() => {}} />
    </Providers>,
  );
}

export async function showBusyHost(harness: M5aHarness) {
  return render(<Providers harness={harness}><BusyCalendarHost /></Providers>);
}

export async function showIntelligence(harness: M5aHarness) {
  return render(
    <Providers harness={harness}>
      <IntelligencePanel onChanged={() => {}} />
    </Providers>,
  );
}

export async function showGoogle(harness: M5aHarness) {
  return render(
    <Providers harness={harness}>
      <CaptureProvider><GoogleIntegrationScreen /></CaptureProvider>
    </Providers>,
  );
}

function OpenAddedDetail() {
  const { actions } = useApp();
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    actions.openDetail('added-1');
  }, [actions]);
  return null;
}

export async function showAddedDetail(harness: M5aHarness) {
  return render(
    <Providers harness={harness}>
      <OpenAddedDetail />
      <DetailsScreen />
    </Providers>,
  );
}

export async function press(testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(screen.getByTestId(testID)); });
}

export async function changeSwitch(testID: string, value: boolean): Promise<void> {
  await act(async () => { await fireEvent(screen.getByTestId(testID), 'valueChange', value); });
}

export function captureAppState() {
  const listeners: ((state: AppStateStatus) => void)[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, listener: (state: AppStateStatus) => void) => {
    listeners.push(listener);
    return { remove: () => {} };
  }) as never);
  return (state: AppStateStatus) => { for (const listener of listeners) listener(state); };
}

export async function waitForRequest(harness: M5aHarness, method: string, path: RegExp, count = 1) {
  await waitFor(() => expect(harness.server.matching(method, path)).toHaveLength(count));
  return harness.server.matching(method, path)[count - 1]!;
}

export async function waitForStored(
  key: string,
  predicate: (value: string | null) => boolean,
  timeoutMs = 2000,
): Promise<string | null> {
  const intervalMs = 50;
  let value = await AsyncStorage.getItem(key);
  for (let elapsedMs = 0; elapsedMs < timeoutMs && !predicate(value); elapsedMs += intervalMs) {
    await act(async () => { await jest.advanceTimersByTimeAsync(intervalMs); });
    value = await AsyncStorage.getItem(key);
  }
  return value;
}

export async function teardown(harness?: M5aHarness): Promise<void> {
  await cleanup();
  harness?.client.clear();
  resetBusySyncForTests();
  resetCalendarSyncForTests();
  resetAuthForTests();
  jest.restoreAllMocks();
  jest.mocked(AsyncStorage.getItem).mockImplementation(ASYNC_STORAGE_IMPLEMENTATIONS.getItem!);
  jest.mocked(AsyncStorage.setItem).mockImplementation(ASYNC_STORAGE_IMPLEMENTATIONS.setItem!);
  jest.mocked(AsyncStorage.multiRemove).mockImplementation(ASYNC_STORAGE_IMPLEMENTATIONS.multiRemove!);
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_READ;
  expect((React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { actQueue: unknown[] | null };
  }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.actQueue).toBeNull();
}

