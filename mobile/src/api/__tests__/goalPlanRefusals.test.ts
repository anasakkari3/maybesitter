import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { apiRequest } from '../client';
import { approveGoalPlan, checkReplacementTimes, chooseGoalPlanTime, confirmGoalPlan, laterWeekTimes } from '../endpoints/goalPlan';
import { goalPlanConfirmResponseSchema, goalPlanStepSchema, goalPlanTimesSchema, type GoalPlanTimes } from '../schemas/goalPlan';
import { resetAuthForTests, setAuthRepository } from '../auth';
import {
  ConflictError,
  ContractError,
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
  timesId: 't1', timesRevision: 2, planId: 'p1', planRevision: 4, anchor: { localDate: '2030-01-07', timezone: 'UTC' },
  steps: [{ stepId: 's1', kind: 'commitment', slot: { startsAt: '2030-01-08T09:00:00.000Z', endsAt: '2030-01-08T09:30:00.000Z' }, alternatives: [], choice: 'proposed' }],
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
    respond(503, { success: false, error: 'x', reason: 'build_unavailable', retryable: true });
    const error = await refusalOf('/api/mobile/plans/2030-01-07/build');
    expect(error).toBeInstanceOf(PlanBuildRefusedError);
    expect((error as PlanBuildRefusedError).reason).toBe('build_unavailable');
    expect((error as PlanBuildRefusedError).retryable).toBe(true);
  });

  it('a date out of range stays a validation refusal, not a build failure (inspection A-005)', async () => {
    respond(400, { success: false, error: 'x', reason: 'date_out_of_range', retryable: false });
    expect(await refusalOf('/api/mobile/plans/2030-01-07/build')).not.toBeInstanceOf(PlanBuildRefusedError);
  });

  it('a build answer with no reason is still the generic server error', async () => {
    respond(500, { success: false, error: 'x' });
    expect(await refusalOf('/api/mobile/plans/2030-01-07/build')).toBeInstanceOf(ServerError);
  });
});

describe('a plan and its times belong together (inspections A2-008, A3-002, A3-003)', () => {
  const approved = { success: true, plan: PLAN, times: TIMES };
  it('approve returns the plan and times it was asked for', async () => {
    respond(200, approved);
    const answer = await approveGoalPlan('g1', 'p1', 4);
    expect(answer.plan.planId).toBe('p1');
    expect(answer.times.planRevision).toBe(4);
  });

  it.each([
    ['another plan', { ...approved, times: { ...TIMES, planId: 'p9' } }],
    ['times for another revision', { ...approved, times: { ...TIMES, planRevision: 3 } }],
    ['an older plan than asked for', { ...approved, plan: { ...PLAN, revision: 2 }, times: { ...TIMES, planRevision: 2 } }],
    ['a step not in the plan', { ...approved, times: { ...TIMES, steps: [{ ...TIMES.steps[0], stepId: 'x' }] } }],
    ['a slot that ends before it starts', { ...approved, times: { ...TIMES, steps: [{ ...TIMES.steps[0], slot: { startsAt: '2030-01-08T09:00:00.000Z', endsAt: '2030-01-08T09:00:00.000Z' } }] } }],
  ])('approve refuses %s as a contract failure', async (_name, body) => {
    respond(200, body);
    await expect(approveGoalPlan('g1', 'p1', 4)).rejects.toBeInstanceOf(ContractError);
  });

  const confirmedPlan = { ...PLAN, status: 'confirmed', steps: [...PLAN.steps, { stepId: 's3', order: 2, phase: { unit: 'week', index: 3 }, title: 'Weigh in', kind: 'commitment', durationMinutes: 20, buildsOn: null, expectedOutcome: null }] };
  const week3 = { ...TIMES, steps: [{ stepId: 's3', kind: 'commitment', slot: { startsAt: '2030-01-22T09:00:00.000Z', endsAt: '2030-01-22T09:20:00.000Z' }, alternatives: [], choice: 'proposed' }] };
  it('a later week answers with exactly that week of the confirmed plan', async () => {
    respond(200, { success: true, plan: confirmedPlan, times: week3 });
    expect((await laterWeekTimes('g1', 'p1', 3, 'k')).times.steps.map(step => step.stepId)).toEqual(['s3']);
  });

  it.each([
    ['a week-1 step for week 3', { success: true, plan: confirmedPlan, times: { ...week3, steps: [{ ...week3.steps[0], stepId: 's1' }] } }],
    ['a plan that is not confirmed', { success: true, plan: { ...confirmedPlan, status: 'draft' }, times: week3 }],
    ['a step still marked later', { success: true, plan: confirmedPlan, times: { ...week3, steps: [{ stepId: 's3', kind: 'commitment', later: { weekIndex: 3 } }] } }],
  ])('a later week refuses %s', async (_name, body) => {
    respond(200, body);
    await expect(laterWeekTimes('g1', 'p1', 3, 'k')).rejects.toBeInstanceOf(ContractError);
  });

  it('a confirm without its receipt is not a success (A3-005)', () => {
    expect(goalPlanConfirmResponseSchema.safeParse({ success: true, saved: [], stayed: [] }).success).toBe(false);
    expect(goalPlanConfirmResponseSchema.safeParse({ success: true, saved: [], stayed: [], receipt: { outcomeId: 'o', replayed: false } }).success).toBe(true);
  });

  it('approve times that leave out a plan step are refused (A4-001)', async () => {
    const twoSteps = { ...PLAN, steps: [...PLAN.steps, { ...PLAN.steps[0], stepId: 's2', order: 2 }] };
    respond(200, { ...approved, plan: twoSteps });
    await expect(approveGoalPlan('g1', 'p1', 4)).rejects.toBeInstanceOf(ContractError);
  });

  it('an alternative that ends before it starts is refused like a slot (A4-003)', async () => {
    const back = { startsAt: '2030-01-08T10:00:00.000Z', endsAt: '2030-01-08T09:30:00.000Z' };
    respond(200, { ...approved, times: { ...TIMES, steps: [{ ...TIMES.steps[0], alternatives: [back] }] } });
    await expect(approveGoalPlan('g1', 'p1', 4)).rejects.toBeInstanceOf(ContractError);
  });
});

describe('a times answer replaces the times on screen only if it is the same proposal (A4-002)', () => {
  const current = TIMES as GoalPlanTimes;
  const moved = { ...TIMES, timesRevision: 3 };
  it('the same proposal, moved on, is taken', async () => {
    respond(200, { success: true, times: moved });
    expect((await chooseGoalPlanTime('g1', current, 's1', { none: true })).timesRevision).toBe(3);
  });

  it.each([
    ['another proposal', { ...moved, timesId: 't9' }],
    ['a revision that did not move', TIMES],
    ['another plan revision', { ...moved, planRevision: 5 }],
    ['another step', { ...moved, steps: [{ ...TIMES.steps[0], stepId: 's9' }] }],
    ['a step that changed kind', { ...moved, steps: [{ stepId: 's1', kind: 'habit', weekly: null, alternatives: [], choice: 'none' }] }],
  ])('a time change answering with %s is refused', async (_name, times) => {
    respond(200, { success: true, times });
    await expect(chooseGoalPlanTime('g1', current, 's1', { none: true })).rejects.toBeInstanceOf(ContractError);
  });

  it('recomputed times (a changed schedule) may carry a new id, but not other steps', () => {
    expect(() => checkReplacementTimes('x', current, { ...current, timesId: 't2', timesRevision: 1 }, false)).not.toThrow();
    expect(() => checkReplacementTimes('x', current, { ...current, timesId: 't2', steps: [] }, false)).toThrow(ContractError);
  });
});

describe('the schemas hold the contract, not just the shape (A4-003)', () => {
  it('a clock is a real time of day', () => {
    const habit = (start: string) => ({ ...TIMES, steps: [{ stepId: 's1', kind: 'habit', weekly: { weekdays: [1], start, end: '23:59' }, alternatives: [], choice: 'proposed' }] });
    expect(goalPlanTimesSchema.safeParse(habit('07:30')).success).toBe(true);
    expect(goalPlanTimesSchema.safeParse(habit('24:00')).success).toBe(false);
    expect(goalPlanTimesSchema.safeParse(habit('09:75')).success).toBe(false);
  });

  it('a habit step carries its rhythm', () => {
    const habit = { ...PLAN.steps[0], kind: 'habit' };
    expect(goalPlanStepSchema.safeParse(habit).success).toBe(false);
    expect(goalPlanStepSchema.safeParse({ ...habit, rhythm: { timesPerWeek: 3 } }).success).toBe(true);
  });
});

describe('a confirm answers for exactly what was reviewed (A4-004)', () => {
  const receipt = { outcomeId: 'o1', replayed: false };
  const saved = { stepId: 's1', entity: 'commitment', id: 'c1', title: 'Walk', when: { kind: 'slot', startsAt: '2030-01-08T09:00:00.000Z', endsAt: '2030-01-08T09:30:00.000Z' } };
  const removedStays = { stepId: 'r1', title: 'Run', why: { kind: 'removed' } };
  const confirm = (body: unknown, removed: readonly string[] | null = ['r1']) => {
    respond(200, { success: true, ...(body as object), receipt });
    return confirmGoalPlan('g1', TIMES as GoalPlanTimes, 'k', removed);
  };

  it('every reviewed step and every removed step, once', async () => {
    expect((await confirm({ saved: [saved], stayed: [removedStays] })).saved).toHaveLength(1);
  });

  it.each([
    ['a reviewed step missing', { saved: [], stayed: [removedStays] }],
    ['a removed step missing', { saved: [saved], stayed: [] }],
    ['a step named twice', { saved: [saved], stayed: [removedStays, { stepId: 's1', title: 'Walk', why: { kind: 'no_room', reason: 'no_free_time_in_phase' } }] }],
    ['a step nobody reviewed', { saved: [saved, { ...saved, stepId: 'zz' }], stayed: [removedStays] }],
    ['a removed step saved', { saved: [saved, { ...saved, stepId: 'r1' }], stayed: [] }],
    ['a removed step staying for another reason', { saved: [saved], stayed: [{ ...removedStays, why: { kind: 'no_room', reason: 'no_free_time_in_phase' } }] }],
    ['a reviewed step staying as removed', { saved: [], stayed: [removedStays, { stepId: 's1', title: 'Walk', why: { kind: 'removed' } }] }],
  ])('refuses %s', async (_name, body) => {
    await expect(confirm(body)).rejects.toBeInstanceOf(ContractError);
  });

  it('with no plan on screen, an extra entry may only be a removed step', async () => {
    expect((await confirm({ saved: [saved], stayed: [removedStays] }, null)).stayed).toHaveLength(1);
    await expect(confirm({ saved: [saved], stayed: [{ ...removedStays, why: { kind: 'no_room', reason: 'no_free_time_in_phase' } }] }, null)).rejects.toBeInstanceOf(ContractError);
  });
});

