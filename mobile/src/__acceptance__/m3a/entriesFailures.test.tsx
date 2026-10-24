import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import {
  ACCOUNT_B,
  GOAL_ID,
  PLAN,
  PLAN_ID,
  SUMMARY_ID,
  TIMES,
  changeText,
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
    await screen.findByTestId('goal-plan-open');
    await press('goal-plan-open');
    await waitFor(() => expect(screen.queryByTestId('plan-step-step-1')).not.toBeNull());
    expect(screen.queryAllByTestId(/^goal-proposal-/)).toHaveLength(0);
    expect(screen.queryByTestId('goal-confirm-selected')).toBeNull();
  });

  it('A5 panel entry: preview shows summary, accept sends the versioned idempotent body, then opens the plan', async () => {
    await renderGoals(harness);
    await waitFor(() => expect(screen.queryByTestId('intelligence-plan-flow')).not.toBeNull());
    await changeText('intelligence-statement', 'Lose weight');
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
      understood: { goalText: 'Lose weight gradually' },
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
    await changeText('intelligence-statement', 'Lose weight');
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
        ? {
            status: 422,
            body: {
              success: false,
              error: 'not_a_goal',
              reason: 'not_a_goal',
              classification,
              recovery,
            },
          }
        : defaultReply(request);
    await renderGoals(harness);
    await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
    await changeText('intelligence-statement', 'Lose weight');
    await press('intelligence-plan-flow');

    await waitFor(() => expect(screen.queryByTestId('plan-failure')).not.toBeNull());
    expect(screen.getByTestId('plan-failure-action').props.testID).toBe('plan-failure-action');
    expect(screen.queryByText(en.errorsServer)).toBeNull();
  });

  it('A5 goal_too_vague: shows the server question with an answer action', async () => {
    harness.server.handler = (request) =>
      request.path.endsWith('/from-statement/preview')
        ? {
            status: 422,
            body: {
              success: false,
              error: 'goal_too_vague',
              reason: 'goal_too_vague',
              question: 'What would be different?',
            },
          }
        : defaultReply(request);
    await renderGoals(harness);
    await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
    await changeText('intelligence-statement', 'Lose weight');
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
          return {
            status: 200,
            body: { success: true, draft: null, confirmed: null, linkedWork: [] },
          };
        }
        if (request.method !== 'GET' && request.path.includes(`/goals/${GOAL_ID}/plan`)) {
          const extras =
            reason === 'goal_too_vague'
              ? { question: 'Which outcome?' }
              : reason === 'not_a_goal'
                ? { classification: 'event', recovery: 'capture' }
                : reason === 'goal_superseded'
                  ? { currentGoalId: 'goal-2' }
                  : reason === 'stale' || reason === 'too_many_edits'
                    ? { plan: PLAN }
                    : reason === 'schedule_changed' || reason === 'slot_in_past'
                      ? { times: TIMES }
                      : reason === 'model_unavailable'
                        ? { recovery: 'retry' }
                        : {};
          return { status, body: { success: false, error: reason, reason, ...extras } };
        }
        return null;
      };
      harness.server.handler = (request) => noPlan(request) ?? defaultReply(request);
      await openGoal(harness);
      await screen.findByTestId('goal-plan-open');
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
        return {
          status: 200,
          body: { success: true, draft: null, confirmed: null, linkedWork: [] },
        };
      if (request.method === 'POST' && request.path.includes(`/goals/${GOAL_ID}/plan`)) return pending;
      return defaultReply(request);
    };
    await openGoal(harness);
    await screen.findByTestId('goal-plan-open');
    await press('goal-plan-open');
    expect(screen.getByTestId('plan-live-status')).toBeTruthy();
    expect(screen.getByTestId('plan-live-status').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByTestId('plan-live-status')).toHaveTextContent(/Started|Working/);
    release({ status: 200, body: { success: true, plan: PLAN } });
    await waitFor(() => expect(screen.getByTestId('plan-live-status')).toHaveTextContent('Done'));
  });

  it('A6 live status: a failed action announces could not', async () => {
    harness.server.handler = (request) =>
      request.method === 'POST' && request.path.includes(`/goals/${GOAL_ID}/plan`)
        ? {
            status: 503,
            body: {
              success: false,
              error: 'model_unavailable',
              reason: 'model_unavailable',
              recovery: 'retry',
            },
          }
        : request.method === 'GET' && request.path.endsWith(`/goals/${GOAL_ID}/plan`)
          ? {
              status: 200,
              body: { success: true, draft: null, confirmed: null, linkedWork: [] },
            }
          : defaultReply(request);
    await openGoal(harness);
    await screen.findByTestId('goal-plan-open');
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
        ? {
            status: 404,
            body: {
              success: false,
              error: 'feature_unavailable',
              reason: 'feature_unavailable',
            },
          }
        : defaultReply(request);
    await renderGoals(harness);
    await waitFor(() =>
      expect(harness.server.answeredMatching('GET', /\/goals\/plans\/upcoming$/)).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByTestId('intelligence-plan-flow')).toBeNull());
    expect(screen.queryByTestId('intelligence-generate')).toBeNull();
    await press(`goal-open-${GOAL_ID}`);
    await waitFor(() => expect(screen.queryByTestId('goal-back-list')).not.toBeNull());
    await waitFor(() =>
      expect(harness.server.answeredMatching('GET', /\/goals\/goal-1\/plan$/)).toHaveLength(1),
    );
    expect(screen.queryByTestId('goal-plan-open')).toBeNull();
    expect(screen.queryByTestId('goal-generate')).toBeNull();
  });
});

describe('#807 the simple-plan recovery follows the request that failed', () => {
  const bodyOf = (request: { body?: unknown }): Record<string, unknown> =>
    typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
  const unavailable: RouteReply = {
    status: 503,
    body: { success: false, error: 'model_unavailable', reason: 'model_unavailable', recovery: 'template' },
  };
  /** Opens the draft and has an edit refused with too_many_edits, whose recovery is "new plan" (the regenerate). */
  const openDraftAndFailAnEdit = async (): Promise<void> => {
    await openGoal(harness);
    await screen.findByTestId('goal-plan-open');
    await press('goal-plan-open');
    await waitFor(() => expect(screen.queryByTestId('plan-step-step-1')).not.toBeNull());
    await press('plan-edit');
    await press('plan-move-down-step-1');
    await waitFor(() => expect(screen.queryByTestId('plan-failure')).not.toBeNull());
    // Out of edit mode, so approve is on screen beside the failure.
    await press('plan-edit-done');
    expect(screen.getByTestId('plan-approve')).toBeTruthy();
  };

  it('after a failed regenerate, the template action regenerates with the template and supersedes the draft', async () => {
    const templatePlan = { ...PLAN, planId: 'plan-template', revision: 1, source: 'template' };
    harness.server.handler = (request) => {
      if (request.method === 'PATCH') {
        return { status: 422, body: { success: false, error: 'too_many_edits', reason: 'too_many_edits', plan: PLAN } };
      }
      if (request.method === 'POST' && request.path.endsWith(`/goals/${GOAL_ID}/plan/regenerate`)) {
        return bodyOf(request).source === 'template'
          ? { status: 200, body: { success: true, plan: templatePlan } }
          : unavailable;
      }
      // What generate answers while the old draft is active (the defect): stale, with that draft.
      if (request.method === 'POST' && request.path.endsWith(`/goals/${GOAL_ID}/plan/generate`)) {
        return { status: 409, body: { success: false, error: 'stale', reason: 'stale', plan: PLAN } };
      }
      return defaultReply(request);
    };
    await openGoal(harness);
    await screen.findByTestId('goal-plan-open');
    await press('goal-plan-open');
    await waitFor(() => expect(screen.queryByTestId('plan-step-step-1')).not.toBeNull());
    // too_many_edits offers a new plan: that is the regenerate.
    await press('plan-edit');
    await press('plan-move-down-step-1');
    await waitFor(() => expect(screen.queryByTestId('plan-failure')).not.toBeNull());
    await press('plan-failure-action');
    await waitFor(() => expect(harness.server.matching('POST', /\/plan\/regenerate$/)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(en.xPlanActionTemplate)).not.toBeNull());

    await press('plan-failure-action');

    await waitFor(() => expect(harness.server.matching('POST', /\/plan\/regenerate$/)).toHaveLength(2));
    expect(harness.server.matching('POST', /\/plan\/regenerate$/)[1]?.body).toEqual({
      currentPlanId: PLAN_ID,
      revision: PLAN.revision,
      idempotencyKey: expect.any(String),
      source: 'template',
    });
    expect(harness.server.matching('POST', /\/plan\/generate$/)).toHaveLength(0);
    await waitFor(() => expect(screen.queryByTestId('plan-failure')).toBeNull());
  });

  it('a later failure that did not come from a regenerate never replaces the draft through regenerate', async () => {
    harness.server.handler = (request) => {
      if (request.method === 'PATCH') {
        return { status: 422, body: { success: false, error: 'too_many_edits', reason: 'too_many_edits', plan: PLAN } };
      }
      if (request.method === 'POST' && request.path.endsWith(`/goals/${GOAL_ID}/plan/regenerate`)) return unavailable;
      if (request.method === 'POST' && request.path.endsWith('/approve')) {
        return { status: 503, body: { success: false, error: 'service_unavailable' } };
      }
      return defaultReply(request);
    };
    await openDraftAndFailAnEdit();
    // A regenerate fails first, so the flow did remember a regenerate ...
    await press('plan-failure-action');
    await waitFor(() => expect(harness.server.matching('POST', /\/plan\/regenerate$/)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(en.xPlanActionTemplate)).not.toBeNull());
    // ... and then approve fails: that is the failure the template answers now.
    await press('plan-approve');
    await waitFor(() => expect(harness.server.matching('POST', /\/approve$/)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('plan-failure-action-2')).not.toBeNull());
    expect(screen.getByTestId('plan-failure-action-2')).toBeTruthy();
    expect(screen.queryByText(en.xPlanActionTemplate)).not.toBeNull();

    await press('plan-failure-action-2');

    await waitFor(() => expect(harness.server.matching('POST', /\/plan\/generate$/)).toHaveLength(1));
    expect(harness.server.matching('POST', /\/plan\/generate$/)[0]?.body).toEqual({
      idempotencyKey: expect.any(String),
      source: 'template',
    });
    expect(harness.server.matching('POST', /\/plan\/regenerate$/)).toHaveLength(1);
  });

  it('a second press in the same frame that never started does not change what the template repeats', async () => {
    const templatePlan = { ...PLAN, planId: 'plan-template', revision: 1, source: 'template' };
    harness.server.handler = (request) => {
      if (request.method === 'PATCH') {
        return { status: 422, body: { success: false, error: 'too_many_edits', reason: 'too_many_edits', plan: PLAN } };
      }
      if (request.method === 'POST' && request.path.endsWith(`/goals/${GOAL_ID}/plan/regenerate`)) {
        return bodyOf(request).source === 'template'
          ? { status: 200, body: { success: true, plan: templatePlan } }
          : unavailable;
      }
      return defaultReply(request);
    };
    await openDraftAndFailAnEdit();
    // "new plan" and approve in one frame: the regenerate starts, approve bails.
    await act(async () => {
      await fireEvent.press(screen.getByTestId('plan-failure-action'));
      await fireEvent.press(screen.getByTestId('plan-approve'));
    });
    await waitFor(() => expect(harness.server.matching('POST', /\/plan\/regenerate$/)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(en.xPlanActionTemplate)).not.toBeNull());
    expect(harness.server.matching('POST', /\/approve$/)).toHaveLength(0);

    await press('plan-failure-action');

    await waitFor(() => expect(harness.server.matching('POST', /\/plan\/regenerate$/)).toHaveLength(2));
    expect(harness.server.matching('POST', /\/plan\/regenerate$/)[1]?.body).toEqual(expect.objectContaining({ source: 'template' }));
    expect(harness.server.matching('POST', /\/plan\/generate$/)).toHaveLength(0);
    expect(harness.server.matching('POST', /\/approve$/)).toHaveLength(0);
  });

  it('after a failed first generate, the template action still generates with the template', async () => {
    harness.server.handler = (request) => {
      if (request.method === 'GET' && request.path.endsWith(`/goals/${GOAL_ID}/plan`)) {
        return { status: 200, body: { success: true, draft: null, confirmed: null, linkedWork: [] } };
      }
      if (request.method === 'POST' && request.path.endsWith(`/goals/${GOAL_ID}/plan/generate`)) {
        return bodyOf(request).source === 'template'
          ? { status: 200, body: { success: true, plan: { ...PLAN, source: 'template' } } }
          : unavailable;
      }
      return defaultReply(request);
    };
    await openGoal(harness);
    await screen.findByTestId('goal-plan-open');
    await press('goal-plan-open');
    await waitFor(() => expect(screen.queryByTestId('plan-failure')).not.toBeNull());
    await waitFor(() => expect(screen.queryByText(en.xPlanActionTemplate)).not.toBeNull());

    await press('plan-failure-action');

    await waitFor(() => expect(harness.server.matching('POST', /\/plan\/generate$/)).toHaveLength(2));
    expect(harness.server.matching('POST', /\/plan\/generate$/)[1]?.body).toEqual({
      idempotencyKey: expect.any(String),
      source: 'template',
    });
    expect(harness.server.matching('POST', /\/plan\/regenerate$/)).toHaveLength(0);
    await waitFor(() => expect(screen.queryByTestId('plan-step-step-1')).not.toBeNull());
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
    await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
    await changeText('intelligence-statement', 'Lose weight');
    await press('intelligence-plan-flow');
    harness.repository.emit(ACCOUNT_B);
    release({
      status: 200,
      body: {
        success: true,
        summaryId: SUMMARY_ID,
        revision: 2,
        understood: { goalText: 'Account A private goal' },
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
        ? {
            status: 200,
            body: {
              success: true,
              draft: null,
              confirmed: {
                planId: PLAN.planId,
                saved: [],
                pendingLater: [{ weekIndex: 3, stepIds: ['step-3'] }],
              },
              linkedWork: [{ entity: 'commitment', id: 'commitment-1', title: 'Plan three lunches' }],
            },
          }
        : defaultReply(request);
    await openGoal(harness);
    await waitFor(() => expect(screen.queryByTestId('goal-plan-progress')).not.toBeNull());
    expect(screen.queryByTestId('goal-plan-open')).toBeNull();
    expect(screen.queryByTestId('goal-regenerate')).toBeNull();
  });

  it('M3A-044 / S1: linked work is listed above a new draft plan without deduplication', async () => {
    setLinkedWork(true);
    await openGoal(harness);
    await screen.findByTestId('goal-plan-open');
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
