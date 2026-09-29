/**
 * A weekly block keeps work out of its window, in the day plan and in the
 * week plan («ثابت أسبوعي»: "work 10–4 every Saturday").
 *
 * Nothing here injects a busy-block reader: the block is created through the
 * real service, materialized into real busy blocks, and the plans are built the
 * way production builds them. Each claim has a control — the same account
 * without the block puts work inside 10:00–16:00 — so a planner that never
 * reached that window cannot pass by accident.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { buildAndStoreDailyPlan, claimDueDelivery, savePlanSettings } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { composeWeek, weekToDto } from '../../lib/services/dailyPlan/weekPlan.ts';
import { createWeeklyBlock } from '../../lib/weeklyBlocks/weeklyBlockService.ts';

const UID = 'user_weekly_plan';
const TZ = 'Asia/Jerusalem';
/** Tuesday 29 Sep 2026: when the person confirmed "every Saturday 10–4". */
const CONFIRMED = new Date('2026-09-29T09:00:00.000Z');
/** Saturday 3 Oct 2026, 08:00 in Jerusalem (UTC+3). */
const SATURDAY_MORNING = new Date('2026-10-03T05:00:00.000Z');
/** Friday 2 Oct 2026, 09:00 in Jerusalem: the week ahead includes Saturday. */
const FRIDAY_MORNING = new Date('2026-10-02T06:00:00.000Z');
/** 10:00–16:00 on Saturday 3 Oct, Jerusalem. */
const WINDOW = { startsAt: Date.parse('2026-10-03T07:00:00.000Z'), endsAt: Date.parse('2026-10-03T13:00:00.000Z') };

function inside(interval: { startsAt: string; endsAt: string }): boolean {
  return Date.parse(interval.startsAt) < WINDOW.endsAt && Date.parse(interval.endsAt) > WINDOW.startsAt;
}

function seedState() {
  let state = createEmptyDomainState();
  const at = '2026-09-28T09:00:00.000Z';
  const titles = ['Write the summary', 'Call the bank', 'Book the train', 'Read the brief', 'Send the invoice', 'Fix the sink', 'Order the parts', 'Draft the reply'];
  titles.forEach((title, index) => {
    const id = `cmt_${index}`;
    // Due Saturday evening, so the week puts them on Saturday too.
    const timeSpec = { kind: 'due_by' as const, dueAt: '2026-10-03T17:00:00.000Z', remindAt: null, timezone: TZ };
    state = applyDomainCommand(state, { type: 'CreateDraft', now: at, commitment: { id, kind: 'task', title, timeSpec }, draftStatus: 'pending_confirmation' }).newState;
    state = applyDomainCommand(state, { type: 'ConfirmCommitment', commitmentId: id, now: at, reminders: [] }).newState;
  });
  return state;
}

async function account(withBlock: boolean): Promise<MemoryStorageAdapter> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  await persistParticipantState(UID, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(UID));
  await storage.set(userDoc(UID), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  if (withBlock) {
    await createWeeklyBlock(UID, {
      title: 'دوام', weekdays: [6], start: '10:00', end: '16:00', timezone: TZ, confirmedAt: CONFIRMED.toISOString(),
    }, { storage, now: CONFIRMED });
  }
  return storage;
}

async function saturdayPlan(withBlock: boolean) {
  const storage = await account(withBlock);
  const deps = { storage, now: () => SATURDAY_MORNING };
  await savePlanSettings(UID, { enabled: true, deliveryLocalTime: '07:30' }, CONFIRMED, deps);
  const claim = await claimDueDelivery(UID, SATURDAY_MORNING, deps);
  assert.ok(claim, 'the account was not claimable; the fixture is wrong');
  assert.equal(claim.date, '2026-10-03');
  await buildAndStoreDailyPlan(claim, deps);
  const stored = await readStoredPlan(UID, claim.date, storage);
  assert.ok(stored, 'no plan was stored');
  return stored.plan;
}

test.afterEach(() => resetStorageForTests());

test('day plan: nothing is placed inside Saturday 10:00–16:00 once the weekly block exists', async () => {
  const control = await saturdayPlan(false);
  assert.ok(control.scheduled.some((placement) => inside(placement.interval)), 'without the block the planner never used the window; this proves nothing');

  const plan = await saturdayPlan(true);
  assert.ok(plan.scheduled.length > 0, 'nothing was scheduled at all');
  for (const placement of plan.scheduled) {
    assert.equal(inside(placement.interval), false, `${placement.itemId} was placed inside the weekly block`);
  }
});

test('week plan: Saturday\'s proposal keeps 10:00–16:00 free too', async () => {
  const saturdayItems = async (withBlock: boolean) => {
    const storage = await account(withBlock);
    const dto = weekToDto(await composeWeek(UID, { moves: [], drops: [] }, { storage, now: () => FRIDAY_MORNING }));
    const saturday = dto.days.find((day) => day.date === '2026-10-03');
    assert.ok(saturday, 'the week does not include Saturday');
    return saturday.items;
  };
  const control = await saturdayItems(false);
  assert.ok(control.some(inside), 'without the block the week never used the window; this proves nothing');
  const items = await saturdayItems(true);
  assert.ok(items.length > 0, 'the week put nothing on Saturday at all');
  for (const item of items) assert.equal(inside(item), false, `${item.itemId} was placed inside the weekly block`);
});
