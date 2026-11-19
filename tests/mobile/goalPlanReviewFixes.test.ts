import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_PLAN_CLAIMS,
  GOAL_PLAN_OUTCOMES,
  GOAL_PLANS,
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
  generate,
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

test('QA v3 V3-F22-04: a goal statement far past what the app can send is refused, at preview and at accept', async () => {
  const h = await setup({ model: false });
  await within(async () => {
    const huge = 'هدف '.repeat(3000).trim();
    const refused = await call('goals/from-statement/preview', 'POST', {}, { statement: huge, locale: 'ar' });
    assert.equal(refused.status, 422, JSON.stringify(refused.body).slice(0, 200));
    assert.equal(refused.body.reason, 'goal_too_long');
    assert.equal(JSON.stringify(refused.body).includes(huge), false, 'the refusal must not echo the text');

    // The app's longest path: a 2000-character statement, a newline and a
    // 2000-character answer to the "too vague" question.
    const longest = `${'أ'.repeat(2000)}\n${'ب'.repeat(2000)}`;
    const accepted = await call('goals/from-statement/preview', 'POST', {}, { statement: longest, locale: 'ar' });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body).slice(0, 200));

    // The accept takes the understood text from the request: it is held to the same bound.
    const small = await call('goals/from-statement/preview', 'POST', {}, { statement: 'بدي أرجع أركض', locale: 'ar' });
    const swapped = await call('goals/from-statement/accept', 'POST', {}, {
      summaryId: small.body.summaryId, revision: small.body.revision, understood: { goalText: huge }, idempotencyKey: key('accept-huge'),
    });
    assert.equal(swapped.status, 422, JSON.stringify(swapped.body).slice(0, 200));
    assert.equal(swapped.body.reason, 'goal_too_long');
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

test('#807 after a failed regenerate, a regenerate with source template supersedes the draft with a template plan', async () => {
  const h = await setup();
  await within(async () => {
    const plan = await draftOf(h.goalId);
    h.answer(new Error('vertex is down'));
    const failed = await call('goals/[goalId]/plan/regenerate', 'POST', { goalId: h.goalId },
      { currentPlanId: plan.planId, revision: plan.revision, idempotencyKey: key('regen-807-fail') });
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    assert.equal(failed.body.reason, 'model_unavailable');
    // The failed regenerate left the old draft in place, so generate cannot
    // make the template: it answers stale with the old draft (the defect).
    const viaGenerate = await call('goals/[goalId]/plan/generate', 'POST', { goalId: h.goalId },
      { idempotencyKey: key('gen-807'), source: 'template' });
    assert.equal(viaGenerate.status, 409, JSON.stringify(viaGenerate.body));
    assert.equal(viaGenerate.body.plan.planId, plan.planId);

    const calls = h.modelCalls.length;
    const template = await call('goals/[goalId]/plan/regenerate', 'POST', { goalId: h.goalId },
      { currentPlanId: plan.planId, revision: plan.revision, idempotencyKey: key('regen-807-template'), source: 'template' });
    assert.equal(template.status, 200, JSON.stringify(template.body));
    assert.equal(template.body.plan.source, 'template');
    assert.notEqual(template.body.plan.planId, plan.planId);
    assert.ok(template.body.plan.steps.length >= 1);
    assert.ok((template.body.plan.steps as Array<{ origin?: string }>).every((step) => step.origin === undefined || step.origin === 'template'));
    assert.equal(h.modelCalls.length, calls, 'the template regenerate called the model');

    const old = await h.storage.get<{ status: string }>(userSubDoc(USER, GOAL_PLANS, plan.planId));
    assert.equal(old?.status, 'superseded');
    const read = await readGoalPlan(USER, h.goalId);
    assert.equal(read.draft?.planId, template.body.plan.planId);
    assert.equal(read.draft?.source, 'template');

    // Older clients send no source: regenerate still asks the model.
    h.answer(weeksPlan());
    const modelAgain = await call('goals/[goalId]/plan/regenerate', 'POST', { goalId: h.goalId },
      { currentPlanId: template.body.plan.planId, revision: template.body.plan.revision, idempotencyKey: key('regen-807-model') });
    assert.equal(modelAgain.status, 200, JSON.stringify(modelAgain.body));
    assert.equal(modelAgain.body.plan.source, 'model');
    assert.equal(h.modelCalls.length, calls + 1);
  }, h);
});

test('QA v3 V3-F22-02: generate sent again with the same key replays the plan; a new key still answers stale', async () => {
  const h = await setup();
  await within(async () => {
    const idempotencyKey = key('gen-replay');
    const first = await call('goals/[goalId]/plan/generate', 'POST', { goalId: h.goalId }, { idempotencyKey });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const calls = h.modelCalls.length;
    // The reply was lost and the phone sends the same request again.
    const again = await call('goals/[goalId]/plan/generate', 'POST', { goalId: h.goalId }, { idempotencyKey });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.plan.planId, first.body.plan.planId);
    assert.equal(h.modelCalls.length, calls, 'a replay must not ask the model again');
    // A different request is still told a draft already exists.
    const other = await call('goals/[goalId]/plan/generate', 'POST', { goalId: h.goalId }, { idempotencyKey: key('gen-other') });
    assert.equal(other.status, 409, JSON.stringify(other.body));
    assert.equal(other.body.reason, 'stale');
    // A regenerate's key is not a generate's: sending it to generate does
    // not replay the regenerate as if generate had made it.
    const regenKey = key('regen-not-gen');
    const regenerated = await call('goals/[goalId]/plan/regenerate', 'POST', { goalId: h.goalId },
      { currentPlanId: first.body.plan.planId, revision: first.body.plan.revision, idempotencyKey: regenKey });
    assert.equal(regenerated.status, 200, JSON.stringify(regenerated.body));
    const crossed = await call('goals/[goalId]/plan/generate', 'POST', { goalId: h.goalId }, { idempotencyKey: regenKey });
    assert.equal(crossed.status, 409, JSON.stringify(crossed.body));
    assert.equal(crossed.body.reason, 'stale');
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

/* ── Live Gemini, 2026-10-24: an Arabic goal got every step in English ── */

/** The recorded answer's shape: right plan, wrong language. */
function englishPlan(): ReturnType<typeof weeksPlan> {
  const plan = weeksPlan();
  return { ...plan, steps: plan.steps.map((step, index) => ({
    ...step, title: ['Track current eating habits', 'Reduce sugary drinks', 'Walk 30 minutes daily'][index]!,
    expectedOutcome: 'Lower calorie intake', buildsOn: null,
  })) };
}

test('L-1 an Arabic goal asks the model for spoken Levantine Arabic, on generate and on regenerate', async () => {
  const h = await setup();
  await within(async () => {
    const plan = await draftOf(h.goalId);
    assert.match(JSON.stringify(h.modelCalls.at(-1)), /spoken Levantine Arabic/);
    const regenerated = await call('goals/[goalId]/plan/regenerate', 'POST', { goalId: h.goalId },
      { currentPlanId: plan.planId, revision: plan.revision, idempotencyKey: key('regen-lang') });
    assert.equal(regenerated.status, 200, JSON.stringify(regenerated.body));
    assert.match(JSON.stringify(h.modelCalls.at(-1)), /spoken Levantine Arabic/);
  }, h);
});

test('L-2 steps all in another language are the model\'s failure: 503 with the template offered, nothing stored', async () => {
  const h = await setup();
  await within(async () => {
    h.answer(englishPlan());
    const answer = await generate(h.goalId);
    assert.equal(answer.status, 503, JSON.stringify(answer.body));
    assert.equal(answer.body.reason ?? answer.body.error, 'model_unavailable');
    assert.equal(answer.body.recovery, 'template');
    const read = await readGoalPlan(USER, h.goalId).catch(() => null);
    assert.ok(!JSON.stringify(read ?? {}).includes('Track current eating habits'));
  }, h);
});

test('L-3 a step in another language is dropped and an explanation in one left out, the rest kept', async () => {
  const h = await setup();
  await within(async () => {
    const mixed = weeksPlan();
    mixed.steps.push(
      { ...mixed.steps[0]!, title: 'Buy running shoes', phase: { unit: 'week', index: 3 } },
      { ...mixed.steps[2]!, title: 'اكتب شو أكلت كل يوم', expectedOutcome: 'Know what you eat', phase: { unit: 'week', index: 3 } },
    );
    h.answer(mixed);
    const plan = await draftOf(h.goalId);
    const titles = plan.steps.map((step) => step.title);
    assert.ok(!titles.includes('Buy running shoes'), titles.join(' | '));
    assert.equal(plan.steps.length, 4);
    const written = plan.steps.find((step) => step.title === 'اكتب شو أكلت كل يوم') as { expectedOutcome?: unknown } | undefined;
    assert.ok(written);
    assert.equal(written.expectedOutcome ?? null, null);
  }, h);
});

test('L-4 an English step that is invalid anyway does not make a short plan "wrong language": 422, not 503', async () => {
  const h = await setup();
  await within(async () => {
    const plan = weeksPlan();
    plan.steps = [plan.steps[0]!, plan.steps[1]!, { ...plan.steps[2]!, title: 'Weigh yourself', durationMinutes: 2 }];
    h.answer(plan);
    const answer = await generate(h.goalId);
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
  }, h);
});
