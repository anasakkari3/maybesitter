/**
 * A plan built before an appointment ends stops showing it once it has ended
 * (lane E1, review round 1 item 4).
 *
 * `fixedRowsOf` re-reads the pinned rows from the commitments as they are now,
 * but it judged "over" at the plan's `generatedAt`: built at 08:00 with a
 * 09:00–10:00 meeting, the plan read at 10:30 still showed the meeting — on
 * Plan, on an accepted week day, and in Today's plan preview. "Over" is a
 * question about the moment of reading.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { createEmptyDomainState, type Commitment } from '../../src/domain/stateMachine.ts';
import { buildDailyPlanOnDemand } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { assemblePlanResponse } from '../../lib/services/dailyPlan/planDto.ts';
import { composeWeek, weekToDto } from '../../lib/services/dailyPlan/weekPlan.ts';
import { uidFor } from '../support/fakeAuth.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';

const UID = uidFor('EndedStoredPlanUser');
const TZ = 'Asia/Jerusalem';
const DATE = '2026-11-12';
/** 08:00 Jerusalem: the plan is built before the meeting. */
const BUILT = new Date('2026-11-12T06:00:00.000Z');
/** 09:30: the meeting is on. */
const DURING = new Date('2026-11-12T07:30:00.000Z');
/** 10:30: the meeting is over. */
const READ = new Date('2026-11-12T08:30:00.000Z');

function commitment(id: string, title: string, timeSpec: Partial<Commitment['timeSpec']>, level: 'high' | 'normal' = 'normal'): Commitment {
  return {
    id, kind: 'task', title, description: null, person: null, status: 'active',
    priority: { level, source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: TZ, ...timeSpec },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '2026-11-11T08:00:00.000Z', updatedAt: '2026-11-11T08:00:00.000Z', confirmedAt: '2026-11-11T08:00:00.000Z',
    completedAt: null, droppedAt: null,
  } as Commitment;
}

const COMMITMENTS = [
  commitment('meeting', 'اجتماع مع سامي', { kind: 'scheduled_event', dueAt: '2026-11-12T07:00:00.000Z', endAt: '2026-11-12T08:00:00.000Z' }),
  commitment('evening', 'عشا مع العيلة', { kind: 'scheduled_event', dueAt: '2026-11-12T16:00:00.000Z', endAt: '2026-11-12T17:00:00.000Z' }),
  commitment('report', 'أكتب التقرير', {}, 'high'),
];

async function withBuiltPlan(body: (storage: StorageAdapter, stored: Awaited<ReturnType<typeof buildDailyPlanOnDemand>>['stored']) => Promise<void>): Promise<void> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    await seedLiveAccount(UID, storage);
    const user = await storage.get<Record<string, unknown>>(userDoc(UID));
    await storage.set(userDoc(UID), { ...(user ?? {}), timezone: TZ, locale: 'en' });
    const state = createEmptyDomainState();
    for (const item of COMMITMENTS) state.commitments[item.id] = item;
    await persistParticipantState(UID, state);
    const built = await buildDailyPlanOnDemand(UID, DATE, { storage, now: () => BUILT, busyBlocks: async () => [] });
    await body(storage, built.stored);
  } finally {
    resetStorageForTests();
  }
}

async function fixedAt(storage: StorageAdapter, stored: Parameters<typeof assemblePlanResponse>[1], now: Date): Promise<string[]> {
  const dto = await assemblePlanResponse(UID, stored, now, new Map(), { commitments: COMMITMENTS, storage });
  return dto.fixed.map((row) => row.itemId);
}

test('E1 stored plan: built at 08:00, the meeting is a fixed row at 09:30 and gone at 10:30', async () => {
  await withBuiltPlan(async (storage, stored) => {
    assert.equal(stored.generatedAt, BUILT.toISOString(), 'sanity: the plan was built before the meeting');
    assert.deepEqual(await fixedAt(storage, stored, DURING), ['meeting', 'evening']);
    assert.deepEqual(await fixedAt(storage, stored, READ), ['evening']);
  });
});

test('E1 stored plan: the week shows the stored day without the meeting once it is over', async () => {
  await withBuiltPlan(async (storage) => {
    const dto = weekToDto(await composeWeek(UID, { moves: [], drops: [] }, { storage, now: () => READ, busyBlocks: async () => [] }));
    const today = dto.days.find((day) => day.date === DATE)!;
    assert.notEqual(today.state, 'proposed', 'sanity: today is the stored plan, not a fresh proposal');
    assert.deepEqual(today.fixed.map((row) => row.itemId), ['evening']);
  });
});
