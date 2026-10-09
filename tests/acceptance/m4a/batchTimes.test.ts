/**
 * M4a Gate B — change all the plan's times at once (condition 23; PLAN-M4a
 * R005) and the goal-plan guards the review folded in: one actionability guard
 * (M4A-R4-001, R5-001, R5-003), later-phase entries preserved (R2-004),
 * misses saved with no time (R3-001), `startFrom` re-anchoring (R5-004), the
 * later-week effective window (R6-001) and day-horizon later steps (R8-002).
 *
 * Reuses the M3a harness: the plan model stubbed at its last hop, the clock
 * pinned to Wednesday 2026-10-07 10:00 Jerusalem.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_AR,
  TODAY,
  TZ,
  addDays,
  approve,
  approved,
  at,
  call,
  choose,
  confirm,
  draftOf,
  key,
  rows,
  setup,
  stepByTitle,
  stepTimes,
  weeksPlan,
  type ModelStep,
  type Plan,
  type Times,
} from '../m3a/support.ts';

async function within<T>(fn: () => Promise<T>, h: { restore(): void }): Promise<T> {
  try { return await fn(); } finally { h.restore(); }
}

function batch(goalId: string, times: Times, preference: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return call('goals/[goalId]/plans/[planId]/times/batch', 'POST', { goalId, planId: times.planId },
    { timesId: times.timesId, timesRevision: times.timesRevision, preference, ...overrides });
}

function localDateOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function localTimeOf(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

function laterEntries(times: Times) {
  return times.steps.filter((step) => step.later !== undefined);
}

function step(title: string, kind: 'commitment' | 'habit', unit: 'day' | 'week', index: number, extra: Partial<ModelStep> = {}): ModelStep {
  return { title, kind, phase: { unit, index }, durationMinutes: 30, buildsOn: null, expectedOutcome: null,
    sourceSpans: [{ start: 0, end: GOAL_AR.length, text: GOAL_AR }], inferred: true, ...extra };
}

/* ── the batch itself ──────────────────────────────────────────────── */

test('R005 «غيّر كل الأوقات» → evening: one request moves every placeable step to the evening; later entries are kept byte for byte (M4A-R2-004)', async () => {
  const h = await setup();
  await within(async () => {
    const { times } = await approved(h.goalId);
    const before = laterEntries(times);
    assert.ok(before.length >= 1, 'the default plan has a week-3 later entry');
    const result = await batch(h.goalId, times, { partOfDay: 'evening' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const after = result.body.times as Times;
    assert.equal(after.timesRevision, times.timesRevision + 1);
    assert.deepEqual(laterEntries(after), before, 'a later entry was touched');
    for (const entry of after.steps.filter((s) => s.slot)) {
      assert.ok(localTimeOf(entry.slot!.startsAt) >= '17:00', `not moved to the evening: ${JSON.stringify(entry)}`);
    }
    for (const entry of after.steps.filter((s) => s.weekly)) {
      assert.ok(entry.weekly!.start >= '17:00', `weekly not moved to the evening: ${JSON.stringify(entry)}`);
    }
    assert.deepEqual(result.body.unplaced, []);
  }, h);
});

test('R005 M4A-R3-001 «كلها بلا وقت»: every placeable step has no time, later entries stay, and the confirm saves them with no time', async () => {
  const h = await setup();
  await within(async () => {
    const { times } = await approved(h.goalId);
    const result = await batch(h.goalId, times, { noTime: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const after = result.body.times as Times;
    for (const entry of after.steps.filter((s) => s.later === undefined)) {
      assert.equal(entry.choice, 'none', JSON.stringify(entry));
    }
    assert.deepEqual(laterEntries(after), laterEntries(times));
    const saved = await confirm(h.goalId, after);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const placeable = after.steps.filter((s) => s.later === undefined).map((s) => s.stepId).sort();
    assert.deepEqual((saved.body.saved as Array<{ stepId: string; when: { kind: string } }>).filter((s) => s.when.kind === 'none').map((s) => s.stepId).sort(), placeable);
  }, h);
});

test('R005 M4A-R3-001 a step that cannot be placed becomes «بلا وقت», is named in unplaced, and is SAVED by the confirm (never stayed: no_room)', async () => {
  const h = await setup();
  await within(async () => {
    // Every evening of the first three weeks is taken.
    for (let day = 0; day < 21; day += 1) {
      const { addBusy } = await import('../m3a/support.ts');
      await addBusy({ startsAt: at(addDays(TODAY, day), '16:30'), endsAt: at(addDays(TODAY, day), '23:30') });
    }
    const { times } = await approved(h.goalId);
    const result = await batch(h.goalId, times, { partOfDay: 'evening' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const unplaced = result.body.unplaced as string[];
    assert.ok(unplaced.length >= 1, JSON.stringify(result.body));
    const after = result.body.times as Times;
    for (const id of unplaced) assert.equal(stepTimes(after, id).choice, 'none', 'a miss not normalised to none');
    const saved = await confirm(h.goalId, after);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const savedIds = new Set((saved.body.saved as Array<{ stepId: string }>).map((s) => s.stepId));
    for (const id of unplaced) assert.ok(savedIds.has(id), `unplaced step ${id} was silently not saved: ${JSON.stringify(saved.body.stayed)}`);
  }, h);
});

test('R005 M4A-R5-004 startFrom re-anchors: day-1 and day-3 steps move by one civil-day delta and keep their spacing', async () => {
  const h = await setup();
  await within(async () => {
    // A plan needs at least three steps (`validateModelPlan`).
    h.answer({ horizon: 'days', steps: [step('خطوة أولى', 'commitment', 'day', 1), step('خطوة تالتة', 'commitment', 'day', 3), step('خطوة خامسة', 'commitment', 'day', 5)] }); // first / third / fifth step
    const { plan, times } = await approve(h.goalId, await draftOf(h.goalId));
    const first = stepTimes(times, stepByTitle(plan, 'خطوة أولى').stepId).slot!;
    const third = stepTimes(times, stepByTitle(plan, 'خطوة تالتة').stepId).slot!;
    assert.ok(first && third, JSON.stringify(times));
    const startFrom = addDays(localDateOf(first.startsAt), 2);
    const result = await batch(h.goalId, times, { startFrom });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const after = result.body.times as Times;
    const firstAfter = stepTimes(after, stepByTitle(plan, 'خطوة أولى').stepId).slot!;
    const thirdAfter = stepTimes(after, stepByTitle(plan, 'خطوة تالتة').stepId).slot!;
    assert.equal(localDateOf(firstAfter.startsAt), startFrom, 'the first step is not on startFrom');
    assert.equal(localDateOf(thirdAfter.startsAt), addDays(localDateOf(third.startsAt), 2), 'the spacing was not kept');
  }, h);
});

test('R005 a stale timesRevision is 409 times_changed carrying the current times', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    const walk = stepByTitle(plan, 'امشي نص ساعة').stepId;
    const moved = await choose(h.goalId, times, walk, { none: true });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const result = await batch(h.goalId, times, { partOfDay: 'morning' });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.reason, 'times_changed');
    assert.equal(result.body.times.timesRevision, times.timesRevision + 1);
  }, h);
});

test('R005 invalid preferences are 400 invalid_preference', async () => {
  const h = await setup();
  await within(async () => {
    const { times } = await approved(h.goalId);
    for (const preference of [{}, { noTime: true, partOfDay: 'evening' }, { startFrom: addDays(TODAY, 15) }, { startFrom: addDays(TODAY, -1) }, { partOfDay: 'night' }]) {
      const result = await batch(h.goalId, times, preference);
      assert.equal(result.status, 400, `${JSON.stringify(preference)} → ${JSON.stringify(result.body)}`);
      assert.equal(result.body.reason, 'invalid_preference', JSON.stringify(result.body));
    }
    const edge = await batch(h.goalId, times, { startFrom: addDays(TODAY, 14) });
    assert.equal(edge.status, 200, `day 14 must be allowed: ${JSON.stringify(edge.body)}`);
  }, h);
});

/* ── one actionability guard (M4A-R4-001, R5-001, R5-003) ──────────── */

test('M4A-R4-001 R5-003 after the initial confirm: a batch, a single-step edit and a fresh-key confirm are 409 times_consumed; the original key still replays', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    const k = key('confirm');
    const first = await confirm(h.goalId, times, k);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const commitmentsBefore = (await rows('commitments')).length;

    const viaBatch = await batch(h.goalId, times, { partOfDay: 'evening' });
    assert.equal(viaBatch.status, 409, JSON.stringify(viaBatch.body));
    assert.equal(viaBatch.body.reason, 'times_consumed');
    assert.equal(viaBatch.body.times, undefined, 'a consumed proposal carried times to adopt');

    const viaStep = await choose(h.goalId, times, stepByTitle(plan, 'امشي نص ساعة').stepId, { none: true });
    assert.equal(viaStep.status, 409, JSON.stringify(viaStep.body));
    assert.equal(viaStep.body.reason, 'times_consumed');

    const fresh = await confirm(h.goalId, times, key('again'));
    assert.equal(fresh.status, 409, JSON.stringify(fresh.body));
    assert.equal(fresh.body.reason, 'times_consumed');
    assert.equal((await rows('commitments')).length, commitmentsBefore, 'a duplicate was written');

    const replay = await confirm(h.goalId, times, k);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
    assert.deepEqual(replay.body.saved, first.body.saved);
  }, h);
});

test('M4A-R4-001 a confirmed later week is consumed too, and the initial confirm still replays', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    const k = key('confirm');
    assert.equal((await confirm(h.goalId, times, k)).status, 200);
    h.setTime(at(addDays(TODAY, 14), '10:00'));
    const later = await call('goals/[goalId]/plans/[planId]/later/[weekIndex]/times', 'POST',
      { goalId: h.goalId, planId: plan.planId, weekIndex: '3' }, { idempotencyKey: key('later') });
    assert.equal(later.status, 200, JSON.stringify(later.body));
    const laterTimes = later.body.times as Times;
    const edited = await batch(h.goalId, laterTimes, { partOfDay: 'morning' });
    assert.equal(edited.status, 200, `a later-week batch must be supported: ${JSON.stringify(edited.body)}`);
    const laterConfirm = await confirm(h.goalId, edited.body.times as Times);
    assert.equal(laterConfirm.status, 200, JSON.stringify(laterConfirm.body));
    const again = await batch(h.goalId, edited.body.times as Times, { partOfDay: 'evening' });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.reason, 'times_consumed');
    assert.equal((await confirm(h.goalId, times, k)).status, 200, 'the initial confirm no longer replays');
  }, h);
});

/* ── the later-week effective window (M4A-R6-001) ──────────────────── */

for (const withBatch of [false, true]) {
  test(`M4A-R6-001 a week-3 habit gets occurrences only from week 3 on${withBatch ? ', after a batch edit' : ''}`, async () => {
    const h = await setup();
    await within(async () => {
      h.answer({ horizon: 'weeks', steps: [
        step('امشي', 'commitment', 'week', 1), // walk
        step('مشي أطول', 'commitment', 'week', 2), // a longer walk
        step('رياضة', 'habit', 'week', 3, { rhythm: { timesPerWeek: 3, timeOfDay: 'evening' } }), // exercise
      ] });
      const { plan, times } = await approve(h.goalId, await draftOf(h.goalId));
      assert.equal((await confirm(h.goalId, times)).status, 200);
      h.setTime(at(addDays(TODAY, 14), '10:00'));
      const later = await call('goals/[goalId]/plans/[planId]/later/[weekIndex]/times', 'POST',
        { goalId: h.goalId, planId: plan.planId, weekIndex: '3' }, { idempotencyKey: key('later') });
      assert.equal(later.status, 200, JSON.stringify(later.body));
      let laterTimes = later.body.times as Times;
      if (withBatch) {
        const edited = await batch(h.goalId, laterTimes, { partOfDay: 'evening' });
        assert.equal(edited.status, 200, JSON.stringify(edited.body));
        laterTimes = edited.body.times as Times;
      }
      assert.equal((await confirm(h.goalId, laterTimes)).status, 200);
      const weekThree = addDays(TODAY, 14);
      const occurrences = await rows('habitOccurrences');
      assert.ok(occurrences.length >= 1, 'no occurrence was written');
      for (const occurrence of occurrences) {
        assert.ok(occurrence.localDate >= weekThree, `an occurrence before week 3: ${occurrence.localDate}`);
      }
    }, h);
  });
}

/* ── day-horizon later steps (M4A-R8-002) ──────────────────────────── */

test('M4A-R8-002 a day-15 commitment and habit are reviewed in the week containing day 15 and saved on their real dates', async () => {
  const h = await setup();
  await within(async () => {
    h.answer({ horizon: 'days', steps: [
      step('بداية', 'commitment', 'day', 1), // a start
      step('مراجعة اليوم 15', 'commitment', 'day', 15), // day-15 review
      step('عادة اليوم 15', 'habit', 'day', 15, { rhythm: { timesPerWeek: 2 } }), // a day-15 habit
    ] });
    const { plan, times } = await approve(h.goalId, await draftOf(h.goalId));
    assert.equal((await confirm(h.goalId, times)).status, 200);
    const reviewId = stepByTitle(plan, 'مراجعة اليوم 15').stepId;
    const habitId = stepByTitle(plan, 'عادة اليوم 15').stepId;
    h.setTime(at(addDays(TODAY, 13), '10:00'));
    const later = await call('goals/[goalId]/plans/[planId]/later/[weekIndex]/times', 'POST',
      { goalId: h.goalId, planId: plan.planId, weekIndex: '3' }, { idempotencyKey: key('later') });
    assert.equal(later.status, 200, `the week containing day 15 is week 3: ${JSON.stringify(later.body)}`);
    const laterTimes = later.body.times as Times;
    assert.deepEqual(laterTimes.steps.map((s) => s.stepId).sort(), [reviewId, habitId].sort());
    const saved = await confirm(h.goalId, laterTimes);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const savedIds = (saved.body.saved as Array<{ stepId: string }>).map((s) => s.stepId).sort();
    assert.deepEqual(savedIds, [reviewId, habitId].sort(), 'a day-15 step was dropped');
    const review = stepTimes(laterTimes, reviewId).slot;
    if (review) assert.equal(localDateOf(review.startsAt) >= addDays(TODAY, 14), true, 'day 15 placed before its date');
  }, h);
});

void weeksPlan;
void (null as unknown as Plan);
