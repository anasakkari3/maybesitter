/**
 * The week's save when the store's own re-solve places nothing (second review
 * of audit 2026-10-03 #4).
 *
 * `acceptWeekDay` composes the week, then stores the day through the daily
 * flow, which solves again against busy time read *then*. A meeting that
 * lands between the two leaves a stored plan that places nothing. That plan
 * is refused by `acceptPlan` (`empty_plan`), and the document this save
 * created must not be left behind as an orphan 'proposed' plan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { acceptWeekDay, composeWeek, weekToDto } from '../../lib/services/dailyPlan/weekPlan.ts';
import { listPlanEvents, readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';

const TZ = 'Asia/Jerusalem';
const USER = 'week-store-race';
/** 09:00 in Jerusalem on Tuesday 15 September. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');
const DAY = '2026-09-17';

test('a meeting landing between the week\'s compose and its store: empty_day, and no plan is left stored', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    let state = createEmptyDomainState();
    const now = '2026-09-14T06:00:00.000Z';
    state = applyCommand(state, {
      type: 'CreateDraft', now, draftStatus: 'pending_confirmation',
      commitment: { id: 'cmt_a', kind: 'task', title: 'Write the summary', timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
    } as never).newState;
    state = applyCommand(state, { type: 'ConfirmCommitment', commitmentId: 'cmt_a', now, reminders: [] } as never).newState;
    await persistParticipantState(USER, state);
    const user = await storage.get<Record<string, unknown>>(userDoc(USER));
    await storage.set(userDoc(USER), { ...(user ?? {}), timezone: TZ, locale: 'en' });

    const decisions = { moves: [{ itemId: 'cmt_a', date: DAY }], drops: [] };
    // Free while the week is composed; wall to wall by the time the day is stored.
    let reads = 0;
    let freeReads = Infinity;
    const wallToWall = [{ blockId: 'b1', startsAt: '2026-09-16T21:00:00.000Z', endsAt: '2026-09-17T20:59:00.000Z' }];
    const busyBlocks = async () => { reads += 1; return reads > freeReads ? wallToWall : []; };
    const deps = { storage, now: () => MORNING, busyBlocks } as never;

    const shownWeek = weekToDto(await composeWeek(USER, decisions as never, deps));
    const composeReads = reads;
    const day = shownWeek.days.find((candidate) => candidate.date === DAY)!;
    assert.deepEqual(day.items.map((item) => item.itemId), ['cmt_a'], 'the setup does not show the step on the day');

    reads = 0;
    freeReads = composeReads;
    const result = await acceptWeekDay(USER, DAY, decisions as never, day.items.map((item) => item.itemId), deps);
    assert.ok(reads > composeReads, 'the store did not read busy time again, so this proves nothing about the race');
    assert.equal(result.outcome, 'empty_day');
    assert.equal(await readStoredPlan(USER, DAY, storage), null, 'the empty plan the store made was left behind');
    assert.ok(!(await listPlanEvents(USER, storage)).some((event) => event.type === 'plan_accepted'), 'it was accepted');
  } finally {
    resetStorageForTests();
  }
});
