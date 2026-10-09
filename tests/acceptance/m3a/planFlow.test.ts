/**
 * M3a Gate B, the plan flow: runtime gate, generate, whole-plan edit, times
 * and the one confirm (PLAN-M3a.md v7 acceptance 1–4, 6 and the dispositions
 * named in each test; shapes from WIRE-M3a.md). Gate author: Claude.
 *
 * Every test fails on the gate base because the routes do not exist; each
 * must then fail for its own criterion against a build that gets it wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMITMENTS, GOAL_GRAPH_LINKS, GOAL_PLAN_OUTCOMES, HABITS, HABIT_OCCURRENCES } from '../../../lib/storage/paths.ts';
import {
  OTHER, TODAY, TZ, USER, addBusy, addDays, approve, approved, at, call, choose, commitments, confirm, draftOf,
  edit, generate, key, loadCalendar, overlaps, rows, setup, stepByTitle, stepTimes, weeksPlan,
  type Plan, type Slot, type Times, type Weekly,
} from './support.ts';

const WALK = 'امشي نص ساعة'; // walk half an hour
const SPORT = 'رياضة خفيفة'; // light exercise
const WEIGH = 'قيس وزنك وراجع الأكل'; // weigh yourself and review food

async function within<T>(fn: () => Promise<T>, h: { restore(): void }): Promise<T> {
  try { return await fn(); } finally { h.restore(); }
}

/* ── B1 runtime gate (M3A-001, -021, -034, -035) ───────────────────── */

test('M3A-001 the flag off closes every plan route with 404 feature_unavailable', async () => {
  const h = await setup({ env: { MAYBESITTER_FEATURE_GOAL_PLAN: undefined } });
  await within(async () => {
    const answers = [
      await generate(h.goalId),
      await call('goals/[goalId]/plan', 'GET', { goalId: h.goalId }),
      await call('goals/plans/upcoming', 'GET', {}),
      await call('goals/from-statement/preview', 'POST', {}, { statement: 'بدي أنزل بالوزن', locale: 'ar' }), // I want to lose weight
    ];
    for (const answer of answers) {
      assert.equal(answer.status, 404);
      assert.equal(answer.body.reason, 'feature_unavailable', JSON.stringify(answer.body));
    }
    assert.equal(h.modelCalls.length, 0);
  }, h);
});

test('M3A-034 production stays closed even with MAYBESITTER_FEATURE_GOAL_PLAN=true', async () => {
  const h = await setup({ env: { MAYBESITTER_ENV: 'production', MAYBESITTER_FEATURE_GOAL_PLAN: 'true' } });
  await within(async () => {
    const answer = await generate(h.goalId);
    assert.equal(answer.status, 404);
    assert.equal(answer.body.reason, 'feature_unavailable');
    const upcoming = await call('goals/plans/upcoming', 'GET', {});
    assert.equal(upcoming.status, 404);
    assert.equal(h.modelCalls.length, 0);
  }, h);
});

test('M3A-001 the kill switch closes the routes in staging', async () => {
  const h = await setup({ env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_KILL_SWITCH_GOAL_PLAN: 'true' } });
  await within(async () => {
    const answer = await generate(h.goalId);
    assert.equal(answer.status, 404);
    assert.equal(answer.body.reason, 'feature_unavailable');
  }, h);
});

/* ── B2 generate (acceptance 1, M3A-017, -027) ─────────────────────── */

test('A1 plan shape: ordered steps grouped by phase, each with kind, duration, buildsOn and expectedOutcome', async () => {
  const h = await setup();
  await within(async () => {
    const plan = await draftOf(h.goalId);
    assert.equal(plan.status, 'draft');
    assert.equal(plan.source, 'model');
    assert.equal(plan.horizon, 'weeks');
    assert.equal(typeof plan.revision, 'number');
    assert.deepEqual(plan.steps.map((s) => s.order), [1, 2, 3]);
    assert.deepEqual(plan.steps.map((s) => s.title), [WALK, SPORT, WEIGH]);
    assert.deepEqual(plan.steps.map((s) => s.phase), [{ unit: 'week', index: 1 }, { unit: 'week', index: 2 }, { unit: 'week', index: 3 }]);
    const sport = stepByTitle(plan, SPORT);
    assert.equal(sport.kind, 'habit');
    assert.equal(sport.durationMinutes, 45);
    assert.equal(sport.rhythm?.timesPerWeek, 3);
    assert.equal(stepByTitle(plan, WALK).buildsOn, null);
    assert.equal(typeof sport.buildsOn, 'string');
    assert.equal(typeof sport.expectedOutcome, 'string');
    assert.equal(h.modelCalls.length, 1);
  }, h);
});

test('A1 #526 a step that names a calendar date or a person who is not in the goal is dropped', async () => {
  const h = await setup();
  await within(async () => {
    const answer = weeksPlan();
    answer.steps.push(
      { ...answer.steps[0], title: 'روح عالنادي يوم 12/10', phase: { unit: 'week', index: 1 } }, // go to the gym on 12/10
      { ...answer.steps[0], title: 'احكي مع أحمد عن الأكل', phase: { unit: 'week', index: 1 } }, // talk to Ahmad about food
    );
    h.answer(answer);
    const plan = await draftOf(h.goalId);
    const titles = plan.steps.map((s) => s.title);
    assert.ok(!titles.some((t) => t.includes('12/10')), `an invented date survived: ${titles.join(' | ')}`);
    assert.ok(!titles.some((t) => t.includes('أحمد')), `an invented person survived: ${titles.join(' | ')}`); // Ahmad
    assert.equal(plan.steps.length, 3);
  }, h);
});

test('A1 fewer than three valid steps answers 422 no_steps and stores nothing', async () => {
  const h = await setup();
  await within(async () => {
    const answer = weeksPlan();
    answer.steps = answer.steps.slice(0, 2);
    h.answer(answer);
    const result = await generate(h.goalId);
    assert.equal(result.status, 422);
    assert.equal(result.body.reason, 'no_steps');
    const plan = await call('goals/[goalId]/plan', 'GET', { goalId: h.goalId });
    assert.equal(plan.status, 200);
    assert.equal(plan.body.draft, null);
  }, h);
});

test('A6 a model failure answers 503 model_unavailable with recovery, and the template path needs no model', async () => {
  const h = await setup();
  await within(async () => {
    h.answer(new Error('vertex is down'));
    const failed = await generate(h.goalId);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.reason, 'model_unavailable');
    assert.ok(['template', 'retry'].includes(failed.body.recovery));
    const calls = h.modelCalls.length;
    const template = await generate(h.goalId, { source: 'template' });
    assert.equal(template.status, 200, JSON.stringify(template.body));
    assert.equal(template.body.plan.source, 'template');
    assert.ok(template.body.plan.steps.length >= 3 && template.body.plan.steps.length <= 10);
    assert.equal(h.modelCalls.length, calls, 'the template path called the model');
  }, h);
});

test('M3A-017 two presses at once make one model call and one draft', async () => {
  const h = await setup();
  await within(async () => {
    const [a, b] = await Promise.all([generate(h.goalId), generate(h.goalId)]);
    assert.equal(h.modelCalls.length, 1, 'both presses reached the model');
    const ok = [a, b].filter((x) => x.status === 200);
    assert.ok(ok.length >= 1);
    const ids = new Set(ok.map((x) => x.body.plan.planId));
    assert.equal(ids.size, 1, 'two drafts were created');
    const plan = await call('goals/[goalId]/plan', 'GET', { goalId: h.goalId });
    assert.equal(plan.body.draft.planId, Array.from(ids)[0]);
  }, h);
});

test('M3A-027 a generation claim abandoned mid-call is retaken after its lease', async () => {
  const h = await setup();
  await within(async () => {
    h.answer((n: number) => (n === 1 ? new Promise(() => {}) : weeksPlan()));
    let settled = false;
    const pending = generate(h.goalId).catch((error: Error) => ({ status: 0, body: { thrown: error.message } }))
      .finally(() => { settled = true; });
    for (let i = 0; i < 200 && h.modelCalls.length === 0 && !settled; i += 1) await new Promise((r) => setImmediate(r));
    if (settled) assert.fail(`the first press did not reach the model: ${JSON.stringify((await pending).body)}`);
    assert.equal(h.modelCalls.length, 1);
    h.setTime(new Date(Date.parse(new Date().toISOString()) + 121_000).toISOString());
    const second = await generate(h.goalId);
    assert.equal(second.status, 200, `the stuck claim blocked generation: ${JSON.stringify(second.body)}`);
    assert.equal(h.modelCalls.length, 2);
  }, h);
});

/* ── B3 whole-plan edit (acceptance 2, M3A-007, -023) ──────────────── */

test('A2 an edit applies against the viewed revision; a stale one answers 409 with the current plan', async () => {
  const h = await setup();
  await within(async () => {
    const plan = await draftOf(h.goalId);
    const removed = await edit(h.goalId, plan, { op: 'remove', stepId: stepByTitle(plan, WEIGH).stepId });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const next = removed.body.plan as Plan;
    assert.equal(next.revision, plan.revision + 1);
    assert.deepEqual(next.steps.map((s) => s.title), [WALK, SPORT]);
    assert.deepEqual(next.removedSteps.map((s) => s.title), [WEIGH]);

    const stale = await edit(h.goalId, plan, { op: 'remove', stepId: stepByTitle(plan, SPORT).stepId });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.reason, 'stale');
    assert.equal(stale.body.plan.revision, next.revision);
    assert.deepEqual(stale.body.plan.steps.map((s: { title: string }) => s.title), [WALK, SPORT], 'the stale edit was applied');
  }, h);
});

test('A2 remove then restore brings the step back where it was', async () => {
  const h = await setup();
  await within(async () => {
    const plan = await draftOf(h.goalId);
    const sport = stepByTitle(plan, SPORT).stepId;
    const removed = (await edit(h.goalId, plan, { op: 'remove', stepId: sport })).body.plan as Plan;
    const restored = await edit(h.goalId, removed, { op: 'restore', stepId: sport });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual((restored.body.plan as Plan).steps.map((s) => s.title), [WALK, SPORT, WEIGH]);
    assert.deepEqual((restored.body.plan as Plan).removedSteps, []);
  }, h);
});

test('A2 M3A-007 an added step is the person’s: no buildsOn, no outcome, normalized order', async () => {
  const h = await setup();
  await within(async () => {
    const plan = await draftOf(h.goalId);
    const added = await edit(h.goalId, plan, { op: 'add', afterStepId: stepByTitle(plan, WALK).stepId,
      step: { title: 'اشتري سكربينة', kind: 'commitment', phase: { unit: 'week', index: 1 }, durationMinutes: 40 } }); // buy trainers
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const next = added.body.plan as Plan;
    assert.deepEqual(next.steps.map((s) => s.order), [1, 2, 3, 4]);
    const mine = stepByTitle(next, 'اشتري سكربينة');
    assert.equal(mine.order, 2);
    assert.equal(mine.origin, 'person');
    assert.equal(mine.buildsOn, null);
    assert.equal(mine.expectedOutcome, null);
    // SPORT's predecessor did not change (it is still after the week-1 steps), but
    // nothing may invent a line for the person's own step.
  }, h);
});

test('A2 M3A-007 a reorder that changes a step’s predecessor clears its buildsOn', async () => {
  const h = await setup();
  await within(async () => {
    const answer = weeksPlan();
    answer.steps[1] = { ...answer.steps[1], phase: { unit: 'week', index: 1 } }; // SPORT in week 1, after WALK
    h.answer(answer);
    const plan = await draftOf(h.goalId);
    const moved = await edit(h.goalId, plan, { op: 'reorder', stepId: stepByTitle(plan, SPORT).stepId, toOrder: 1 });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const next = moved.body.plan as Plan;
    assert.deepEqual(next.steps.map((s) => s.title), [SPORT, WALK, WEIGH]);
    assert.equal(stepByTitle(next, SPORT).buildsOn, null, 'the first step still claims to build on another');
    assert.equal(stepByTitle(next, WALK).buildsOn, null, 'a buildsOn line was invented for the new predecessor');
  }, h);
});

test('A2 update switches kind and rhythm; an out-of-range duration is refused and changes nothing', async () => {
  const h = await setup();
  await within(async () => {
    const plan = await draftOf(h.goalId);
    const walk = stepByTitle(plan, WALK).stepId;
    const habit = await edit(h.goalId, plan, { op: 'update', stepId: walk, fields: { kind: 'habit', rhythm: { timesPerWeek: 5 } } });
    assert.equal(habit.status, 200, JSON.stringify(habit.body));
    const next = habit.body.plan as Plan;
    assert.equal(stepByTitle(next, WALK).kind, 'habit');
    assert.equal(stepByTitle(next, WALK).rhythm?.timesPerWeek, 5);
    const bad = await edit(h.goalId, next, { op: 'update', stepId: walk, fields: { durationMinutes: 3 } });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.reason, 'invalid_edit');
    assert.equal(stepByTitle(bad.body.plan as Plan, WALK).durationMinutes, 30);
    assert.equal((bad.body.plan as Plan).revision, next.revision);
  }, h);
});

test('A2 M3A-007 a plan cannot be edited down to no steps', async () => {
  const h = await setup();
  await within(async () => {
    let plan = await draftOf(h.goalId);
    for (const title of [WALK, SPORT]) plan = (await edit(h.goalId, plan, { op: 'remove', stepId: stepByTitle(plan, title).stepId })).body.plan as Plan;
    const last = await edit(h.goalId, plan, { op: 'remove', stepId: stepByTitle(plan, WEIGH).stepId });
    assert.equal(last.status, 422);
    assert.equal(last.body.reason, 'invalid_edit');
    assert.equal((last.body.plan as Plan).steps.length, 1);
  }, h);
});

test('M3A-023 the 61st edit of a plan answers 422 too_many_edits with the current plan', async () => {
  const h = await setup();
  await within(async () => {
    let plan = await draftOf(h.goalId);
    const sport = stepByTitle(plan, SPORT).stepId;
    for (let i = 0; i < 60; i += 1) {
      const op = i % 2 === 0 ? { op: 'remove', stepId: sport } : { op: 'restore', stepId: sport };
      const answer = await edit(h.goalId, plan, op);
      assert.equal(answer.status, 200, `edit ${i + 1}: ${JSON.stringify(answer.body)}`);
      plan = answer.body.plan as Plan;
    }
    const over = await edit(h.goalId, plan, { op: 'remove', stepId: sport });
    assert.equal(over.status, 422);
    assert.equal(over.body.reason, 'too_many_edits');
    assert.equal((over.body.plan as Plan).revision, plan.revision);
  }, h);
});

test('A2 account isolation: another account cannot read or edit the plan', async () => {
  const h = await setup();
  await within(async () => {
    const plan = await draftOf(h.goalId);
    const read = await call('goals/[goalId]/plan', 'GET', { goalId: h.goalId }, undefined, OTHER);
    assert.equal(read.status, 404);
    const write = await call('goals/[goalId]/plans/[planId]', 'PATCH', { goalId: h.goalId, planId: plan.planId },
      { revision: plan.revision, op: { op: 'remove', stepId: plan.steps[0].stepId } }, OTHER);
    assert.equal(write.status, 404);
    const mine = await call('goals/[goalId]/plan', 'GET', { goalId: h.goalId });
    assert.equal((mine.body.draft as Plan).steps.length, 3);
  }, h);
});

/* ── B4 times (acceptance 3, M3A-003, -004, -006, -013, -020, -026) ── */

function weekDates(week: number): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(TODAY, (week - 1) * 7 + i));
}

function weeklyIntervals(weekly: Weekly, week: number): Slot[] {
  return weekDates(week)
    .filter((date) => weekly.weekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay()))
    .map((date) => ({ startsAt: at(date, weekly.start), endsAt: at(date, weekly.end) }));
}

function weeklyDates(weekly: Weekly, week: number): string[] {
  return weekDates(week).filter((date) => weekly.weekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay()));
}

function localDate(instant: string): string {
  return new Date(Date.parse(instant) + 3 * 3_600_000).toISOString().slice(0, 10);
}

test('A3 on a loaded calendar the commitment slot is free, in its week, in the future, and as long as the step', async () => {
  const h = await setup();
  await within(async () => {
    const busy = await loadCalendar();
    const { plan, times } = await approved(h.goalId);
    assert.deepEqual(times.anchor, { localDate: TODAY, timezone: TZ });
    const walk = stepTimes(times, stepByTitle(plan, WALK).stepId);
    assert.equal(walk.kind, 'commitment');
    assert.ok(walk.slot, `no slot: ${JSON.stringify(walk)}`);
    const slot = walk.slot!;
    assert.equal(Date.parse(slot.endsAt) - Date.parse(slot.startsAt), 30 * 60_000);
    assert.ok(Date.parse(slot.startsAt) > Date.now(), 'a slot in the past');
    assert.ok(Date.parse(slot.endsAt) <= Date.parse(at(addDays(TODAY, 7), '00:00')), 'a week-1 step placed after week 1');
    assert.ok(!busy.some((b) => overlaps(b, slot)), `the slot ${slot.startsAt} clashes with the calendar`);
    assert.ok((walk.alternatives ?? []).length <= 3);
    for (const alt of (walk.alternatives ?? []) as Slot[]) assert.ok(!busy.some((b) => overlaps(b, alt)), 'a busy alternative');
  }, h);
});

test('A3 M3A-020 a habit gets a weekly timing inside its week, clear of the calendar', async () => {
  const h = await setup();
  await within(async () => {
    const busy = await loadCalendar();
    const { plan, times } = await approved(h.goalId);
    const sport = stepTimes(times, stepByTitle(plan, SPORT).stepId);
    assert.equal(sport.kind, 'habit');
    assert.ok(sport.weekly, `no weekly timing: ${JSON.stringify(sport)}`);
    assert.equal(sport.weekly!.weekdays.length, 3);
    const intervals = weeklyIntervals(sport.weekly!, 2);
    assert.equal(intervals.length, 3);
    for (const interval of intervals) {
      assert.equal(Date.parse(interval.endsAt) - Date.parse(interval.startsAt), 45 * 60_000);
      assert.ok(!busy.some((b) => overlaps(b, interval)), `the habit at ${interval.startsAt} clashes with the calendar`);
    }
  }, h);
});

test('A3 a step after day 14 gets no slot, only its week', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    const weigh = stepTimes(times, stepByTitle(plan, WEIGH).stepId);
    assert.deepEqual(weigh.later, { weekIndex: 3 });
    assert.ok(!weigh.slot, 'a later-week step was given a slot');
  }, h);
});

test('M3A-006 approve requires the viewed revision', async () => {
  const h = await setup();
  await within(async () => {
    const plan = await draftOf(h.goalId);
    const next = (await edit(h.goalId, plan, { op: 'remove', stepId: stepByTitle(plan, WEIGH).stepId })).body.plan as Plan;
    const stale = await call('goals/[goalId]/plans/[planId]/approve', 'POST', { goalId: h.goalId, planId: plan.planId }, { revision: plan.revision });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.reason, 'stale');
    assert.equal(stale.body.plan.revision, next.revision);
  }, h);
});

test('A3 M3A-006 moving a slot is a CAS: alternative accepted, stale refused, busy and past refused', async () => {
  const h = await setup();
  await within(async () => {
    const busy = await loadCalendar();
    const { plan, times } = await approved(h.goalId);
    const walkId = stepByTitle(plan, WALK).stepId;
    const alternatives = (stepTimes(times, walkId).alternatives ?? []) as Slot[];
    assert.ok(alternatives.length >= 1, 'no free alternative was offered on a calendar with free evenings');

    const moved = await choose(h.goalId, times, walkId, { slot: alternatives[0] });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const next = moved.body.times as Times;
    assert.equal(next.timesRevision, times.timesRevision + 1);
    assert.deepEqual(stepTimes(next, walkId).slot, alternatives[0]);

    const stale = await choose(h.goalId, times, walkId, { slot: alternatives[0] });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.reason, 'stale');

    const clash = await choose(h.goalId, next, walkId, { slot: { startsAt: busy[0].startsAt, endsAt: at(TODAY, '09:30') } });
    assert.ok([422].includes(clash.status));
    assert.ok(['not_free', 'slot_in_past'].includes(clash.body.reason), JSON.stringify(clash.body));

    const past = await choose(h.goalId, next, walkId, { slot: { startsAt: at(TODAY, '07:00'), endsAt: at(TODAY, '07:30') } });
    assert.equal(past.status, 422);
    assert.equal(past.body.reason, 'slot_in_past');
  }, h);
});

/* ── B5 the one confirm (acceptance 4, M3A-002, -003, -015, -024, -025, -018, -029, -050) ── */

test('A4 M3A-025 confirm saves a commitment as a timed window at its slot and a habit at its weekly time', async () => {
  const h = await setup();
  await within(async () => {
    await loadCalendar();
    const { plan, times } = await approved(h.goalId);
    const walkId = stepByTitle(plan, WALK).stepId;
    const sportId = stepByTitle(plan, SPORT).stepId;
    const slot = stepTimes(times, walkId).slot!;
    const weekly = stepTimes(times, sportId).weekly!;
    const before = (await commitments()).length;

    const answer = await confirm(h.goalId, times);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));

    const saved = answer.body.saved as Array<Record<string, any>>;
    const walk = saved.find((s) => s.stepId === walkId)!;
    assert.equal(walk.entity, 'commitment');
    assert.equal(walk.title, WALK);
    assert.deepEqual(walk.when, { kind: 'slot', startsAt: slot.startsAt, endsAt: slot.endsAt });
    const sport = saved.find((s) => s.stepId === sportId)!;
    assert.equal(sport.entity, 'habit');
    assert.deepEqual(sport.when, { kind: 'weekly', weekdays: weekly.weekdays, start: weekly.start, end: weekly.end });

    const all = await commitments();
    assert.equal(all.length, before + 1);
    const commitment = all.find((c) => c.id === walk.id)!;
    assert.equal(commitment.status, 'active');
    assert.equal(commitment.timeSpec.kind, 'due_by');
    assert.equal(commitment.timeSpec.dueAt, slot.startsAt);
    assert.equal(commitment.timeSpec.endAt, slot.endsAt);
    assert.equal(commitment.timeSpec.allDay, false);
    assert.equal((commitment.timeSpec as unknown as Record<string, unknown>).windowRule, 'shift');

    const habit = (await rows(HABITS)).find((row) => JSON.stringify(row).includes(sport.id));
    assert.ok(habit, 'the habit was not written');
    assert.deepEqual(habit!.cadence, { kind: 'weekdays', weekdays: weekly.weekdays });
    assert.deepEqual(habit!.preferredWindows, [{ start: weekly.start, end: weekly.end }]);

    const links = await rows(GOAL_GRAPH_LINKS);
    assert.equal(links.filter((link) => JSON.stringify(link).includes(h.goalId)).length, 2, 'the saved steps are not linked to the goal');
  }, h);
});

test('RB-4 a week-2 habit starts in its phase week and projects only those dates', async () => {
  const h = await setup();
  await within(async () => {
    await loadCalendar();
    const { plan, times } = await approved(h.goalId);
    const sportId = stepByTitle(plan, SPORT).stepId;
    const weekly = stepTimes(times, sportId).weekly!;
    const idempotencyKey = key('week-2-habit');
    const answer = await confirm(h.goalId, times, idempotencyKey);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const habitId = (answer.body.saved as Array<Record<string, any>>).find((s) => s.stepId === sportId)!.id;
    const occurrences = (await rows(HABIT_OCCURRENCES)).filter((row) => row.habitId === habitId);
    const expectedDates = weeklyDates(weekly, 2);
    assert.deepEqual(occurrences.map((row) => row.localDate).sort(), expectedDates);
    const expected = weeklyIntervals(weekly, 2);
    for (const interval of expected) {
      const date = localDate(interval.startsAt);
      const occurrence = occurrences.find((row) => row.localDate === date);
      assert.ok(occurrence, `no occurrence on ${date}`);
      assert.equal(occurrence!.placement?.startsAt, interval.startsAt);
      assert.equal(occurrence!.placement?.endsAt, interval.endsAt);
      assert.equal(occurrence!.placement?.origin, 'accepted');
    }
    const outcome = (await rows(GOAL_PLAN_OUTCOMES)).find((row) => row.outcomeId === idempotencyKey);
    const walkSlot = stepTimes(times, stepByTitle(plan, WALK).stepId).slot!;
    assert.deepEqual(outcome?.affectedDates, Array.from(new Set([localDate(walkSlot.startsAt), ...expectedDates])).sort());
  }, h);
});

test('RB-4 a week-1 habit keeps occurrences across both initial weeks', async () => {
  const h = await setup();
  await within(async () => {
    const answer = weeksPlan();
    answer.steps[0] = { ...answer.steps[0]!, kind: 'habit', rhythm: { timesPerWeek: 3, timeOfDay: 'morning' } };
    h.answer(answer);
    const { plan, times } = await approved(h.goalId);
    const habitStepId = stepByTitle(plan, WALK).stepId;
    const weekly = stepTimes(times, habitStepId).weekly!;
    const confirmed = await confirm(h.goalId, times);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const habitId = (confirmed.body.saved as Array<Record<string, any>>).find((saved) => saved.stepId === habitStepId)!.id;
    const occurrenceDates = (await rows(HABIT_OCCURRENCES))
      .filter((row) => row.habitId === habitId)
      .map((row) => row.localDate)
      .sort();
    assert.deepEqual(occurrenceDates, [...weeklyDates(weekly, 1), ...weeklyDates(weekly, 2)].sort());
  }, h);
});

test('RB-4 a day-phase habit in days 8–14 starts in week 2', async () => {
  for (const phaseDay of [8, 14]) {
    const h = await setup();
    await within(async () => {
      const answer = weeksPlan();
      h.answer({ horizon: 'days', steps: [
        { ...answer.steps[0]!, phase: { unit: 'day', index: 1 } },
        { ...answer.steps[1]!, phase: { unit: 'day', index: phaseDay } },
        { ...answer.steps[2]!, phase: { unit: 'day', index: 15 } },
      ] });
      const { plan, times } = await approved(h.goalId);
      const habitStepId = stepByTitle(plan, SPORT).stepId;
      const weekly = stepTimes(times, habitStepId).weekly!;
      const confirmed = await confirm(h.goalId, times);
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      const habitId = (confirmed.body.saved as Array<Record<string, any>>).find((saved) => saved.stepId === habitStepId)!.id;
      const occurrenceDates = (await rows(HABIT_OCCURRENCES))
        .filter((row) => row.habitId === habitId)
        .map((row) => row.localDate)
        .sort();
      assert.deepEqual(occurrenceDates, weeklyDates(weekly, 2), `day ${phaseDay}`);
    }, h);
  }
});

test('RB-4 a replay keeps the phase-scoped habit occurrence rows unchanged', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    const sportId = stepByTitle(plan, SPORT).stepId;
    const weekly = stepTimes(times, sportId).weekly!;
    const idempotencyKey = key('habit-replay');
    const first = await confirm(h.goalId, times, idempotencyKey);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const habitId = (first.body.saved as Array<Record<string, any>>).find((saved) => saved.stepId === sportId)!.id;
    const before = (await rows(HABIT_OCCURRENCES)).filter((row) => row.habitId === habitId);
    assert.deepEqual(before.map((row) => row.localDate).sort(), weeklyDates(weekly, 2));

    const replay = await confirm(h.goalId, times, idempotencyKey);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.receipt.replayed, true);
    const after = (await rows(HABIT_OCCURRENCES)).filter((row) => row.habitId === habitId);
    assert.deepEqual(after, before);
  }, h);
});

test('A4 M3A-008 M3A-024 the answer says what stayed and why; «بلا وقت» is saved without a time', async () => {
  const h = await setup();
  await within(async () => {
    const plan = await draftOf(h.goalId);
    const extra = await edit(h.goalId, plan, { op: 'add', afterStepId: stepByTitle(plan, WALK).stepId,
      step: { title: 'اشتري ميزان', kind: 'commitment', phase: { unit: 'week', index: 1 }, durationMinutes: 20 } }); // buy scales
    let next = extra.body.plan as Plan;
    next = (await edit(h.goalId, next, { op: 'remove', stepId: stepByTitle(next, 'اشتري ميزان').stepId })).body.plan as Plan;
    const { times } = await approve(h.goalId, next);
    const walkId = stepByTitle(next, WALK).stepId;
    const none = await choose(h.goalId, times, walkId, { none: true });
    assert.equal(none.status, 200, JSON.stringify(none.body));

    const answer = await confirm(h.goalId, none.body.times as Times);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const saved = answer.body.saved as Array<Record<string, any>>;
    const walk = saved.find((s) => s.stepId === walkId);
    assert.ok(walk, '«بلا وقت» was not saved'); // no time
    assert.deepEqual(walk!.when, { kind: 'none' });
    const commitment = (await commitments()).find((c) => c.id === walk!.id)!;
    assert.equal(commitment.timeSpec.kind, 'unscheduled');

    const stayed = answer.body.stayed as Array<Record<string, any>>;
    assert.deepEqual(stayed.find((s) => s.title === WEIGH)?.why, { kind: 'later_week', weekIndex: 3 });
    assert.deepEqual(stayed.find((s) => s.title === 'اشتري ميزان')?.why, { kind: 'removed' });
    assert.ok(!stayed.some((s) => s.stepId === walkId), '«بلا وقت» listed as a suggestion that stayed');
    assert.ok(!stayed.some((s) => s.why?.kind === 'no_time_chosen'));
  }, h);
});

test('M3A-004 a commitment saved between approve and confirm answers 409 schedule_changed and writes nothing', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    const slot = stepTimes(times, stepByTitle(plan, WALK).stepId).slot!;
    await addBusy(slot);
    const before = { commitments: (await commitments()).length, habits: (await rows(HABITS)).length, links: (await rows(GOAL_GRAPH_LINKS)).length };
    const answer = await confirm(h.goalId, times);
    assert.equal(answer.status, 409);
    assert.equal(answer.body.reason, 'schedule_changed');
    const fresh = answer.body.times as Times;
    assert.ok(fresh && fresh.timesId, 'no recomputed proposal came back');
    assert.ok(!overlaps(stepTimes(fresh, stepByTitle(plan, WALK).stepId).slot!, slot), 'the recomputed slot still clashes');
    assert.deepEqual({ commitments: (await commitments()).length, habits: (await rows(HABITS)).length, links: (await rows(GOAL_GRAPH_LINKS)).length }, before);
  }, h);
});

test('M3A-013 a slot that entered the past answers 422 slot_in_past and writes nothing', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    const slot = stepTimes(times, stepByTitle(plan, WALK).stepId).slot!;
    h.setTime(new Date(Date.parse(slot.startsAt) + 60_000).toISOString());
    const before = (await commitments()).length;
    const answer = await confirm(h.goalId, times);
    assert.equal(answer.status, 422);
    assert.equal(answer.body.reason, 'slot_in_past');
    assert.equal((await commitments()).length, before);
  }, h);
});

test('A4 M3A-018 M3A-029 a replay returns the original answer and creates nothing; another payload under the key is key_reused', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    const k = key('replay');
    const first = await confirm(h.goalId, times, k);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const count = (await commitments()).length;
    const habits = (await rows(HABITS)).length;

    const again = await confirm(h.goalId, times, k);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.saved, first.body.saved);
    assert.deepEqual(again.body.stayed, first.body.stayed);
    assert.equal(again.body.receipt.replayed, true);
    assert.equal((await commitments()).length, count);
    assert.equal((await rows(HABITS)).length, habits);

    const reused = await confirm(h.goalId, { ...times, timesRevision: times.timesRevision + 1 }, k);
    assert.equal(reused.status, 409);
    assert.equal(reused.body.reason, 'key_reused');
    void plan;
  }, h);
});

test('M3A-004 two confirms of one plan at once save one set', async () => {
  const h = await setup();
  await within(async () => {
    const { times } = await approved(h.goalId);
    const before = (await commitments()).length;
    const [a, b] = await Promise.all([confirm(h.goalId, times), confirm(h.goalId, times)]);
    assert.ok([a.status, b.status].includes(200));
    assert.equal((await commitments()).length, before + 1, 'two confirms saved the commitment twice');
    assert.equal((await rows(HABITS)).length, 1, 'two confirms saved the habit twice');
  }, h);
});

test('M3A-002 M3A-022 a failure at any commit leaves nothing or everything visible, and a replay completes once', async () => {
  for (let failAt = 1; failAt <= 8; failAt += 1) {
    const h = await setup();
    await within(async () => {
      const { times } = await approved(h.goalId);
      const k = key(`fault${failAt}`);
      let commits = 0;
      let failed = false;
      h.storage.setBeforeCommitHookForTests(async () => {
        commits += 1;
        if (commits === failAt && !failed) { failed = true; throw new Error(`injected commit failure ${failAt}`); }
      });
      const answer = await confirm(h.goalId, times, k).catch((error: Error) => ({ status: 500, body: { thrown: error.message } }));
      h.storage.setBeforeCommitHookForTests(null);
      const visible = { commitments: (await commitments()).length, habits: (await rows(HABITS)).length,
        links: (await rows(GOAL_GRAPH_LINKS)).filter((l) => JSON.stringify(l).includes(h.goalId)).length };
      if (answer.status === 200) {
        assert.deepEqual(visible, { commitments: 1, habits: 1, links: 2 }, `failAt ${failAt}: success with a partial set`);
      } else {
        assert.deepEqual(visible, { commitments: 0, habits: 0, links: 0 }, `failAt ${failAt}: a failed confirm left a partial set`);
      }
      const replay = await confirm(h.goalId, times, k);
      assert.equal(replay.status, 200, `failAt ${failAt}: the replay did not complete: ${JSON.stringify(replay.body)}`);
      assert.equal((await commitments()).length, 1, `failAt ${failAt}: the replay saved twice`);
      assert.equal((await rows(HABITS)).length, 1, `failAt ${failAt}: the replay saved the habit twice`);
    }, h);
  }
});

test('M3A-030 a day whose plan was already built shows the saved step at its slot right after the confirm', async () => {
  const h = await setup();
  await within(async () => {
    await loadCalendar();
    const { plan, times } = await approved(h.goalId);
    const slot = stepTimes(times, stepByTitle(plan, WALK).stepId).slot!;
    const date = new Date(Date.parse(slot.startsAt) + 3 * 3_600_000).toISOString().slice(0, 10);
    const built = await call('plans/[date]/build', 'POST', { date });
    assert.equal(built.status, 200, `building ${date}: ${JSON.stringify(built.body)}`);

    const answer = await confirm(h.goalId, times);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const commitmentId = (answer.body.saved as Array<Record<string, any>>).find((s) => s.entity === 'commitment')!.id;
    const day = await call('plans/[date]', 'GET', { date });
    assert.equal(day.status, 200, JSON.stringify(day.body));
    const holders = objectsMentioning(day.body, commitmentId);
    assert.ok(holders.length > 0, `the stored plan of ${date} does not show the saved step`);
    assert.ok(holders.some((o) => Object.values(o).includes(slot.startsAt)), `the step is not at its slot ${slot.startsAt}: ${JSON.stringify(holders)}`);
  }, h);
});

function objectsMentioning(value: unknown, id: string, found: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(value)) { for (const item of value) objectsMentioning(item, id, found); return found; }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.values(record).includes(id)) found.push(record);
    for (const item of Object.values(record)) objectsMentioning(item, id, found);
  }
  return found;
}

/* ── S1 / M3A-046 regenerate ─────────────────────────────────────── */

test('S1 regenerating a confirmed plan answers 409 plan_confirmed and touches nothing', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    assert.equal((await confirm(h.goalId, times)).status, 200);
    const calls = h.modelCalls.length;
    const answer = await call('goals/[goalId]/plan/regenerate', 'POST', { goalId: h.goalId },
      { currentPlanId: plan.planId, revision: plan.revision, idempotencyKey: key('regen') });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.reason, 'plan_confirmed');
    assert.equal(h.modelCalls.length, calls);
  }, h);
});

test('M3A-046 regenerating a draft supersedes it: the old plan id can no longer be edited, approved or confirmed', async () => {
  const h = await setup();
  await within(async () => {
    const { plan, times } = await approved(h.goalId);
    const regenerated = await call('goals/[goalId]/plan/regenerate', 'POST', { goalId: h.goalId },
      { currentPlanId: plan.planId, revision: plan.revision, idempotencyKey: key('regen') });
    assert.equal(regenerated.status, 200, JSON.stringify(regenerated.body));
    assert.notEqual(regenerated.body.plan.planId, plan.planId);
    const old = await confirm(h.goalId, times);
    assert.equal(old.status, 409);
    assert.equal(old.body.reason, 'stale');
    assert.equal((await commitments()).length, 0);
    const oldEdit = await edit(h.goalId, plan, { op: 'remove', stepId: plan.steps[0].stepId });
    assert.equal(oldEdit.status, 409);
  }, h);
});
