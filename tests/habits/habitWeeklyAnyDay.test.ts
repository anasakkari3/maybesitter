/**
 * A weekly-count habit counts whatever day the person does it on (owner
 * decision 2026-11-15, lane B4).
 *
 * "Gym 3 times a week" asks for Monday, Wednesday and Saturday. Done on a
 * Tuesday instead, Tuesday counts for the week and the nearest still-open day
 * after it — Wednesday — stops being asked for, so the week still totals three
 * and the plan frees Wednesday's hour. Once three are done, nothing more is
 * asked that week. «مش اليوم» means nothing on a day that was never asked for,
 * so an off-day row takes «تمّت» only.
 *
 * Every date is named: the week of Monday 2026-11-16 to Sunday 2026-11-22.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import {
  applyOccurrenceOutcome,
  createHabitServices,
  createHabitWithOccurrences,
  patchHabitWithOccurrences,
  todayLocalDateFor,
  todaysOccurrences,
  type HabitServices,
} from '../../lib/services/habits/habitService.ts';
import { materializeHabitOccurrences } from '../../lib/habits/materialize.ts';
import { buildHabitPlanningRequest } from '../../lib/services/habits/habitPlanningAdapter.ts';
import { habitInput } from './habitSupport.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';

const USER = 'weeklyAnyDayUser';
const MON = '2026-11-16';
const TUE = '2026-11-17';
const WED = '2026-11-18';
const THU = '2026-11-19';
const FRI = '2026-11-20';
const SAT = '2026-11-21';
const SUN = '2026-11-22';
const NEXT_MON = '2026-11-23';

let services: HabitServices;

async function setup(): Promise<() => void> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  await seedLiveAccount(USER, storage);
  services = createHabitServices(storage);
  return () => resetStorageForTests();
}

/** Gym, three times a week (Mon/Wed/Sat), no make-ups: the tests are about counting, not recovery. */
async function gym(): Promise<string> {
  const { habit } = await createHabitWithOccurrences(
    services,
    habitInput({ scopeId: USER, recoveryPolicy: 'skip' }),
    '2026-11-16T06:00:00.000Z',
    MON,
  );
  return habit.habitId;
}

const id = (habitId: string, date: string, ordinal = 0) => `${habitId}.${date}.${ordinal}`;

async function decide(habitId: string, occurrenceId: string, outcome: 'completed' | 'skipped', today: string) {
  return (await applyOccurrenceOutcome(services, USER, habitId, occurrenceId, outcome, today)).transition;
}

async function stateOf(occurrenceId: string): Promise<string | undefined> {
  return (await services.occurrences.get(USER, occurrenceId))?.state;
}

test('done on a day it was not asked for, it counts, and the nearest asked-for day after it stops being asked', async () => {
  const restore = await setup();
  try {
    const habitId = await gym();

    const tuesday = await todaysOccurrences(services, USER, TUE);
    const row = tuesday.occurrences.find((entry) => entry.habitId === habitId);
    assert.equal(row?.occurrenceId, id(habitId, TUE), 'a weekly habit offers today even on a day it did not ask for');
    assert.deepEqual(tuesday.anyDay, [id(habitId, TUE)], 'an off-day row is marked as one (done only, no «not today»)');
    assert.deepEqual(tuesday.weeks.find((week) => week.habitId === habitId), { habitId, completed: 0, target: 3 });

    assert.equal((await decide(habitId, id(habitId, TUE), 'completed', TUE)).kind, 'applied');
    assert.equal(await stateOf(id(habitId, TUE)), 'completed');
    assert.equal(await stateOf(id(habitId, WED)), 'recovered', "Wednesday's demand is the one Tuesday took");
    assert.equal(await stateOf(id(habitId, SAT)), 'pending', 'only the nearest day is taken, not the last');

    // On Wednesday the week still owes one more, and Wednesday is offered as an
    // off day again — not as the row Tuesday already covered.
    const wednesday = await todaysOccurrences(services, USER, WED);
    const wedRows = wednesday.occurrences.filter((entry) => entry.habitId === habitId);
    assert.deepEqual(wedRows.map((entry) => [entry.occurrenceId, entry.state]), [[id(habitId, WED, 1), 'pending']]);
    assert.deepEqual(wednesday.weeks.find((week) => week.habitId === habitId), { habitId, completed: 1, target: 3 });
  } finally {
    restore();
  }
});

test('«not today» has no meaning on an off day and decides nothing', async () => {
  const restore = await setup();
  try {
    const habitId = await gym();
    assert.equal((await decide(habitId, id(habitId, TUE), 'skipped', TUE)).kind, 'not_found');
    assert.equal(await stateOf(id(habitId, TUE)), undefined);
    assert.equal(await stateOf(id(habitId, WED)), 'pending');
  } finally {
    restore();
  }
});

test('once the week is done nothing more is asked, and a fourth cannot be added', async () => {
  const restore = await setup();
  try {
    const habitId = await gym();
    await decide(habitId, id(habitId, MON), 'completed', MON);
    await decide(habitId, id(habitId, TUE), 'completed', TUE); // takes Wednesday
    await decide(habitId, id(habitId, THU), 'completed', THU); // takes Saturday

    const friday = await todaysOccurrences(services, USER, FRI);
    assert.deepEqual(friday.occurrences.filter((entry) => entry.habitId === habitId), [], 'nothing is asked for after the week is done');
    assert.deepEqual(friday.weeks.find((week) => week.habitId === habitId), { habitId, completed: 3, target: 3 });
    assert.deepEqual(friday.anyDay, []);
    assert.equal((await decide(habitId, id(habitId, FRI), 'completed', FRI)).kind, 'not_found');
    const saturday = await todaysOccurrences(services, USER, SAT);
    assert.deepEqual(saturday.occurrences.filter((entry) => entry.habitId === habitId && entry.state === 'pending'), []);
  } finally {
    restore();
  }
});

test('with no open day left to take, an off-day «done» still counts while the week is short', async () => {
  const restore = await setup();
  try {
    const habitId = await gym();
    await decide(habitId, id(habitId, MON), 'completed', MON);
    await decide(habitId, id(habitId, WED), 'skipped', MON);
    await decide(habitId, id(habitId, SAT), 'skipped', MON);

    assert.equal((await decide(habitId, id(habitId, THU), 'completed', THU)).kind, 'applied');
    const stored = await services.occurrences.get(USER, id(habitId, THU));
    assert.equal(stored?.state, 'completed');
    assert.equal(stored?.recoveredFromOccurrenceId, null, 'nothing was taken, and it says so');
    assert.equal(await stateOf(id(habitId, WED)), 'skipped');
    assert.equal(await stateOf(id(habitId, SAT)), 'skipped');
  } finally {
    restore();
  }
});

test('the week ends on Sunday: a Sunday «done» never takes next Monday', async () => {
  const restore = await setup();
  try {
    const habitId = await gym();
    await decide(habitId, id(habitId, MON), 'completed', MON);
    await decide(habitId, id(habitId, WED), 'skipped', MON);
    await decide(habitId, id(habitId, SAT), 'skipped', MON);

    assert.equal((await decide(habitId, id(habitId, SUN), 'completed', SUN)).kind, 'applied');
    assert.equal(await stateOf(id(habitId, NEXT_MON)), 'pending', "next week's Monday belongs to next week");
    const monday = await todaysOccurrences(services, USER, NEXT_MON);
    assert.deepEqual(monday.weeks.find((week) => week.habitId === habitId), { habitId, completed: 0, target: 3 });
  } finally {
    restore();
  }
});

test("the week is the person's own: 23:30 UTC on Sunday is already Monday in Jerusalem", async () => {
  assert.equal(todayLocalDateFor(new Date('2026-11-22T23:30:00.000Z'), 'Asia/Jerusalem'), NEXT_MON);
  assert.equal(todayLocalDateFor(new Date('2026-11-22T23:30:00.000Z'), 'UTC'), SUN);
});

test('a paused weekly habit offers no off-day row and takes no «done»', async () => {
  const restore = await setup();
  try {
    const habitId = await gym();
    await patchHabitWithOccurrences(services, USER, habitId, { status: 'paused' }, '2026-11-16T07:00:00.000Z', MON);
    const tuesday = await todaysOccurrences(services, USER, TUE);
    assert.deepEqual(tuesday.occurrences.filter((entry) => entry.habitId === habitId), []);
    assert.equal((await decide(habitId, id(habitId, TUE), 'completed', TUE)).kind, 'not_found');
  } finally {
    restore();
  }
});

test('two devices pressing «done» on the same off day at once record one completion and take one day', async () => {
  const restore = await setup();
  try {
    const habitId = await gym();
    // Device B reads the rows before A writes, and gets them back only after
    // A has finished — the same interleaving as the mint race.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reading!: () => void;
    const bRead = new Promise<void>((resolve) => { reading = resolve; });
    const occurrencesB = Object.create(services.occurrences);
    occurrencesB.listForHabit = async (scopeId: string, habit: string) => {
      const stale = await services.occurrences.listForHabit(scopeId, habit);
      reading();
      await gate;
      return stale;
    };
    occurrencesB.listInRange = async (scopeId: string, from: string, to: string) => {
      const stale = await services.occurrences.listInRange(scopeId, from, to);
      reading();
      await gate;
      return stale;
    };
    const b = applyOccurrenceOutcome({ habits: services.habits, occurrences: occurrencesB }, USER, habitId, id(habitId, TUE), 'completed', TUE);
    await bRead;
    const a = await applyOccurrenceOutcome(services, USER, habitId, id(habitId, TUE), 'completed', TUE);
    release();
    const second = await b;

    assert.equal(a.transition.kind, 'applied');
    assert.equal(second.transition.kind, 'unchanged', 'the same press twice is a retry, never a second completion');
    const week = (await services.occurrences.listForHabit(USER, habitId)).filter((row) => row.localDate >= MON && row.localDate <= SUN);
    assert.equal(week.filter((row) => row.state === 'completed').length, 1);
    assert.equal(await stateOf(id(habitId, WED)), 'recovered');
    assert.equal(await stateOf(id(habitId, SAT)), 'pending', 'the second press must not take a second day');
  } finally {
    restore();
  }
});

test("the daily plan agrees: the day an off-day «done» took is not planned, the others are", async () => {
  const restore = await setup();
  try {
    const habitId = await gym();
    await decide(habitId, id(habitId, TUE), 'completed', TUE);
    const definitions = await services.habits.list(USER);
    const planned = async (date: string) => {
      const stored = await services.occurrences.listInRange(USER, date, date);
      const occurrences = definitions.flatMap((definition) => materializeHabitOccurrences(
        definition,
        { fromLocalDate: date, toLocalDate: date },
        stored.filter((row) => row.habitId === definition.habitId),
      ).occurrences);
      return buildHabitPlanningRequest({ definitions, occurrences, localDate: date, timezone: 'UTC', earliestStartAt: null })
        .items.map((item) => item.itemId);
    };
    assert.deepEqual(await planned(WED), [], "Wednesday's hour goes back to the day");
    assert.deepEqual(await planned(SAT), [id(habitId, SAT)]);
  } finally {
    restore();
  }
});
