import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { apiRequest } from '../client';
import { resetAuthForTests, setAuthRepository } from '../auth';
import {
  ConflictError,
  FeatureUnavailableError,
  GOAL_PLAN_REASONS,
  GoalPlanRefusedError,
  PlanBuildRefusedError,
  ServerError,
} from '../errors';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';

/**
 * The plan path's refusals keep their reason (M3a, M3A-009/-031).
 *
 * The generic classes flatten a 409 into "conflict" and a 422 into a plan
 * edit refusal; the plan path needs the reason itself — `stale` says one
 * thing and redraws from the plan it carries, `schedule_changed` another and
 * redraws from the times. Scoped by path, so the goal execution routes beside
 * it keep the classes they always had.
 */

const ok = z.object({ ok: z.boolean() });
const PLAN = {
  planId: 'p1', goalId: 'g1', revision: 4, status: 'draft', horizon: 'weeks', removedSteps: [],
  steps: [{ stepId: 's1', order: 1, phase: { unit: 'week', index: 1 }, title: 'Walk', kind: 'commitment', durationMinutes: 30, buildsOn: null, expectedOutcome: null }],
};
const TIMES = {
  timesId: 't1', timesRevision: 2, planId: 'p1', planRevision: 4,
  steps: [{ stepId: 's1', kind: 'commitment', slot: { startsAt: '2030-01-08T09:00:00.000Z', endsAt: '2030-01-08T09:30:00.000Z' }, alternatives: [] }],
};

function respond(status: number, body: unknown): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({ status, text: async () => JSON.stringify(body) })) as never;
}

async function refusalOf(path: string): Promise<unknown> {
  try {
    await apiRequest('POST', path, { body: {}, schema: ok });
  } catch (error) {
    return error;
  }
  throw new Error('the request did not fail');
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({ initialUser: { uid: 'u1', email: 'a@example.com', emailVerified: true, displayName: null, providerIds: ['password'] }, idToken: 't' }));
});
afterEach(() => {
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('a plan route refusal', () => {
  it.each(GOAL_PLAN_REASONS.map(reason => [reason]))('%s keeps its reason', async (reason) => {
    respond(reason === 'gone' ? 410 : 422, { success: false, error: 'x', reason });
    const error = await refusalOf('/api/mobile/goals/g1/plans/p1/confirm');
    expect(error).toBeInstanceOf(GoalPlanRefusedError);
    expect((error as GoalPlanRefusedError).reason).toBe(reason);
  });

  it('a stale edit carries the current plan, parsed', async () => {
    respond(409, { success: false, error: 'x', reason: 'stale', plan: PLAN });
    const error = await refusalOf('/api/mobile/goals/g1/plans/p1') as GoalPlanRefusedError;
    expect(error.detail.plan?.revision).toBe(4);
  });

  it('a changed schedule carries the recomputed times; a payload that does not parse is dropped, not trusted', async () => {
    respond(409, { success: false, error: 'x', reason: 'schedule_changed', times: TIMES });
    expect(((await refusalOf('/api/mobile/goals/g1/plans/p1/confirm')) as GoalPlanRefusedError).detail.times?.timesId).toBe('t1');
    respond(409, { success: false, error: 'x', reason: 'schedule_changed', times: { nonsense: true } });
    const dropped = await refusalOf('/api/mobile/goals/g1/plans/p1/confirm') as GoalPlanRefusedError;
    expect(dropped).toBeInstanceOf(GoalPlanRefusedError);
    expect(dropped.detail.times).toBeUndefined();
  });

  it('carries the question, the classification and the replacement goal', async () => {
    respond(422, { success: false, error: 'x', reason: 'goal_too_vague', question: 'Which outcome?' });
    expect(((await refusalOf('/api/mobile/goals/from-statement/preview')) as GoalPlanRefusedError).detail.question).toBe('Which outcome?');
    respond(422, { success: false, error: 'x', reason: 'not_a_goal', classification: 'thought', recovery: 'thoughts' });
    expect(((await refusalOf('/api/mobile/goals/from-statement/preview')) as GoalPlanRefusedError).detail.classification).toBe('thought');
    respond(409, { success: false, error: 'x', reason: 'goal_superseded', currentGoalId: 'g2' });
    expect(((await refusalOf('/api/mobile/goals/g1/plan/generate')) as GoalPlanRefusedError).detail.currentGoalId).toBe('g2');
  });

  it('a switched-off module stays a FeatureUnavailableError, so the entries hide', async () => {
    respond(404, { success: false, error: 'not found', reason: 'feature_unavailable' });
    expect(await refusalOf('/api/mobile/goals/plans/upcoming')).toBeInstanceOf(FeatureUnavailableError);
  });

  it('the goal execution routes beside it keep their generic classes', async () => {
    respond(409, { success: false, error: 'x', reason: 'stale' });
    const error = await refusalOf('/api/mobile/goals/g1/execution/confirm');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).not.toBeInstanceOf(GoalPlanRefusedError);
  });
});

describe('«اعمل خطة اليوم» (image 2)', () => {
  it('a build that cannot finish keeps its reason and whether to try again', async () => {
    respond(503, { success: false, error: 'x', reason: 'plan_unavailable', retryable: true });
    const error = await refusalOf('/api/mobile/plans/2030-01-07/build');
    expect(error).toBeInstanceOf(PlanBuildRefusedError);
    expect((error as PlanBuildRefusedError).reason).toBe('plan_unavailable');
    expect((error as PlanBuildRefusedError).retryable).toBe(true);
  });

  it('a build answer with no reason is still the generic server error', async () => {
    respond(500, { success: false, error: 'x' });
    expect(await refusalOf('/api/mobile/plans/2030-01-07/build')).toBeInstanceOf(ServerError);
  });
});
