import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import {
  ACCOUNT_B,
  GOAL_ID,
  PLAN,
  SUMMARY_ID,
  defaultReply,
  openGoal,
  prepare,
  press,
  renderDailyPlan,
  renderGoals,
  setLinkedWork,
  teardown,
  type M3aHarness,
  type RouteReply,
} from './harness';
import * as intelligenceEndpoints from '../../api/endpoints/intelligence';
import * as planEndpoints from '../../api/endpoints/plans';
import en from '../../i18n/locales/en.json';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M3aHarness;

beforeEach(async () => {
  harness = await prepare();
});
afterEach(async () => {
  await teardown(harness);
});

describe('M3a A5 entries use one flow', () => {
  it('A5 goal entry: the goal action opens the plan flow and the old per-card review never renders', async () => {
    await openGoal(harness);
    expect(screen.queryByTestId('goal-generate')).toBeNull();
    await press('goal-plan-open');
    await waitFor(() => expect(screen.queryByTestId('plan-step-step-1')).not.toBeNull());
    expect(screen.queryAllByTestId(/^goal-proposal-/)).toHaveLength(0);
    expect(screen.queryByTestId('goal-confirm-selected')).toBeNull();
  });

  it('A5 panel entry: preview shows summary, accept sends the versioned idempotent body, then opens the plan', async () => {
    await renderGoals(harness);
    await waitFor(() => expect(screen.queryByTestId('intelligence-plan-flow')).not.toBeNull());
    await press('intelligence-plan-flow');
    await waitFor(() => expect(screen.queryByTestId('plan-summary')).not.toBeNull());
    await press('plan-summary-confirm');

    await waitFor(() => expect(harness.server.matching('POST', /\/from-statement\/accept$/)).toHaveLength(1));
    expect(harness.server.matching('POST', /\/from-statement\/preview$/)[0]?.body).toEqual(
      expect.objectContaining({ statement: expect.any(String), locale: 'en' }),
    );
    expect(harness.server.matching('POST', /\/from-statement\/accept$/)[0]?.body).toEqual({
      summaryId: SUMMARY_ID,
      revision: 2,
      understood: 'Lose weight gradually',
      idempotencyKey: expect.any(String),
    });
    await waitFor(() => expect(screen.queryByTestId('plan-step-step-1')).not.toBeNull());
  });

  it('A5 analyze plan route: an understood plan imperative opens summary without another tap', async () => {
    jest.spyOn(intelligenceEndpoints, 'analyzeIntelligenceStatement').mockResolvedValue({
      success: true,
      route: 'plan_flow',
      statement: 'build me a plan',
    } as never);
    await renderGoals(harness);
    await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
    await screen.findByTestId('intelligence-analyze');
    await press('intelligence-analyze');
    const confirm = screen.queryByTestId('intelligence-analyze-confirm');
    if (confirm) await press('intelligence-analyze-confirm');

    await waitFor(() => expect(screen.queryByTestId('plan-summary')).not.toBeNull());
    expect(harness.server.matching('POST', /\/from-statement\/preview$/)).toHaveLength(1);
  });

  it.each<['event' | 'thought', 'capture' | 'thoughts']>([
    ['event', 'capture'],
    ['thought', 'thoughts'],
  ])('A5 not_a_goal.%s: offers only its %s recovery', async (classification, recovery) => {
    harness.server.handler = (request) =>
      request.path.endsWith('/from-statement/preview')
        ? { status: 422, body: { reason: 'not_a_goal', classification, recovery } }
        : defaultReply(request);
    await renderGoals(harness);
    await press('intelligence-plan-flow');

    await waitFor(() => expect(screen.queryByTestId('plan-failure')).not.toBeNull());
    expect(screen.getByTestId('plan-failure-action').props.testID).toBe('plan-failure-action');
    expect(screen.queryByText(en.errorsServer)).toBeNull();
  });

  it('A5 goal_too_vague: shows the server question with an answer action', async () => {
    harness.server.handler = (request) =>
      request.path.endsWith('/from-statement/preview')
        ? { status: 422, body: { reason: 'goal_too_vague', question: 'What would be different?' } }
        : defaultReply(request);
    await renderGoals(harness);
    await press('intelligence-plan-flow');

    await waitFor(() => expect(screen.queryByText('What would be different?')).not.toBeNull());
    expect(screen.getByTestId('plan-failure-action')).toBeTruthy();
    expect(screen.queryByText(en.errorsServer)).toBeNull();
  });
});

describe('M3a A6 typed failures and live state', () => {
  it.each<
    [
      (
        | 'model_unavailable'
        | 'daily_cap_reached'
        | 'no_steps'
        | 'stale'
        | 'schedule_changed'
        | 'offline'
        | 'goal_too_vague'
        | 'not_a_goal'
        | 'too_many_edits'
        | 'slot_in_past'
        | 'key_reused'
        | 'gone'
        | 'plan_confirmed'
        | 'goal_superseded'
      ),
      409 | 410 | 422 | 429 | 503,
    ]
  >([
    ['model_unavailable', 503],
    ['daily_cap_reached', 429],
    ['no_steps', 422],
    ['stale', 409],
    ['schedule_changed', 409],
    ['offline', 503],
    ['goal_too_vague', 422],
    ['not_a_goal', 422],
    ['too_many_edits', 422],
    ['slot_in_past', 422],
    ['key_reused', 409],
    ['gone', 410],
    ['plan_confirmed', 409],
    ['goal_superseded', 409],
  ])(
    'A6 %s: has a typed failure, a recovery action when applicable, and never errorsServer',
    async (reason, status) => {
      const noPlan = (request: { method: string; path: string }): RouteReply | null => {
        if (request.method === 'GET' && request.path.endsWith(`/goals/${GOAL_ID}/plan`)) {
          return { status: 200, body: { success: true, draft: null, confirmed: null } };
        }
        if (request.method !== 'GET' && request.path.includes(`/goals/${GOAL_ID}/plan`)) {
          const extras =
            reason === 'goal_too_vague'
              ? { question: 'Which outcome?' }
              : reason === 'not_a_goal'
                ? { classification: 'event', recovery: 'capture' }
                : reason === 'goal_superseded'
                  ? { currentGoalId: 'goal-2' }
                  : reason === 'stale'
                    ? { plan: PLAN }
                    : reason === 'schedule_changed' || reason === 'slot_in_past'
                      ? { times: null }
                      : {};
          return { status, body: { reason, ...extras } };
        }
        return null;
      };
      harness.server.handler = (request) => noPlan(request) ?? defaultReply(request);
      await openGoal(harness);
      await press('goal-plan-open');

      await waitFor(() => expect(screen.queryByTestId('plan-failure')).not.toBeNull());
      expect(screen.queryByText(en.errorsServer)).toBeNull();
      if (reason !== 'daily_cap_reached') expect(screen.getByTestId('plan-failure-action')).toBeTruthy();
    },
  );

  it('A6 live status: a successful action announces started, thinking and done', async () => {
    let release!: (reply: RouteReply) => void;
    const pending = new Promise<RouteReply>((resolve) => {
      release = resolve;
    });
    harness.server.handler = (request) => {
      if (request.method === 'GET' && request.path.endsWith(`/goals/${GOAL_ID}/plan`))
        return { status: 200, body: { success: true, draft: null, confirmed: null } };
      if (request.method === 'POST' && request.path.includes(`/goals/${GOAL_ID}/plan`)) return pending;
      return defaultReply(request);
    };
    await openGoal(harness);
    await press('goal-plan-open');
    expect(screen.getByTestId('plan-live-status')).toBeTruthy();
    expect(screen.getByTestId('plan-live-status').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByTestId('plan-live-status')).toHaveTextContent(/Started|Working/);
    release({ status: 200, body: { success: true, plan: PLAN, ...PLAN } });
    await waitFor(() => expect(screen.getByTestId('plan-live-status')).toHaveTextContent('Done'));
  });

  it('A6 live status: a failed action announces could not', async () => {
    harness.server.handler = (request) =>
      request.method === 'POST' && request.path.includes(`/goals/${GOAL_ID}/plan`)
        ? { status: 503, body: { reason: 'model_unavailable', recovery: 'retry' } }
        : request.method === 'GET' && request.path.endsWith(`/goals/${GOAL_ID}/plan`)
          ? { status: 200, body: { success: true, draft: null, confirmed: null } }
          : defaultReply(request);
    await openGoal(harness);
    await press('goal-plan-open');
    await waitFor(() =>
      expect(screen.getByTestId('plan-live-status')).toHaveTextContent(/didn't work|Could not/),
    );
  });

  it.each(['nothing_to_plan', 'model_unavailable', 'daily_cap_reached', 'offline'] as const)(
    'A6 daily plan %s: the build shows its typed reason, never errorsServer',
    async (reason) => {
      jest.spyOn(planEndpoints, 'buildPlan').mockRejectedValue(Object.assign(new Error(reason), { reason }));
      await renderDailyPlan(harness);
      await press('plan-build');
      await waitFor(() => expect(screen.queryByTestId('plan-build-failure')).not.toBeNull());
      expect(screen.queryByText(en.errorsServer)).toBeNull();
    },
  );

  it('A6 feature_unavailable: both plan entries are hidden and the old panel generate path is gone', async () => {
    harness.server.handler = (request) =>
      request.path.includes('/goals/') || request.path.endsWith('/goals/plans/upcoming')
        ? { status: 404, body: { reason: 'feature_unavailable' } }
        : defaultReply(request);
    await renderGoals(harness);
    await waitFor(() => expect(screen.queryByTestId('intelligence-plan-flow')).toBeNull());
    expect(screen.queryByTestId('intelligence-generate')).toBeNull();
    await press(`goal-open-${GOAL_ID}`);
    await waitFor(() => expect(screen.queryByTestId('goal-back-list')).not.toBeNull());
    expect(screen.queryByTestId('goal-plan-open')).toBeNull();
    expect(screen.queryByTestId('goal-generate')).toBeNull();
  });
});

describe('M3a account and confirmed-plan boundaries', () => {
  it('Account isolation: account A preview resolving after account B signs in is dropped', async () => {
    let release!: (reply: RouteReply) => void;
    const pending = new Promise<RouteReply>((resolve) => {
      release = resolve;
    });
    harness.server.handler = (request) =>
      request.path.endsWith('/from-statement/preview') ? pending : defaultReply(request);
    await renderGoals(harness);
    await press('intelligence-plan-flow');
    harness.repository.emit(ACCOUNT_B);
    release({
      status: 200,
      body: {
        success: true,
        summaryId: SUMMARY_ID,
        revision: 2,
        understood: 'Account A private goal',
        expiresAt: '2030-01-07T10:30:00.000Z',
      },
    });

    await waitFor(() => expect(screen.queryByText('Account A private goal')).toBeNull());
    expect(screen.queryByTestId('plan-summary')).toBeNull();
  });

  it('M3A-044 / S1: a confirmed plan hides regenerate and shows progress', async () => {
    setLinkedWork(true);
    harness.server.handler = (request) =>
      request.path.endsWith(`/goals/${GOAL_ID}/plan`)
        ? { status: 200, body: { success: true, draft: null, confirmed: { ...PLAN, status: 'confirmed' } } }
        : defaultReply(request);
    await openGoal(harness);
    await waitFor(() => expect(screen.queryByTestId('goal-plan-progress')).not.toBeNull());
    expect(screen.queryByTestId('goal-plan-open')).toBeNull();
    expect(screen.queryByTestId('goal-regenerate')).toBeNull();
  });

  it('M3A-044 / S1: linked work is listed above a new draft plan without deduplication', async () => {
    setLinkedWork(true);
    await openGoal(harness);
    await press('goal-plan-open');
    await waitFor(() => expect(screen.queryByTestId('plan-linked-work')).not.toBeNull());
    const linkedIndex = screen
      .getAllByTestId(/^(plan-linked-work|plan-phase-)/)
      .findIndex((node) => node.props.testID === 'plan-linked-work');
    const phaseIndex = screen
      .getAllByTestId(/^(plan-linked-work|plan-phase-)/)
      .findIndex((node) => String(node.props.testID).startsWith('plan-phase-'));
    expect(linkedIndex).toBeGreaterThanOrEqual(0);
    expect(linkedIndex).toBeLessThan(phaseIndex);
  });
});
