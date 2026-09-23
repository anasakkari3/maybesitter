/**
 * Today, the plan and the next step are three server computations over the
 * same commitments (Round 2, Phase C). A change to one must invalidate the
 * other two, or the screen can show a thing as both finished and scheduled.
 *
 * Both gaps this pins were real: completing a commitment did not touch the
 * plan, and accepting a plan did not touch the next step.
 */
import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Text } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../auth/fakeAuthRepository';
import { setAuthRepository, resetAuthForTests } from '../auth';
import { createAppQueryClient } from '../queryClient';
import { queryKeys, useCommitmentAction, usePlanAction } from '../queries';
import { ApiProvider } from '../ui/ApiProvider';
import type { AuthUser } from '../../auth/types';
import type { DailyPlan } from '../schemas/plan';
import * as commitments from '../endpoints/commitments';
import * as plans from '../endpoints/plans';

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'alice', email: null, emailVerified: true, displayName: null, providerIds: ['password'] };
const DATE = '2026-09-22';
const PLAN: DailyPlan = {
  date: DATE, timezone: 'Asia/Amman', status: 'proposed', generation: 1, inputDigest: 'x', generatedAt: '2026-09-22T04:00:00.000Z',
  acceptedAt: null, explanation: { text: '', locale: 'ar', source: 'template' }, scheduled: [], unscheduled: [], edited: false, protections: [],
};

let repository: FakeAuthRepository;
let client: ReturnType<typeof createAppQueryClient>;

beforeEach(() => {
  client = createAppQueryClient();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  onlineManager.setOnline(true);
});
afterEach(() => { client.clear(); resetAuthForTests(); jest.restoreAllMocks(); });

let actions: { complete: (id: string) => void; accept: () => void } | null = null;
function Probe() {
  const act = useCommitmentAction();
  const planAct = usePlanAction(DATE);
  // Handed out from an effect, not during render: the mutation hooks are
  // stable, and a render must not write to module scope.
  useEffect(() => {
    actions = {
      complete: (id) => act.mutate({ id, action: 'complete' }),
      accept: () => planAct.mutate('accept'),
    };
  }, [act, planAct]);
  return <Text testID="probe">{act.isSuccess || planAct.isSuccess ? 'done' : 'idle'}</Text>;
}

async function mount() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <ApiProvider client={client}><Probe /></ApiProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(actions).not.toBeNull());
}

const seeded = () => {
  client.setQueryData(queryKeys.plan('alice', DATE), PLAN);
  client.setQueryData(queryKeys.nextStep('alice', 'en'), { success: true, participantId: 'alice', recommendation: { version: '1', proposalId: 'p', state: 'empty', locale: 'en' } });
  client.setQueryData(queryKeys.today('alice', 'Asia/Amman'), { items: [] });
};
const invalidated = (key: readonly unknown[]) => client.getQueryState(key as unknown[])?.isInvalidated === true;

describe('one truth across Today, the plan and the next step', () => {
  it('finishing a commitment invalidates the plan and the next step, not just the lists', async () => {
    jest.spyOn(commitments, 'actOnCommitment').mockResolvedValue({ success: true } as never);
    await mount();
    seeded();
    await act(async () => { actions!.complete('c1'); });
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('done'));
    expect(invalidated(queryKeys.plan('alice', DATE))).toBe(true);
    expect(invalidated(queryKeys.nextStep('alice', 'en'))).toBe(true);
    expect(invalidated(queryKeys.today('alice', 'Asia/Amman'))).toBe(true);
  });

  it('accepting the plan writes the plan and invalidates the next step and the lists', async () => {
    jest.spyOn(plans, 'actOnPlan').mockResolvedValue({ ...PLAN, status: 'accepted' } as never);
    await mount();
    seeded();
    await act(async () => { actions!.accept(); });
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('done'));
    expect(client.getQueryData<DailyPlan>(queryKeys.plan('alice', DATE))?.status).toBe('accepted');
    expect(invalidated(queryKeys.nextStep('alice', 'en'))).toBe(true);
    expect(invalidated(queryKeys.today('alice', 'Asia/Amman'))).toBe(true);
  });
});
