/**
 * Weekly planning never proposes work after its due day (UAT round 2, N3;
 * complaint #23).
 *
 * The UAT account on Sunday 27 September at 18:30 (Asia/Amman), «خطّط أسبوعي»
 * for Sunday … Saturday 3 October, proposed:
 *   - the prep step for Monday's 15:00 meeting (shown Monday 13:00) on Wednesday;
 *   - the electricity bill due Wednesday on Thursday;
 *   - the market, due Monday 15:00, on Friday;
 *   - the room, due today, on Tuesday;
 *   - the doctor, Sunday 4 October (outside the week), on Monday 08:00 as
 *     «بلا موعد، بس مهمّة إلك», and «أجدد الهوية» (Thursday) and «أتصل بسامي»
 *     (tomorrow) as «بلا موعد» too;
 * and a saved day's rows dropped their «موعدها …» label.
 *
 * Three causes, each with its own test below:
 *   1. The week's step was the planner's first placement by start time, over
 *      undated work and dated work alike. One step a day then pushed dated work
 *      forward day by day, and #383's roll-over let it land after its due day.
 *   2. An all-day due date is stored as its local midnight, and the planner read
 *      that midnight as the deadline: the day's own start. Nothing all-day could
 *      be placed on its own day, so it rolled to the next.
 *   3. «بدون وقت محدد», answered to «أي ساعة يوم الاثنين؟», threw the day away:
 *      the review still said «لحد بكرا» and the saved commitment had no date.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { uidFor } from '../support/fakeAuth.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import {
  applyCommand as applyDomainCommand,
  createEmptyDomainState,
  type DomainState,
  type TimeSpec,
} from '../../src/domain/stateMachine.ts';
import { buildDailyPlanInput, type BusyBlockReader } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { buildAndStoreDailyPlan, readPlanSettings } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { acceptWeekDay, composeWeek, weekToDto, type WeekDto } from '../../lib/services/dailyPlan/weekPlan.ts';
import {
  answerClarification,
  confirmCapture,
  MemoryCaptureProposalStore,
  proposeCapture,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';

const TZ = 'Asia/Amman';
const USER = uidFor('WeekDueUser');
/** Sunday 27 September 2026, 18:30 in Amman (UTC+3): when the UAT opened «خطّط أسبوعي». */
const NOW = new Date('2026-09-27T15:30:00.000Z');
const WEEK = ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'];
/** Local midnight in Amman: the `dueAt` of an all-day commitment on `date`. */
const midnight = (date: string): string => new Date(Date.parse(`${date}T00:00:00.000Z`) - 3 * 3_600_000).toISOString();
/** A local Amman wall-clock time on `date`, as an instant. */
const at = (date: string, time: string): string => new Date(Date.parse(`${date}T${time}:00.000Z`) - 3 * 3_600_000).toISOString();

interface Seed {
  readonly id: string;
  readonly title: string;
  readonly level: 'normal' | 'high';
  readonly timeSpec: Omit<TimeSpec, 'timezone'>;
  /** The local day it is due on, for the assertions; null for undated work. */
  readonly dueDay: string | null;
}

const allDay = (date: string): Omit<TimeSpec, 'timezone'> => ({ kind: 'due_by', dueAt: midnight(date), endAt: null, remindAt: null, allDay: true });

/**
 * The UAT account's commitments as they are stored (shots 136–169, 144): the
 * three items asked «أي ساعة …؟» and answered «بدون وقت محدد» keep their day
 * as an all-day due date (cause 3, tested on its own below).
 */
const UAT: readonly Seed[] = [
  // «حضّرني», edited to 13:00: a window, shown 13:00, done by the 15:00 meeting (FX1).
  { id: 'prep', title: 'أجهّز أرقام المبيعات وأكتب ٣ نقاط للنقاش', level: 'normal', dueDay: WEEK[1]!,
    timeSpec: { kind: 'due_by', dueAt: at(WEEK[1]!, '13:00'), endAt: at(WEEK[1]!, '15:00'), remindAt: at(WEEK[1]!, '13:00'), allDay: false } },
  // «لازم أدفع فاتورة الكهربا قبل آخر الشهر» → «لحد الأربعاء، 30 سبتمبر · لازم» (136).
  { id: 'bill', title: 'أدفع فاتورة الكهربا', level: 'high', dueDay: WEEK[3]!, timeSpec: allDay(WEEK[3]!) },
  // «وبكرا العصرية بدي أروح عالسوق» → «بكرا · 15:00», a limit (177: «موعدها بكرا · 15:00»).
  { id: 'market', title: 'أروح عالسوق', level: 'normal', dueDay: WEEK[1]!,
    timeSpec: { kind: 'due_by', dueAt: at(WEEK[1]!, '15:00'), endAt: null, remindAt: at(WEEK[1]!, '15:00'), allDay: false } },
  // «واليوم لازم أرتب الغرفة»: today, no hour (179).
  { id: 'room', title: 'أرتب الغرفة', level: 'high', dueDay: WEEK[0]!, timeSpec: allDay(WEEK[0]!) },
  // «عندي موعد دكتور يوم الأحد» → Sunday 4 October, outside the week.
  { id: 'doctor', title: 'موعد دكتور', level: 'high', dueDay: '2026-10-04', timeSpec: allDay('2026-10-04') },
  // «لازم أجدد الهوية يوم الخميس» → «لحد الخميس، 1 أكتوبر · لازم».
  { id: 'id_card', title: 'أجدد الهوية', level: 'high', dueDay: WEEK[4]!, timeSpec: allDay(WEEK[4]!) },
  // «أتصل بسامي» → «لحد بكرا».
  { id: 'sami', title: 'أتصل بسامي', level: 'normal', dueDay: WEEK[1]!, timeSpec: allDay(WEEK[1]!) },
  // «أشتري هدية لأختي»: no day at all.
  { id: 'gift', title: 'أشتري هدية لأختي', level: 'normal', dueDay: null,
    timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false } },
  // «لازم أحضّر الغداء الساعة 8 المسا»: a time to be at, a fixed row tonight.
  { id: 'dinner', title: 'أحضّر الغداء', level: 'high', dueDay: WEEK[0]!,
    timeSpec: { kind: 'scheduled_event', dueAt: at(WEEK[0]!, '20:00'), endAt: null, remindAt: at(WEEK[0]!, '20:00'), allDay: false } },
];

/** The phone-calendar meeting on Monday 15:00–16:00 (153). */
const MONDAY_MEETING: BusyBlockReader = async (_uid, window) => (
  window.startsAt === midnight(WEEK[1]!)
    ? [{ blockId: 'meeting', startsAt: at(WEEK[1]!, '15:00'), endsAt: at(WEEK[1]!, '16:00') }]
    : []
);

function seededState(seeds: readonly Seed[]): DomainState {
  let state = createEmptyDomainState();
  const created = '2026-09-27T15:00:00.000Z';
  for (const seed of seeds) {
    state = applyDomainCommand(state, {
      type: 'CreateDraft',
      now: created,
      commitment: {
        id: seed.id,
        kind: 'task',
        title: seed.title,
        priority: { level: seed.level, source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
        timeSpec: { ...seed.timeSpec, timezone: TZ },
      },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyDomainCommand(state, { type: 'ConfirmCommitment', commitmentId: seed.id, now: created, reminders: [] }).newState;
  }
  return state;
}

async function withUat(fn: (storage: StorageAdapter) => Promise<void>, seeds: readonly Seed[] = UAT): Promise<void> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    await persistParticipantState(USER, seededState(seeds));
    const user = await storage.get<Record<string, unknown>>(userDoc(USER));
    await storage.set(userDoc(USER), { ...(user ?? {}), timezone: TZ, locale: 'ar' });
    await fn(storage);
  } finally {
    resetStorageForTests();
  }
}

async function week(storage: StorageAdapter): Promise<WeekDto> {
  return weekToDto(await composeWeek(USER, { moves: [], drops: [] }, { storage, now: () => NOW, busyBlocks: MONDAY_MEETING }));
}

/** Where each step is proposed: itemId → date. */
function placements(dto: WeekDto): Map<string, string> {
  return new Map(dto.days.flatMap((day) => day.items.map((item) => [item.itemId, day.date] as const)));
}

const dueDayOf = new Map(UAT.map((seed) => [seed.id, seed.dueDay]));

/* ── 1. No step lands after its due day ─────────────────────────────── */

test('N3: the literal UAT week proposes every dated step on or before its due day', async () => {
  await withUat(async (storage) => {
    const dto = await week(storage);
    const placed = placements(dto);
    for (const [itemId, date] of Array.from(placed)) {
      const due = dueDayOf.get(itemId);
      if (due) assert.ok(date <= due, `${itemId} (due ${due}) was proposed on ${date}, after its due day`);
    }
    // The table the UAT should have seen.
    assert.deepEqual(Object.fromEntries(placed), {
      room: WEEK[0], // due today, stays today
      market: WEEK[1], // due Monday 15:00, before the meeting
      sami: WEEK[1], // due Monday; Sunday is the room's, so it is Monday's too
      gift: WEEK[2], // undated: the first free day
      bill: WEEK[3], // due Wednesday
      id_card: WEEK[4], // due Thursday
    });
    const monday = dto.days[1]!;
    assert.ok(monday.items.every((item) => Date.parse(item.endsAt) <= Date.parse(at(WEEK[1]!, '15:00'))), 'a Monday step runs into the meeting');
    assert.ok(monday.items.every((item) => item.itemId !== 'market' || Date.parse(item.endsAt) <= Date.parse(at(WEEK[1]!, '15:00'))));
    // Nothing else of the week is left unplaced or waiting.
    assert.deepEqual(dto.days.flatMap((day) => day.unplaced), []);
    assert.equal(dto.waiting, 0);
  });
});

test('N3: work due today is proposed today, at a time still ahead', async () => {
  await withUat(async (storage) => {
    const today = (await week(storage)).days[0]!;
    const room = today.items.find((item) => item.itemId === 'room');
    assert.ok(room, `the room (due today) is not on today: ${JSON.stringify(today.items)}`);
    assert.ok(Date.parse(room!.startsAt) >= NOW.getTime());
    assert.equal(room!.reason, 'due');
  });
});

test('N3: one step a day holds; a second step appears only for work due that same day that no earlier day could take', async () => {
  await withUat(async (storage) => {
    const dto = await week(storage);
    for (const day of dto.days) {
      const beyondTheCap = day.items.slice(1);
      for (const item of beyondTheCap) {
        assert.equal(dueDayOf.get(item.itemId), day.date, `${day.date} holds ${item.itemId} beyond the one-step cap without it being due that day`);
      }
    }
    // Monday is the only such day: three things are due by Monday and Sunday
    // has room for one.
    assert.deepEqual(dto.days.map((day) => day.items.length), [1, 2, 1, 1, 1, 0, 0]);
  });
});

/* ── 2. Fixed times stay on their own day; the week ends at Saturday ── */

test('N3: the meeting prep window and tonight\'s dinner are fixed rows on their own day, never steps', async () => {
  await withUat(async (storage) => {
    const dto = await week(storage);
    const fixedOn = new Map(dto.days.flatMap((day) => day.fixed.map((row) => [row.itemId, [day.date, row.startsAt]] as const)));
    assert.deepEqual(fixedOn.get('prep'), [WEEK[1], at(WEEK[1]!, '13:00')]);
    assert.deepEqual(fixedOn.get('dinner'), [WEEK[0], at(WEEK[0]!, '20:00')]);
    const steps = new Set(placements(dto).keys());
    assert.ok(!steps.has('prep') && !steps.has('dinner'), 'a fixed-time commitment was proposed as a movable step');
  });
});

test('N3: an appointment after the seven days is nowhere in the week', async () => {
  await withUat(async (storage) => {
    const dto = await week(storage);
    const everywhere = dto.days.flatMap((day) => [...day.items, ...day.fixed, ...day.unplaced].map((row) => row.itemId));
    assert.ok(!everywhere.includes('doctor'), 'the doctor, on Sunday 4 October, was put into this week');
  });
});

/* ── 3. The reason on the card is true ──────────────────────────────── */

test('N3: every reason says what is true of the item and the day it is shown on', async () => {
  await withUat(async (storage) => {
    const dto = await week(storage);
    for (const day of dto.days) {
      for (const item of day.items) {
        const due = dueDayOf.get(item.itemId) ?? null;
        const want = due === null ? 'open' : due === day.date ? 'due' : due < day.date ? 'due_earlier' : 'due_later';
        assert.equal(item.reason, want, `${item.itemId} on ${day.date} (due ${due}) reads ${item.reason}`);
      }
    }
    assert.ok(!dto.days.some((day) => day.items.some((item) => item.reason === 'open' && dueDayOf.get(item.itemId))), 'a dated item reads «بلا موعد»');
  });
});

test('N3: a step pulled ahead of its due day says so, not «موعدها بهاليوم»', async () => {
  // Two things due Wednesday: one of them is proposed on Tuesday.
  const seeds: readonly Seed[] = [
    { id: 'bill', title: 'أدفع فاتورة الكهربا', level: 'high', dueDay: WEEK[3]!, timeSpec: allDay(WEEK[3]!) },
    { id: 'rent', title: 'أدفع الإيجار', level: 'high', dueDay: WEEK[3]!, timeSpec: allDay(WEEK[3]!) },
  ];
  await withUat(async (storage) => {
    const placed = (await week(storage)).days.flatMap((day) => day.items.map((item) => [item.itemId, day.date, item.reason]));
    assert.deepEqual(placed.map(([, date, reason]) => [date, reason]), [[WEEK[2], 'due_later'], [WEEK[3], 'due']]);
  }, seeds);
});

/* ── 4. A saved day keeps the labels it was proposed with ─────────── */

test('N3: saving a day keeps each row\'s due label as proposed (174)', async () => {
  await withUat(async (storage) => {
    const before = await week(storage);
    const monday = before.days[1]!;
    const shown = [...monday.items.map((item) => item.itemId), ...monday.unplaced.map((item) => item.itemId)];
    const saved = await acceptWeekDay(USER, WEEK[1]!, { moves: [], drops: [] }, shown, { storage, now: () => NOW, busyBlocks: MONDAY_MEETING });
    assert.equal(saved.outcome, 'accepted');
    const after = weekToDto(saved.layout).days[1]!;
    assert.equal(after.state, 'accepted');
    assert.deepEqual(
      after.items.map((item) => [item.itemId, item.reason]).sort(),
      monday.items.map((item) => [item.itemId, item.reason]).sort(),
    );
  });
});

/* ── The daily planner, which the week and the morning job share ───── */

test('N3: an all-day due date is due by the end of its day, so the daily planner can place it on that day', async () => {
  const state = seededState(UAT);
  const input = buildDailyPlanInput({
    uid: USER, date: WEEK[0]!, timezone: TZ, commitments: Object.values(state.commitments),
    busyBlocks: [], profile: null, focusHint: null, builtAt: NOW.toISOString(),
  });
  const room = input.constraints.items.find((item) => item.itemId === 'room');
  assert.equal(room?.deadlineAt, midnight(WEEK[1]!), 'the room\'s deadline is not the end of today');
});

test('N3: the morning build for Monday places everything due Monday on Monday and keeps the prep at 13:00', async () => {
  await withUat(async (storage) => {
    // 06:00 on Monday: the morning job's build of the day.
    const { stored } = await buildAndStoreDailyPlan(
      { uid: USER, date: WEEK[1]!, settings: await readPlanSettings(USER, { storage }) },
      { storage, now: () => new Date('2026-09-28T03:00:00.000Z'), busyBlocks: MONDAY_MEETING, push: async () => undefined },
    );
    const scheduled = new Map(stored.plan.scheduled.map((item) => [item.itemId, item.interval]));
    for (const itemId of ['market', 'sami', 'room']) assert.ok(scheduled.has(itemId), `${itemId} is not in Monday's plan`);
    assert.ok(Date.parse(scheduled.get('market')!.endsAt) <= Date.parse(at(WEEK[1]!, '15:00')));
    assert.ok(!scheduled.has('prep'), 'the prep window floated as a step');
    const prep = stored.constraints.fixedEvents.find((event) => event.sourceCommitmentId === 'prep');
    assert.equal(prep?.interval.startsAt, at(WEEK[1]!, '13:00'));
    assert.ok(await readStoredPlan(USER, WEEK[1]!, storage));
  });
});

/* ── 3. «بدون وقت محدد» keeps the day the question named ────────────── */

test('N3: answering «بدون وقت محدد» to «أي ساعة يوم الاثنين؟» saves an all-day due date on Monday, as the review shows', async () => {
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const at1807 = new Date('2026-09-27T15:07:00.000Z');
  const contract = await proposeCapture('بدي أتصل بسامي بكرا', { now: at1807, timezone: TZ, scopeId: 'n3', requestedEngine: 'rules' }, { store, persistence });
  const item = contract.items[0]!;
  assert.equal(item.clarification?.questionKey, 'ask_time');
  assert.equal(item.clarification?.params.date, WEEK[1]);
  const none = item.clarification!.options.find((option) => !option.value.localTime && !option.value.localDate)!;
  const answered = await answerClarification(
    { proposalId: contract.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: none.optionId },
    { now: at1807, timezone: TZ, scopeId: 'n3' },
    { store, recordEvent: () => undefined },
  );
  const reviewed = answered.items[0]!;
  // What the review card shows: that day, no hour.
  assert.deepEqual([reviewed.needsClarification, reviewed.resolvedTime, reviewed.resolvedDate], [false, null, WEEK[1]]);
  const result = await confirmCapture(
    { proposalId: contract.proposalId, scopeId: 'n3', selectedItemIds: [item.itemId], idempotencyKey: 'k-n3', now: at1807 },
    { store, persistence },
  );
  assert.equal(result.success, true, JSON.stringify(result));
  const [saved] = Object.values((await persistence.snapshot()).commitments);
  // What is saved: the same day, no hour, nothing to ring.
  assert.deepEqual(
    [saved!.timeSpec.kind, saved!.timeSpec.dueAt, saved!.timeSpec.allDay, saved!.timeSpec.remindAt, saved!.timeSpec.timezone],
    ['due_by', midnight(WEEK[1]!), true, null, TZ],
  );
});

test('N3: work whose hour has already gone today is not stranded on today as «ما إلها وقت»; it takes the first free day and says it is due before it', async () => {
  const seeds: readonly Seed[] = [
    { id: 'email', title: 'أبعت الإيميل للمدير', level: 'high', dueDay: WEEK[0]!,
      timeSpec: { kind: 'due_by', dueAt: at(WEEK[0]!, '15:00'), endAt: null, remindAt: at(WEEK[0]!, '15:00'), allDay: false } },
    { id: 'room', title: 'أرتب الغرفة', level: 'high', dueDay: WEEK[0]!, timeSpec: allDay(WEEK[0]!) },
  ];
  await withUat(async (storage) => {
    const dto = await week(storage);
    assert.deepEqual(dto.days[0]!.unplaced, []);
    assert.deepEqual(dto.days.flatMap((day) => day.items.map((item) => [item.itemId, day.date, item.reason])), [
      ['room', WEEK[0], 'due'],
      ['email', WEEK[1], 'due_earlier'],
    ]);
  }, seeds);
});

test('N3: work due today stays on today even when today has no room left, and says so there', async () => {
  const seeds: readonly Seed[] = [
    { id: 'room', title: 'أرتب الغرفة', level: 'high', dueDay: WEEK[0]!, timeSpec: allDay(WEEK[0]!) },
  ];
  // Busy from now to midnight tonight.
  const busyTonight: BusyBlockReader = async (_uid, window) => (
    window.startsAt === midnight(WEEK[0]!) ? [{ blockId: 'evening', startsAt: NOW.toISOString(), endsAt: midnight(WEEK[1]!) }] : []
  );
  await withUat(async (storage) => {
    const dto = weekToDto(await composeWeek(USER, { moves: [], drops: [] }, { storage, now: () => NOW, busyBlocks: busyTonight }));
    assert.deepEqual(dto.days[0]!.unplaced.map((item) => item.itemId), ['room'], 'the room, due today, left today');
    assert.ok(!dto.days.slice(1).some((day) => day.items.some((item) => item.itemId === 'room')), 'the room was proposed after the day it is due');
  }, seeds);
});

/* ── Review I1: the prep window during and after its own hour ───────── */

async function weekAt(storage: StorageAdapter, now: Date): Promise<WeekDto> {
  return weekToDto(await composeWeek(USER, { moves: [], drops: [] }, { storage, now: () => now, busyBlocks: MONDAY_MEETING }));
}

/** Every place the prep appears: [date, 'fixed' | 'step' | 'unplaced']. */
function prepEverywhere(dto: WeekDto): Array<[string, string]> {
  return dto.days.flatMap((day) => [
    ...day.fixed.filter((row) => row.itemId === 'prep').map(() => [day.date, 'fixed'] as [string, string]),
    ...day.items.filter((row) => row.itemId === 'prep').map(() => [day.date, 'step'] as [string, string]),
    ...day.unplaced.filter((row) => row.itemId === 'prep').map(() => [day.date, 'unplaced'] as [string, string]),
  ]);
}

test('I1: opened on the meeting day at 13:30, inside the prep window, the prep is a fixed row on Monday only', async () => {
  await withUat(async (storage) => {
    const dto = await weekAt(storage, new Date(Date.parse(at(WEEK[1]!, '13:30'))));
    assert.equal(dto.today, WEEK[1]);
    assert.deepEqual(prepEverywhere(dto), [[WEEK[1], 'fixed']], JSON.stringify(dto.days.map((day) => [day.date, day.items.map((item) => item.itemId), day.fixed.map((row) => row.itemId)])));
  });
});

test('I1: opened on the meeting day at 15:30, after the meeting started, the prep is late on Monday and is never a fresh step on a later day', async () => {
  await withUat(async (storage) => {
    const dto = await weekAt(storage, new Date(Date.parse(at(WEEK[1]!, '15:30'))));
    assert.equal(dto.today, WEEK[1]);
    assert.deepEqual(prepEverywhere(dto), [[WEEK[1], 'fixed']], JSON.stringify(dto.days.map((day) => [day.date, day.items.map((item) => item.itemId), day.fixed.map((row) => row.itemId)])));
  });
});

test('I1: tonight\'s dinner, once 20:00 has passed, stays tonight\'s fixed row and is not proposed tomorrow', async () => {
  await withUat(async (storage) => {
    const dto = await weekAt(storage, new Date(Date.parse(at(WEEK[0]!, '21:00'))));
    const dinner = dto.days.flatMap((day) => [
      ...day.fixed.filter((row) => row.itemId === 'dinner').map(() => [day.date, 'fixed']),
      ...day.items.filter((row) => row.itemId === 'dinner').map(() => [day.date, 'step']),
    ]);
    assert.deepEqual(dinner, [[WEEK[0], 'fixed']]);
  });
});

/* ── Review M1: only an all-day day is due by its end ───────────────── */

test('M1: a timed deadline at exactly local 00:00 keeps its instant; only an all-day day is due by its end', () => {
  const seeds: readonly Seed[] = [
    { id: 'midnight', title: 'Send it by midnight', level: 'normal', dueDay: WEEK[2]!,
      timeSpec: { kind: 'due_by', dueAt: midnight(WEEK[2]!), endAt: null, remindAt: null, allDay: false } },
    { id: 'tuesday', title: 'Tuesday, all day', level: 'normal', dueDay: WEEK[2]!, timeSpec: allDay(WEEK[2]!) },
  ];
  const input = buildDailyPlanInput({
    uid: USER, date: WEEK[2]!, timezone: TZ, commitments: Object.values(seededState(seeds).commitments),
    busyBlocks: [], profile: null, focusHint: null, builtAt: NOW.toISOString(),
  });
  const deadline = new Map(input.constraints.items.map((item) => [item.itemId, item.deadlineAt]));
  assert.equal(deadline.get('tuesday'), midnight(WEEK[3]!), 'the all-day Tuesday is not due by Tuesday\'s end');
  assert.equal(deadline.get('midnight'), midnight(WEEK[2]!), 'a timed 00:00 deadline was stretched to the whole day');
});

/* ── Re-review: a prep window that opens the evening before ─────────── */

/**
 * `schedulePrepAt` moves the prep to the evening before when quiet hours block
 * the hour before an early meeting: Mon 07:30 → prep shown Sun 21:30, due by
 * 07:30. A window across midnight.
 */
const EVENING_PREP: readonly Seed[] = [
  { id: 'early_prep', title: 'أجهّز العرض', level: 'normal', dueDay: WEEK[1]!,
    timeSpec: { kind: 'due_by', dueAt: at(WEEK[0]!, '21:30'), endAt: at(WEEK[1]!, '07:30'), remindAt: at(WEEK[0]!, '21:30'), allDay: false } },
];

function everywhere(dto: WeekDto, itemId: string): Array<[string, string, string | null]> {
  return dto.days.flatMap((day) => [
    ...day.fixed.filter((row) => row.itemId === itemId).map((row) => [day.date, 'fixed', row.startsAt] as [string, string, string | null]),
    ...day.items.filter((row) => row.itemId === itemId).map((row) => [day.date, 'step', row.startsAt] as [string, string, string | null]),
    ...day.unplaced.filter((row) => row.itemId === itemId).map(() => [day.date, 'unplaced', null] as [string, string, string | null]),
  ]);
}

test('re-review: a prep window opened the evening before is never proposed after the meeting it prepares for', async () => {
  await withUat(async (storage) => {
    // Monday 06:00: the window opened last night and is due by 07:30.
    const dto = weekToDto(await composeWeek(USER, { moves: [], drops: [] }, { storage, now: () => new Date(Date.parse(at(WEEK[1]!, '06:00'))) }));
    const seen = everywhere(dto, 'early_prep');
    for (const [date, , startsAt] of seen) {
      assert.ok(date <= WEEK[1]!, `the prep was proposed on ${date}, after Monday's meeting`);
      if (startsAt) assert.ok(Date.parse(startsAt) < Date.parse(at(WEEK[1]!, '07:30')), `the prep was proposed at ${startsAt}, after the 07:30 meeting`);
    }
    // No room before 07:30 in the working day: late, on Monday, said honestly.
    assert.deepEqual(seen, [[WEEK[1], 'unplaced', null]]);
  }, EVENING_PREP);
});

test('re-review: at Sunday 22:00 the evening prep is a fixed row on Sunday only', async () => {
  await withUat(async (storage) => {
    const dto = weekToDto(await composeWeek(USER, { moves: [], drops: [] }, { storage, now: () => new Date(Date.parse(at(WEEK[0]!, '22:00'))) }));
    assert.deepEqual(everywhere(dto, 'early_prep'), [[WEEK[0], 'fixed', at(WEEK[0]!, '21:30')]]);
  }, EVENING_PREP);
});

test('re-review: the daily planner reads a window\'s end as its deadline on the day after it opened', () => {
  const input = buildDailyPlanInput({
    uid: USER, date: WEEK[1]!, timezone: TZ, commitments: Object.values(seededState(EVENING_PREP).commitments),
    busyBlocks: [], profile: null, focusHint: null, builtAt: at(WEEK[1]!, '06:00'),
  });
  assert.equal(input.constraints.items.find((item) => item.itemId === 'early_prep')?.deadlineAt, at(WEEK[1]!, '07:30'));
});
