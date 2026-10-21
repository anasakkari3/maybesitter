import React from 'react';
import { expect, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests } from '../../api/auth';
import { ApiProvider } from '../../api/ui/ApiProvider';
import type { AuthUser } from '../../auth/types';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { KnowsScreen } from '../../features/settings/KnowsScreen';
import { MemoryScreen } from '../../features/memory/MemoryScreen';
import { ReadinessSettingsScreen } from '../../features/settings/ReadinessSettingsScreen';
import { PlanScreen } from '../../screens/PlanScreen';
import { TodayScreen } from '../../screens/TodayScreen';

export const ZONE = 'Asia/Jerusalem';
export const NOW = new Date('2030-03-29T09:00:00.000Z');
export const TODAY = '2030-03-29';

export const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

export const ACCOUNT_A: AuthUser = {
  uid: 'm5b-account-a', email: 'a@example.com', emailVerified: true,
  displayName: null, providerIds: ['password'],
};

export const ACCOUNT_B: AuthUser = {
  ...ACCOUNT_A, uid: 'm5b-account-b', email: 'b@example.com',
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

export type Energy = {
  band: 'low' | 'steady' | 'high' | null;
  source: 'check_in' | 'health' | 'none';
  level: 1 | 2 | 3 | 4 | 5 | null;
  changedPick: boolean;
};

export type ReadinessApplied = {
  source: 'check_in' | 'health' | 'none';
  energy: 1 | 2 | 3 | 4 | 5 | null;
  band: 'low' | 'steady' | 'high' | null;
  bufferMinutesAdded: number;
  observedAt: string | null;
} | null;

export interface M5bState {
  memoryLearning: boolean;
  memoryItems: ReturnType<typeof memoryItem>[];
  summary: Record<string, unknown>;
  plan: Record<string, unknown> | null;
  readiness: Record<string, unknown>;
  energy: Energy;
}

export function memoryItem(id = 'memory-1') {
  return {
    id, kind: 'fact', content: 'Focus window 09:00-12:00', language: 'en',
    source: 'user_stated', sourceLabel: 'you_told_us', confidence: 1,
    createdAt: '2030-03-01T09:00:00.000Z', observedAt: '2030-03-01T09:00:00.000Z',
    staleAfter: '2040-03-01T09:00:00.000Z', provenance: { origin: 'manual' },
    evidence: {
      origin: 'manual', observedAt: '2030-03-01T09:00:00.000Z', recordedAt: '2030-03-01T09:00:00.000Z',
      confirmedAt: null, edited: false, observationCount: 0, pattern: null,
    },
  };
}

export function readySummary(language: 'ar' | 'en' | 'he' = 'en') {
  return {
    status: 'ready', language,
    sentences: [
      { text: 'Focus works between 09:00 and 12:00.', memoryIds: ['memory-1'] },
      { text: 'This is a second sentence.', memoryIds: ['memory-1'] },
    ],
    coveredCount: 1, totalCount: 43,
  };
}

export function plan(readinessApplied: ReadinessApplied = {
  source: 'check_in', energy: 2, band: 'low', bufferMinutesAdded: 15,
  observedAt: '2030-03-29T08:00:00.000Z',
}, basisChanged = false, rebuildsLeft = 2) {
  return {
    date: TODAY, timezone: ZONE, status: 'proposed', generation: 1,
    inputDigest: 'a'.repeat(64), generatedAt: '2030-03-29T08:05:00.000Z', acceptedAt: null,
    explanation: { text: 'A deterministic plan.', locale: 'en', source: 'template' },
    scheduled: [{
      itemId: 'task-1', title: 'Write the report', startsAt: '2030-03-29T11:00:00.000Z',
      endsAt: '2030-03-29T11:45:00.000Z', blockId: 'block:task-1',
    }],
    unscheduled: [], edited: false, protections: [], proposal: null, fixed: [],
    inputsChanged: false, rebuildsLeft, workingEndsAt: '2030-03-29T19:00:00.000Z',
    readinessApplied, basisChanged,
  };
}

export function readinessResponse(planEffect: Record<string, unknown> = {
  source: 'check_in', energy: 2, band: 'low', bufferMinutes: 15,
  staleReading: null,
}) {
  return {
    readiness: {
      version: 'v1', schemaVersion: 'readiness-v1', scopeId: ACCOUNT_A.uid,
      computedAt: '2030-03-29T08:00:00.000Z', windowStart: '2030-03-28T08:00:00.000Z',
      windowEnd: '2030-03-29T08:00:00.000Z', band: 'low', score: null,
      normalizedSignals: {}, subjective: { energy: 2, observedAt: '2030-03-29T08:00:00.000Z' },
      derived: { readinessBand: 'low', confidence: null }, signals: [],
      sourceKinds: ['subjective'], missingSourceKinds: [],
    },
    selectedSource: 'current_subjective', freshness: 'fresh', planEffect,
  };
}

export function nextStep(energy: Energy = {
  source: 'check_in', level: 2, band: 'low', changedPick: false,
}) {
  return {
    success: true, participantId: ACCOUNT_A.uid,
    recommendation: {
      version: 'v1', proposalId: 'next-step-0123456789abcdef', state: 'ready', locale: 'en',
      primaryStep: { commitmentId: 'task-1', title: 'Write the report' },
      explanation: { summary: 'Ready.', evidenceLabels: [], evidenceCodes: [], sensitiveInferenceUsed: false },
      availableActions: ['accept', 'done', 'defer', 'edit', 'dismiss'],
      persistence: { occurred: false, confirmationRequired: true },
    },
    energy,
  };
}

export function initialState(overrides: Partial<M5bState> = {}): M5bState {
  return {
    memoryLearning: true,
    memoryItems: [memoryItem()],
    summary: readySummary(),
    plan: plan(),
    readiness: readinessResponse(),
    energy: { source: 'check_in', level: 2, band: 'low', changedPick: false },
    ...overrides,
  };
}

function abortable<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export class M5bServer {
  readonly requests: RecordedRequest[] = [];

  constructor(public state = initialState(), public handler?: RouteHandler) {}

  install(): void {
    (globalThis as { fetch: unknown }).fetch = jest.fn(
      async (input: string | { url?: string }, init?: RequestInit) => {
        const rawUrl = typeof input === 'string' ? input : (input.url ?? String(input));
        const url = new URL(rawUrl, 'http://localhost');
        const request: RecordedRequest = {
          method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null,
        };
        this.requests.push(request);
        const reply = await abortable(
          Promise.resolve(this.handler?.(request)).then(value => value ?? this.route(request)),
          init?.signal,
        );
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
    if (request.path === '/api/mobile/capabilities/m5b') {
      return { status: 200, body: { success: true, memoryLearning: state.memoryLearning } };
    }
    if (request.path === '/api/mobile/memory/summary') {
      if (!state.memoryLearning) return { status: 404, body: { success: false, error: 'm5b_unavailable' } };
      return { status: 200, body: { success: true, summary: state.summary } };
    }
    if (request.path === '/api/mobile/memory' && request.method === 'GET') {
      return { status: 200, body: { items: state.memoryItems, suggestions: [], adaptive: null } };
    }
    if (/^\/api\/mobile\/memory\/[^/]+$/.test(request.path) && request.method === 'PATCH') {
      return { status: 200, body: { success: true, memory: state.memoryItems[0] } };
    }
    if (request.path === '/api/mobile/profile') {
      return { status: 200, body: { routine: null, updatedAt: null, aiContextImport: null } };
    }
    if (request.path === '/api/mobile/profile/routine' && request.method === 'PUT') {
      const body = request.body as Record<string, unknown>;
      return { status: 200, body: {
        success: true,
        routine: { schemaVersion: 1, updatedAt: NOW.toISOString(), ...body },
        facts: { created: 0, superseded: 0, revoked: 0, unchanged: 0 },
      } };
    }
    if (request.path === '/api/mobile/pilot/trust') return { status: 200, body: trust() };
    if (request.path === '/api/mobile/readiness' && request.method === 'GET') {
      return { status: 200, body: state.readiness };
    }
    if (request.path === '/api/mobile/readiness' && request.method === 'PUT') {
      return { status: 200, body: { success: true, result: 'stored' } };
    }
    if (request.path === `/api/mobile/plans/${TODAY}` && request.method === 'GET') {
      return state.plan
        ? { status: 200, body: { success: true, plan: state.plan, proposal: null } }
        : { status: 404, body: { success: false, error: 'not_found', reason: 'not_found' } };
    }
    if (/^\/api\/mobile\/plans\/\d{4}-\d{2}-\d{2}$/.test(request.path) && request.method === 'GET') {
      return { status: 404, body: { success: false, error: 'not_found', reason: 'not_found' } };
    }
    if (request.path === `/api/mobile/plans/${TODAY}/opened`) return { status: 200, body: { success: true } };
    if (request.path === `/api/mobile/plans/${TODAY}/build` || request.path === `/api/mobile/plans/${TODAY}/regenerate`) {
      state.plan = plan();
      return { status: 200, body: { success: true, plan: state.plan, proposal: null } };
    }
    if (request.path === '/api/mobile/settings/plan') {
      return { status: 200, body: { success: true, planSettings: {
        enabled: true, deliveryLocalTime: '07:30', timezone: ZONE,
        nextRunAt: '2030-03-30T04:30:00.000Z', continuousReplanEnabled: true,
      } } };
    }
    if (request.path === '/api/mobile/recommendations/next-step') {
      return { status: 200, body: nextStep(state.energy) };
    }
    if (request.path === '/api/mobile/recommendations/next-step/actions') {
      return { status: 409, body: { success: false, error: 'conflict', reason: 'stale_proposal' } };
    }
    if (request.path === '/api/mobile/commitments/today') {
      return { status: 200, body: { items: [commitment()], calendarOrphans: [] } };
    }
    if (request.path === '/api/mobile/commitments/upcoming') return { status: 200, body: { items: [] } };
    if (request.path === '/api/mobile/consents') {
      return { status: 200, body: {
        aiProcessing: { state: 'granted', version: 'ai-consent-v1', changedAt: NOW.toISOString(), asked: true },
        recommendations: { state: 'granted', version: 'rec-consent-v1', changedAt: NOW.toISOString(), asked: true },
        personalization: { state: 'granted', version: 'personalization-consent-v1', changedAt: NOW.toISOString(), asked: true },
        currentVersions: {
          aiProcessing: 'ai-consent-v1', recommendations: 'rec-consent-v1', personalization: 'personalization-consent-v1',
        },
        currentVersion: 'ai-consent-v1',
      } };
    }
    if (request.path === '/api/mobile/plans/week') {
      return { status: 200, body: { success: true, today: TODAY, saved: [] } };
    }
    if (request.path === '/api/mobile/weekly-blocks/occurrences') {
      return { status: 200, body: { success: true, occurrences: [] } };
    }
    if (request.path === '/api/mobile/capabilities/m4b') {
      return { status: 200, body: { success: true, externalClashHold: false, eveningImpact: false, smartPostpone: false } };
    }
    if (request.path === '/api/mobile/football') {
      return { status: 200, body: { success: true, providerConfigured: false, clubs: [], followedClubIds: [], fixtures: [] } };
    }
    if (request.path === '/api/mobile/settings/categories') {
      return { status: 200, body: { success: true, categoryPreferences: { grouping: false, enabled: [] } } };
    }
    return { status: 404, body: { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' } };
  }
}

function commitment() {
  return {
    id: 'task-1', kind: 'task', title: 'Write the report', description: null, person: null,
    status: 'active', priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: '2030-03-29T17:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: ZONE },
    currentAckState: 'not_seen', postponedUntil: null, createdAt: '2030-03-01T09:00:00.000Z',
    updatedAt: '2030-03-01T09:00:00.000Z', confirmedAt: '2030-03-01T09:00:00.000Z',
    completedAt: null, droppedAt: null, rank: 0, reasonCodes: [], deviceCalendarLink: null,
  };
}

function trust() {
  return {
    success: true, participantId: ACCOUNT_A.uid,
    trust: {
      version: 'v1', participantId: ACCOUNT_A.uid, recommendationConsent: true, analyticsConsent: false,
      calendarConsent: false, firstValueAt: null, quietMode: false, revokedAt: null, deletedAt: null,
      updatedAt: NOW.toISOString(),
    },
    exposure: { allowed: true, reason: 'pilot' },
    whatKnows: {
      version: 'v1', participantId: ACCOUNT_A.uid, confirmedCommitmentCount: 1,
      recommendationConsent: true, analyticsConsent: false, calendarConnected: false,
      privateMessageIngestion: false, sensitiveInference: false, medicalProfile: false,
    },
  };
}

export interface M5bHarness {
  client: QueryClient;
  repository: ReturnType<typeof createFakeAuthRepository>;
  server: M5bServer;
}

export async function prepare(
  language: 'ar' | 'en' | 'he' = 'en',
  state = initialState(),
  handler?: RouteHandler,
): Promise<M5bHarness> {
  onlineManager.setOnline(true);
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  const client = new QueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 1_000 }, mutations: { retry: false } } });
  const repository = createFakeAuthRepository({ initialUser: ACCOUNT_A, idToken: 'm5b-token' });
  const server = new M5bServer(state, handler);
  server.install();
  return { client, repository, server };
}

export function Providers({ harness, children }: { harness: M5bHarness; children: React.ReactNode }) {
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

export async function showKnows(harness: M5bHarness) {
  return render(<Providers harness={harness}><KnowsScreen onBack={() => {}} onMemory={() => {}} /></Providers>);
}

export async function showMemory(harness: M5bHarness) {
  return render(<Providers harness={harness}><MemoryScreen onBack={() => {}} /></Providers>);
}

export async function showPlan(harness: M5bHarness) {
  return render(<Providers harness={harness}><PlanScreen date={TODAY} onBack={() => {}} /></Providers>);
}

export async function showReadiness(harness: M5bHarness) {
  return render(<Providers harness={harness}><ReadinessSettingsScreen onBack={() => {}} /></Providers>);
}

export async function showToday(harness: M5bHarness) {
  return render(<Providers harness={harness}><TodayScreen /></Providers>);
}

export async function press(testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(screen.getByTestId(testID)); });
}

export async function waitForRequest(harness: M5bHarness, method: string, pattern: RegExp, count = 1) {
  await waitFor(() => expect(harness.server.matching(method, pattern)).toHaveLength(count));
  return harness.server.matching(method, pattern)[count - 1]!;
}

export async function teardown(harness?: M5bHarness): Promise<void> {
  await cleanup();
  harness?.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
}
