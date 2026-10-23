/**
 * Habit occurrences in the shared daily-plan request (#750, SIM-6).
 *
 * Mutation contract:
 *  - remove the habit merge in `composeDailyPlanRequest`: the Saturday,
 *    skipped-state, drag/re-solve and provenance tests all lose their item;
 *  - label habit items as commitments: the source/title assertions fail;
 *  - state a protection on a flexible adapter item: the first-generation
 *    absence assertion fails and the user's protected drag is overwritten;
 *  - admit closed occurrences: the skipped-state assertion fails;
 *  - fall back to the title stored in the old plan request: the rename/delete
 *    GET assertions return the original title instead of current/null.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import {
  buildDailyPlanOnDemand,
  composeDailyPlanRequest,
  currentPlanTitles,
  type DailyPlanRequest,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import {
  createHabitServices,
  createHabitWithOccurrences,
  patchHabitWithOccurrences,
  removeHabitWithOccurrences,
} from '../../lib/services/habits/habitService.ts';
import { schedulePlan, reconcileScheduleBlocks } from '../../lib/planning/scheduler/index.ts';
import { editPlan, regeneratePlan, setBlockProtection } from '../../lib/services/dailyPlan/planActions.ts';
import { composeWeek, NO_WEEK_DECISIONS, weekToDto } from '../../lib/services/dailyPlan/weekPlan.ts';
import { habitInput } from '../habits/habitSupport.ts';
import type { HabitDefinitionInput } from '../../src/contracts/v1/habitContracts.ts';
import { installFakeAuth, tokenFor } from '../support/fakeAuth.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';

const UID = 'habit_daily_plan_user';
const TIMEZONE = 'UTC';
const FRIDAY = '2026-03-06';
const SATURDAY = '2026-03-07';
const NOW = new Date('2026-03-07T05:00:00.000Z');

async function seedAccount(storage: StorageAdapter, uid = UID): Promise<Record<string, unknown>> {
  const user = { timezone: TIMEZONE, locale: 'en' };
  await storage.set(userDoc(uid), user);
  return user;
}

function saturdayHabit(uid: string, overrides: Partial<HabitDefinitionInput> = {}): HabitDefinitionInput {
  return habitInput({
    scopeId: uid,
    title: 'Saturday training',
    cadence: { kind: 'weekdays', weekdays: [6] },
    durationMinutes: 45,
    preferredWindows: [{ start: '08:00', end: '08:45' }],
    minimumOccurrences: 1,
    maximumOccurrences: 1,
    flexibility: 'protected_flexible',
    recoveryPolicy: 'skip',
    ...overrides,
  });
}

function planRequest(date: string): Request {
  return new Request(`http://127.0.0.1:4321/api/mobile/plans/${date}`, {
    headers: { authorization: `Bearer ${tokenFor(UID)}` },
  });
}

function planParams(date: string): { params: Promise<{ date: string }> } {
  return { params: Promise.resolve({ date }) };
}

async function addSaturdayHabit(
  storage: StorageAdapter,
  uid = UID,
  overrides: Partial<HabitDefinitionInput> = {},
) {
  return createHabitWithOccurrences(
    createHabitServices(storage),
    saturdayHabit(uid, overrides),
    '2026-03-01T09:00:00.000Z',
    FRIDAY,
  );
}

async function requestFor(
  storage: StorageAdapter,
  userDocument: unknown,
  date: string,
  uid = UID,
  previousBlocks: Parameters<typeof composeDailyPlanRequest>[0]['previousBlocks'] = null,
): Promise<DailyPlanRequest> {
  return composeDailyPlanRequest({
    uid,
    date,
    timezone: TIMEZONE,
    now: NOW.toISOString(),
    userDocument,
    previousBlocks,
  }, { storage, busyBlocks: async () => [] });
}

test('a timed Saturday habit is present only on Saturday, at its time, with deterministic habit identity', async () => {
  const storage = createMemoryStorage();
  const user = await seedAccount(storage);
  const created = await addSaturdayHabit(storage);
  const occurrenceId = created.materialization.occurrences[0]!.occurrenceId;

  const friday = await requestFor(storage, user, FRIDAY);
  assert.equal(friday.constraints.items.some((item) => item.itemId === occurrenceId), false);

  const saturday = await requestFor(storage, user, SATURDAY);
  const repeated = await requestFor(storage, user, SATURDAY);
  const item = saturday.constraints.items.find((candidate) => candidate.itemId === occurrenceId);
  assert.ok(item, 'the materialized Saturday occurrence never reached the shared request');
  assert.deepEqual(saturday.scheduleSources.items.get(occurrenceId), {
    kind: 'habit_occurrence',
    id: occurrenceId,
  });
  assert.equal(saturday.titles.get(occurrenceId), 'Saturday training');

  const plan = schedulePlan(saturday.constraints, saturday.config);
  const placed = plan.scheduled.find((candidate) => candidate.itemId === occurrenceId);
  assert.equal(placed?.interval.startsAt, '2026-03-07T08:00:00.000Z');
  assert.equal(placed?.interval.endsAt, '2026-03-07T08:45:00.000Z');
  assert.equal(repeated.constraints.items.find((candidate) => candidate.itemId === occurrenceId)?.itemId, occurrenceId);
  assert.equal(schedulePlan(repeated.constraints, repeated.config).inputDigest, plan.inputDigest);

  const blocks = reconcileScheduleBlocks({
    constraints: saturday.constraints,
    plan,
    generation: 1,
    sources: saturday.scheduleSources,
    preferredWindows: saturday.preferredWindows,
  });
  const habitBlock = blocks.find((block) => block.source.id === occurrenceId);
  assert.equal(habitBlock?.source.kind, 'habit_occurrence');
  assert.deepEqual(habitBlock?.placement.preferredWindows, [{
    startsAt: '2026-03-07T08:00:00.000Z',
    endsAt: '2026-03-07T08:45:00.000Z',
  }]);
  assert.equal((await currentPlanTitles(UID, [], { blocks }, storage)).get(occurrenceId), 'Saturday training');
});

test('GET joins a habit occurrence to its current title, then null after the habit is deleted', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  const previousAiDisabled = process.env.MAYBESITTER_AI_DISABLED;
  process.env.MAYBESITTER_AI_DISABLED = 'true';
  try {
    await seedAccount(storage);
    const created = await addSaturdayHabit(storage);
    const occurrenceId = created.materialization.occurrences[0]!.occurrenceId;
    await buildDailyPlanOnDemand(UID, SATURDAY, {
      storage,
      busyBlocks: async () => [],
      now: () => NOW,
    });

    const services = createHabitServices(storage);
    const renamed = await patchHabitWithOccurrences(
      services,
      UID,
      created.habit.habitId,
      { title: 'Renamed Saturday training' },
      '2026-03-07T06:00:00.000Z',
      SATURDAY,
    );
    assert.ok(renamed);

    const renamedResponse = await planGet(planRequest(SATURDAY), planParams(SATURDAY));
    assert.equal(renamedResponse.status, 200);
    const renamedBody = await renamedResponse.json() as {
      plan: { scheduled: Array<{ itemId: string; title: string | null }> };
    };
    assert.equal(
      renamedBody.plan.scheduled.find((item) => item.itemId === occurrenceId)?.title,
      'Renamed Saturday training',
    );

    assert.equal(await removeHabitWithOccurrences(services, UID, created.habit.habitId), true);
    const deletedResponse = await planGet(planRequest(SATURDAY), planParams(SATURDAY));
    assert.equal(deletedResponse.status, 200);
    const deletedBody = await deletedResponse.json() as {
      plan: { scheduled: Array<{ itemId: string; title: string | null }> };
    };
    const deletedItem = deletedBody.plan.scheduled.find((item) => item.itemId === occurrenceId);
    assert.ok(deletedItem, 'deleting the source must not make the stored plan unreadable');
    assert.equal(deletedItem.title, null);
  } finally {
    auth.restore();
    resetStorageForTests();
    if (previousAiDisabled === undefined) delete process.env.MAYBESITTER_AI_DISABLED;
    else process.env.MAYBESITTER_AI_DISABLED = previousAiDisabled;
  }
});

test('a skipped occurrence is absent from the daily-plan request', async () => {
  const storage = createMemoryStorage();
  const user = await seedAccount(storage);
  const created = await addSaturdayHabit(storage);
  const occurrence = created.materialization.occurrences[0]!;
  const services = createHabitServices(storage);
  const transition = await services.occurrences.transition(UID, created.habit.habitId, occurrence.occurrenceId, 'skipped');
  assert.equal(transition.kind, 'applied');

  const request = await requestFor(storage, user, SATURDAY);
  assert.equal(request.constraints.items.some((item) => item.itemId === occurrence.occurrenceId), false);
  assert.equal(request.scheduleSources.items.has(occurrence.occurrenceId), false);
});

test('the week composer keeps the dated habit in its daily solve', async () => {
  const storage = createMemoryStorage();
  await seedAccount(storage);
  const created = await addSaturdayHabit(storage);
  const occurrenceId = created.materialization.occurrences[0]!.occurrenceId;

  const layout = await composeWeek(UID, NO_WEEK_DECISIONS, {
    storage,
    busyBlocks: async () => [],
    now: () => new Date('2026-03-06T05:00:00.000Z'),
  });
  const saturday = weekToDto(layout).days.find((day) => day.date === SATURDAY)!;
  assert.deepEqual(saturday.items.map((item) => ({ id: item.itemId, title: item.title })), [{
    id: occurrenceId,
    title: 'Saturday training',
  }]);
  assert.equal(saturday.items[0]?.startsAt, '2026-03-07T08:00:00.000Z');
});

test('a flexible habit states no protection and a user-protected drag survives regeneration', async () => {
  const storage = createMemoryStorage();
  await seedAccount(storage);
  const created = await addSaturdayHabit(storage, UID, {
    flexibility: 'flexible',
    preferredWindows: [],
  });
  const occurrenceId = created.materialization.occurrences[0]!.occurrenceId;

  const previousAiDisabled = process.env.MAYBESITTER_AI_DISABLED;
  process.env.MAYBESITTER_AI_DISABLED = 'true';
  try {
    const built = await buildDailyPlanOnDemand(UID, SATURDAY, {
      storage,
      busyBlocks: async () => [],
      now: () => NOW,
    });
    const firstItem = built.stored.constraints.items.find((item) => item.itemId === occurrenceId)!;
    assert.equal(Object.hasOwn(firstItem, 'protection'), false, 'the adapter pre-empted plan-layer protection');
    const block = built.stored.blocks.find((candidate) => candidate.source.id === occurrenceId)!;
    assert.equal(block.source.kind, 'habit_occurrence');

    await setBlockProtection(UID, SATURDAY, {
      blockId: block.blockId,
      ownership: 'protected_flexible',
      origin: 'user',
      maxShiftMinutes: null,
      preferredInterval: null,
    }, { storage, now: () => NOW });
    await editPlan(UID, SATURDAY, {
      moves: [{
        itemId: occurrenceId,
        startsAt: '2026-03-07T12:00:00.000Z',
        endsAt: '2026-03-07T12:45:00.000Z',
      }],
      removals: [],
    }, { storage, now: () => NOW });

    const regenerated = await regeneratePlan(UID, SATURDAY, {
      storage,
      busyBlocks: async () => [],
      now: () => NOW,
    });
    assert.equal(regenerated.ok, true);
    if (!regenerated.ok) return;
    const next = regenerated.stored.blocks.find((candidate) => candidate.source.id === occurrenceId)!;
    assert.equal(next.currentInterval?.startsAt, '2026-03-07T12:00:00.000Z');
    assert.equal(next.protection?.origin, 'user');
    assert.equal(next.protection?.preferredInterval?.startsAt, '2026-03-07T12:00:00.000Z');
  } finally {
    if (previousAiDisabled === undefined) delete process.env.MAYBESITTER_AI_DISABLED;
    else process.env.MAYBESITTER_AI_DISABLED = previousAiDisabled;
  }
});

test('habit inclusion changes no M5b memory provenance in off or on mode', async () => {
  const keys = [
    'MAYBESITTER_ENV',
    'MAYBESITTER_FEATURE_MEMORY_LEARNING',
    'MAYBESITTER_KILL_SWITCH_MEMORY_LEARNING',
    'MAYBESITTER_FEATURE_MEMORY',
    'MAYBESITTER_KILL_SWITCH_MEMORY',
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const provenance = (request: DailyPlanRequest) => ({
    basisSnapshot: request.basisSnapshot,
    focusFromMemory: request.focusFromMemory,
    personalizationPurgeEpoch: request.personalizationPurgeEpoch,
    memoryUse: request.memoryUse,
    storedPurgeEpoch: request.storedPurgeEpoch,
  });

  try {
    for (const enabled of [false, true]) {
      process.env.MAYBESITTER_ENV = 'test';
      process.env.MAYBESITTER_FEATURE_MEMORY_LEARNING = String(enabled);
      process.env.MAYBESITTER_KILL_SWITCH_MEMORY_LEARNING = 'false';
      process.env.MAYBESITTER_FEATURE_MEMORY = 'true';
      process.env.MAYBESITTER_KILL_SWITCH_MEMORY = 'false';

      const storage = createMemoryStorage();
      const user = await seedAccount(storage, `${UID}_${enabled ? 'on' : 'off'}`);
      const uid = `${UID}_${enabled ? 'on' : 'off'}`;
      const withoutHabit = await requestFor(storage, user, SATURDAY, uid);
      await addSaturdayHabit(storage, uid);
      const withHabit = await requestFor(storage, user, SATURDAY, uid);
      assert.deepEqual(
        provenance(withHabit),
        provenance(withoutHabit),
        `habit wiring changed ${enabled ? 'on' : 'off'}-mode memory provenance`,
      );
    }
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
