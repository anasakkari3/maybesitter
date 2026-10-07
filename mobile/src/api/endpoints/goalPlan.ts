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
      // Offered alternatives are sent back as they are, so they are held to the same rule (A4-003).
      for (const alternative of 'alternatives' in step ? step.alternatives : []) {
        if ('startsAt' in alternative ? !forward(alternative.startsAt, alternative.endsAt) : !clockForward(alternative.start, alternative.end)) {
          problems.push(`alternative:${step.stepId}`);
        }
      }
      return problems;
    }),
    ...(expected.stepIds && (expected.stepIds.length !== seen.size || expected.stepIds.some(id => !seen.has(id))) ? ['steps'] : []),
  ];
  if (issues.length > 0) throw new ContractError(where, issues);
}

export async function approveGoalPlan(goalId: string, planId: string, revision: number): Promise<{ plan: GoalPlan; times: GoalPlanTimes }> {
  const response = await apiRequest('POST', `${plan(goalId, planId)}/approve`, { body: { revision }, schema: goalPlanApproveResponseSchema });
  // Every step of the approved plan is in its times exactly once, later weeks included (A4-001).
  checkTimesAgainstPlan('goalPlan.approved', response.plan, response.times, { planId, revision, stepIds: response.plan.steps.map(step => step.stepId) });
  return { plan: response.plan, times: response.times };
}

/**
 * A proposal that comes back in place of the one on screen (A4-002): the same
 * plan and plan revision, the same steps with the same kinds. `sameTimes` also
 * holds it to the same proposal moved on (a time change); a recomputed
 * proposal (a changed schedule) carries a new id.
 */
export function checkReplacementTimes(where: string, current: GoalPlanTimes, next: GoalPlanTimes, sameTimes: boolean): void {
  const kinds = (times: GoalPlanTimes) => new Map(times.steps.map(step => [step.stepId, step.kind]));
  const before = kinds(current);
  const after = kinds(next);
  const issues = [
    ...(next.planId !== current.planId || next.planRevision !== current.planRevision ? ['plan'] : []),
    ...(sameTimes && (next.timesId !== current.timesId || next.timesRevision <= current.timesRevision) ? ['timesRevision'] : []),
    ...(after.size !== next.steps.length || after.size !== before.size || Array.from(before).some(([id, kind]) => after.get(id) !== kind) ? ['steps'] : []),
  ];
  if (issues.length > 0) throw new ContractError(where, issues);
}

export async function chooseGoalPlanTime(goalId: string, current: GoalPlanTimes, stepId: string, choice: GoalPlanTimesChoice): Promise<GoalPlanTimes> {
  const response = await apiRequest('PATCH', `${plan(goalId, current.planId)}/times/${encodeURIComponent(stepId)}`, {
    body: { timesRevision: current.timesRevision, choice },
    schema: goalPlanTimesResponseSchema,
  });
  checkReplacementTimes('goalPlan.timeChanged', current, response.times, true);
  return response.times;
}

/**
 * The reviewed proposal, exactly: the client never authors a times array.
 * The answer is held to it too (A4-004): every reviewed step, and every step
 * removed from the plan, is saved or stays, once, and nothing else is named.
 * `removedStepIds` is null only when the plan is not on screen; then an extra
 * entry may only be a removed step staying.
 */
export async function confirmGoalPlan(goalId: string, times: GoalPlanTimes, idempotencyKey: string, removedStepIds: readonly string[] | null): Promise<GoalPlanConfirmResult> {
  const result = await apiRequest('POST', `${plan(goalId, times.planId)}/confirm`, {
    body: { planRevision: times.planRevision, timesId: times.timesId, timesRevision: times.timesRevision, idempotencyKey },
    schema: goalPlanConfirmResponseSchema,
  });
  const reviewed = new Set(times.steps.map(step => step.stepId));
  const removed = new Set(removedStepIds ?? []);
  const named = [...result.saved.map(item => item.stepId), ...result.stayed.map(item => item.stepId)];
  const isRemoved = (item: GoalPlanConfirmResult['stayed'][number]) => (removedStepIds === null ? !reviewed.has(item.stepId) : removed.has(item.stepId));
  const issues = [
    ...(new Set(named).size !== named.length ? ['duplicate'] : []),
    ...Array.from(reviewed).flatMap(id => (named.includes(id) ? [] : [`missing:${id}`])),
    ...(removedStepIds ?? []).flatMap(id => (result.stayed.some(item => item.stepId === id) ? [] : [`missing:${id}`])),
    ...result.saved.flatMap(item => (reviewed.has(item.stepId) ? [] : [`saved-unreviewed:${item.stepId}`])),
    ...result.stayed.flatMap(item => (reviewed.has(item.stepId) || isRemoved(item) ? [] : [`unknown:${item.stepId}`])),
    ...result.stayed.flatMap(item => (isRemoved(item) !== (item.why.kind === 'removed') ? [`why:${item.stepId}`] : [])),
  ];
  if (issues.length > 0) throw new ContractError('goalPlan.confirmed', issues);
  return result;
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
