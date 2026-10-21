/**
 * M5b-1 Gate B — the week: proposals take no readiness, and acceptance stores
 * the validated week solve (PLAN-M5b-1 R4.1 "applyReadiness", "Week
 * acceptance stores the validated week solve"; Non-goals "Energy on the week
 * view"; M5B1-004, M5B1-006, M5B1-009, M5B1-012).
 *
 * Through `composeWeek` / `acceptWeekDay` — the functions the week routes
 * call — with an injected busy-time reader, as
 * tests/dailyPlan/weekAcceptStoreRace.test.ts drives them, and the real plan
 * routes for what the person then sees. A change is injected "between
 * validation and store" on the last busy read of the validating
 * `composeWeek`: after the accepted day (tomorrow) was composed and before
 * anything is stored.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptWeekDay, composeWeek, weekToDto } from '../../../lib/services/dailyPlan/weekPlan.ts';
import { saveSubjectiveEnergyCheckIn } from '../../../lib/userState/userStateService.ts';
import { planPath } from '../../../lib/services/dailyPlan/planStore.ts';
import {
  NO_READINESS_APPLIED,
  REFERENCE,
  TOMORROW,
  TZ,
  addCommitment,
  addFloating,
  at,
  begin,
  buffersOf,
  call,
  checkInOk,
  currentStorage,
  editCommitment,
  end,
  getPlan,
  healthSnapshot,
  plusMinutes,
  setAccount,
  show,
  storeReadingContext,
  storedPlan,
  type M5bSwitches,
} from './support.ts';

test.afterEach(() => end());

const TASK = 'cmt-week-task-0000-000000000001';
const EVENT = 'cmt-week-event-000-000000000002';
const DECISIONS = { moves: [{ itemId: TASK, date: TOMORROW }], drops: [] };

type Injection = (uid: string) => Promise<void>;

/** One account: a floating task moved onto tomorrow, and a fixed appointment there at 12:00–13:00. */
async function account(switches: M5bSwitches = {}): Promise<string> {
  const uid = await begin(switches);
  await addFloating(uid, 'Write the quarterly report', TASK);
  await addCommitment(uid, 'Doctor appointment', { kind: 'scheduled_event', dueAt: at(TOMORROW, '12:00'), endAt: at(TOMORROW, '13:00'), allDay: false }, EVENT);
  return uid;
}

/** A busy reader that returns nothing until `inject` fires on read `fireOn`, and `after` from then on. */
function reader(fireOn: number, inject: () => Promise<void>, after: () => Array<{ blockId: string; startsAt: string; endsAt: string }> = () => []) {
  let reads = 0;
  return {
    reads: () => reads,
    busyBlocks: async () => {
      reads += 1;
      if (reads === fireOn) { await inject(); return []; }
      return reads > fireOn ? after() : [];
    },
  };
}

async function weekDay(uid: string, deps: Record<string, unknown>) {
  const layout = await composeWeek(uid, DECISIONS as any, deps as any);
  const day = layout.days.find((candidate: any) => candidate.date === TOMORROW) as any;
  assert.ok(day && day.kind === 'proposed', 'fixture: tomorrow is not a proposed day');
  assert.ok(day.plan.scheduled.some((item: any) => item.itemId === TASK), 'fixture: the task is not placed on tomorrow');
  return { layout, day };
}

/* ── the week view takes no readiness (M5B1-004) ───────────────────── */

test('M5B1-004 on: a fresh low check-in, a stale one and a historical-only account each leave the week layout byte-identical to the same week with no reading', async () => {
  const kinds: Array<[string, (uid: string) => Promise<void>]> = [
    ['fresh low', async (uid) => { await checkInOk(uid, 1, plusMinutes(REFERENCE, -10)); }],
    ['stale', async (uid) => storeReadingContext(uid, { currentSubjective: { energy: 1, observedAt: plusMinutes(REFERENCE, -13 * 60) } })],
    ['historical-only', async (uid) => storeReadingContext(uid, { historicalInference: healthSnapshot(uid, 'low', plusMinutes(REFERENCE, -4 * 24 * 60)) })],
  ];
  for (const [label, write] of kinds) {
    const uid = await account();
    const deps = { storage: currentStorage(), now: () => new Date() };
    const shape = (layout: any) => JSON.stringify({
      dto: weekToDto(layout),
      days: layout.days.map((day: any) => (day.kind === 'proposed' ? { date: day.date, constraints: day.constraints, plan: day.plan } : { date: day.date })),
    });
    const without = shape(await composeWeek(uid, DECISIONS as any, deps as any));
    await write(uid);
    assert.equal(shape(await composeWeek(uid, DECISIONS as any, deps as any)), without, `${label}: the reading changed the week`);
    end();
  }
});

test('M5B1-004 parity (passes on base): off, a low reading buffers the week exactly as today', async () => {
  const uid = await account({ on: false });
  await checkInOk(uid, 1, plusMinutes(REFERENCE, -10));
  const { day } = await weekDay(uid, { storage: currentStorage(), now: () => new Date() });
  assert.ok(day.constraints.items.length > 0);
  assert.ok(day.constraints.items.every((item: any) => item.bufferAfterMinutes === 15), 'off-mode week composition no longer applies readiness');
});

/* ── acceptance stores the validated card (M5B1-006, M5B1-009) ─────── */

test('M5B1-009 on, fresh low check-in: the stored day byte-equals the validated card, readinessApplied NO_READINESS_APPLIED; the next GET says basisChanged with no new generation; a rebuild applies the reading', async () => {
  const uid = await account();
  const observedAt = await checkInOk(uid, 1, plusMinutes(REFERENCE, -10));
  const deps = { storage: currentStorage(), now: () => new Date() };
  const { day } = await weekDay(uid, deps);
  const result = await acceptWeekDay(uid, TOMORROW, DECISIONS as any, day.assignment.include, deps as any);
  assert.equal(result.outcome, 'accepted', show(result.outcome));
  const stored = await storedPlan(uid, TOMORROW);
  assert.deepEqual(stored.plan, day.plan, 'the stored placements are not the validated card');
  assert.deepEqual(stored.constraints, day.constraints);
  assert.deepEqual(stored.config, day.config, 'the stored config is not the validated request\'s (ProposedDay.config)');
  assert.equal(stored.inputDigest, day.plan.inputDigest);
  assert.ok(buffersOf(stored).every((minutes) => minutes === 0), 'the accepted day carries readiness buffers');
  assert.deepEqual(stored.readinessApplied, NO_READINESS_APPLIED);

  const read = await getPlan(uid, TOMORROW);
  assert.equal(read.plan.basisChanged, true);
  assert.equal(read.plan.generation, stored.generation, 'the accepted day was refreshed');
  assert.deepEqual(read.plan.readinessApplied, NO_READINESS_APPLIED);

  const rebuilt = await call(uid, 'plans/[date]/regenerate', 'POST', { params: { date: TOMORROW } });
  assert.equal(rebuilt.status, 200, show(rebuilt.body));
  assert.deepEqual(rebuilt.body.plan.readinessApplied, { source: 'check_in', energy: 1, band: 'low', bufferMinutesAdded: 15, observedAt });
  assert.ok(buffersOf(await storedPlan(uid, TOMORROW)).every((minutes) => minutes === 15));
});

test('M5B1-006 controls: the same accept with no reading and with only a stale reading → basisChanged false', async () => {
  for (const stale of [false, true]) {
    const uid = await account();
    if (stale) await storeReadingContext(uid, { currentSubjective: { energy: 1, observedAt: plusMinutes(REFERENCE, -13 * 60) } });
    const deps = { storage: currentStorage(), now: () => new Date() };
    const { day } = await weekDay(uid, deps);
    const result = await acceptWeekDay(uid, TOMORROW, DECISIONS as any, day.assignment.include, deps as any);
    assert.equal(result.outcome, 'accepted');
    const read = await getPlan(uid, TOMORROW);
    assert.equal(read.plan.basisChanged, false, stale ? 'stale' : 'no reading');
    assert.deepEqual(read.plan.readinessApplied, NO_READINESS_APPLIED);
    end();
  }
});

test('M5B1-006 parity (passes on base): a shown that no longer matches answers week_changed and stores nothing', async () => {
  const uid = await account();
  const deps = { storage: currentStorage(), now: () => new Date() };
  await weekDay(uid, deps);
  const result = await acceptWeekDay(uid, TOMORROW, DECISIONS as any, ['not-on-the-card'], deps as any);
  assert.equal(result.outcome, 'week_changed');
  assert.equal(await currentStorage().get(planPath(uid, TOMORROW)), null);
});

/* ── the second-solve race (M5B1-009) ─────────────────────────────── */

/** Runs one accept with `inject` fired between validation and store. Returns the validated day and the stored plan. */
async function raced(uid: string, inject: Injection, after?: () => Array<{ blockId: string; startsAt: string; endsAt: string }>) {
  const dry = reader(Number.POSITIVE_INFINITY, async () => {});
  const { day } = await weekDay(uid, { storage: currentStorage(), now: () => new Date(), busyBlocks: dry.busyBlocks });
  const composeReads = dry.reads();
  assert.ok(composeReads > 1, 'fixture: composeWeek read busy time for fewer than two days');
  const busy = reader(composeReads, () => inject(uid), after);
  const result = await acceptWeekDay(uid, TOMORROW, DECISIONS as any, day.assignment.include, { storage: currentStorage(), now: () => new Date(), busyBlocks: busy.busyBlocks } as any);
  return { day, result, composeReads, reads: busy.reads() };
}

function assertIdenticalOrRefused(label: string, run: Awaited<ReturnType<typeof raced>>, stored: any) {
  if (run.result.outcome === 'week_changed' || run.result.outcome === 'already_planned') {
    assert.equal(stored, null, `${label}: refused, but something was stored`);
    return;
  }
  assert.equal(run.result.outcome, 'accepted', `${label}: ${run.result.outcome}`);
  assert.deepEqual(stored.plan, run.day.plan, `${label}: the store solved a different plan from the validated card`);
  assert.deepEqual(stored.constraints, run.day.constraints, `${label}: different constraints`);
  assert.equal(stored.inputDigest, run.day.plan.inputDigest, `${label}: different digest`);
  // The validating composition (N reads, one per proposed day), no busy read by the store, then the
  // redraw after the accept (N − 1: the accepted day is stored now and reads none). dd73a9fb's store
  // re-solves and reads once more (2N).
  assert.equal(run.reads, 2 * run.composeReads - 1, `${label}: the store read busy time again (${run.reads} reads for ${run.composeReads} per week)`);
}

test('M5B1-009 race: a busy block over the card\'s slot lands between validation and store → the stored plan is the validated card', async () => {
  const uid = await account();
  const { day } = await weekDay(uid, { storage: currentStorage(), now: () => new Date() });
  const slot = day.plan.scheduled.find((item: any) => item.itemId === TASK).interval;
  const run = await raced(uid, async () => {}, () => [{ blockId: 'busy-race', startsAt: slot.startsAt, endsAt: slot.endsAt }]);
  assertIdenticalOrRefused('busy block', run, await currentStorage().get(planPath(uid, TOMORROW)));
});

test('M5B1-009 race: the appointment\'s span edited in storage between validation and store → identical or refused, never a different plan', async () => {
  const uid = await account();
  const run = await raced(uid, async (id) => {
    await editCommitment(id, EVENT, { timeSpec: { dueAt: at(TOMORROW, '08:00'), endAt: at(TOMORROW, '20:00') } });
  });
  assertIdenticalOrRefused('span edit', run, await currentStorage().get(planPath(uid, TOMORROW)));
});

test('M5B1-009 race: a fresh low check-in written between validation and store → identical, no buffers, NO_READINESS_APPLIED', async () => {
  const uid = await account();
  const run = await raced(uid, async (id) => {
    await saveSubjectiveEnergyCheckIn(id, { energy: 1, observedAt: plusMinutes(REFERENCE, -1) }, { storage: currentStorage() as any });
  });
  const stored: any = await currentStorage().get(planPath(uid, TOMORROW));
  assertIdenticalOrRefused('check-in', run, stored);
  assert.deepEqual(stored?.readinessApplied, NO_READINESS_APPLIED);
});

test('M5B1-009 parity (passes on base): off, acceptance re-solves and applies readiness as today, and writes no readinessApplied', async () => {
  const uid = await account({ on: false });
  const run = await raced(uid, async (id) => {
    await saveSubjectiveEnergyCheckIn(id, { energy: 1, observedAt: plusMinutes(REFERENCE, -1) }, { storage: currentStorage() as any });
  });
  assert.equal(run.result.outcome, 'accepted');
  const stored: any = await currentStorage().get(planPath(uid, TOMORROW));
  assert.ok(buffersOf(stored).every((minutes) => minutes === 15), 'off-mode acceptance no longer re-solves with readiness');
  assert.equal('readinessApplied' in stored, false);
});

/* ── the complete snapshot (M5B1-012) ──────────────────────────────── */

test('M5B1-012: a title rename, a timezone change and a locale change between validation and store each store the validated snapshot (AI off: template explanation)', async () => {
  // The control: the same account accepted with nothing injected.
  const control = await account({ aiDisabled: true });
  const controlRun = await raced(control, async () => {});
  assert.equal(controlRun.result.outcome, 'accepted');
  const expected: any = await currentStorage().get(planPath(control, TOMORROW));
  const comparable = (stored: any, uid: string) => JSON.parse(JSON.stringify({
    timezone: stored.timezone,
    locale: stored.locale,
    plan: stored.plan,
    constraints: stored.constraints,
    config: stored.config,
    inputDigest: stored.inputDigest,
    explanation: stored.explanation,
  }).split(uid).join('<uid>').replace(/"inputDigest":"[0-9a-f]{64}"/g, '"inputDigest":"<digest>"'));
  const want = comparable(expected, control);
  assert.equal(want.timezone, TZ);
  assert.equal(want.locale, 'en');
  end();

  const injections: Array<[string, Injection]> = [
    ['title rename', async (uid) => editCommitment(uid, TASK, { title: 'A completely different title' })],
    ['timezone change', async (uid) => setAccount(uid, { timezone: 'Europe/London' })],
    ['locale change', async (uid) => setAccount(uid, { locale: 'ar' })],
  ];
  for (const [label, inject] of injections) {
    const uid = await account({ aiDisabled: true });
    const run = await raced(uid, inject);
    assert.equal(run.result.outcome, 'accepted', `${label}: ${run.result.outcome}`);
    const stored: any = await currentStorage().get(planPath(uid, TOMORROW));
    assert.deepEqual(comparable(stored, uid), want, `${label}: the stored document was built from a re-read, not the validated snapshot`);
    assert.equal(run.reads, 2 * run.composeReads - 1, `${label}: the store read busy time again`);
    end();
  }
});


/* ── the accepted card is the card the client saw (M5B1-014, r5 amendment) ── */

test('M5B1-014 on: each proposed week day carries a layoutDigest; accepting with it stores the day, a different or missing digest answers week_changed and stores nothing', async () => {
  const uid = await account();
  const deps = { storage: currentStorage(), now: () => new Date() };
  const { layout, day } = await weekDay(uid, deps);
  const dtoDay = (weekToDto(layout as any) as any).days.find((candidate: any) => candidate.date === TOMORROW);
  assert.equal(typeof dtoDay?.layoutDigest, 'string', 'the week DTO day has no layoutDigest');
  const body = (layoutDigest?: string) => ({ date: TOMORROW, shown: day.assignment.include, ...DECISIONS, ...(layoutDigest === undefined ? {} : { layoutDigest }) });

  const missing = await call(uid, 'plans/week/accept', 'POST', { body: body() });
  assert.equal(missing.status, 409, `missing digest: ${show(missing.body)}`);
  assert.equal((missing.body as any).reason, 'week_changed');
  const wrong = await call(uid, 'plans/week/accept', 'POST', { body: body(`${dtoDay.layoutDigest}x`) });
  assert.equal(wrong.status, 409, `wrong digest: ${show(wrong.body)}`);
  assert.equal((wrong.body as any).reason, 'week_changed');
  assert.equal(await currentStorage().get(planPath(uid, TOMORROW)), null, 'a refused accept stored a plan');

  const right = await call(uid, 'plans/week/accept', 'POST', { body: body(dtoDay.layoutDigest) });
  assert.equal(right.status, 200, `right digest: ${show(right.body)}`);
  assert.notEqual(await currentStorage().get(planPath(uid, TOMORROW)), null);
});

test('M5B1-014 on: the digest binds times, not only ids — the same steps moved to another slot give a different digest', async () => {
  const uid = await account();
  const deps = { storage: currentStorage(), now: () => new Date() };
  const first = (weekToDto((await weekDay(uid, deps)).layout as any) as any).days.find((candidate: any) => candidate.date === TOMORROW);
  // The appointment moves; the floating task's slot moves with it, its id does not.
  await editCommitment(uid, EVENT, { timeSpec: { dueAt: at(TOMORROW, '09:00'), endAt: at(TOMORROW, '17:00') } });
  const second = (weekToDto((await weekDay(uid, deps)).layout as any) as any).days.find((candidate: any) => candidate.date === TOMORROW);
  assert.equal(typeof first?.layoutDigest, 'string');
  assert.notEqual(second?.layoutDigest, first?.layoutDigest, 'a moved slot kept the same digest');
});

test('M5B1-014 parity (passes on base): off, the week DTO and the accept body are as today', async () => {
  const uid = await account({ on: false });
  const deps = { storage: currentStorage(), now: () => new Date() };
  const { layout, day } = await weekDay(uid, deps);
  const dtoDay = (weekToDto(layout as any) as any).days.find((candidate: any) => candidate.date === TOMORROW);
  assert.equal('layoutDigest' in (dtoDay ?? {}), false, 'off: the week DTO grew a field');
  const accepted = await call(uid, 'plans/week/accept', 'POST', { body: { date: TOMORROW, shown: day.assignment.include, ...DECISIONS } });
  assert.equal(accepted.status, 200, show(accepted.body));
});
