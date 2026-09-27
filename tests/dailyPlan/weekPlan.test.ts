/**
 * Weekly planning mode, «خطّط أسبوعي» (CL5b; council verdict 2026-09-26, item 6).
 *
 * The week is the existing daily planner run once per date, today … today+6,
 * with one proposed step per day (the council's cap) and the day's pinned
 * commitments as fixed rows. Nothing is stored until the person accepts a
 * day, and accepting stores that date's plan through the daily flow's own
 * build. These tests hold it to that, and to the rules a stored plan already
 * lives under: a touched plan is never overwritten (#626), a declined patch
 * stays declined (#587), the rebuild cap is per date, and the morning job
 * leaves an accepted future-dated plan as the person left it.
 *
 * Every plan here is built at a stated instant (#500): the service tests pass
 * `now`, and the route tests pin `Date` to it.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { PLANNING_STATE_CHANGES, PLANS, docIdForKey, userDoc, userSubDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { loadDomainState, persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import {
  applyCommand as applyDomainCommand,
  createEmptyDomainState,
  type DomainState,
} from '../../src/domain/stateMachine.ts';
import {
  PlanDateOutOfRangeError,
  buildAndStoreDailyPlan,
  buildDailyPlanOnDemand,
  readPlanSettings,
  runDailyPlanTick,
  savePlanSettings,
  storeWeekDayPlan,
  type PlanReadyNotice,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import type { BusyBlockReader } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import {
  listPlanEvents,
  proposalWasRejected,
  readStoredPlan,
  storePlanProposal,
  type StoredDailyPlan,
  type StoredPlanProposal,
} from '../../lib/services/dailyPlan/planStore.ts';
import { processStateChangesForUser } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import { actionsToday, reserveDailyAction } from '../../lib/llm/usageGuard.ts';
import { replaceBusyBlocksAsFixture } from '../support/busyFixtures.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';
import { dismissPlan, regeneratePlan, rejectPlanProposal } from '../../lib/services/dailyPlan/planActions.ts';
import { readCurrentPlan } from '../../lib/services/dailyPlan/planRefresh.ts';
import { MAX_PLAN_REBUILDS_PER_DAY } from '../../lib/services/dailyPlan/planSettings.ts';
import { diffPlans } from '../../lib/planning/scheduler/index.ts';
import {
  MAX_WEEK_PLANS_PER_DAY,
  WEEK_PLAN_ACTION,
  WeekDecisionsInvalid,
  acceptWeekDay,
  composeWeek,
  parseWeekDecisions,
  weekToDto,
  type WeekDecisions,
  type WeekDto,
} from '../../lib/services/dailyPlan/weekPlan.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import { GET as weekGet, POST as weekPost } from '../../src/app/api/mobile/plans/week/route.ts';
import { POST as weekAcceptPost } from '../../src/app/api/mobile/plans/week/accept/route.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const USER = uidFor('WeekUser');
/** Tuesday. The week is 15 … 21 September. */
const TODAY = '2026-09-15';
const WEEK = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21'];
/** 09:00 in Jerusalem on TODAY. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');
/** 09:00 in Jerusalem the next day: after the 07:30 delivery, so the tick is due. */
const NEXT_MORNING = new Date('2026-09-16T06:00:00.000Z');
const NONE: WeekDecisions = { moves: [], drops: [] };

const UNDATED = ['cmt_a', 'cmt_b', 'cmt_c'];

type Spec =
  | { kind: 'undated' }
  | { kind: 'due'; dueAt: string }
  | { kind: 'pinned'; at: string };

function withCommitment(state: DomainState, id: string, title: string, spec: Spec, now = '2026-09-14T06:00:00.000Z'): DomainState {
  const timeSpec = spec.kind === 'pinned'
    ? { kind: 'scheduled_event' as const, dueAt: spec.at, remindAt: spec.at, timezone: TZ }
    : { kind: 'due_by' as const, dueAt: spec.kind === 'due' ? spec.dueAt : null, remindAt: null, timezone: TZ };
  const drafted = applyDomainCommand(state, {
    type: 'CreateDraft',
    now,
    commitment: { id, kind: 'task', title, timeSpec },
    draftStatus: 'pending_confirmation',
  }).newState;
  return applyDomainCommand(drafted, { type: 'ConfirmCommitment', commitmentId: id, now, reminders: [] }).newState;
}

/**
 * Three undated tasks (they belong to every day by the daily rule), one due
 * on Saturday the 19th at 18:00, and a dentist pinned to Thursday 11:00.
 */
function seedState(): DomainState {
  let state = createEmptyDomainState();
  state = withCommitment(state, 'cmt_a', 'Write the summary', { kind: 'undated' });
  state = withCommitment(state, 'cmt_b', 'Call the bank', { kind: 'undated' });
  state = withCommitment(state, 'cmt_c', 'Book the train', { kind: 'undated' });
  state = withCommitment(state, 'cmt_rent', 'Pay the rent', { kind: 'due', dueAt: '2026-09-19T15:00:00.000Z' });
  state = withCommitment(state, 'cmt_dentist', 'Dentist', { kind: 'pinned', at: '2026-09-17T08:00:00.000Z' });
  return state;
}

async function seed(storage: StorageAdapter, options: { delivery?: boolean } = {}): Promise<void> {
  await persistParticipantState(USER, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(USER));
  await storage.set(userDoc(USER), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  if (options.delivery) {
    await savePlanSettings(USER, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
  }
}

async function addCommitment(storage: StorageAdapter, id: string, title: string, spec: Spec, now: string): Promise<void> {
  const state = await loadDomainState(storage, USER);
  await persistParticipantState(USER, withCommitment(state, id, title, spec, now));
}

function recorder() {
  const sent: PlanReadyNotice[] = [];
  return { sent, push: async (notice: PlanReadyNotice) => { sent.push(notice); } };
}

async function week(storage: StorageAdapter, decisions: WeekDecisions = NONE, now: Date = MORNING, busyBlocks?: BusyBlockReader): Promise<WeekDto> {
  return weekToDto(await composeWeek(USER, decisions, { storage, now: () => now, ...(busyBlocks ? { busyBlocks } : {}) }));
}

function stepsOn(dto: WeekDto, date: string): string[] {
  return dto.days.find((day) => day.date === date)!.items.map((item) => item.itemId);
}

/** What a card shows for `date`: its steps and the moved work with no room. What "Save" sends (I1). */
function shownOn(dto: WeekDto, date: string): string[] {
  const day = dto.days.find((candidate) => candidate.date === date);
  return day ? [...day.items.map((item) => item.itemId), ...day.unplaced.map((item) => item.itemId)] : [];
}

/** Saves a day exactly as the screen does: look at the week, then save what the card showed. */
async function save(storage: StorageAdapter, date: string, decisions: WeekDecisions = NONE, now: Date = MORNING) {
  const shown = shownOn(await week(storage, decisions, now), date);
  return acceptWeekDay(USER, date, decisions, shown, { storage, now: () => now });
}

async function withStorage(fn: (storage: StorageAdapter) => Promise<void>): Promise<void> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    await fn(storage);
  } finally {
    resetStorageForTests();
  }
}

/* ── The week is the daily planner, one date at a time ───────────── */

test('the week proposes today … today+6, one date at a time, and stores nothing', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const dto = await week(storage);

    assert.equal(dto.today, TODAY);
    assert.deepEqual(dto.days.map((day) => day.date), WEEK, 'the week is not today and the six days after it, in order');
    assert.ok(dto.days.every((day) => day.state === 'proposed'));
    for (const date of WEEK) assert.equal(await readStoredPlan(USER, date, storage), null, `proposing the week stored ${date}`);
    assert.deepEqual(await listPlanEvents(USER, storage), [], 'proposing the week wrote to the plan ledger');
  });
});

test('each day holds at most one proposed step, and a floating commitment is proposed on one day only', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const dto = await week(storage);

    for (const day of dto.days) assert.ok(day.items.length <= 1, `${day.date} holds ${day.items.length} steps; the week proposes one per day`);
    const placed = dto.days.flatMap((day) => day.items.map((item) => item.itemId));
    assert.equal(new Set(placed).size, placed.length, 'one commitment was proposed on two days');
    // The undated work fills the first three days, one each, in the planner's order.
    assert.deepEqual([...stepsOn(dto, WEEK[0]!), ...stepsOn(dto, WEEK[1]!), ...stepsOn(dto, WEEK[2]!)].sort(), UNDATED);
    for (const date of WEEK.slice(0, 3)) {
      assert.equal(dto.days.find((day) => day.date === date)!.items[0]!.reason, 'open');
    }
    // The rent is due on Saturday, so the daily rule puts it on Saturday, not before.
    assert.deepEqual(stepsOn(dto, '2026-09-19'), ['cmt_rent']);
    assert.equal(dto.days.find((day) => day.date === '2026-09-19')!.items[0]!.reason, 'due');
    assert.deepEqual(stepsOn(dto, '2026-09-18'), []);
    assert.equal(dto.waiting, 0);
  });
});

test('a pinned commitment is a fixed row on its own day and is never a proposed step', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const dto = await week(storage);

    const thursday = dto.days.find((day) => day.date === '2026-09-17')!;
    assert.deepEqual(thursday.fixed.map((row) => [row.itemId, row.title, row.startsAt]), [['cmt_dentist', 'Dentist', '2026-09-17T08:00:00.000Z']]);
    assert.ok(!dto.days.some((day) => day.items.some((item) => item.itemId === 'cmt_dentist')));
    assert.ok(dto.days.filter((day) => day.date !== '2026-09-17').every((day) => day.fixed.length === 0));
  });
});

test('each day is solved around that day\'s own busy time', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    // Wednesday is busy 08:00–15:00 local; every other day is free.
    const busy: BusyBlockReader = async (_uid, window) => window.startsAt.startsWith('2026-09-15T21')
      ? [{ blockId: 'wed', startsAt: '2026-09-16T05:00:00.000Z', endsAt: '2026-09-16T12:00:00.000Z' }]
      : [];
    const dto = await week(storage, NONE, MORNING, busy);
    const wednesday = dto.days.find((day) => day.date === '2026-09-16')!;
    assert.equal(wednesday.items.length, 1);
    assert.ok(Date.parse(wednesday.items[0]!.startsAt) >= Date.parse('2026-09-16T12:00:00.000Z'), 'Wednesday\'s step was placed inside its busy time');
    const friday = dto.days.find((day) => day.date === '2026-09-18')!;
    assert.deepEqual(friday.items, []);
  });
});

test('today\'s proposal starts no earlier than the time it is built at (#500)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const afternoon = new Date('2026-09-15T11:44:00.000Z'); // 14:44 local
    const dto = await week(storage, NONE, afternoon);
    const today = dto.days[0]!;
    assert.equal(today.items.length, 1);
    assert.ok(Date.parse(today.items[0]!.startsAt) >= afternoon.getTime(), 'today\'s step was placed in the past');
  });
});

/* ── The range: seven days for proposals, two for a day's own build ─ */

test('accepting a day outside today … today+6 is refused before anything is composed', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    for (const date of ['2026-09-14', '2026-09-22']) {
      await assert.rejects(
        save(storage, date, NONE),
        (error: unknown) => error instanceof PlanDateOutOfRangeError && error.days === 7,
        `${date} was accepted from the week`,
      );
      assert.equal(await readStoredPlan(USER, date, storage), null);
    }
  });
});

test('the widened range is for proposals only: a day\'s own build still refuses the day after tomorrow', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    await assert.rejects(
      buildDailyPlanOnDemand(USER, '2026-09-17', { storage, now: () => MORNING }),
      (error: unknown) => error instanceof PlanDateOutOfRangeError && error.days === 2,
    );
    // …while the week accepts that same date.
    const accepted = await save(storage, '2026-09-17', NONE);
    assert.equal(accepted.outcome, 'accepted');
  });
});

test('the week\'s store refuses a date outside the proposal window on its own, whoever calls it', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const decision = { assignment: { include: [], exclude: [] }, origin: { considered: [], heldElsewhere: [], announced: false } };
    await assert.rejects(
      storeWeekDayPlan(USER, '2026-09-22', decision, { storage, now: () => MORNING }),
      (error: unknown) => error instanceof PlanDateOutOfRangeError && error.days === 7,
    );
    assert.equal(await readStoredPlan(USER, '2026-09-22', storage), null);
    assert.equal((await storeWeekDayPlan(USER, '2026-09-21', decision, { storage, now: () => MORNING })).created, true);
  });
});

/* ── Accepting a day is the daily flow's own build, then its accept ─ */

test('accepting a day stores exactly the proposed plan for that date, accepted, like the daily flow', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const before = await week(storage);
    const proposed = before.days.find((day) => day.date === '2026-09-19')!;

    const result = await save(storage, '2026-09-19', NONE);
    assert.equal(result.outcome, 'accepted');

    const stored = await readStoredPlan(USER, '2026-09-19', storage);
    assert.ok(stored, 'accepting the day stored no plan');
    assert.equal(stored!.generation, 1, 'the accepted day is not the date\'s first generation');
    assert.equal(stored!.status, 'accepted');
    assert.equal(stored!.acceptedAt, MORNING.toISOString());
    assert.deepEqual(
      stored!.plan.scheduled.map((item) => [item.itemId, item.interval.startsAt, item.interval.endsAt]),
      proposed.items.map((item) => [item.itemId, item.startsAt, item.endsAt]),
      'the stored plan is not the plan the person was shown',
    );
    // What the daily rule put on Saturday when the week was planned — the
    // Thursday dentist included, as Saturday alone would read it (#383) — and
    // where the week held each of them instead.
    assert.deepEqual(stored!.weekPlan?.considered.slice().sort(), ['cmt_a', 'cmt_b', 'cmt_c', 'cmt_dentist', 'cmt_rent']);
    assert.deepEqual(
      stored!.weekPlan?.heldElsewhere.map((held) => [held.itemId, held.date]).sort(),
      [...UNDATED.map((itemId) => [itemId, WEEK[stepsOn(before, WEEK[0]!).includes(itemId) ? 0 : stepsOn(before, WEEK[1]!).includes(itemId) ? 1 : 2]]), ['cmt_dentist', '2026-09-17']].sort(),
    );
    assert.equal(stored!.weekPlan?.announced, false);
    assert.deepEqual(
      // Both at the same instant, so the ledger's time order does not decide which is first.
      (await listPlanEvents(USER, storage)).map((event) => [event.type, event.date]).sort(),
      [['plan_accepted', '2026-09-19'], ['plan_proposed', '2026-09-19']],
    );
    // No other date was written.
    for (const date of WEEK.filter((d) => d !== '2026-09-19')) assert.equal(await readStoredPlan(USER, date, storage), null);
  });
});

test('an accepted day reads back on its date as the plan screen reads any plan', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  mock.timers.enable({ apis: ['Date'], now: MORNING.getTime() });
  try {
    await seed(storage);
    const response = await weekAcceptPost(request('/api/mobile/plans/week/accept', { body: { date: '2026-09-19', shown: ['cmt_rent'] } }));
    assert.equal(response.status, 200);
    const accepted = await response.json() as { plan: { date: string; status: string; scheduled: Array<{ itemId: string }> }; week: WeekDto };
    assert.equal(accepted.plan.date, '2026-09-19');
    assert.equal(accepted.plan.status, 'accepted');
    assert.equal(accepted.week.days.find((day) => day.date === '2026-09-19')!.state, 'accepted');

    const read = await planGet(request('/api/mobile/plans/2026-09-19'), params('2026-09-19'));
    assert.equal(read.status, 200);
    const body = await read.json() as { plan: { status: string; scheduled: Array<{ itemId: string; title: string }> } };
    assert.equal(body.plan.status, 'accepted');
    assert.deepEqual(body.plan.scheduled.map((item) => [item.itemId, item.title]), [['cmt_rent', 'Pay the rent']]);
  } finally {
    mock.timers.reset();
    auth.restore();
    resetStorageForTests();
  }
});

test('work placed on an accepted day is not proposed on any other day, and the day shows as accepted', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const first = await week(storage);
    const mondayStep = stepsOn(first, WEEK[0]!)[0]!;
    await save(storage, WEEK[0]!, NONE);

    const after = await week(storage);
    assert.equal(after.days[0]!.state, 'accepted');
    assert.deepEqual(stepsOn(after, WEEK[0]!), [mondayStep]);
    assert.equal(
      after.days.slice(1).filter((day) => day.items.some((item) => item.itemId === mondayStep)).length,
      0,
      'the step accepted for today was proposed again on another day',
    );
  });
});

test('accepting a date that already has a plan leaves that plan exactly as it was', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const built = await buildDailyPlanOnDemand(USER, '2026-09-16', { storage, now: () => MORNING });
    const result = await save(storage, '2026-09-16', NONE);
    assert.equal(result.outcome, 'already_planned');
    assert.deepEqual(await readStoredPlan(USER, '2026-09-16', storage), built.stored);
    const dto = await week(storage);
    assert.equal(dto.days[1]!.state, 'planned');
  });
});

test('a day whose plan the person dismissed places nothing: its work is free for the rest of the week', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    await buildDailyPlanOnDemand(USER, TODAY, { storage, now: () => MORNING });
    await dismissPlan(USER, TODAY, { storage, now: () => MORNING });
    const dto = await week(storage);
    assert.equal(dto.days[0]!.state, 'planned');
    const proposed = dto.days.slice(1).flatMap((day) => day.items.map((item) => item.itemId));
    assert.deepEqual(proposed.filter((itemId) => UNDATED.includes(itemId)).sort(), UNDATED, 'work on a dismissed plan was held off the week');
  });
});

/* ── Moving and dropping ─────────────────────────────────────────── */

test('moving a step to another day puts it there, and its old day offers the next thing', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const first = await week(storage);
    const moved = stepsOn(first, WEEK[0]!)[0]!;

    const dto = await week(storage, { moves: [{ itemId: moved, date: '2026-09-18' }], drops: [] });
    assert.deepEqual(stepsOn(dto, '2026-09-18'), [moved]);
    assert.equal(dto.days.find((day) => day.date === '2026-09-18')!.items[0]!.reason, 'moved');
    assert.ok(!stepsOn(dto, WEEK[0]!).includes(moved));
    assert.equal(stepsOn(dto, WEEK[0]!).length, 1, 'the day the step left was not offered the next thing');
    assert.deepEqual(dto.moves, [{ itemId: moved, date: '2026-09-18' }]);

    const accepted = await save(storage, '2026-09-18', { moves: [{ itemId: moved, date: '2026-09-18' }], drops: [] });
    assert.equal(accepted.outcome, 'accepted');
    assert.deepEqual((await readStoredPlan(USER, '2026-09-18', storage))!.plan.scheduled.map((item) => item.itemId), [moved]);
  });
});

test('moving a step onto a day that has its own adds it beside that day\'s step', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const first = await week(storage);
    const moved = stepsOn(first, WEEK[0]!)[0]!;
    const dto = await week(storage, { moves: [{ itemId: moved, date: '2026-09-19' }], drops: [] });
    assert.deepEqual(stepsOn(dto, '2026-09-19').sort(), [moved, 'cmt_rent'].sort());
  });
});

test('dropping a step takes it out of the whole week, and it is not stored on the day accepted', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const first = await week(storage);
    const dropped = stepsOn(first, WEEK[0]!)[0]!;
    const decisions = { moves: [], drops: [dropped] };

    const dto = await week(storage, decisions);
    assert.ok(!dto.days.some((day) => day.items.some((item) => item.itemId === dropped)), 'a dropped step was still proposed');
    assert.deepEqual(dto.drops.map((drop) => [drop.itemId, drop.title !== null]), [[dropped, true]]);

    await save(storage, WEEK[0]!, decisions);
    assert.ok(!(await readStoredPlan(USER, WEEK[0]!, storage))!.plan.scheduled.some((item) => item.itemId === dropped));
  });
});

test('decisions about work the week does not hold are ignored, not stored', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    await save(storage, WEEK[0]!, NONE);
    const taken = (await readStoredPlan(USER, WEEK[0]!, storage))!.plan.scheduled[0]!.itemId;
    const free = UNDATED.find((itemId) => itemId !== taken)!;
    const dto = await week(storage, {
      moves: [{ itemId: 'not-a-commitment', date: WEEK[2]! }, { itemId: taken, date: WEEK[3]! }, { itemId: free, date: WEEK[0]! }],
      drops: ['cmt_dentist'],
    });
    // Moves onto a stored day, of a stored step, or of nothing, and drops of pinned work, do not apply.
    assert.deepEqual(dto.moves.filter((move) => move.itemId === 'not-a-commitment' || move.itemId === taken || move.date === WEEK[0]), []);
    assert.deepEqual(dto.drops, []);
  });
});

test('the decisions a client sends are bounded and shaped', () => {
  assert.deepEqual(parseWeekDecisions({}), NONE);
  assert.deepEqual(parseWeekDecisions({ moves: [{ itemId: 'x', date: '2026-09-16' }], drops: ['y'] }), { moves: [{ itemId: 'x', date: '2026-09-16' }], drops: ['y'] });
  for (const bad of [null, [], { moves: 'x' }, { drops: [1] }, { moves: [{ itemId: 'x', date: 'tomorrow' }] }, { moves: [{ date: '2026-09-16' }] },
    { drops: Array.from({ length: 51 }, (_, i) => `id${i}`) }, { drops: ['x'.repeat(201)] }]) {
    assert.throws(() => parseWeekDecisions(bad), WeekDecisionsInvalid, JSON.stringify(bad)?.slice(0, 60));
  }
});

/* ── The rules a stored plan lives under hold on a future date ──── */

test('an accepted future day is never rebuilt by a read: a new commitment raises inputsChanged, held work does not', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    await save(storage, WEEK[1]!, NONE);
    const accepted = await readStoredPlan(USER, WEEK[1]!, storage);

    // Held work — the other undated tasks, on other days — is not news.
    const quiet = await readCurrentPlan(USER, WEEK[1]!, { storage, now: () => MORNING });
    assert.equal(quiet!.inputsChanged, false, 'work the week held on another day was reported as new on this one');
    assert.deepEqual(quiet!.stored, accepted);

    await addCommitment(storage, 'cmt_new', 'Buy a gift', { kind: 'undated' }, '2026-09-15T07:00:00.000Z');
    const read = await readCurrentPlan(USER, WEEK[1]!, { storage, now: () => new Date('2026-09-15T07:00:00.000Z') });
    assert.deepEqual(read!.stored, accepted, 'an accepted future day was overwritten by a read');
    assert.equal(read!.inputsChanged, true, 'a commitment that landed on the day since was not reported');
  });
});

test('work held for a day that has passed rolls into today and is news on today\'s accepted plan (#383)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    await save(storage, WEEK[0]!, NONE);
    await save(storage, WEEK[1]!, NONE);
    const heldOnMonday = (await readStoredPlan(USER, WEEK[0]!, storage))!.plan.scheduled[0]!.itemId;
    assert.ok((await readStoredPlan(USER, WEEK[1]!, storage))!.weekPlan!.heldElsewhere.some((held) => held.itemId === heldOnMonday && held.date === WEEK[0]));

    // The next morning, yesterday's step is still active: it is today's now.
    const read = await readCurrentPlan(USER, WEEK[1]!, { storage, now: () => NEXT_MORNING });
    assert.equal(read!.inputsChanged, true, 'yesterday\'s unfinished step did not roll into today');
  });
});

test('a declined patch on an accepted future day stays declined, and the week never rewrites that day', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    await save(storage, WEEK[1]!, NONE);
    const stored = (await readStoredPlan(USER, WEEK[1]!, storage))!;
    const shifted = {
      ...stored.plan,
      scheduled: stored.plan.scheduled.map((item) => {
        const startsAt = new Date(Date.parse(item.interval.startsAt) + 3_600_000).toISOString();
        const endsAt = new Date(Date.parse(item.interval.endsAt) + 3_600_000).toISOString();
        return { itemId: item.itemId, interval: { startsAt, endsAt }, reservedInterval: { startsAt, endsAt } };
      }),
    };
    const proposal: StoredPlanProposal = {
      proposalId: 'prp_week',
      proposedAt: MORNING.toISOString(),
      baseGeneration: stored.generation,
      baseInputDigest: stored.inputDigest,
      plan: shifted,
      solveInputs: { constraints: stored.constraints, config: stored.config },
      diff: diffPlans(stored.plan, shifted),
      reason: 'user_requires_confirmation',
      userControlMode: 'always_require_confirmation',
      causeChangeIds: ['chg-calendar-moved'],
    };
    assert.ok(await storePlanProposal(USER, WEEK[1]!, proposal, storage));
    assert.ok(await rejectPlanProposal(USER, WEEK[1]!, { storage, now: () => MORNING, proposalId: 'prp_week' }));
    const declined = (await readStoredPlan(USER, WEEK[1]!, storage))!;
    assert.ok(proposalWasRejected(declined, proposal));

    const again = await save(storage, WEEK[1]!, NONE);
    assert.equal(again.outcome, 'already_planned');
    await week(storage);
    const read = await readCurrentPlan(USER, WEEK[1]!, { storage, now: () => MORNING });
    assert.deepEqual(read!.stored, declined, 'the week or a read rewrote a day whose patch the person declined');
    assert.ok(proposalWasRejected(read!.stored, proposal), 'the declined patch is no longer remembered as declined');
  });
});

test('the rebuild cap is per date: an accepted week day is generation 1 of its own date\'s cap', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    await save(storage, WEEK[2]!, NONE);
    await save(storage, WEEK[3]!, NONE);

    for (let rebuild = 0; rebuild < MAX_PLAN_REBUILDS_PER_DAY; rebuild += 1) {
      const outcome = await regeneratePlan(USER, WEEK[2]!, { storage, now: () => MORNING });
      assert.equal(outcome.ok, true, `rebuild ${rebuild + 1} of an accepted week day was refused`);
    }
    const capped = await regeneratePlan(USER, WEEK[2]!, { storage, now: () => MORNING });
    assert.deepEqual(capped, { ok: false, reason: 'limit_reached' });
    // Another date's cap is its own.
    assert.equal((await regeneratePlan(USER, WEEK[3]!, { storage, now: () => MORNING })).ok, true);
    // A person's own rebuild is a daily plan again: the week's record goes with it.
    assert.equal((await readStoredPlan(USER, WEEK[2]!, storage))!.weekPlan, undefined);
  });
});

/* ── The morning job ─────────────────────────────────────────────── */

test('the morning job leaves an accepted future-dated plan exactly as accepted, and says so once', async () => {
  await withStorage(async (storage) => {
    await seed(storage, { delivery: true });
    await save(storage, WEEK[1]!, NONE);
    const accepted = (await readStoredPlan(USER, WEEK[1]!, storage))!;
    const push = recorder();

    const totals = await runDailyPlanTick({ storage, push: push.push, now: () => NEXT_MORNING });
    assert.equal(totals.claimed, 1, 'the morning was not claimed, so this proves nothing about the job');
    assert.equal(totals.built, 0, 'the morning job built over the plan the person accepted');

    const after = (await readStoredPlan(USER, WEEK[1]!, storage))!;
    assert.equal(after.generation, accepted.generation);
    assert.equal(after.status, 'accepted');
    assert.equal(after.acceptedAt, accepted.acceptedAt);
    assert.deepEqual(after.plan, accepted.plan, 'the morning job changed the accepted placements');
    assert.deepEqual(after.edits, accepted.edits);
    assert.equal(push.sent.length, 1, 'the morning of an accepted week day did not tell the person their plan is today\'s');
    assert.equal(push.sent[0]!.data.planDate, WEEK[1]);

    // A replay of the same morning's build says nothing more.
    const replay = await buildAndStoreDailyPlan(
      { uid: USER, date: WEEK[1]!, settings: await readPlanSettings(USER, { storage }) },
      { storage, push: push.push, now: () => new Date('2026-09-16T06:05:00.000Z') },
    );
    assert.equal(replay.created, false);
    assert.equal(replay.pushed, false);
    assert.equal(push.sent.length, 1, 'the accepted week day was announced twice');
    assert.deepEqual((await readStoredPlan(USER, WEEK[1]!, storage))!.plan, accepted.plan);
  });
});

test('two morning builds of an accepted week day at once announce it once', async () => {
  await withStorage(async (storage) => {
    await seed(storage, { delivery: true });
    await save(storage, WEEK[1]!, NONE);
    const push = recorder();
    const claim = { uid: USER, date: WEEK[1]!, settings: await readPlanSettings(USER, { storage }) };
    const [left, right] = await Promise.all([
      buildAndStoreDailyPlan(claim, { storage, push: push.push, now: () => NEXT_MORNING }),
      buildAndStoreDailyPlan(claim, { storage, push: push.push, now: () => NEXT_MORNING }),
    ]);
    assert.equal(Number(left.pushed) + Number(right.pushed), 1);
    assert.equal(push.sent.length, 1, 'two concurrent mornings both announced the accepted day');
  });
});

test('accepting today from the week is today\'s plan on screen: the morning sends nothing about it', async () => {
  await withStorage(async (storage) => {
    await seed(storage, { delivery: true });
    await save(storage, TODAY, NONE);
    assert.equal((await readStoredPlan(USER, TODAY, storage))!.weekPlan?.announced, true);
    const push = recorder();
    const totals = await runDailyPlanTick({ storage, push: push.push, now: () => new Date('2026-09-15T06:01:00.000Z') });
    assert.equal(totals.claimed, 1, 'today\'s morning was not claimed, so this proves nothing');
    assert.equal(push.sent.length, 0, 'the morning announced a plan the person accepted on screen');
  });
});

/* ── The routes ──────────────────────────────────────────────────── */

function request(path: string, options: { body?: unknown; raw?: string; anonymous?: boolean } = {}): Request {
  const headers = new Headers();
  if (!options.anonymous) headers.set('authorization', `Bearer ${tokenFor(USER)}`);
  const hasBody = options.body !== undefined || options.raw !== undefined;
  if (hasBody) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: hasBody ? 'POST' : 'GET',
    headers,
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

function params(date: string): { params: Promise<{ date: string }> } {
  return { params: Promise.resolve({ date }) };
}

async function withRoutes(fn: (storage: StorageAdapter, auth: FakeAuthControls) => Promise<void>): Promise<void> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  mock.timers.enable({ apis: ['Date'], now: MORNING.getTime() });
  try {
    await seed(storage);
    await fn(storage, auth);
  } finally {
    mock.timers.reset();
    auth.restore();
    resetStorageForTests();
  }
}

test('both week routes refuse a caller with no token and write nothing', async () => {
  await withRoutes(async (storage) => {
    assert.equal((await weekPost(request('/api/mobile/plans/week', { body: {}, anonymous: true }))).status, 401);
    assert.equal((await weekAcceptPost(request('/api/mobile/plans/week/accept', { body: { date: TODAY }, anonymous: true }))).status, 401);
    assert.equal(await readStoredPlan(USER, TODAY, storage), null);
  });
});

test('POST week answers the seven days and stores nothing', async () => {
  await withRoutes(async (storage) => {
    const response = await weekPost(request('/api/mobile/plans/week', { body: {} }));
    assert.equal(response.status, 200);
    const body = await response.json() as { success: boolean; week: WeekDto };
    assert.equal(body.success, true);
    assert.deepEqual(body.week.days.map((day) => day.date), WEEK);
    assert.deepEqual(body.week.days.find((day) => day.date === '2026-09-19')!.items.map((item) => item.title), ['Pay the rent']);
    assert.deepEqual(await listPlanEvents(USER, storage), []);
  });
});

test('the week routes refuse a malformed body with 400 and write nothing', async () => {
  await withRoutes(async (storage) => {
    assert.equal((await weekPost(request('/api/mobile/plans/week', { raw: '{not json' }))).status, 400);
    assert.equal((await weekPost(request('/api/mobile/plans/week', { body: { drops: 'cmt_a' } }))).status, 400);
    // `shown` is required: a save says which steps the card showed (I1).
    for (const body of [{}, { date: 'tomorrow', shown: [] }, { date: TODAY, moves: 3, shown: [] }, { date: TODAY }, { date: TODAY, shown: 'cmt_a' },
      { date: TODAY, shown: Array.from({ length: 51 }, (_, i) => `id${i}`) }]) {
      assert.equal((await weekAcceptPost(request('/api/mobile/plans/week/accept', { body }))).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(await listPlanEvents(USER, storage), []);
  });
});

test('POST week/accept answers 400 date_out_of_range outside the week, and 409 already_planned on a planned date', async () => {
  await withRoutes(async (storage) => {
    const outside = await weekAcceptPost(request('/api/mobile/plans/week/accept', { body: { date: '2026-09-22', shown: [] } }));
    assert.equal(outside.status, 400);
    assert.equal((await outside.json() as { reason: string }).reason, 'date_out_of_range');

    const shown = shownOn(await week(storage), TODAY);
    assert.equal((await weekAcceptPost(request('/api/mobile/plans/week/accept', { body: { date: TODAY, shown } }))).status, 200);
    const again = await weekAcceptPost(request('/api/mobile/plans/week/accept', { body: { date: TODAY, shown } }));
    assert.equal(again.status, 409);
    const body = await again.json() as { reason: string; week: WeekDto };
    assert.equal(body.reason, 'already_planned');
    assert.equal(body.week.days[0]!.state, 'accepted');
  });
});

/* ══ Review round 1 (CL5b-review.md) ════════════════════════════════ */

/* ── I1: the day saved is the day the card showed ─────────────────── */

test('a save whose card no longer matches the week is refused as week_changed, and nothing is stored (I1)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const thursday = WEEK[2]!;
    const shown = shownOn(await week(storage), thursday);
    assert.equal(shown.length, 1, 'fixture: Thursday shows one step');

    // The literal repro: another phone captures a task due today while the week is on screen.
    await addCommitment(storage, 'cmt_today', 'Send the form', { kind: 'due', dueAt: '2026-09-15T15:00:00.000Z' }, '2026-09-15T06:01:00.000Z');
    const fresh = await week(storage);
    assert.notDeepEqual(shownOn(fresh, thursday), shown, 'fixture: the new task must shift Thursday\'s step');

    const result = await acceptWeekDay(USER, thursday, NONE, shown, { storage, now: () => MORNING });
    assert.equal(result.outcome, 'week_changed', 'a day the person never saw was saved');
    assert.equal(await readStoredPlan(USER, thursday, storage), null);
    assert.deepEqual(await listPlanEvents(USER, storage), []);
    assert.deepEqual(shownOn(weekToDto(result.layout), thursday), shownOn(fresh, thursday), 'the refusal does not carry the week as it is now');
  });
});

test('the same save with the card as it is now goes through (I1)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    await addCommitment(storage, 'cmt_today', 'Send the form', { kind: 'due', dueAt: '2026-09-15T15:00:00.000Z' }, '2026-09-15T06:01:00.000Z');
    const result = await save(storage, WEEK[2]!);
    assert.equal(result.outcome, 'accepted');
  });
});

test('POST week/accept answers 409 week_changed with the fresh week when the card is stale (I1)', async () => {
  await withRoutes(async (storage) => {
    const response = await weekAcceptPost(request('/api/mobile/plans/week/accept', { body: { date: WEEK[2], shown: ['cmt_not_on_this_day'] } }));
    assert.equal(response.status, 409);
    const body = await response.json() as { success: boolean; reason: string; week: WeekDto };
    assert.equal(body.success, false);
    assert.equal(body.reason, 'week_changed');
    assert.deepEqual(body.week.days.map((day) => day.date), WEEK);
    assert.equal(await readStoredPlan(USER, WEEK[2]!, storage), null);
  });
});

/* ── M-a: never "accepted" for a day that was not accepted ────────── */

/** Deletes the day's plan the moment it is stored: an account deletion racing the save. */
function deletingThePlanOnceStored(storage: StorageAdapter, date: string): StorageAdapter {
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'set') {
        return async (path: string, value: unknown) => {
          await target.set(path, value as Record<string, unknown>);
          const record = value as { type?: unknown; date?: unknown } | null;
          if (record?.type === 'plan_proposed' && record.date === date) await target.delete(userSubDoc(USER, PLANS, date));
        };
      }
      const member = Reflect.get(target, property, receiver);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

test('when the accept finds no plan, the save is not answered as accepted (M-a)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const shown = shownOn(await week(storage), WEEK[2]!);
    const racing = deletingThePlanOnceStored(storage, WEEK[2]!);
    const result = await acceptWeekDay(USER, WEEK[2]!, NONE, shown, { storage: racing, now: () => MORNING });
    assert.notEqual(result.outcome, 'accepted', 'a day with no plan was answered as accepted');
    assert.equal(result.outcome, 'week_changed');
  });
});

/* ── I2: the replan tick solves a week day under the week's decisions ─ */

const CALENDAR = 'device:calendar-1';

/** A calendar sync that puts a meeting on `interval`, and the change row the tick drains. */
async function meetingAt(storage: StorageAdapter, interval: { startsAt: string; endsAt: string }): Promise<void> {
  await replaceBusyBlocksAsFixture(
    USER,
    CALENDAR,
    { startsAt: '2026-09-15T00:00:00.000Z', endsAt: '2026-09-17T00:00:00.000Z' },
    [{ blockId: 'busy-meeting', sourceId: CALENDAR, sourceKind: 'device' as const, startAt: interval.startsAt, endAt: interval.endsAt, allDay: false }],
    { storage },
  );
  const change: PlanningStateChange = {
    schemaVersion: 'planning-state-change-v1',
    changeId: 'chg-meeting',
    scopeId: USER,
    source: 'calendar',
    entityId: 'busy-meeting',
    occurredAt: MORNING.toISOString(),
    changedFields: ['interval', 'blocking'],
    beforeDigest: null,
    afterDigest: 'digest-busy-meeting',
    provenanceRef: 'calendar:refresh-1',
  };
  await storage.set(userSubDoc(USER, PLANNING_STATE_CHANGES, docIdForKey('chg-meeting')), change);
}

/** Every piece of work the plan in force, or an offer on it, would put on the day. */
function workOnTheDay(stored: StoredDailyPlan): { inForce: string[]; offered: string[] | null } {
  const ids = (plan: { scheduled: readonly { itemId: string }[]; unscheduled: readonly { itemId: string }[] }) =>
    [...plan.scheduled, ...plan.unscheduled].map((item) => item.itemId).sort();
  return { inForce: ids(stored.plan), offered: stored.proposal ? ids(stored.proposal.plan) : null };
}

for (const userControlMode of ['always_require_confirmation', 'silent_auto'] as const) {
  test(`a replan of a saved week day keeps the week's decisions: held work stays off, moved work stays on (I2, ${userControlMode})`, async () => {
    await withStorage(async (storage) => {
      await seed(storage);
      const step = stepsOn(await week(storage), TODAY)[0]!;
      // The rent is due Saturday; the person moves it onto today, and saves today.
      const decisions = { moves: [{ itemId: 'cmt_rent', date: TODAY }], drops: [] };
      assert.equal((await save(storage, TODAY, decisions)).outcome, 'accepted');
      const saved = (await readStoredPlan(USER, TODAY, storage))!;
      const expected = [step, 'cmt_rent'].sort();
      assert.deepEqual(workOnTheDay(saved).inForce, expected, 'fixture: today holds its step and the moved rent');

      const placed = saved.plan.scheduled.find((item) => item.itemId === step)!;
      await meetingAt(storage, placed.interval);
      await processStateChangesForUser(USER, { storage, now: MORNING, policyConfig: { userControlMode } });

      const after = (await readStoredPlan(USER, TODAY, storage))!;
      const work = workOnTheDay(after);
      assert.ok(after.generation > saved.generation || work.offered !== null, 'fixture: the meeting did not make the tick replan the day');
      assert.deepEqual(work.inForce, expected, 'the replan put held work on the day, or took the moved work off it');
      if (work.offered) assert.deepEqual(work.offered, expected, 'the replan offered to undo the week\'s decisions');
    });
  });
}

test('under silent_auto, a replan of a saved week day never adds work the week held elsewhere (I2)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    assert.equal((await save(storage, TODAY)).outcome, 'accepted');
    const saved = (await readStoredPlan(USER, TODAY, storage))!;
    const step = saved.plan.scheduled[0]!;
    await meetingAt(storage, step.interval);
    await processStateChangesForUser(USER, { storage, now: MORNING, policyConfig: { userControlMode: 'silent_auto' } });

    const after = (await readStoredPlan(USER, TODAY, storage))!;
    assert.ok(after.generation > saved.generation, 'fixture: the meeting was not applied silently');
    assert.deepEqual(workOnTheDay(after).inForce, [step.itemId], 'a silent replan added the week\'s held work to the day');
  });
});

/* ── I3: work a saved week day holds is on no other day ──────────── */

test('a day built on its own leaves out the step a saved week day holds, and a read or a rebuild does not put it back (I3)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    assert.equal((await save(storage, WEEK[2]!)).outcome, 'accepted');
    const held = (await readStoredPlan(USER, WEEK[2]!, storage))!.plan.scheduled[0]!.itemId;

    // The reviewer's probe A: build Wednesday on demand.
    const built = await buildDailyPlanOnDemand(USER, WEEK[1]!, { storage, now: () => MORNING });
    const onWednesday = (stored: StoredDailyPlan) => workOnTheDay(stored).inForce;
    assert.ok(!onWednesday(built.stored).includes(held), 'the step saved for Thursday also landed on Wednesday');
    assert.deepEqual(onWednesday(built.stored), UNDATED.filter((itemId) => itemId !== held).sort());

    // A read does not see the held step as news and rebuild the day with it.
    const read = await readCurrentPlan(USER, WEEK[1]!, { storage, now: () => MORNING });
    assert.equal(read!.stored.generation, built.stored.generation, 'a read rebuilt Wednesday');
    assert.equal(read!.inputsChanged, false);

    // Nor does the person's own rebuild.
    const rebuilt = await regeneratePlan(USER, WEEK[1]!, { storage, now: () => MORNING });
    assert.ok(rebuilt.ok);
    assert.ok(!onWednesday(rebuilt.stored).includes(held), 'a rebuild put the Thursday step on Wednesday');
  });
});

test('the morning job builds the day without the step a saved week day holds (I3)', async () => {
  await withStorage(async (storage) => {
    await seed(storage, { delivery: true });
    assert.equal((await save(storage, WEEK[2]!)).outcome, 'accepted');
    const held = (await readStoredPlan(USER, WEEK[2]!, storage))!.plan.scheduled[0]!.itemId;
    const push = recorder();
    const totals = await runDailyPlanTick({ storage, push: push.push, now: () => NEXT_MORNING });
    assert.equal(totals.built, 1, 'fixture: Wednesday\'s morning was not built');
    const wednesday = (await readStoredPlan(USER, WEEK[1]!, storage))!;
    assert.ok(!workOnTheDay(wednesday).inForce.includes(held), 'the morning put Thursday\'s saved step on Wednesday');
  });
});

test('a person\'s rebuild of a saved week day leaves out the steps other saved days hold (I3, M-b)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    assert.equal((await save(storage, WEEK[1]!)).outcome, 'accepted');
    assert.equal((await save(storage, WEEK[2]!)).outcome, 'accepted');
    const heldThursday = (await readStoredPlan(USER, WEEK[2]!, storage))!.plan.scheduled[0]!.itemId;
    const rebuilt = await regeneratePlan(USER, WEEK[1]!, { storage, now: () => MORNING });
    assert.ok(rebuilt.ok);
    assert.ok(!workOnTheDay(rebuilt.stored).inForce.includes(heldThursday), 'the rebuilt Wednesday holds Thursday\'s saved step');
  });
});

test('a saved day that has passed holds nothing: its unfinished step rolls into the next day (I3, #383)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    assert.equal((await save(storage, TODAY)).outcome, 'accepted');
    const held = (await readStoredPlan(USER, TODAY, storage))!.plan.scheduled[0]!.itemId;
    const built = await buildDailyPlanOnDemand(USER, WEEK[1]!, { storage, now: () => NEXT_MORNING });
    assert.ok(workOnTheDay(built.stored).inForce.includes(held), 'yesterday\'s unfinished step was kept off today');
  });
});

test('a saved week day the person dismissed holds nothing (I3)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    assert.equal((await save(storage, WEEK[2]!)).outcome, 'accepted');
    const held = (await readStoredPlan(USER, WEEK[2]!, storage))!.plan.scheduled[0]!.itemId;
    await dismissPlan(USER, WEEK[2]!, { storage, now: () => MORNING });
    const built = await buildDailyPlanOnDemand(USER, WEEK[1]!, { storage, now: () => MORNING });
    assert.ok(workOnTheDay(built.stored).inForce.includes(held), 'a dismissed day still held its step');
  });
});

/* ── I4: the saved week, for the Calendar strip ──────────────────── */

test('GET week answers the saved week days of the next seven, with their steps, and nothing else (I4)', async () => {
  await withRoutes(async (storage) => {
    assert.equal((await weekGet(request('/api/mobile/plans/week', { anonymous: true }))).status, 401);
    const empty = await weekGet(request('/api/mobile/plans/week'));
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json() as { saved: unknown[] }).saved, []);

    assert.equal((await save(storage, WEEK[2]!)).outcome, 'accepted');
    assert.equal((await save(storage, WEEK[4]!)).outcome, 'accepted');
    await dismissPlan(USER, WEEK[4]!, { storage, now: () => MORNING });
    // A plan built on its own is not a saved week day.
    await buildDailyPlanOnDemand(USER, TODAY, { storage, now: () => MORNING });

    const thursday = (await readStoredPlan(USER, WEEK[2]!, storage))!.plan.scheduled[0]!;
    const response = await weekGet(request('/api/mobile/plans/week'));
    assert.equal(response.status, 200);
    const body = await response.json() as { success: boolean; today: string; saved: Array<{ date: string; items: Array<{ itemId: string; startsAt: string; endsAt: string }> }> };
    assert.equal(body.success, true);
    assert.equal(body.today, TODAY);
    assert.deepEqual(body.saved, [{
      date: WEEK[2],
      items: [{ itemId: thursday.itemId, startsAt: thursday.interval.startsAt, endsAt: thursday.interval.endsAt }],
    }]);
  });
});

/* ── I5: one read of the account per week, and a daily cap ───────── */

/** Counts the reads that cost the most: the commitments collection and the user document. */
function countingReads(storage: StorageAdapter) {
  const counts = { commitments: 0, user: 0 };
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'list') {
        return (path: string, ...rest: unknown[]) => {
          if (path.endsWith('/commitments')) counts.commitments += 1;
          return (target.list as (...args: unknown[]) => unknown)(path, ...rest);
        };
      }
      if (property === 'get') {
        return (path: string) => {
          if (path === userDoc(USER)) counts.user += 1;
          return target.get(path);
        };
      }
      const member = Reflect.get(target, property, receiver);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  return { storage: proxy, counts };
}

test('composing the week reads the commitments and the account once, not once per day (I5)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const counting = countingReads(storage);
    const layout = await composeWeek(USER, NONE, { storage: counting.storage, now: () => MORNING });
    assert.equal(layout.days.length, 7);
    assert.equal(counting.counts.commitments, 1, `the week loaded the commitments ${counting.counts.commitments} times`);
    // Once for the week, and once by the focus hint's consent gate — which
    // reads the live consent on purpose (#202), once for the week, not per day.
    assert.equal(counting.counts.user, 2, `the week read the account ${counting.counts.user} times`);
  });
});

test('both week routes stop at a generous daily cap with 429 and write nothing (I5)', async () => {
  await withRoutes(async (storage) => {
    assert.equal((await weekPost(request('/api/mobile/plans/week', { body: {} }))).status, 200);
    assert.equal(await actionsToday(USER, WEEK_PLAN_ACTION, { storage }), 1, 'a week call was not counted');
    for (let call = 1; call < MAX_WEEK_PLANS_PER_DAY; call += 1) await reserveDailyAction(USER, WEEK_PLAN_ACTION, MAX_WEEK_PLANS_PER_DAY, { storage });

    const refused = await weekPost(request('/api/mobile/plans/week', { body: {} }));
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { success: false, error: 'too many week plans today', reason: 'week_rate_limited', maxPerDay: MAX_WEEK_PLANS_PER_DAY });

    const accept = await weekAcceptPost(request('/api/mobile/plans/week/accept', { body: { date: WEEK[2], shown: ['cmt_c'] } }));
    assert.equal(accept.status, 429);
    assert.equal(await readStoredPlan(USER, WEEK[2]!, storage), null);
    assert.equal(MAX_WEEK_PLANS_PER_DAY, 300);
  });
});

/* ── M-e: the week bodies are bounded tighter than the default ────── */

test('the week routes refuse a body over 32 KB with 413 (M-e)', async () => {
  await withRoutes(async (storage) => {
    const padding = 'x'.repeat(40 * 1024);
    assert.equal((await weekPost(request('/api/mobile/plans/week', { body: { padding } }))).status, 413);
    assert.equal((await weekAcceptPost(request('/api/mobile/plans/week/accept', { body: { date: TODAY, shown: [], padding } }))).status, 413);
    assert.equal(await readStoredPlan(USER, TODAY, storage), null);
  });
});

test('a day built around a saved week day, refreshed after a capture, still leaves the held step off (I3)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    assert.equal((await save(storage, WEEK[2]!)).outcome, 'accepted');
    const held = (await readStoredPlan(USER, WEEK[2]!, storage))!.plan.scheduled[0]!.itemId;
    const built = await buildDailyPlanOnDemand(USER, WEEK[1]!, { storage, now: () => MORNING });
    assert.deepEqual(built.stored.heldByWeek, [{ itemId: held, date: WEEK[2] }]);

    await addCommitment(storage, 'cmt_new', 'Buy a gift', { kind: 'undated' }, '2026-09-15T07:00:00.000Z');
    const later = new Date('2026-09-15T07:00:00.000Z');
    const read = await readCurrentPlan(USER, WEEK[1]!, { storage, now: () => later });
    assert.equal(read!.stored.generation, built.stored.generation + 1, 'fixture: the untouched plan was not refreshed');
    assert.ok(workOnTheDay(read!.stored).inForce.includes('cmt_new'));
    assert.ok(!workOnTheDay(read!.stored).inForce.includes(held), 'the refresh put Thursday\'s saved step on Wednesday');
    assert.deepEqual(read!.stored.heldByWeek, built.stored.heldByWeek, 'the refresh dropped the record of what the week holds');
  });
});

test('a week day stored but never accepted (a crash between the two writes) keeps its week decisions on a read (M-a)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    const dto = await week(storage);
    const layout = await composeWeek(USER, NONE, { storage, now: () => MORNING });
    const day = layout.days.find((candidate) => candidate.date === WEEK[1])!;
    assert.equal(day.kind, 'proposed');
    if (day.kind !== 'proposed') return;
    const { stored } = await storeWeekDayPlan(USER, WEEK[1]!, {
      assignment: day.assignment,
      origin: { considered: [...day.rule], heldElsewhere: [], announced: false },
    }, { storage, now: () => MORNING });
    assert.equal(stored.status, 'proposed');

    const read = await readCurrentPlan(USER, WEEK[1]!, { storage, now: () => MORNING });
    assert.equal(read!.stored.generation, stored.generation, 'a read rebuilt the stored week day as a plain daily plan');
    assert.deepEqual(workOnTheDay(read!.stored).inForce, stepsOn(dto, WEEK[1]!).sort());
    assert.ok(read!.stored.weekPlan, 'the week\'s record was dropped');
  });
});

test('once the saved day holding a step has passed, a day built around it takes the unfinished step back (I3, #383)', async () => {
  await withStorage(async (storage) => {
    await seed(storage);
    assert.equal((await save(storage, TODAY)).outcome, 'accepted');
    const held = (await readStoredPlan(USER, TODAY, storage))!.plan.scheduled[0]!.itemId;
    // Built on Tuesday, Wednesday leaves Tuesday's saved step off.
    const built = await buildDailyPlanOnDemand(USER, WEEK[1]!, { storage, now: () => MORNING });
    assert.ok(!workOnTheDay(built.stored).inForce.includes(held), 'fixture: Wednesday was built with Tuesday\'s step');

    // Wednesday morning, the step was not done: it is Wednesday's now.
    const read = await readCurrentPlan(USER, WEEK[1]!, { storage, now: () => NEXT_MORNING });
    assert.ok(workOnTheDay(read!.stored).inForce.includes(held), 'yesterday\'s unfinished step stayed off today');
  });
});
