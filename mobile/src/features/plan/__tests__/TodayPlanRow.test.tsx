import React from 'react';
import { StyleSheet } from 'react-native';
import { tFor } from '../../../i18n';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { TodayPlanRow } from '../TodayPlanRow';
import { composeToday } from '../../today/composeToday';
import { NetworkError } from '../../../api/errors';
import type { DailyPlan } from '../../../api/schemas/plan';
import { deviceTimeZone } from '../../../i18n/timezone';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { deferred } from '../../../testing/deferred';
import { Txt } from '../../../ui/primitives';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';
import todayFixture from '../../../api/__fixtures__/plan.today.json';

import * as planEndpoints from '../../../api/endpoints/plans';

/**
 * The way into today's plan from Today (UC-3.10b, #195 step 4).
 *
 * Every `render` and every `fireEvent` is awaited: RNTL v14 returns promises,
 * and an un-awaited one leaves the next case mounting nothing and passing
 * while asserting about an empty tree.
 *
 * ── Why the state is read from inside the tree ───────────────────
 *
 * `openPlan` is a state change, and the component it changes is the one being
 * rendered. A test that captured it into an outer variable from a render prop
 * would be writing to that variable during React's render phase — the thing
 * RNTL v14 made unsafe. `Probe` renders the state as text instead, which is
 * also closer to what the screen switch in `Root.tsx` actually reads.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'today-plan-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const BASE = todayFixture.plan as DailyPlan;

function planWith(over: Partial<DailyPlan> = {}): DailyPlan {
  return { ...BASE, ...over };
}

/**
 * The day the card is about, worked out without the app's own helper.
 *
 * Derived from the clock this suite is actually running on, never written down
 * as an instant: a literal date here would be right on the afternoon it was
 * typed and wrong for every run afterwards.
 */
function deviceDay(): string {
  const zone = deviceTimeZone();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find(entry => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The app state the card changes, rendered where a test can read it. */
/** The row as Today mounts it: fed the reconciled model's plan state. */
function RowUnderTest() {
  const { usePlan } = require('../../../api/queries') as typeof import('../../../api/queries');
  const { dayKey } = require('../../../i18n/format') as typeof import('../../../i18n/format');
  const query = usePlan(dayKey(new Date(), deviceTimeZone()));
  const model = composeToday({
    groups: { must: [], should: [], nice: [], finished: [] },
    next: { recommendation: undefined, silenced: false, isPending: false, isError: false },
    plan: { plan: query.data, isPending: query.isPending, isError: query.isError },
    upcoming: [],
  });
  return <TodayPlanRow row={model.plan} />;
}

function Probe() {
  const { s } = useApp();
  return <Txt testID="probe">{`${s.screen}:${s.planDate ?? '-'}`}</Txt>;
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  await AsyncStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith() as never);
});

afterEach(() => {
  client.clear();
  onlineManager.setOnline(true);
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <RowUnderTest />
            <Probe />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

async function shown() {
  await show();
  await waitFor(() => expect(screen.queryByTestId('today-plan-card')).not.toBeNull());
}

/**
 * Waits until the plan query has actually answered.
 *
 * `expect(getPlan).toHaveBeenCalled()` is not this: the call happens on the
 * first render, so a `waitFor` on it resolves before the answer arrives and
 * before React has re-rendered with it — which makes "renders nothing" pass on
 * a component that was simply not finished yet. A mutant that deleted the
 * "dismissed stays dismissed" rule survived exactly that assertion.
 *
 * The signed-out key is skipped. The first render happens before the auth
 * repository has answered, and `usePlan` is disabled for `signed-out`, so that
 * query sits at `pending/idle` for the whole test and never settles.
 */
async function planAnswered() {
  await waitFor(() => {
    const queries = client.getQueryCache().findAll({
      predicate: query => query.queryKey.includes('plan') && !query.queryKey.includes('signed-out'),
    });
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      const key = query.queryKey.join('/');
      expect({ key, state: `${query.state.status}/${query.state.fetchStatus}` })
        .toEqual({ key, state: expect.stringMatching(/^(success|error)\/idle$/) });
    }
  });
}

describe('the row is always there, and says which of six things is true', () => {
  it('asks for the plan for the day the device is in', async () => {
    await shown();
    await planAnswered();
    expect(planEndpoints.getPlan).toHaveBeenCalledWith(deviceDay());
  });

  it('says it is still asking, and cannot be opened yet', async () => {
    const pending = deferred<DailyPlan>();
    jest.spyOn(planEndpoints, 'getPlan').mockReturnValue(pending.promise as never);
    await shown();
    expect(screen.getByTestId('today-plan-summary')).toHaveTextContent(en.planRowLoading);
    expect(screen.queryByTestId('today-plan-open')).toBeNull();
    await act(async () => { pending.resolve(planWith()); });
    await planAnswered();
  });

  it('says there is no plan for today, and offers to make one', async () => {
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(null as never);
    await shown();
    await planAnswered();
    await waitFor(() => expect(screen.getByTestId('today-plan-title')).toHaveTextContent(en.planRowNone));
    expect(screen.getByTestId('today-plan-open')).toHaveTextContent(en.planRowMake);
    await fireEvent.press(screen.getByTestId('today-plan-card'));
    expect(screen.getByTestId('probe')).toHaveTextContent(`plan:${deviceDay()}`);
  });

  it('says the plan could not be fetched, and the press is a retry rather than an apology', async () => {
    const spy = jest.spyOn(planEndpoints, 'getPlan').mockRejectedValue(new NetworkError('offline'));
    await shown();
    await planAnswered();
    await waitFor(() => expect(screen.getByTestId('today-plan-summary')).toHaveTextContent(en.planRowFailed));
    spy.mockResolvedValue(planWith());
    await fireEvent.press(screen.getByTestId('today-plan-card'));
    await waitFor(() => expect(screen.getByTestId('today-plan-title')).toHaveTextContent(en.planRowProposal));
    expect(screen.getByTestId('probe')).toHaveTextContent('today:-');
  });

  it('does not come back offering a new one after somebody has said “not today” — but still opens', async () => {
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith({ status: 'dismissed' }));
    await shown();
    await planAnswered();
    await waitFor(() => expect(screen.getByTestId('today-plan-summary')).toHaveTextContent(en.planRowDismissedSub));
    expect(screen.queryByText(en.planRowMake)).toBeNull();
    await fireEvent.press(screen.getByTestId('today-plan-card'));
    expect(screen.getByTestId('probe')).toHaveTextContent(`plan:${deviceDay()}`);
  });

  it('marks a proposal as a proposal, and an accepted plan as saved', async () => {
    await shown();
    await planAnswered();
    await waitFor(() => expect(screen.getByTestId('today-plan-title')).toHaveTextContent(en.planRowProposal));
    expect(screen.getByTestId('today-plan-summary')).toHaveTextContent(en.planRowProposalSub);
    const style = StyleSheet.flatten(screen.getByTestId('today-plan-card').props.style) as { borderStyle?: string; borderWidth?: number };
    expect(style).toMatchObject({ borderStyle: 'dashed', borderWidth: 1.5 });
  });

  it('stays after somebody has accepted, counts what the planner placed, and is not dashed', async () => {
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith({ status: 'accepted', acceptedAt: '2026-09-22T05:00:00.000Z' }));
    await shown();
    await planAnswered();
    const placed = tFor('en')('planCardPlaced', { n: BASE.scheduled.length });
    await waitFor(() => expect(screen.getByTestId('today-plan-summary')).toHaveTextContent(placed));
    expect(screen.getByTestId('today-plan-title')).toHaveTextContent(en.planTitle);
    const style = StyleSheet.flatten(screen.getByTestId('today-plan-card').props.style) as { borderWidth?: number };
    expect(style.borderWidth).toBe(0);
  });

  it('opens that day’s plan, and only on a press', async () => {
    await shown();
    await planAnswered();
    await waitFor(() => expect(screen.getByTestId('today-plan-title')).toHaveTextContent(en.planRowProposal));
    expect(screen.getByTestId('probe')).toHaveTextContent('today:-');
    await fireEvent.press(screen.getByTestId('today-plan-card'));
    expect(screen.getByTestId('probe')).toHaveTextContent(`plan:${deviceDay()}`);
  });
});

describe('in the three languages', () => {
  it.each<[ 'ar' | 'he', typeof ar ]>([['ar', ar], ['he', he]])('%s: the row reads in the language the app is set to', async (tag, bundle) => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, tag);
    await shown();
    await planAnswered();
    await waitFor(() => expect(screen.getByTestId('today-plan-title')).toHaveTextContent(bundle.planRowProposal));
    expect(screen.getByTestId('today-plan-summary')).toHaveTextContent(bundle.planRowProposalSub);
  });
});
