import { apiRequest } from '../client';
import {
  goalPlanApproveResponseSchema,
  goalPlanConfirmResponseSchema,
  goalPlanResponseSchema,
  goalPlanTimesResponseSchema,
  goalPlanViewSchema,
  laterWeekTimesResponseSchema,
  statementAcceptResponseSchema,
  statementPreviewResponseSchema,
  upcomingPlansResponseSchema,
  type GoalPlan,
  type GoalPlanConfirmResult,
  type GoalPlanPhase,
  type GoalPlanRhythm,
  type GoalPlanSlot,
  type GoalPlanTimes,
  type GoalPlanView,
  type GoalPlanWeekly,
  type StatementPreview,
  type UpcomingPlanItem,
} from '../schemas/goalPlan';

/**
 * The one plan path (M3a), route by route. Shapes: `WIRE-M3a.md`.
 *
 * Every write names the version it was made against — the plan's `revision`,
 * the proposal's `timesRevision` — so the server can refuse an edit made on a
 * plan another device already changed, and every write that saves anything
 * carries an idempotency key the caller keeps across a retry.
 */

const goal = (goalId: string) => `/api/mobile/goals/${encodeURIComponent(goalId)}`;
const plan = (goalId: string, planId: string) => `${goal(goalId)}/plans/${encodeURIComponent(planId)}`;

export type GoalPlanEditOp =
  | { op: 'reorder'; stepId: string; toOrder: number }
  | { op: 'remove'; stepId: string }
  | { op: 'restore'; stepId: string }
  | { op: 'add'; afterStepId: string | null; step: { title: string; kind: 'commitment' | 'habit'; phase: GoalPlanPhase; durationMinutes: number; rhythm?: GoalPlanRhythm } }
  | { op: 'update'; stepId: string; fields: Partial<{ title: string; kind: 'commitment' | 'habit'; phase: GoalPlanPhase; durationMinutes: number; rhythm: GoalPlanRhythm }> };

export type GoalPlanTimesChoice = { slot: GoalPlanSlot } | { weekly: GoalPlanWeekly } | { none: true };

export function getGoalPlan(goalId: string): Promise<GoalPlanView> {
  return apiRequest('GET', `${goal(goalId)}/plan`, { schema: goalPlanViewSchema });
}

export async function generateGoalPlan(goalId: string, idempotencyKey: string, source?: 'template'): Promise<GoalPlan> {
  const response = await apiRequest('POST', `${goal(goalId)}/plan/generate`, {
    body: { idempotencyKey, ...(source ? { source } : {}) },
    schema: goalPlanResponseSchema,
  });
  return response.plan;
}

export async function regenerateGoalPlan(goalId: string, current: { planId: string; revision: number }, idempotencyKey: string): Promise<GoalPlan> {
  const response = await apiRequest('POST', `${goal(goalId)}/plan/regenerate`, {
    body: { currentPlanId: current.planId, revision: current.revision, idempotencyKey },
    schema: goalPlanResponseSchema,
  });
  return response.plan;
}

export async function editGoalPlan(goalId: string, planId: string, revision: number, op: GoalPlanEditOp): Promise<GoalPlan> {
  const response = await apiRequest('PATCH', plan(goalId, planId), { body: { revision, op }, schema: goalPlanResponseSchema });
  return response.plan;
}

export async function approveGoalPlan(goalId: string, planId: string, revision: number): Promise<GoalPlanTimes> {
  const response = await apiRequest('POST', `${plan(goalId, planId)}/approve`, { body: { revision }, schema: goalPlanApproveResponseSchema });
  return response.times;
}

export async function chooseGoalPlanTime(goalId: string, planId: string, stepId: string, timesRevision: number, choice: GoalPlanTimesChoice): Promise<GoalPlanTimes> {
  const response = await apiRequest('PATCH', `${plan(goalId, planId)}/times/${encodeURIComponent(stepId)}`, {
    body: { timesRevision, choice },
    schema: goalPlanTimesResponseSchema,
  });
  return response.times;
}

/** The reviewed proposal, exactly: the client never authors a times array. */
export function confirmGoalPlan(goalId: string, times: GoalPlanTimes, idempotencyKey: string): Promise<GoalPlanConfirmResult> {
  return apiRequest('POST', `${plan(goalId, times.planId)}/confirm`, {
    body: { planRevision: times.planRevision, timesId: times.timesId, timesRevision: times.timesRevision, idempotencyKey },
    schema: goalPlanConfirmResponseSchema,
  });
}

/** A later week's steps, placed when that week is near (M3A-012), against the then-current calendar. */
export async function laterWeekTimes(goalId: string, planId: string, weekIndex: number, idempotencyKey: string): Promise<{ plan: GoalPlan; times: GoalPlanTimes }> {
  const response = await apiRequest('POST', `${plan(goalId, planId)}/later/${weekIndex}/times`, {
    body: { idempotencyKey },
    schema: laterWeekTimesResponseSchema,
  });
  return { plan: response.plan, times: response.times };
}

export async function listUpcomingPlans(): Promise<readonly UpcomingPlanItem[]> {
  const response = await apiRequest('GET', '/api/mobile/goals/plans/upcoming', { schema: upcomingPlansResponseSchema });
  return response.items;
}

export function previewStatementGoal(statement: string, locale: string): Promise<StatementPreview> {
  return apiRequest('POST', '/api/mobile/goals/from-statement/preview', { body: { statement, locale }, schema: statementPreviewResponseSchema });
}

/** `understood` is what the person approved, which may be their own edit of the summary. */
export async function acceptStatementGoal(preview: StatementPreview, understood: { goalText: string }, idempotencyKey: string): Promise<string> {
  const response = await apiRequest('POST', '/api/mobile/goals/from-statement/accept', {
    body: { summaryId: preview.summaryId, revision: preview.revision, understood, idempotencyKey },
    schema: statementAcceptResponseSchema,
  });
  return response.goalId;
}
