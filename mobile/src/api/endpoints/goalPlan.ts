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
const forward = (start: string, end: string) => Date.parse(end) > Date.parse(start);
const clockForward = (start: string, end: string) => end > start;

/**
 * Every span in a proposal moves forward: the chosen slot or weekly time and
 * every offered alternative, which is sent back as it is (A4-003, R5-002).
 */
function intervalProblems(times: GoalPlanTimes): string[] {
  return times.steps.flatMap(step => {
    const problems: string[] = [];
    if ('slot' in step && step.slot && !forward(step.slot.startsAt, step.slot.endsAt)) problems.push(`slot:${step.stepId}`);
    if ('weekly' in step && step.weekly && !clockForward(step.weekly.start, step.weekly.end)) problems.push(`weekly:${step.stepId}`);
    for (const alternative of 'alternatives' in step ? step.alternatives : []) {
      if ('startsAt' in alternative ? !forward(alternative.startsAt, alternative.endsAt) : !clockForward(alternative.start, alternative.end)) {
        problems.push(`alternative:${step.stepId}`);
      }
    }
    return problems;
  });
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
      return problems;
    }),
    ...intervalProblems(times),
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
    ...intervalProblems(next),
  ];
  if (issues.length > 0) throw new ContractError(where, issues);
}

/** The step after a time change carries the choice that was sent (R5-001). */
function reflectsChoice(step: GoalPlanTimes['steps'][number] | undefined, choice: GoalPlanTimesChoice): boolean {
  if (!step || 'later' in step) return false;
  if ('none' in choice) return step.choice === 'none' && ('slot' in step ? step.slot === null : step.weekly === null);
  if ('slot' in choice) return 'slot' in step && step.choice === 'proposed' && step.slot?.startsAt === choice.slot.startsAt && step.slot.endsAt === choice.slot.endsAt;
  return 'weekly' in step && step.choice === 'proposed' && step.weekly !== null && step.weekly.start === choice.weekly.start && step.weekly.end === choice.weekly.end
    && step.weekly.weekdays.length === choice.weekly.weekdays.length && choice.weekly.weekdays.every(day => step.weekly!.weekdays.includes(day));
}

export async function chooseGoalPlanTime(goalId: string, current: GoalPlanTimes, stepId: string, choice: GoalPlanTimesChoice): Promise<GoalPlanTimes> {
  const response = await apiRequest('PATCH', `${plan(goalId, current.planId)}/times/${encodeURIComponent(stepId)}`, {
    // The proposal on screen, by id: a choice never lands on another device's newer one (R5-005).
    body: { timesId: current.timesId, timesRevision: current.timesRevision, choice },
    schema: goalPlanTimesResponseSchema,
  });
  checkReplacementTimes('goalPlan.timeChanged', current, response.times, true);
  if (!reflectsChoice(response.times.steps.find(step => step.stepId === stepId), choice)) throw new ContractError('goalPlan.timeChanged', [`choice:${stepId}`]);
  return response.times;
}

type ConfirmRow =
  | { saved: GoalPlanConfirmResult['saved'][number] }
  | { stayed: GoalPlanConfirmResult['stayed'][number] };

/**
 * What the confirm must say of one reviewed step, read from the times the
 * person saw — the server's own rule (R5-003): a later week stays with its
 * week; no room stays with its reason; anything else is saved, at its slot
 * or weekly time, or with no time.
 */
function expectedRow(step: GoalPlanTimes['steps'][number], title: string | undefined): ConfirmRow {
  const named = title ?? '';
  if ('later' in step) return { stayed: { stepId: step.stepId, title: named, why: { kind: 'later_week', weekIndex: step.later.weekIndex } } };
  const timing = 'slot' in step ? step.slot : step.weekly;
  if (timing === null && step.choice !== 'none' && step.reason) return { stayed: { stepId: step.stepId, title: named, why: { kind: 'no_room', reason: step.reason } } };
  const when = 'slot' in step
    ? (step.slot ? { kind: 'slot' as const, ...step.slot } : { kind: 'none' as const })
    : (step.weekly ? { kind: 'weekly' as const, ...step.weekly } : { kind: 'none' as const });
  return { saved: { stepId: step.stepId, entity: step.kind, id: '', title: named, when } };
}

/** Same value, whatever the key order. */
const canonical = (value: unknown): unknown => (Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * The reviewed proposal, exactly: the client never authors a times array.
 * The answer is held to it too (A4-004, R5-003): every reviewed step, and
 * every step removed from the plan, is named once, with the disposition,
 * kind, timing and title the reviewed times and plan give it; nothing else
 * is named. `plan` is null only when it is not on screen: titles are then
 * not compared, and an extra entry may only be a removed step staying.
 */
export async function confirmGoalPlan(goalId: string, times: GoalPlanTimes, idempotencyKey: string, planOnScreen: GoalPlan | null): Promise<GoalPlanConfirmResult> {
  const result = await apiRequest('POST', `${plan(goalId, times.planId)}/confirm`, {
    body: { planRevision: times.planRevision, timesId: times.timesId, timesRevision: times.timesRevision, idempotencyKey },
    schema: goalPlanConfirmResponseSchema,
  });
  const titles = new Map(planOnScreen?.steps.map(step => [step.stepId, step.title]) ?? []);
  const removed = new Map(planOnScreen?.removedSteps.map(step => [step.stepId, step.title]) ?? []);
  const reviewed = new Map(times.steps.map(step => [step.stepId, step]));
  const named = [...result.saved.map(item => item.stepId), ...result.stayed.map(item => item.stepId)];
  const titleOk = (expected: string | undefined, actual: string) => planOnScreen === null || expected === actual;
  const issues = [
    ...(new Set(named).size !== named.length ? ['duplicate'] : []),
    ...Array.from(reviewed.keys()).flatMap(id => (named.includes(id) ? [] : [`missing:${id}`])),
    ...Array.from(removed.keys()).flatMap(id => (result.stayed.some(item => item.stepId === id) ? [] : [`missing:${id}`])),
    ...result.saved.flatMap(item => {
      const step = reviewed.get(item.stepId);
      if (!step) return [`saved-unreviewed:${item.stepId}`];
      const want = expectedRow(step, titles.get(item.stepId));
      return 'saved' in want && want.saved.entity === item.entity && sameJson(want.saved.when, item.when) && titleOk(want.saved.title, item.title)
        ? [] : [`saved:${item.stepId}`];
    }),
    ...result.stayed.flatMap(item => {
      const step = reviewed.get(item.stepId);
      if (!step) {
        const isRemoved = planOnScreen === null || removed.has(item.stepId);
        return isRemoved && item.why.kind === 'removed' && titleOk(removed.get(item.stepId), item.title) ? [] : [`stayed-unknown:${item.stepId}`];
      }
      const want = expectedRow(step, titles.get(item.stepId));
      return 'stayed' in want && sameJson(want.stayed.why, item.why) && titleOk(want.stayed.title, item.title) ? [] : [`stayed:${item.stepId}`];
    }),
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
