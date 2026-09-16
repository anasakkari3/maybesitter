/**
 * The calendar actually reaching the planner (UC-3.2, #186 step 6).
 *
 * UC-3.10a (#194) built the mapping and left the reader as a seam. Its own test
 * file says so in as many words: "what this cannot prove is that a real
 * calendar reaches this function at all; `NO_BUSY_BLOCKS` is today's production
 * reader, and until #186 lands the end-to-end criterion is open." This file is
 * that criterion, and it is deliberately written against the *default*: nothing
 * below injects a reader, so a change that put `NO_BUSY_BLOCKS` back — or wired
 * the real one somewhere the job never reaches — turns these red.
 *
 * Two claims, and they pull in opposite directions on purpose:
 *
 *   a timed block is honoured, so nothing is ever placed inside the two hours
 *   somebody is at a lecture;
 *
 *   an all-day block is *not*, so a birthday does not empty the day. That is
 *   #186's explicit decision, and without a case for it the safe-looking
 *   implementation — treat every block as blocking — passes everything else.
 *
 * Every instant is derived from the clock this process is running on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { dayHorizon } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { toEpochMs } from '../../lib/planning/shared/time.ts';
import { busyBlockId, replaceBusyBlocks, type BusyBlock } from '../../lib/calendar/busyBlocks.ts';

const UID = 'user_busy_plan_1';
const TZ = 'Asia/Jerusalem';
const SOURCE = 'device:9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a';
const HOUR = 3_600_000;

/** Today, as this account's calendar shows it. */
const DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const HORIZON = dayHorizon(DATE, TZ);
const MIDNIGHT = toEpochMs(HORIZON.startsAt);
/** Local `hours:00`, as an instant. */
const local = (hours: number): string => new Date(MIDNIGHT + hours * HOUR).toISOString();

const MORNING = new Date(MIDNIGHT + 9 * HOUR);
const YESTERDAY_NOON = new Date(MIDNIGHT - 12 * HOUR);

function seedState() {
  let state = createEmptyDomainState();
  const at = YESTERDAY_NOON.toISOString();
  // Eight, not three. Three thirty-minute tasks fit between 08:00 and 09:30 and
  // never reach 10:00, so a busy block at 10:00 would be avoided by a planner
  // that had never heard of it — the control case below caught exactly that.
  const titles = [
    'Write the summary', 'Call the bank', 'Book the train', 'Read the brief',
    'Send the invoice', 'Fix the sink', 'Order the parts', 'Draft the reply',
  ];
  for (let index = 0; index < titles.length; index += 1) {
    const id = `cmt_${index}`;
    const title = titles[index]!;
    state = applyDomainCommand(state, {
      type: 'CreateDraft',
      now: at,
      commitment: { id, kind: 'task', title, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyDomainCommand(state, {
      type: 'ConfirmCommitment', commitmentId: id, now: at, reminders: [],
    }).newState;
  }
  return state;
}

function busy(nativeId: string, fromHour: number, toHour: number, allDay = false): BusyBlock {
  return {
    blockId: busyBlockId(SOURCE, nativeId, local(fromHour)),
    sourceId: SOURCE,
    sourceKind: 'device',
    startAt: local(fromHour),
    endAt: local(toHour),
    allDay,
  };
}

/**
 * A plan, built the way the morning job builds one.
 *
 * `deps` carries a storage adapter and a clock and *no reader*, which is the
 * whole point: whatever the daily plan does about busy time here is what it
 * does in production.
 */
async function planWith(blocks: readonly BusyBlock[]) {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const deps = { storage, now: () => MORNING };
  await persistParticipantState(UID, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(UID));
  await storage.set(userDoc(UID), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await replaceBusyBlocks(UID, SOURCE, HORIZON, blocks, { storage, platform: 'ios', now: MORNING });

  await savePlanSettings(UID, { enabled: true, deliveryLocalTime: '07:30' }, YESTERDAY_NOON, deps);
  const claim = await claimDueDelivery(UID, MORNING, deps);
  assert.ok(claim, 'the account was not claimable; the fixture, not the feature, is wrong');
  await buildAndStoreDailyPlan(claim, deps);
  const stored = await readStoredPlan(UID, claim.date, storage);
  assert.ok(stored, 'no plan was stored');
  return stored.plan;
}

function overlapsAny(
  placement: { startsAt: string; endsAt: string },
  blocks: readonly BusyBlock[],
): boolean {
  return blocks.some((block) => (
    toEpochMs(placement.startsAt) < toEpochMs(block.endAt)
    && toEpochMs(placement.endsAt) > toEpochMs(block.startAt)
  ));
}

test('nothing is placed inside a lecture the calendar already knows about', async () => {
  try {
    const blocks = [busy('lecture', 10, 12)];
    const plan = await planWith(blocks);
    assert.ok(plan.scheduled.length > 0, 'nothing was scheduled at all; this check would be vacuous');
    for (const placement of plan.scheduled) {
      assert.equal(
        overlapsAny(placement.interval, blocks),
        false,
        `${placement.itemId} was placed inside a busy block`,
      );
    }
  } finally {
    resetStorageForTests();
  }
});

/**
 * The same day with nothing in the calendar, for comparison.
 *
 * Without it, "no placement overlaps 10:00–12:00" is satisfied by a planner
 * that happens never to use those hours — and a test that passes for a reason
 * it is not about is a test that will keep passing when the wiring is gone.
 * This asserts the busy hours are ones the planner would otherwise have used.
 */
test('the hours the lecture takes are hours the planner would otherwise have used', async () => {
  try {
    const free = await planWith([]);
    const used = free.scheduled.some((placement) => overlapsAny(placement.interval, [busy('lecture', 10, 12)]));
    assert.equal(used, true, 'the planner avoids 10:00-12:00 anyway, so the busy case proves nothing');
  } finally {
    resetStorageForTests();
  }
});

test('an all-day entry does not empty the day', async () => {
  try {
    const plan = await planWith([busy('holiday', 0, 24, true)]);
    assert.ok(
      plan.scheduled.length > 0,
      'an all-day calendar entry blocked every hour of the day',
    );
  } finally {
    resetStorageForTests();
  }
});

test('another account\'s busy time does not narrow this one\'s day', async () => {
  try {
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    await replaceBusyBlocks('user_busy_plan_2', SOURCE, HORIZON, [busy('lecture', 10, 12)], { storage });
    const mine = await storage.list(`users/${UID}/busyBlocks`);
    assert.deepEqual(mine, []);
  } finally {
    resetStorageForTests();
  }
});
