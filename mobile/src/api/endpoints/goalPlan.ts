import { apiRequest } from '../client';
import { ContractError } from '../errors';
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

/**
 * A plan and its times belong together (inspections A2-008, A3-002, A3-003).
 * The fixtures prove the shapes; this proves the two halves of one answer are
 * about the same plan: the plan asked for, its revision, every step in it once
 * with its own kind, and every span forward in time.
 */
function checkTimesAgainstPlan(where: string, planIn: GoalPlan, times: GoalPlanTimes, expected: { planId: string; revision?: number; status?: GoalPlan['status']; stepIds?: readonly string[]; noLater?: boolean }): void {
  const kinds = new Map(planIn.steps.map(step => [step.stepId, step.kind]));
  const seen = new Set<string>();
  const forward = (start: string, end: string) => Date.parse(end) > Date.parse(start);
  const clockForward = (start: string, end: string) => end > start;
  const issues = [
    ...(planIn.planId !== expected.planId || times.planId !== expected.planId ? ['planId'] : []),
    // An approve may move the plan's revision on; it may never move it back.
    ...(expected.revision !== undefined && planIn.revision < expected.revision ? ['revision'] : []),
    ...(times.planRevision !== planIn.revision ? ['planRevision'] : []),
    ...(expected.status !== undefined && planIn.status !== expected.status ? ['status'] : []),
    ...(times.steps.length === 0 ? ['empty'] : []),
    ...times.steps.flatMap(step => {
      const problems: string[] = [];
      if (seen.has(step.stepId)) problems.push(`duplicate:${step.stepId}`);
      seen.add(step.stepId);
      if (kinds.get(step.stepId) !== step.kind) problems.push(`step:${step.stepId}`);
      if (expected.noLater && 'later' in step) problems.push(`later:${step.stepId}`);
      if ('slot' in step && step.slot && !forward(step.slot.startsAt, step.slot.endsAt)) problems.push(`slot:${step.stepId}`);
      if ('weekly' in step && step.weekly && !clockForward(step.weekly.start, step.weekly.end)) problems.push(`weekly:${step.stepId}`);
      return problems;
    }),
    ...(expected.stepIds && (expected.stepIds.length !== seen.size || expected.stepIds.some(id => !seen.has(id))) ? ['steps'] : []),
  ];
  if (issues.length > 0) throw new ContractError(where, issues);
}

export async function approveGoalPlan(goalId: string, planId: string, revision: number): Promise<{ plan: GoalPlan; times: GoalPlanTimes }> {
  const response = await apiRequest('POST', `${plan(goalId, planId)}/approve`, { body: { revision }, schema: goalPlanApproveResponseSchema });
  checkTimesAgainstPlan('goalPlan.approved', response.plan, response.times, { planId, revision });
  return { plan: response.plan, times: response.times };
}

export async function chooseGoalPlanTime(goalId: string, planId: string, stepId: string, timesRevision: number, choice: GoalPlanTimesChoice): Promise<GoalPlanTimes> {
  const response = await apiRequest('PATCH', `${plan(goalId, planId)}/times/${encodeURIComponent(stepId)}`, {
    body: { timesRevision, choice },
    schema: goalPlanTimesResponseSchema,
  });
  // The same proposal, moved on: this plan, a newer revision, the step still in it.
  const times = response.times;
  if (times.planId !== planId || times.timesRevision <= timesRevision || !times.steps.some(step => step.stepId === stepId)) {
    throw new ContractError('goalPlan.timeChanged', ['times']);
  }
  return times;
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
  // A later week answers with exactly that week's steps of the confirmed plan.
  const weekSteps = response.plan.steps.filter(step => step.phase.unit === 'week' && step.phase.index === weekIndex).map(step => step.stepId);
  checkTimesAgainstPlan('goalPlan.laterTimes', response.plan, response.times, { planId, status: 'confirmed', stepIds: weekSteps, noLater: true });
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
