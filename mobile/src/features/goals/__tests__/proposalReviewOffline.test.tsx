/**
 * The goal's step review (CXA7.1) says a failed confirm or «اقترح غيرهم»
 * exactly once (lane B6 review): in place, never again by the toast bridge.
 * The reads are stubbed; the two mutations are the real ones, on a real
 * query client, over endpoints that fail offline.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { createAppQueryClient } from '../../../api/queryClient';
import { FeatureUnavailableError, NetworkError } from '../../../api/errors';
import { MutationFailureToasts, UNHANDLED_FAILURE_DELAY_MS } from '../../../api/ui/MutationFailureToasts';
import * as goalEndpoints from '../../../api/endpoints/goals';
import en from '../../../i18n/locales/en.json';
import { GoalExecutionScreen } from '../GoalExecutionScreen';

const mockGraph = {
  version: 'v1', schema: 'goal-graph-v1', graphId: 'graph-1', goalMemoryId: 'goal-1', scopeId: 'user-1', language: 'en',
  nodes: [{ nodeId: 'g1.step.s1', kind: 'decomposition_step_proposal', status: 'proposed', stepId: 's1', title: 'Draft invitation', sourceSpans: [], inferred: false, statedTiming: null, statedOwner: null }],
  edges: [], generatedAt: '2026-11-15T09:00:00.000Z', generation: 1,
  provenance: { decompositionProposalId: 'p-1', decompositionOutcome: 'decomposed' },
};
const mockOff = new FeatureUnavailableError('not found');

jest.mock('../../capture/useCaptureKinds', () => ({ useCaptureKinds: () => ({ pending: false, entries: ['goal'] }) }));
jest.mock('../../settings/featureSettings', () => ({ useFeatures: () => ({ data: { success: true, mode: 'off', features: [] } }) }));
jest.mock('../../../api/queries', () => {
  const actual = jest.requireActual('../../../api/queries') as Record<string, unknown>;
  return {
    ...actual,
    useMemory: () => ({ data: { items: [{ id: 'goal-1', kind: 'goal', content: 'Launch the pilot' }] }, isPending: false, error: null, refetch: jest.fn() }),
    useIntelligenceDecided: () => () => undefined,
    useGoalExecution: () => ({ data: { success: true, graph: mockGraph, progress: { scopeId: 'user-1', goalMemoryId: 'goal-1', confirmedCount: 0, completedCount: 0, nodes: [], derivedAt: '2026-11-15T09:00:00.000Z', period: null } }, isPending: false, isFetching: false, error: null, refetch: jest.fn() }),
    useGoalPlan: () => ({ data: undefined, isSuccess: false, isPending: false, error: mockOff, refetch: jest.fn() }),
    useUpcomingPlans: () => ({ data: undefined, isPending: false, error: mockOff }),
    useHabits: () => ({ data: [], isPending: false, error: null, refetch: jest.fn() }),
    useCommitment: () => ({ data: undefined, isPending: false, error: null, refetch: jest.fn() }),
  };
});

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER = { uid: 'goal-offline-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
let client: ReturnType<typeof createAppQueryClient>;
let toasts: string[];

function ToastLog() {
  const { s } = useApp();
  React.useEffect(() => { if (s.toast) toasts.push(s.toast.text); }, [s.toast]);
  return null;
}

async function openGoal() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={createFakeAuthRepository({ initialUser: USER })} isDevBundle={false}>
          <QueryClientProvider client={client}><GoalExecutionScreen /><MutationFailureToasts /><ToastLog /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('goal-open-goal-1')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('goal-open-goal-1'));
  await waitFor(() => expect(screen.queryByTestId('goal-proposal-g1.step.s1')).not.toBeNull());
  await act(async () => { onlineManager.setOnline(false); });
}

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, UNHANDLED_FAILURE_DELAY_MS + 100)); });
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = createAppQueryClient();
  setAuthRepository(createFakeAuthRepository({ initialUser: USER }));
  toasts = [];
  jest.spyOn(goalEndpoints, 'confirmGoalSelections').mockRejectedValue(new NetworkError('offline'));
  jest.spyOn(goalEndpoints, 'regenerateGoalExecution').mockRejectedValue(new NetworkError('offline'));
});

afterEach(() => {
  onlineManager.setOnline(true);
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

it('a failed confirm is said once, in the review, and the bridge stays quiet', async () => {
  await openGoal();
  await fireEvent.press(screen.getByTestId('goal-proposal-g1.step.s1'));
  await act(async () => { await fireEvent.press(screen.getByTestId('goal-confirm-selected')); });
  await settle();
  expect(screen.getAllByText(en.errorsNetwork)).toHaveLength(1);
  expect(toasts).toEqual([]);
});

it('a failed suggest-others is said once, in the review, and the bridge stays quiet', async () => {
  await openGoal();
  await act(async () => { await fireEvent.press(screen.getByTestId('goal-review-regenerate')); });
  await settle();
  expect(screen.getAllByText(en.errorsNetwork)).toHaveLength(1);
  expect(toasts).toEqual([]);
});
