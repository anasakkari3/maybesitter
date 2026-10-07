import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_PLAN_CLAIMS,
  GOAL_PLAN_OUTCOMES,
  GOAL_STATEMENT_PREVIEWS,
  HABITS,
  MEMORY,
  docIdForKey,
  userCol,
  userSubDoc,
  type StorageAdapter,
} from '../../lib/storage/index.ts';
import { getStorage } from '../../lib/storage/index.ts';
import { acceptGoalStatement, isPlanImperative, readGoalPlan } from '../../lib/services/mobile/goalPlanService.ts';
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
  overlaps,
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

test('S-1 statement acceptance reads a Firestore Timestamp-shaped expiry', async () => {
  const h = await setup({ model: false });
  await within(async () => {
    const preview = await call('goals/from-statement/preview', 'POST', {}, { statement: 'بدي أرجع أركض', locale: 'ar' });
    const previewPath = userSubDoc(USER, GOAL_STATEMENT_PREVIEWS, preview.body.summaryId);
    const timestampStorage = new Proxy(h.storage, {
      get(target, property, receiver) {
        if (property === 'get') return async <T>(documentPath: string): Promise<T | null> => {
          const stored = await target.get<Record<string, unknown>>(documentPath);
          if (!stored || documentPath !== previewPath) return stored as T | null;
          const expiresAt = new Date(String(stored.expiresAt));
          return { ...stored, expiresAt: { toDate: () => expiresAt } } as T;
        };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as StorageAdapter;
    const accepted = await acceptGoalStatement(USER, {
      summaryId: preview.body.summaryId,
      revision: preview.body.revision,
      understood: preview.body.understood,
      idempotencyKey: key('timestamp-accept'),
    }, timestampStorage);
    assert.equal(typeof accepted.goalId, 'string');
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

function overlappingCommitmentsPlan() {
  const answer = weeksPlan();
  answer.steps[1] = {
    ...answer.steps[1]!,
    kind: 'commitment',
    phase: { unit: 'week', index: 1 },
    durationMinutes: 20,
    rhythm: undefined,
  };
  return answer;
}

async function proposedOverlappingCommitments() {
  const h = await setup();
  h.answer(overlappingCommitmentsPlan());
  const plan = await draftOf(h.goalId);
  const approvedResult = await approve(h.goalId, plan);
  const first = stepTimes(approvedResult.times, approvedResult.plan.steps[0]!.stepId);
  return { h, ...approvedResult, first };
}

test('S-2 every offered commitment alternative is accepted and PATCH recomputes the other alternatives', async () => {
  const initial = await proposedOverlappingCommitments();
  const count = initial.first.alternatives!.length;
  initial.h.restore();
  assert.ok(count > 0, 'the scenario offered no alternatives');

  for (let alternativeIndex = 0; alternativeIndex < count; alternativeIndex += 1) {
    const scenario = await proposedOverlappingCommitments();
    await within(async () => {
      const alternative = scenario.first.alternatives![alternativeIndex];
      assert.ok(alternative && 'startsAt' in alternative, `alternative ${alternativeIndex} disappeared`);
      const chosen = await choose(scenario.h.goalId, scenario.times, scenario.first.stepId, { slot: alternative });
      assert.equal(chosen.status, 200, JSON.stringify(chosen.body));

      const next = chosen.body.times as Times;
      const selected = next.steps.flatMap((entry) => entry.slot ? [entry.slot] : []);
      for (const entry of next.steps) {
        for (const offered of entry.alternatives ?? []) {
          if (!('startsAt' in offered)) continue;
          const otherSelected = selected.filter((slot) => entry.slot !== slot);
          assert.equal(otherSelected.some((slot) => overlaps(offered, slot)), false,
            `${entry.stepId} still offered ${JSON.stringify(offered)} over another chosen slot`);
        }
      }
    }, scenario.h);
  }
});

test('S-3 the fifteen-minute open-goal template carries 15 minutes in Arabic, Hebrew, and English', async () => {
  const cases = [
    { goalText: 'بدي أرتّب البيت', words: /ربع ساعة/ },
    { goalText: 'לסדר את הבית', words: /רבע שעה/ },
    { goalText: 'A tidy flat', words: /15 minutes/ },
  ];
  for (const item of cases) {
    const h = await setup({ model: false, goalText: item.goalText });
    await within(async () => {
      const generated = await call('goals/[goalId]/plan/generate', 'POST', { goalId: h.goalId }, {
        idempotencyKey: key('template-duration'), source: 'template',
      });
      assert.equal(generated.status, 200, JSON.stringify(generated.body));
      const step = (generated.body.plan as Plan).steps.find((candidate) => item.words.test(candidate.title));
      assert.ok(step, `no fifteen-minute step for ${item.goalText}`);
      assert.equal(step.durationMinutes, 15);
    }, h);
  }
});

test('later-week times return the confirmed public plan that names their steps', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    const later = times.steps.find((entry) => entry.later);
    assert.ok(later?.later, 'the plan has no later week');
    const saved = await confirm(h.goalId, times);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const answer = await call(
      'goals/[goalId]/plans/[planId]/later/[weekIndex]/times',
      'POST',
      { goalId: h.goalId, planId: plan.planId, weekIndex: String(later.later.weekIndex) },
      { idempotencyKey: key('later-times') },
    );
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.plan.planId, plan.planId);
    assert.equal(answer.body.plan.status, 'confirmed');
    assert.deepEqual(answer.body.plan.steps, plan.steps);
    assert.equal(answer.body.plan.lineageId, undefined);
    assert.equal(answer.body.times.steps[0].stepId, later.stepId);
  }, h);
});
