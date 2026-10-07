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
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { GoalExecutionScreen } from '../../features/goals/GoalExecutionScreen';
import { TodayScreen } from '../../screens/TodayScreen';
import { PlanScreen } from '../../screens/PlanScreen';
import { Root } from '../../Root';
import * as intelligenceEndpoints from '../../api/endpoints/intelligence';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as nextStepEndpoints from '../../api/endpoints/nextStep';
import * as consentEndpoints from '../../api/endpoints/consents';
import * as planEndpoints from '../../api/endpoints/plans';
import * as profileEndpoints from '../../api/endpoints/profile';
import * as footballEndpoints from '../../api/endpoints/football';
import * as goalEndpoints from '../../api/endpoints/goals';
import * as habitEndpoints from '../../api/endpoints/habits';

export const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

export const ACCOUNT_A: AuthUser = {
  uid: 'm3a-account-a',
  email: 'a@example.com',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

export const ACCOUNT_B: AuthUser = {
  ...ACCOUNT_A,
  uid: 'm3a-account-b',
  email: 'b@example.com',
};

export const GOAL_ID = 'goal-1';
export const PLAN_ID = 'plan-1';
export const TIMES_ID = 'times-1';
export const SUMMARY_ID = 'summary-1';

export const PLAN = {
  planId: PLAN_ID,
  goalId: GOAL_ID,
  revision: 7,
  language: 'en',
  summary: { goalText: 'Lose weight' },
  horizon: 'weeks',
  status: 'draft',
  source: 'model',
  removedSteps: [{ stepId: 'removed-1', title: 'Buy a scale' }],
  steps: [
    {
      stepId: 'step-1',
      order: 1,
      phase: { unit: 'week', index: 1 },
      title: 'Plan three lunches',
      kind: 'commitment',
      durationMinutes: 30,
      buildsOn: null,
      expectedOutcome: 'A short lunch list',
      origin: 'model',
    },
    {
      stepId: 'step-2',
      order: 2,
      phase: { unit: 'week', index: 1 },
      title: 'Walk after lunch',
      kind: 'habit',
      durationMinutes: 20,
      rhythm: { timesPerWeek: 3, timeOfDay: 'afternoon' },
      buildsOn: 'Uses the lunch cue',
      expectedOutcome: 'Three walks completed',
      origin: 'model',
    },
    {
      stepId: 'step-none',
      order: 3,
      phase: { unit: 'week', index: 2 },
      title: 'Prepare walking shoes',
      kind: 'commitment',
      durationMinutes: 10,
      buildsOn: null,
      expectedOutcome: null,
      origin: 'person',
    },
    {
      stepId: 'step-4',
      order: 4,
      phase: { unit: 'week', index: 2 },
      title: 'Find a class',
      kind: 'commitment',
      durationMinutes: 30,
      buildsOn: null,
      expectedOutcome: null,
      origin: 'model',
    },
    {
      stepId: 'step-3',
      order: 5,
      phase: { unit: 'week', index: 3 },
      title: 'Review the routine',
      kind: 'commitment',
      durationMinutes: 15,
      buildsOn: null,
      expectedOutcome: null,
      origin: 'model',
    },
  ],
} as const;

export const TIMES = {
  planId: PLAN_ID,
  planRevision: 8,
  timesId: TIMES_ID,
  timesRevision: 4,
  anchor: { localDate: '2030-01-07', timezone: 'UTC' },
  steps: [
    {
      stepId: 'step-1',
      kind: 'commitment',
      slot: { startsAt: '2030-01-08T09:00:00.000Z', endsAt: '2030-01-08T09:30:00.000Z' },
      alternatives: [{ startsAt: '2030-01-08T11:00:00.000Z', endsAt: '2030-01-08T11:30:00.000Z' }],
      choice: 'proposed',
    },
    {
      stepId: 'step-2',
      kind: 'habit',
      weekly: { weekdays: [1, 3, 5], start: '14:00', end: '14:20' },
      alternatives: [{ weekdays: [2, 4, 6], start: '15:00', end: '15:20' }],
      choice: 'proposed',
    },
    { stepId: 'step-3', kind: 'commitment', later: { weekIndex: 3 } },
    {
      stepId: 'step-none',
      kind: 'commitment',
      slot: null,
      alternatives: [{ startsAt: '2030-01-09T09:00:00.000Z', endsAt: '2030-01-09T09:10:00.000Z' }],
      choice: 'none',
    },
    {
      stepId: 'step-4',
      kind: 'commitment',
      slot: null,
      reason: 'no_free_time_in_phase',
      alternatives: [],
      choice: 'none',
    },
  ],
} as const;

export const RESULT = {
  saved: [
    {
      stepId: 'step-1',
      entity: 'commitment',
      id: 'commitment-1',
      title: 'Plan three lunches',
      when: { kind: 'slot', startsAt: '2030-01-08T09:00:00.000Z', endsAt: '2030-01-08T09:30:00.000Z' },
    },
    {
      stepId: 'step-2',
      entity: 'habit',
      id: 'habit-1',
      title: 'Walk after lunch',
      when: { kind: 'weekly', weekdays: [1, 3, 5], start: '14:00', end: '14:20' },
    },
    {
      stepId: 'step-none',
      entity: 'commitment',
      id: 'commitment-2',
      title: 'Untimed step',
      when: { kind: 'none' },
    },
  ],
  stayed: [
    { stepId: 'step-3', title: 'Review the routine', why: { kind: 'later_week', weekIndex: 3 } },
    { stepId: 'removed-1', title: 'Buy a scale', why: { kind: 'removed' } },
    { stepId: 'step-4', title: 'Find a class', why: { kind: 'no_room', reason: 'no_free_time_in_phase' } },
  ],
  receipt: { outcomeId: 'outcome-1', replayed: false },
} as const;

export type RecordedRequest = { method: string; path: string; body: unknown };
export type RouteReply = { status: number; body: unknown };
export type RouteHandler = (request: RecordedRequest) => RouteReply | Promise<RouteReply>;

export class M3aServer {
  readonly requests: RecordedRequest[] = [];
  readonly answeredRequests: RecordedRequest[] = [];
  handler: RouteHandler;

  constructor(handler: RouteHandler = defaultReply) {
    this.handler = handler;
  }

  install(): void {
    (globalThis as { fetch: unknown }).fetch = jest.fn(
      async (input: string | { url?: string }, init?: RequestInit) => {
        const rawUrl = typeof input === 'string' ? input : (input.url ?? String(input));
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
        const request = { method, path: new URL(rawUrl, 'http://localhost').pathname, body };
        this.requests.push(request);
        const reply = await this.handler(request);
        this.answeredRequests.push(request);
        return { status: reply.status, text: async () => JSON.stringify(reply.body) };
      },
    ) as never;
  }

  matching(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && pattern.test(request.path));
  }

  answeredMatching(method: string, pattern: RegExp): RecordedRequest[] {
    return this.answeredRequests.filter((request) => request.method === method && pattern.test(request.path));
  }
}

function envelope<T extends object>(value: T, key: string): Record<string, unknown> {
  return { success: true, [key]: value };
}

export function defaultReply(request: RecordedRequest): RouteReply {
  if (request.path.endsWith('/from-statement/preview')) {
    return {
      status: 200,
      body: {
        success: true,
        summaryId: SUMMARY_ID,
        revision: 2,
        understood: { goalText: 'Lose weight gradually' },
        expiresAt: '2030-01-07T10:30:00.000Z',
      },
    };
  }
  if (request.path.endsWith('/from-statement/accept'))
    return { status: 200, body: { success: true, goalId: GOAL_ID } };
  if (request.path.endsWith('/plans/upcoming')) {
    return {
      status: 200,
      body: {
        success: true,
        items: [
          {
            goalId: GOAL_ID,
            planId: PLAN_ID,
            goalTitle: 'Lose weight',
            weekIndex: 3,
            weekStartsAt: '2030-01-21T00:00:00.000Z',
            stepCount: 1,
          },
        ],
      },
    };
  }
  if (request.path.endsWith('/approve')) {
    return {
      status: 200,
      body: {
        success: true,
        plan: { ...PLAN, revision: TIMES.planRevision, status: 'approved' },
        times: TIMES,
      },
    };
  }
  if (/\/times\/[^/]+$/.test(request.path)) {
    const noneChosen =
      typeof request.body === 'object' &&
      request.body !== null &&
      'choice' in request.body &&
      typeof request.body.choice === 'object' &&
      request.body.choice !== null &&
      'none' in request.body.choice &&
      request.body.choice.none === true;
    const stepId = request.path.split('/').at(-1);
    const steps = noneChosen
      ? TIMES.steps.map((step) =>
          step.stepId === stepId
            ? {
                stepId: step.stepId,
                kind: step.kind,
                slot: null,
                ...('alternatives' in step ? { alternatives: step.alternatives } : {}),
                choice: 'none',
              }
            : step,
        )
      : TIMES.steps;
    return {
      status: 200,
      body: envelope({ ...TIMES, timesRevision: TIMES.timesRevision + 1, steps }, 'times'),
    };
  }
  if (/\/later\/\d+\/times$/.test(request.path)) {
    return {
      status: 200,
      body: {
        success: true,
        plan: { ...PLAN, status: 'confirmed' },
        times: { ...TIMES, steps: TIMES.steps.filter((step) => 'later' in step) },
      },
    };
  }
  if (request.path.endsWith('/confirm')) return { status: 200, body: { success: true, ...RESULT } };
  if (/\/plans\/[^/]+$/.test(request.path) && request.method === 'PATCH') {
    const op =
      typeof request.body === 'object' && request.body !== null && 'op' in request.body
        ? request.body.op
        : null;
    if (typeof op === 'object' && op !== null && 'op' in op && op.op === 'remove' && 'stepId' in op) {
      const removed = PLAN.steps.find((step) => step.stepId === op.stepId);
      return {
        status: 200,
        body: envelope(
          {
            ...PLAN,
            revision: PLAN.revision + 1,
            steps: PLAN.steps.filter((step) => step.stepId !== op.stepId),
            removedSteps: removed
              ? [...PLAN.removedSteps, { stepId: removed.stepId, title: removed.title }]
              : PLAN.removedSteps,
          },
          'plan',
        ),
      };
    }
    if (typeof op === 'object' && op !== null && 'op' in op && op.op === 'restore' && 'stepId' in op) {
      return {
        status: 200,
        body: envelope({ ...PLAN, revision: PLAN.revision + 2 }, 'plan'),
      };
    }
    return { status: 200, body: envelope({ ...PLAN, revision: PLAN.revision + 1 }, 'plan') };
  }
  if (request.method === 'GET' && request.path.endsWith(`/goals/${GOAL_ID}/plan`)) {
    return {
      status: 200,
      body: {
        success: true,
        draft: PLAN,
        confirmed: null,
        linkedWork: mockLinked
          ? [{ entity: 'commitment', id: 'commitment-1', title: 'Plan three lunches' }]
          : [],
      },
    };
  }
  if (request.path.includes(`/goals/${GOAL_ID}/plan`)) {
    return { status: 200, body: { success: true, plan: PLAN } };
  }
  return {
    status: 404,
    body: { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' },
  };
}

let mockLinked = false;

export interface M3aHarness {
  client: QueryClient;
  repository: ReturnType<typeof createFakeAuthRepository>;
  server: M3aServer;
}

export async function prepare(language: 'ar' | 'en' = 'en', server = new M3aServer()): Promise<M3aHarness> {
  mockLinked = false;
  onlineManager.setOnline(true);
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const repository = createFakeAuthRepository({ initialUser: ACCOUNT_A, idToken: 'm3a-token' });
  setAuthRepository(repository);
  server.install();

  jest
    .spyOn(intelligenceEndpoints, 'getIntelligenceInbox')
    .mockResolvedValue({ success: true, observations: [], suggestions: [], schedule: [] } as never);
  jest
    .spyOn(intelligenceEndpoints, 'getGmailIntelligenceMonitor')
    .mockResolvedValue({ success: true, enabled: false, lastSuccessAt: null, error: null } as never);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [], calendarOrphans: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue({
    success: true,
    participantId: ACCOUNT_A.uid,
    recommendation: {
      version: 'v1',
      proposalId: 'empty',
      state: 'empty',
      locale: 'en',
      primaryStep: null,
      explanation: null,
    },
  } as never);
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue({
    aiProcessing: { state: 'granted' },
    recommendations: { state: 'granted' },
    personalization: { state: 'granted' },
  } as never);
  jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(null as never);
  jest.spyOn(planEndpoints, 'getSavedWeek').mockResolvedValue(null as never);
  jest.spyOn(profileEndpoints, 'listMemory').mockResolvedValue(MEMORY as never);
  jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ profile: null } as never);
  jest.spyOn(footballEndpoints, 'getFootballSettings').mockRejectedValue(new Error('off'));
  jest
    .spyOn(goalEndpoints, 'getGoalExecution')
    .mockImplementation(async () => legacyGoalExecution() as never);
  jest.spyOn(habitEndpoints, 'listHabits').mockResolvedValue([] as never);

  return { client, repository, server };
}

export function setLinkedWork(value: boolean): void {
  mockLinked = value;
}

export async function renderGoals(harness: M3aHarness): Promise<void> {
  await render(providers(harness, <GoalExecutionScreen />));
  await waitFor(() => expect(screen.queryByTestId(`goal-open-${GOAL_ID}`)).not.toBeNull());
}

export async function openGoal(harness: M3aHarness): Promise<void> {
  await renderGoals(harness);
  await press(`goal-open-${GOAL_ID}`);
  await waitFor(() => expect(screen.queryByTestId('goal-back-list')).not.toBeNull());
}

export async function renderToday(harness: M3aHarness): Promise<void> {
  await render(providers(harness, <TodayScreen />));
  await waitFor(() => expect(screen.queryByTestId('query-loading')).toBeNull());
}

export async function renderRoot(harness: M3aHarness): Promise<void> {
  await render(providers(harness, <Root />));
  await waitFor(() => expect(screen.queryByTestId('today-scroll')).not.toBeNull());
}

export async function renderDailyPlan(harness: M3aHarness): Promise<void> {
  await render(providers(harness, <PlanScreen date="2030-01-07" onBack={() => undefined} />));
  await waitFor(() => expect(screen.queryByTestId('plan-empty')).not.toBeNull());
}

export async function teardown(harness: M3aHarness | undefined): Promise<void> {
  await cleanup();
  harness?.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
}

function providers(harness: M3aHarness, child: React.ReactNode): React.ReactElement {
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

export async function press(testID: string): Promise<void> {
  await act(async () => {
    await fireEvent.press(screen.getByTestId(testID));
  });
}

export async function changeText(testID: string, value: string): Promise<void> {
  await act(async () => {
    await fireEvent.changeText(screen.getByTestId(testID), value);
  });
}

export async function valueChange(testID: string, value: unknown): Promise<void> {
  await act(async () => {
    await fireEvent(screen.getByTestId(testID), 'valueChange', value);
  });
}

export function lastRequest(server: M3aServer, method: string, pattern: RegExp): RecordedRequest {
  const request = server.matching(method, pattern).at(-1);
  expect(request).toBeDefined();
  return request!;
}

export function legacyGoalExecution() {
  const linkedNodes = mockLinked
    ? [{ nodeId: 'linked-1', kind: 'linked_commitment', status: 'confirmed', commitmentId: 'commitment-1' }]
    : [];
  return {
    success: true,
    graph: {
      version: 'v1',
      schema: 'goal-graph-v1',
      graphId: 'legacy-graph',
      goalMemoryId: GOAL_ID,
      scopeId: ACCOUNT_A.uid,
      language: 'en',
      nodes: linkedNodes,
      edges: [],
      generatedAt: '2030-01-07T09:00:00.000Z',
      generation: 1,
      provenance: { decompositionProposalId: 'legacy', decompositionOutcome: 'decomposed' },
    },
    progress: {
      scopeId: ACCOUNT_A.uid,
      goalMemoryId: GOAL_ID,
      confirmedCount: linkedNodes.length,
      completedCount: 0,
      nodes: [],
      derivedAt: '2030-01-07T09:00:00.000Z',
      period: { fromLocalDate: '2030-01-07', toLocalDate: '2030-01-13' },
    },
  };
}

export const MEMORY = {
  items: [
    {
      id: GOAL_ID,
      kind: 'goal',
      content: 'Lose weight',
      language: 'en',
      source: 'user_stated',
      sourceLabel: 'you',
      confidence: 1,
      createdAt: '2030-01-01T09:00:00.000Z',
      observedAt: '2030-01-01T09:00:00.000Z',
      staleAfter: null,
      provenance: { origin: 'capture', originRef: 'capture-1' },
      evidence: {
        origin: 'capture',
        observedAt: '2030-01-01T09:00:00.000Z',
        recordedAt: '2030-01-01T09:00:00.000Z',
        confirmedAt: null,
        edited: false,
        observationCount: 0,
        pattern: null,
      },
    },
  ],
  suggestions: [],
  adaptive: null,
};
