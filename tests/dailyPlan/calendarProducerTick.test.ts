/**
 * A real calendar sync reaches the replan tick, with no row written by hand (#611).
 *
 * Every earlier tick test stored its `PlanningStateChange` row itself, because
 * nothing in production wrote one: a meeting landing on a scheduled task never
 * replanned anything. Here the only writer is the phone's busy route, the same
 * handler production runs, and the only reader is `runContinuousReplanTick`.
 *
 * Under the council's default (`always_require_confirmation`, #611 guards) the
 * outcome is an **offer**, never a new generation: the plan in force stays as
 * it is until the person accepts. The plan GET shows the offer, and when the
 * meeting goes away again the next sync announces that too and the tick
 * withdraws the offer (#636's withdrawal on facts), without recording a
 * rejection the person never made.
 *
 * The fixture is #604's: three half-hour tasks at 06:00, 06:30 and 07:00 UTC
 * (09:00–10:30 in Jerusalem), and a meeting that moves onto the first.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { PLANNING_STATE_CHANGES, userCol, userDoc } from '../../lib/storage/paths.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { buildAndStoreDailyPlan, claimDueDelivery, savePlanSettings } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { listPlanEvents, readStoredPlan, type StoredDailyPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { runContinuousReplanTick } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { busyBlockId } from '../../lib/calendar/busyBlocks.ts';
import { createIcsFeed, icsBusyBlocks, refreshIcsFeed } from '../../lib/calendar/icsFeeds.ts';
import { createInMemoryKms } from '../../lib/security/inMemoryKms.ts';
import { KMS_KEY_ENV_VAR, resetFieldEncryptionForTests } from '../../lib/security/fieldEncryption.ts';
import { intervalsOverlap } from '../../lib/planning/shared/time.ts';
import { installFakeAuth, tokenFor, uidFor } from '../support/fakeAuth.ts';
import { POST as busyPost } from '../../src/app/api/mobile/calendar/busy/route.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';
import type { TimeInterval } from '../../src/contracts/v1/planningContracts.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const DATE = '2026-09-15';
/** 09:00 in Jerusalem: past the 07:30 delivery. */
const MORNING = Date.parse('2026-09-15T06:00:00.000Z');
const TASKS = ['cmt_a', 'cmt_b', 'cmt_c'] as const;
const SOURCE = 'device:0b7e4a52-3d61-4c8f-9a2e-5f1d6c7b8a90';
/** The native event the phone reads; its block id hashes it with its start. */
const STANDUP = 'evt-standup';
/** Inside the day, after every task: overlaps nothing placed. */
const EVENING: TimeInterval = { startsAt: `${DATE}T16:00:00.000Z`, endsAt: `${DATE}T16:30:00.000Z` };
/** The first task's slot. */
const ON_TASK: TimeInterval = { startsAt: `${DATE}T06:00:00.000Z`, endsAt: `${DATE}T06:30:00.000Z` };
const WINDOW = { windowStart: `${DATE}T00:00:00.000Z`, windowEnd: '2026-10-13T00:00:00.000Z' };

function minutesAfterMorning(minutes: number): Date {
  return new Date(MORNING + minutes * 60_000);
}

function seedState() {
  let state = createEmptyDomainState();
  for (const id of TASKS) {
    state = applyDomainCommand(state, {
      type: 'CreateDraft',
      now: '2026-09-14T06:00:00.000Z',
      commitment: { id, kind: 'task', title: id, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyDomainCommand(state, {
      type: 'ConfirmCommitment', commitmentId: id, now: '2026-09-14T06:00:00.000Z', reminders: [],
    }).newState;
  }
  return state;
}

/** The morning plan, built by the real morning build, and calendar consent on. */
async function seedAccount(storage: StorageAdapter, uid: string): Promise<StoredDailyPlan> {
  await persistParticipantState(uid, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await savePlanSettings(uid, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
  const claim = await claimDueDelivery(uid, new Date(MORNING), { storage });
  assert.ok(claim, 'fixture: the account must be due for a plan');
  await buildAndStoreDailyPlan(claim, { storage, now: () => new Date(MORNING) });
  await applyTrustAction(uid, { type: 'record_first_value', at: '2026-09-14T06:00:00.000Z' });
  await applyTrustAction(uid, { type: 'set_calendar_consent', granted: true, at: '2026-09-14T06:00:00.000Z' });
  const stored = await readStoredPlan(uid, DATE, storage);
  assert.ok(stored, 'fixture: the morning build stored no plan');
  const first = stored.plan.scheduled.find((item) => item.itemId === 'cmt_a');
  assert.ok(first && intervalsOverlap(first.reservedInterval, ON_TASK), `fixture: cmt_a must sit at 06:00, got ${JSON.stringify(first)}`);
  return stored;
}

interface World {
  readonly storage: MemoryStorageAdapter;
  readonly uid: string;
  /** Moves the wall clock the routes read. */
  setClock(at: Date): void;
}

async function withWorld(name: string, fn: (world: World) => Promise<void>): Promise<void> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  // The routes read the wall clock, and an offer expires with its day (#611
  // guards): pinned inside the plan's own day.
  mock.timers.enable({ apis: ['Date'], now: MORNING });
  try {
    await fn({ storage, uid: uidFor(name), setClock: (at) => mock.timers.setTime(at.getTime()) });
  } finally {
    mock.timers.reset();
    auth.restore();
    resetStorageForTests();
  }
}

/** One event on the phone's calendar: its native id and where it sits. */
interface PhoneEvent {
  readonly nativeId: string;
  readonly at: TimeInterval;
}

/** The phone's sync, through the production route: the whole calendar, as the phone restates it. */
async function phoneSyncAll(uid: string, events: readonly PhoneEvent[]): Promise<string[]> {
  const blocks = events.map((event) => ({
    blockId: busyBlockId(SOURCE, event.nativeId, event.at.startsAt),
    startAt: event.at.startsAt,
    endAt: event.at.endsAt,
    allDay: false,
  }));
  const response = await busyPost(new Request(`${BASE}/api/mobile/calendar/busy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${tokenFor(uid)}` },
    body: JSON.stringify({ sourceId: SOURCE, platform: 'ios', ...WINDOW, blocks }),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  return blocks.map((block) => block.blockId);
}

/** The phone's sync with the standup at `at`, or with no standup at all. */
async function phoneSync(uid: string, at: TimeInterval | null): Promise<string | null> {
  const [blockId] = await phoneSyncAll(uid, at === null ? [] : [{ nativeId: STANDUP, at }]);
  return blockId ?? null;
}

async function pendingRows(storage: StorageAdapter, uid: string): Promise<PlanningStateChange[]> {
  return (await storage.list<PlanningStateChange>(userCol(uid, PLANNING_STATE_CHANGES))).map((row) => row.data);
}

async function planResponse(uid: string): Promise<{ proposal: { proposalId: string; causeChangeIds: string[] } | null }> {
  const response = await planGet(
    new Request(`${BASE}/api/mobile/plans/${DATE}`, { headers: { authorization: `Bearer ${tokenFor(uid)}` } }),
    { params: Promise.resolve({ date: DATE }) },
  );
  assert.equal(response.status, 200);
  return response.json();
}

test('a phone sync that moves a meeting onto a scheduled task becomes a stored offer at the next tick; removing it withdraws the offer', async () => {
  await withWorld('ProducerTickUser', async ({ storage, uid, setClock }) => {
    const before = await seedAccount(storage, uid);

    // The standup, somewhere harmless. It is announced, and the tick finds
    // nothing it contradicts.
    const evening = await phoneSync(uid, EVENING);
    assert.deepEqual((await pendingRows(storage, uid)).map((row) => row.entityId), [evening]);
    setClock(minutesAfterMorning(1));
    const quiet = await runContinuousReplanTick({ storage, now: minutesAfterMorning(1) });
    assert.equal(quiet.replanRequired, 0, JSON.stringify(quiet));
    assert.equal((await readStoredPlan(uid, DATE, storage))!.proposal ?? null, null);
    assert.deepEqual(await pendingRows(storage, uid), [], 'the tick drained what it judged');

    // An identical re-sync: nothing moved, nothing announced.
    await phoneSync(uid, EVENING);
    assert.deepEqual(await pendingRows(storage, uid), []);

    // The standup moves onto the first task. Its id hashes its start, so the
    // sync announces two changes: the evening id, now free, and the new one.
    setClock(minutesAfterMorning(5));
    const onTask = await phoneSync(uid, ON_TASK);
    const moved = await pendingRows(storage, uid);
    assert.deepEqual(moved.map((row) => row.entityId).sort(), [evening, onTask].sort());
    assert.ok(moved.every((row) => row.source === 'calendar'), 'rows the tick resolves per change (#605)');
    const arrival = moved.find((row) => row.entityId === onTask)!;

    setClock(minutesAfterMorning(6));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(6) });
    assert.equal(totals.replanRequired, 1, `the meeting on the task must reach the planner: ${JSON.stringify(totals)}`);
    assert.equal(totals.proposed, 1, JSON.stringify(totals));
    assert.equal(totals.autoApplied, 0, 'the default asks first: never a new generation');

    const offered = (await readStoredPlan(uid, DATE, storage))!;
    assert.equal(offered.generation, before.generation, 'the plan in force is untouched until the person accepts');
    assert.ok(offered.proposal, 'the offer must be stored');
    assert.equal(offered.proposal.userControlMode, 'always_require_confirmation');
    assert.deepEqual(offered.proposal.causeChangeIds, [arrival.changeId], 'the arrival is the cause; the freed evening slot is not');
    assert.deepEqual(offered.proposal.causeRefs, [{ changeId: arrival.changeId, source: 'calendar', entityId: onTask }]);
    const task = offered.proposal.plan.scheduled.find((item) => item.itemId === 'cmt_a');
    assert.ok(task, 'the offer still places the task');
    assert.ok(!intervalsOverlap(task.reservedInterval, ON_TASK), `the offer moves the task off the meeting: ${JSON.stringify(task)}`);
    assert.deepEqual(await pendingRows(storage, uid), []);

    const shown = await planResponse(uid);
    assert.equal(shown.proposal?.proposalId, offered.proposal.proposalId, 'the plan GET shows the offer');
    assert.deepEqual(shown.proposal?.causeChangeIds, [arrival.changeId]);

    // The standup is cancelled. The sync announces the freed time, and the
    // tick withdraws the offer: nothing on the day collides any more.
    setClock(minutesAfterMorning(10));
    await phoneSync(uid, null);
    assert.deepEqual((await pendingRows(storage, uid)).map((row) => row.entityId), [onTask]);
    setClock(minutesAfterMorning(11));
    const after = await runContinuousReplanTick({ storage, now: minutesAfterMorning(11) });
    assert.equal(after.withdrawn, 1, JSON.stringify(after));

    const withdrawn = (await readStoredPlan(uid, DATE, storage))!;
    assert.equal(withdrawn.proposal ?? null, null);
    assert.equal(withdrawn.generation, before.generation);
    assert.deepEqual(withdrawn.rejectedProposals ?? [], [], 'a withdrawal is not the person declining anything');
    assert.equal((await planResponse(uid)).proposal, null);
  });
});

/**
 * A storage that runs `between` after every write it passes on: the instants
 * at which a concurrent Cloud Run instance's tick could read a sync in flight.
 */
function tickingBetweenWrites(raw: MemoryStorageAdapter, between: () => Promise<void>): StorageAdapter {
  let inside = false;
  const after = async () => {
    if (inside) return;
    inside = true;
    try {
      await between();
    } finally {
      inside = false;
    }
  };
  return {
    get: (path) => raw.get(path),
    list: (path, options) => raw.list(path, options),
    listGroup: (id, options) => raw.listGroup(id, options),
    deleteTree: (path) => raw.deleteTree(path),
    async set(path, value) { await raw.set(path, value); await after(); },
    async delete(path) { await raw.delete(path); await after(); },
    async runTransaction(fn) { const result = await raw.runTransaction(fn); await after(); return result; },
  };
}

/*
 * The mid-sync case. A tick runs after every write the sync makes. A row the
 * tick could see before its block was written would resolve as a deleted
 * meeting, be judged `PLAN_STALE`, and be drained; the block would then land
 * with no row left to announce it, and the day would keep a task under a
 * meeting until tomorrow's build. Each block commits with its own row, so
 * that instant does not exist.
 */
test('a tick that runs in the middle of the sync never loses the meeting', async () => {
  await withWorld('ProducerMidSyncUser', async ({ storage, uid, setClock }) => {
    await seedAccount(storage, uid);
    await phoneSync(uid, EVENING);
    await runContinuousReplanTick({ storage, now: minutesAfterMorning(1) });
    assert.deepEqual(await pendingRows(storage, uid), []);

    setClock(minutesAfterMorning(5));
    const interleaved: string[] = [];
    setStorageForTests(tickingBetweenWrites(storage, async () => {
      const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });
      interleaved.push(JSON.stringify(totals));
    }));
    const onTask = await phoneSync(uid, ON_TASK);
    setStorageForTests(storage);
    assert.ok(interleaved.length >= 1, 'the sync must have had an instant for a tick to run in');

    setClock(minutesAfterMorning(6));
    await runContinuousReplanTick({ storage, now: minutesAfterMorning(6) });

    const stored = (await readStoredPlan(uid, DATE, storage))!;
    assert.ok(stored.proposal, `the meeting must have been offered for, by some tick. Interleaved: ${interleaved.join(' | ')}`);
    assert.ok(stored.proposal.causeRefs?.some((ref) => ref.entityId === onTask), 'and the offer names it');
    const task = stored.proposal.plan.scheduled.find((item) => item.itemId === 'cmt_a');
    assert.ok(task && !intervalsOverlap(task.reservedInterval, ON_TASK));
    assert.deepEqual(await pendingRows(storage, uid), []);
  });
});

/* ══ Removals on another day (#645 review, P2) ═══════════════════════ */

/*
 * A removal resolves to `{ interval: null }`: the block is gone. Before the
 * row carried the removed block's own interval, the evaluator could not tell a
 * removal next week from one on the plan's day, judged every removal
 * `PLAN_STALE`, and with an offer pending that re-solves and re-issues the
 * offer: a new id, drifted placements, another `plan_proposed`, and the
 * person's Accept on the offer they are looking at refused as stale. Off-day
 * removals are routine: a cancellation next week, the old id of a meeting
 * moved within next week, the phone's window rolling past midnight, and every
 * ICS refresh (its window starts at `now`, so lectures that ended drop out).
 */

const NEXT_WEEK: TimeInterval = { startsAt: '2026-09-22T07:00:00.000Z', endsAt: '2026-09-22T08:00:00.000Z' };
const NEXT_WEEK_LATER: TimeInterval = { startsAt: '2026-09-22T09:00:00.000Z', endsAt: '2026-09-22T10:00:00.000Z' };
const REVIEW = 'evt-review';

/** An account with an offer on the table: the standup moved onto `cmt_a`, and next week's review in the calendar. */
async function withOfferPending(storage: MemoryStorageAdapter, uid: string, setClock: (at: Date) => void): Promise<{ proposalId: string; proposed: number }> {
  await seedAccount(storage, uid);
  await phoneSyncAll(uid, [{ nativeId: STANDUP, at: EVENING }, { nativeId: REVIEW, at: NEXT_WEEK }]);
  setClock(minutesAfterMorning(1));
  await runContinuousReplanTick({ storage, now: minutesAfterMorning(1) });
  setClock(minutesAfterMorning(5));
  await phoneSyncAll(uid, [{ nativeId: STANDUP, at: ON_TASK }, { nativeId: REVIEW, at: NEXT_WEEK }]);
  setClock(minutesAfterMorning(6));
  const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(6) });
  assert.equal(totals.proposed, 1, `fixture: the standup must be offered for: ${JSON.stringify(totals)}`);
  const offer = (await readStoredPlan(uid, DATE, storage))!.proposal;
  assert.ok(offer);
  assert.deepEqual(await pendingRows(storage, uid), []);
  return { proposalId: offer.proposalId, proposed: await offersMade(storage, uid) };
}

async function offersMade(storage: StorageAdapter, uid: string): Promise<number> {
  return (await listPlanEvents(uid, storage)).filter((event) => event.type === 'plan_proposed').length;
}

async function assertOfferUntouched(storage: StorageAdapter, uid: string, before: { proposalId: string; proposed: number }): Promise<void> {
  const stored = (await readStoredPlan(uid, DATE, storage))!;
  assert.equal(stored.proposal?.proposalId, before.proposalId, 'the offer the person is looking at is the same offer');
  assert.equal(await offersMade(storage, uid), before.proposed, 'and nothing was offered again');
  assert.deepEqual(await pendingRows(storage, uid), [], 'the rows were judged and drained');
}

test('P2: a meeting cancelled next week leaves today\'s pending offer as it is', async () => {
  await withWorld('ProducerOffDayRemoval', async ({ storage, uid, setClock }) => {
    const before = await withOfferPending(storage, uid, setClock);

    setClock(minutesAfterMorning(40));
    await phoneSyncAll(uid, [{ nativeId: STANDUP, at: ON_TASK }]);
    assert.equal((await pendingRows(storage, uid)).length, 1, 'the cancellation is announced');
    setClock(minutesAfterMorning(41));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(41) });

    assert.equal(totals.noEffect, 1, `a removal next week cannot touch today: ${JSON.stringify(totals)}`);
    assert.equal(totals.stale + totals.proposed + totals.kept + totals.withdrawn, 0, JSON.stringify(totals));
    await assertOfferUntouched(storage, uid, before);
  });
});

test('P2: a meeting moved within next week (old id freed, new id taken) leaves today\'s offer as it is', async () => {
  await withWorld('ProducerOffDayMove', async ({ storage, uid, setClock }) => {
    const before = await withOfferPending(storage, uid, setClock);

    setClock(minutesAfterMorning(40));
    await phoneSyncAll(uid, [{ nativeId: STANDUP, at: ON_TASK }, { nativeId: REVIEW, at: NEXT_WEEK_LATER }]);
    assert.equal((await pendingRows(storage, uid)).length, 2, 'a move is two rows');
    setClock(minutesAfterMorning(41));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(41) });

    assert.equal(totals.noEffect, 1, JSON.stringify(totals));
    assert.equal(totals.stale + totals.proposed + totals.kept + totals.withdrawn, 0, JSON.stringify(totals));
    await assertOfferUntouched(storage, uid, before);
  });
});

test('P2: an ICS refresh that drops a lecture which ended yesterday leaves today\'s offer as it is', async () => {
  await withWorld('ProducerIcsEnded', async ({ storage, uid, setClock }) => {
    resetFieldEncryptionForTests();
    const kms = createInMemoryKms();
    let feedNow = new Date('2026-09-14T08:00:00.000Z');
    const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const lecture = (uid: string, at: TimeInterval) => [
      'BEGIN:VEVENT', `UID:${uid}`, 'SUMMARY:Lecture', 'DTSTAMP:20260901T080000Z',
      `DTSTART:${stamp(at.startsAt)}`, `DTEND:${stamp(at.endsAt)}`, 'END:VEVENT',
    ];
    const YESTERDAY: TimeInterval = { startsAt: '2026-09-14T10:00:00.000Z', endsAt: '2026-09-14T12:00:00.000Z' };
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lecture('lec-1', YESTERDAY), ...lecture('lec-2', NEXT_WEEK), 'END:VCALENDAR', ''].join('\r\n');
    const deps = {
      now: () => feedNow,
      encryption: { kms, env: { NODE_ENV: 'test', [KMS_KEY_ENV_VAR]: kms.keyName } as NodeJS.ProcessEnv },
      log: () => undefined,
      classifyTimeoutMs: 15_000,
      fetch: async () => ({ notModified: false as const, body, etag: null, lastModified: null }),
    };

    const before = await (async () => {
      await seedAccount(storage, uid);
      // Subscribed yesterday morning: both lectures are busy time.
      const created = await createIcsFeed(uid, { url: 'https://moodle.univ.example/export?authtoken=T0KEN' }, deps);
      assert.equal(created.preview.busyBlocks, 2);
      const offer = await (async () => {
        setClock(minutesAfterMorning(1));
        await runContinuousReplanTick({ storage, now: minutesAfterMorning(1) });
        assert.deepEqual(await pendingRows(storage, uid), [], 'fixture: the subscribe rows were drained');
        await phoneSyncAll(uid, [{ nativeId: STANDUP, at: ON_TASK }]);
        setClock(minutesAfterMorning(6));
        const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(6) });
        assert.equal(totals.proposed, 1, JSON.stringify(totals));
        return (await readStoredPlan(uid, DATE, storage))!.proposal!;
      })();
      return { feedId: created.feed.feedId, proposalId: offer.proposalId, proposed: await offersMade(storage, uid) };
    })();

    // This morning's scheduled refresh: yesterday's lecture has ended and
    // falls out of the feed's window.
    feedNow = minutesAfterMorning(40);
    setClock(feedNow);
    const refreshed = await refreshIcsFeed(uid, before.feedId, { manual: false }, deps);
    assert.equal(refreshed.outcome, 'updated');
    assert.equal((await icsBusyBlocks(uid, before.feedId, { now: () => feedNow })).length, 1);
    assert.equal((await pendingRows(storage, uid)).length, 1, 'the ended lecture\'s removal is announced');

    setClock(minutesAfterMorning(41));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(41) });
    assert.equal(totals.noEffect, 1, JSON.stringify(totals));
    assert.equal(totals.stale + totals.proposed + totals.kept + totals.withdrawn, 0, JSON.stringify(totals));
    await assertOfferUntouched(storage, uid, before);
    resetFieldEncryptionForTests();
  });
});

test('P2 control: a removal on the plan\'s own day is still judged — it frees today\'s time', async () => {
  await withWorld('ProducerSameDayRemoval', async ({ storage, uid, setClock }) => {
    await seedAccount(storage, uid);
    const LUNCH: TimeInterval = { startsAt: `${DATE}T10:00:00.000Z`, endsAt: `${DATE}T11:00:00.000Z` };
    await phoneSyncAll(uid, [{ nativeId: STANDUP, at: ON_TASK }, { nativeId: 'evt-lunch', at: LUNCH }]);
    setClock(minutesAfterMorning(6));
    const offered = await runContinuousReplanTick({ storage, now: minutesAfterMorning(6) });
    assert.equal(offered.proposed, 1, JSON.stringify(offered));

    // Lunch is cancelled; the standup still sits on the task.
    setClock(minutesAfterMorning(40));
    await phoneSyncAll(uid, [{ nativeId: STANDUP, at: ON_TASK }]);
    setClock(minutesAfterMorning(41));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(41) });
    assert.equal(totals.stale, 1, `a removal on today is a planner input that moved: ${JSON.stringify(totals)}`);
    assert.equal(totals.noEffect, 0);
    assert.equal(totals.proposed + totals.kept, 1, 'with an offer pending it re-solves, as before');
    assert.ok((await readStoredPlan(uid, DATE, storage))!.proposal, 'the standup still needs the offer');
  });
});

/* ══ No plan today: no compose (#645 review, P3) ═════════════════════ */

/*
 * Since #611 every calendar-connected account has change rows on most ticks,
 * and most of those accounts have no plan for the day. The evaluator answers
 * `no_current_plan` before it reads a fact, so the tick must not resolve
 * entity facts or compose the day's planning request (the domain load and the
 * busy-block read) for them. The rows still drain, as they did.
 */
test('P3: an account with calendar rows and no plan today drains them without composing a plan request', async () => {
  await withWorld('ProducerNoPlanToday', async ({ storage, uid }) => {
    await storage.set(userDoc(uid), { timezone: TZ, locale: 'en' });
    await applyTrustAction(uid, { type: 'record_first_value', at: '2026-09-14T06:00:00.000Z' });
    await applyTrustAction(uid, { type: 'set_calendar_consent', granted: true, at: '2026-09-14T06:00:00.000Z' });
    await phoneSyncAll(uid, [{ nativeId: STANDUP, at: ON_TASK }, { nativeId: REVIEW, at: NEXT_WEEK }]);
    assert.equal((await pendingRows(storage, uid)).length, 2);
    assert.equal(await readStoredPlan(uid, DATE, storage), null, 'fixture: no plan for today');

    const reads: string[] = [];
    const spy: StorageAdapter = {
      get: (path) => { reads.push(path); return storage.get(path); },
      list: (path, options) => { reads.push(path); return storage.list(path, options); },
      listGroup: (id, options) => { reads.push(`group:${id}`); return storage.listGroup(id, options); },
      set: (path, value) => storage.set(path, value),
      delete: (path) => storage.delete(path),
      deleteTree: (path) => storage.deleteTree(path),
      runTransaction: (fn) => storage.runTransaction(fn),
    };
    const totals = await runContinuousReplanTick({ storage: spy, now: minutesAfterMorning(1) });

    assert.deepEqual(totals, {
      examined: 1, replanRequired: 0, autoApplied: 0, proposed: 0, kept: 0, withdrawn: 0,
      stale: 0, noEffect: 1, failed: 0, skipped: 0,
    });
    assert.deepEqual(await pendingRows(storage, uid), [], 'the rows drain, as a verdict that stored nothing drains');
    const busyReads = reads.filter((path) => path.startsWith(`users/${uid}/busyBlocks`));
    assert.deepEqual(busyReads, [], `no entity facts were resolved and no plan request composed; read: ${reads.join(', ')}`);
    assert.equal(await readStoredPlan(uid, DATE, storage), null, 'and nothing was planned');
  });
});
