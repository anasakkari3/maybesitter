import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_PLAN_CLAIMS,
  GOAL_PLAN_OUTCOMES,
  HABITS,
  MEMORY,
  docIdForKey,
  userCol,
  userSubDoc,
  type StorageAdapter,
} from '../../lib/storage/index.ts';
import { getStorage } from '../../lib/storage/index.ts';
import { isPlanImperative, readGoalPlan } from '../../lib/services/mobile/goalPlanService.ts';
import {
  REFERENCE,
  USER,
  approve,
  approved,
  call,
  choose,
  confirm,
  draftOf,
  edit,
  key,
  rows,
  setup,
  stepByTitle,
  stepTimes,
  weeksPlan,
  type Plan,
  type Times,
  type Weekly,
} from '../acceptance/m3a/support.ts';

async function within<T>(fn: () => Promise<T>, h: { restore(): void }): Promise<T> {
  try { return await fn(); } finally { h.restore(); }
}

function localWeeklyFromSlot(startsAt: string, durationMinutes: number): Weekly {
  const local = new Date(Date.parse(startsAt) + 3 * 3_600_000);
  const weekday = local.getUTCDay();
  const startMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const endMinutes = startMinutes + durationMinutes;
  return {
    weekdays: [weekday],
    start: `${String(Math.floor(startMinutes / 60)).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`,
    end: `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`,
  };
}

test('B-1 add without an anchor appends within its phase and a cross-phase anchor is invalid', async () => {
  const h = await setup();
  await within(async () => {
    const answer = weeksPlan();
    answer.steps[1] = { ...answer.steps[1]!, phase: { unit: 'week', index: 1 } };
    h.answer(answer);
    const plan = await draftOf(h.goalId);
    const added = await edit(h.goalId, plan, {
      op: 'add', afterStepId: null,
      step: { title: 'NEW', kind: 'commitment', phase: { unit: 'week', index: 1 }, durationMinutes: 20 },
    });
    assert.equal(added.status, 200);
    const changed = added.body.plan as Plan;
    assert.deepEqual(changed.steps.slice(0, 3).map((step) => step.title), ['امشي نص ساعة', 'رياضة خفيفة', 'NEW']);

    const crossPhase = await edit(h.goalId, changed, {
      op: 'add', afterStepId: changed.steps[0]!.stepId,
      step: { title: 'WRONG PHASE', kind: 'commitment', phase: { unit: 'week', index: 2 }, durationMinutes: 20 },
    });
    assert.equal(crossPhase.status, 422);
    assert.equal(crossPhase.body.reason, 'invalid_edit');
  }, h);
});

test('B-2 Arabic plan imperatives require the plan noun', () => {
  assert.equal(isPlanImperative('اعمللي تذكير بكرا الساعة 9'), false);
  assert.equal(isPlanImperative('اقترحلي مطعم'), false);
  assert.equal(isPlanImperative('ابنيلي خطة أنزل بالوزن'), true);
  assert.equal(isPlanImperative('اعمل إلي خطة للرياضة'), true);
});

test('B-3 a habit saved without a time keeps weekly-count cadence and invents no weekdays', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    const habitStep = stepByTitle(plan, 'رياضة خفيفة');
    const none = await choose(h.goalId, times, habitStep.stepId, { none: true });
    assert.equal(none.status, 200);
    assert.equal((await confirm(h.goalId, none.body.times as Times)).status, 200);
    const habit = (await rows(HABITS))[0]!;
    assert.deepEqual(habit.cadence, { kind: 'weekly_count', count: habitStep.rhythm!.timesPerWeek });
    assert.deepEqual(habit.preferredWindows, []);
  }, h);
});

test('B-4 concurrent statement accepts with one key create and return one goal', async () => {
  const h = await setup({ model: false });
  await within(async () => {
    const preview = await call('goals/from-statement/preview', 'POST', {}, { statement: 'بدي أرجع أركض', locale: 'ar' });
    const idempotencyKey = key('accept-race');
    const body = { summaryId: preview.body.summaryId, revision: preview.body.revision, understood: preview.body.understood, idempotencyKey };
    const [first, second] = await Promise.all([
      call('goals/from-statement/accept', 'POST', {}, body),
      call('goals/from-statement/accept', 'POST', {}, body),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.goalId, second.body.goalId);
    const goals = (await getStorage().list<Record<string, unknown>>(userCol(USER, MEMORY)))
      .filter((row) => row.data.kind === 'goal');
    assert.equal(goals.length, 2, 'the seeded goal plus exactly one accepted goal');
  }, h);
});

test('B-5 vague questions follow locale and event detection requires a time cue', async () => {
  const h = await setup({ model: false });
  await within(async () => {
    const english = await call('goals/from-statement/preview', 'POST', {}, { statement: 'run', locale: 'en' });
    assert.equal(english.body.reason, 'goal_too_vague');
    assert.equal(english.body.question, 'What do you want to change?');

    const hebrew = await call('goals/from-statement/preview', 'POST', {}, { statement: 'לרוץ', locale: 'he' });
    assert.equal(hebrew.body.reason, 'goal_too_vague');
    assert.equal(hebrew.body.question, 'מה היית רוצה לשנות?');

    const goalWithNumber = await call('goals/from-statement/preview', 'POST', {}, {
      statement: 'بدي أنزل 5 كيلو وأروح عالدكتور', locale: 'ar',
    });
    assert.equal(goalWithNumber.status, 200);

    const appointment = await call('goals/from-statement/preview', 'POST', {}, {
      statement: 'عندي موعد دكتور اليوم الساعة 4', locale: 'ar',
    });
    assert.equal(appointment.body.reason, 'not_a_goal');
  }, h);
});

test('B-6 a habit cannot be moved onto another chosen plan interval', async () => {
  const h = await setup();
  await within(async () => {
    const answer = weeksPlan();
    answer.steps[1] = { ...answer.steps[1]!, phase: { unit: 'week', index: 1 }, rhythm: { timesPerWeek: 1 } };
    h.answer(answer);
    const plan = await draftOf(h.goalId);
    const { times } = await approve(h.goalId, plan);
    const walk = stepTimes(times, stepByTitle(plan, 'امشي نص ساعة').stepId).slot!;
    const habitId = stepByTitle(plan, 'رياضة خفيفة').stepId;
    const moved = await choose(h.goalId, times, habitId, { weekly: localWeeklyFromSlot(walk.startsAt, 45) });
    assert.equal(moved.status, 422);
    assert.equal(moved.body.reason, 'not_free');
  }, h);
});

test('B-6 habit timing enforces cadence count and duration-derived end', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    const habitId = stepByTitle(plan, 'رياضة خفيفة').stepId;
    const proposed = stepTimes(times, habitId).weekly!;
    const wrongCount = await choose(h.goalId, times, habitId, { weekly: { ...proposed, weekdays: proposed.weekdays.slice(0, 1) } });
    assert.equal(wrongCount.status, 422);
    assert.equal(wrongCount.body.reason, 'not_free');

    const wrongEnd = await choose(h.goalId, times, habitId, { weekly: { ...proposed, end: proposed.start } });
    assert.equal(wrongEnd.status, 422);
    assert.equal(wrongEnd.body.reason, 'not_free');
  }, h);
});

test('B-6 a habit whose first occurrence is in the past is refused distinctly', async () => {
  const h = await setup();
  await within(async () => {
    const answer = weeksPlan();
    answer.steps[1] = { ...answer.steps[1]!, phase: { unit: 'week', index: 1 }, rhythm: { timesPerWeek: 1 } };
    h.answer(answer);
    const plan = await draftOf(h.goalId);
    const { times } = await approve(h.goalId, plan);
    const habitId = stepByTitle(plan, 'رياضة خفيفة').stepId;
    const today = new Date(Date.parse(REFERENCE) + 3 * 3_600_000).getUTCDay();
    const moved = await choose(h.goalId, times, habitId, { weekly: { weekdays: [today], start: '06:00', end: '06:45' } });
    assert.equal(moved.status, 422);
    assert.equal(moved.body.reason, 'slot_in_past');
  }, h);
});

test('B-7 concurrent regenerate presses share one leased model call and one replacement', async () => {
  const h = await setup();
  await within(async () => {
    const plan = await draftOf(h.goalId);
    const callsBefore = h.modelCalls.length;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    h.answer(async () => { await held; return weeksPlan(); });
    const body = { currentPlanId: plan.planId, revision: plan.revision, idempotencyKey: key('regen-race') };
    const firstPromise = call('goals/[goalId]/plan/regenerate', 'POST', { goalId: h.goalId }, body);
    while (h.modelCalls.length === callsBefore) await new Promise((resolve) => setImmediate(resolve));
    const secondPromise = call('goals/[goalId]/plan/regenerate', 'POST', { goalId: h.goalId }, body);
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(first.body.plan.planId, second.body.plan.planId);
    assert.equal(h.modelCalls.length - callsBefore, 1);
  }, h);
});

test('B-8 reading one goal ignores another goal\'s pending projection', async () => {
  const h = await setup({ model: false });
  await within(async () => {
    await h.storage.set(userSubDoc(USER, GOAL_PLAN_OUTCOMES, 'other-goal-pending'), {
      outcomeId: 'other-goal-outcome', lineageId: 'other-goal', goalId: 'other-goal', requestDigest: 'digest',
      planId: 'other-plan', saved: [], stayed: [], projection: 'pending', affectedDates: [], createdAt: REFERENCE,
    });
    const noProjectionTransactions = new Proxy(h.storage, {
      get(target, property, receiver) {
        if (property === 'runTransaction') return async () => { throw new Error('projection unavailable'); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as StorageAdapter;
    const result = await readGoalPlan(USER, h.goalId, noProjectionTransactions);
    assert.equal(result.draft, null);
    assert.equal(result.confirmed, null);
  }, h);
});

test('B-9 retaking an expired generation lease mints a new fencing token', async () => {
  const h = await setup();
  await within(async () => {
    const claimId = 'abandoned-owner';
    const claimDocumentId = docIdForKey(`goal-plan-claim:${h.goalId}`);
    const claimDocument = userSubDoc(USER, GOAL_PLAN_CLAIMS, claimDocumentId);
    await h.storage.set(claimDocument, {
      claimId, lineageId: h.goalId, goalId: h.goalId, idempotencyKey: 'old-key', state: 'claimed',
      reservedUntil: new Date(Date.parse(REFERENCE) - 1).toISOString(),
    });
    const generated = await call('goals/[goalId]/plan/generate', 'POST', { goalId: h.goalId }, { idempotencyKey: key('retake') });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const finished = await h.storage.get<{ claimId: string; state: string }>(claimDocument);
    assert.equal(finished?.state, 'done');
    assert.notEqual(finished?.claimId, claimId);
  }, h);
});
