import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import type { ListOptions, StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { CALENDAR_SOURCES, userCol, userDoc } from '../../lib/storage/paths.ts';
import { replaceBusyBlocks } from '../../lib/calendar/busyBlocks.ts';
import { findFreeSlots, readFreeSlotSchedule, setFreeSlotScheduleReaderForTests, type FreeSlotSchedule } from '../../lib/planning/freeSlots.ts';
import { buildRoutineProfile } from '../../src/contracts/v1/routineContracts.ts';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';
import type { Commitment, DomainState } from '../../src/domain/stateMachine.ts';
import type { CaptureProposalItemContract } from '../../src/contracts/v1/captureContracts.ts';
import { candidateClashes } from '../../lib/planning/freeSlots.ts';
import { eveningImpacts, withEveningImpacts } from '../../lib/planning/eveningImpact.ts';
import { rankPostponeSlots, usualHoursFor } from '../../lib/planning/postponeSlots.ts';

const UID = 'free-slots-unit-user';
const TZ = 'Asia/Jerusalem';
const NOW = '2026-10-24T12:00:00.000Z';
const DATE = '2026-10-25';

function schedule(overrides: Partial<FreeSlotSchedule> = {}): FreeSlotSchedule {
  return { commitments: [], busyBlocks: [], weeklyBlocks: [], routineProfile: null, coverage: [], complete: true, ...overrides };
}

function saved(id: string, title: string, start: string, end: string | null, overrides: Partial<Commitment> = {}): Commitment {
  return {
    id, kind: 'task', title, description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' }, category: null, categorySource: 'inferred',
    timeSpec: { kind: 'scheduled_event', dueAt: start, endAt: end, remindAt: null, allDay: false, timezone: TZ },
    currentAckState: 'not_seen', postponedUntil: null, createdAt: NOW, updatedAt: NOW,
    confirmedAt: NOW, completedAt: null, droppedAt: null, ...overrides,
  };
}

test('candidateClashes is candidate-aware, excludes the moved row, and fails closed on coverage', () => {
  const existing = saved('saved', 'Saved meeting', '2026-10-25T07:00:00.000Z', '2026-10-25T08:00:00.000Z');
  const known = schedule({ commitments: [existing] });
  assert.deepEqual(candidateClashes(known, { dueAt: existing.timeSpec.dueAt!, endAt: existing.timeSpec.endAt!, kind: 'scheduled_event' }), {
    state: 'clash', clashes: [{ title: 'Saved meeting', startsAt: existing.timeSpec.dueAt, endsAt: existing.timeSpec.endAt, kind: 'commitment' }],
  });
  assert.deepEqual(candidateClashes(known, { dueAt: existing.timeSpec.dueAt!, endAt: existing.timeSpec.endAt!, kind: 'scheduled_event' }, { excludeCommitmentIds: ['saved'] }), { state: 'free' });
  assert.deepEqual(candidateClashes(schedule({ coverage: [{ sourceId: 'phone', kind: 'device', windowStart: '2026-10-25T00:00:00.000Z', windowEnd: '2026-10-25T07:30:00.000Z' }] }),
    { dueAt: '2026-10-25T07:00:00.000Z', endAt: '2026-10-25T08:00:00.000Z', kind: 'scheduled_event' }), { state: 'unknown', reason: 'uncovered' });
});

test('candidateClashes carries a weekly block\'s own title', () => {
  const weekly = { startsAt: '2026-10-25T07:00:00.000Z', endsAt: '2026-10-25T08:00:00.000Z', title: 'English tutoring' };
  assert.deepEqual(candidateClashes(schedule({ weeklyBlocks: [weekly] }), {
    dueAt: weekly.startsAt,
    endAt: weekly.endsAt,
    kind: 'scheduled_event',
  }), {
    state: 'clash',
    clashes: [{ title: weekly.title, startsAt: weekly.startsAt, endsAt: weekly.endsAt, kind: 'weekly' }],
  });
});

test('eveningImpacts uses Jerusalem civil time across the 2026 fall-back night', () => {
  const evening = { itemId: 'evening', title: 'Late dinner', resolvedTime: '2026-10-24T18:00:00.000Z', endTime: '2026-10-24T20:30:00.000Z', allDayEvent: false } as CaptureProposalItemContract;
  const exam = saved('exam', 'Math exam', '2026-10-25T07:00:00.000Z', '2026-10-25T09:00:00.000Z');
  assert.deepEqual(eveningImpacts([evening], schedule({ commitments: [exam] }), TZ), [{
    itemId: 'evening', impact: { kind: 'late_before_important', role: 'evening', otherTitle: 'Math exam',
      otherStartsAt: exam.timeSpec.dueAt, otherEndsAt: exam.timeSpec.endAt, readiness: null, prep: null },
  }]);
});

test('withEveningImpacts removes stale impacts and generated prep when the schedule read is incomplete', async () => {
  const previousEnvironment = process.env.MAYBESITTER_ENV;
  const previousFeature = process.env.MAYBESITTER_FEATURE_EVENING_IMPACT;
  process.env.MAYBESITTER_ENV = 'test';
  process.env.MAYBESITTER_FEATURE_EVENING_IMPACT = 'true';
  setFreeSlotScheduleReaderForTests(() => async () => schedule({ complete: false }));
  const impact = { kind: 'late_before_important', role: 'evening', otherTitle: 'Math exam',
    otherStartsAt: '2026-10-25T07:00:00.000Z', otherEndsAt: null, readiness: 'not_ready',
    prep: { state: 'offered', itemId: 'prep' } } as const;
  const contract = {
    version: 'v8', proposalId: 'proposal', status: 'proposal', seeds: [],
    items: [
      { itemId: 'evening', title: 'Late dinner', resolvedTime: '2026-10-24T18:00:00.000Z', endTime: '2026-10-24T20:30:00.000Z', impacts: [impact] },
      { itemId: 'prep', title: 'Prepare', resolvedTime: '2026-10-24T16:00:00.000Z', generated: { kind: 'evening_impact_prep', sourceItemId: 'evening' } },
    ],
  } as unknown as import('../../src/contracts/v1/captureContracts.ts').CaptureProposalContract;
  try {
    const refreshed = await withEveningImpacts(contract, UID, { timezone: TZ, now: NOW, storage: createMemoryStorage() });
    assert.deepEqual(refreshed.items.map((item) => item.itemId), ['evening']);
    assert.equal(refreshed.items[0]!.impacts, undefined);
  } finally {
    setFreeSlotScheduleReaderForTests(null);
    if (previousEnvironment === undefined) delete process.env.MAYBESITTER_ENV;
    else process.env.MAYBESITTER_ENV = previousEnvironment;
    if (previousFeature === undefined) delete process.env.MAYBESITTER_FEATURE_EVENING_IMPACT;
    else process.env.MAYBESITTER_FEATURE_EVENING_IMPACT = previousFeature;
  }
});

test('usualHoursFor requires eight recent completions and a 60% three-hour cluster', () => {
  const rows: Record<string, Commitment> = {};
  for (let index = 0; index < 8; index += 1) {
    const completedAt = new Date(Date.parse('2026-10-23T15:30:00.000Z') - index * 86_400_000).toISOString();
    rows[String(index)] = saved(String(index), 'Run', completedAt, null, { category: 'health', completedAt, status: 'completed' });
  }
  const state = { commitments: rows, reminders: {}, escalations: {}, events: [], version: 0 } as unknown as DomainState;
  assert.deepEqual(usualHoursFor(state, TZ, 'health', new Date(NOW)), { startHour: 18, endHour: 21 });
  delete rows['7'];
  assert.equal(usualHoursFor(state, TZ, 'health', new Date(NOW)), null);
});

test('rankPostponeSlots prefers a usual time and returns no more than two candidates per day', () => {
  const row = saved('move', 'Run', '2026-10-24T12:00:00.000Z', '2026-10-24T12:30:00.000Z', { category: 'health' });
  const candidates = [
    { startsAt: '2026-10-25T05:00:00.000Z', endsAt: '2026-10-25T05:30:00.000Z' },
    { startsAt: '2026-10-25T16:00:00.000Z', endsAt: '2026-10-25T16:30:00.000Z' },
    { startsAt: '2026-10-25T17:30:00.000Z', endsAt: '2026-10-25T18:00:00.000Z' },
    { startsAt: '2026-10-26T05:00:00.000Z', endsAt: '2026-10-26T05:30:00.000Z' },
  ];
  const ranked = rankPostponeSlots(candidates, { commitment: row, schedule: schedule(), timezone: TZ, now: NOW, usualHours: { startHour: 18, endHour: 21 } });
  assert.equal(ranked[0]?.why, 'usual_time');
  assert.ok(ranked.filter((slot) => slot.startsAt.startsWith('2026-10-25')).length <= 2);
  assert.ok(ranked.length <= 3);
});

test('the explicit capture and goalPlan policies differ outside planner working windows', async () => {
  const storage = createMemoryStorage();
  const profile = buildRoutineProfile({
    timezone: TZ,
    sleepWindow: null,
    focusWindows: [{ start: '09:00', end: '12:00' }],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'softAwareness',
    quietHours: null,
    surveySkipped: false,
  }, NOW);
  await storage.set(userDoc(UID), { profile: { routine: profile } });
  const goalPlan = await findFreeSlots({ policy: 'goalPlan', uid: UID, timezone: TZ, now: NOW, dates: [DATE], durationMinutes: 30, storage });
  const capture = await findFreeSlots({ policy: 'capture', uid: UID, timezone: TZ, now: NOW, dates: [DATE], durationMinutes: 30,
    schedule: schedule({ routineProfile: profile }), limit: 100, storage });
  const local = (iso: string) => localTimeSpecFor(new Date(iso), TZ)?.time;
  assert.ok(goalPlan.length > 0);
  assert.ok(goalPlan.every((slot) => (local(slot.startsAt) ?? '') >= '09:00' && (local(slot.startsAt) ?? '') < '12:00'));
  assert.ok(capture.some((slot) => local(slot.startsAt) === '14:00'));
});

test('capture occupancy blocks commitments, busy time and caller-held slots', async () => {
  const storage = createMemoryStorage();
  const held = [{ startsAt: '2026-10-25T06:00:00.000Z', endsAt: '2026-10-25T08:00:00.000Z' }];
  const slots = await findFreeSlots({ policy: 'capture', uid: UID, timezone: TZ, now: NOW, dates: [DATE], durationMinutes: 30,
    schedule: schedule(), held, storage });
  assert.ok(slots.every((slot) => Date.parse(slot.startsAt) >= Date.parse(held[0]!.endsAt)));
});

test('Asia/Jerusalem fall-back week keeps local dates ordered and 30-minute real intervals', async () => {
  const storage = createMemoryStorage();
  const dates = ['2026-10-25', '2026-10-26', '2026-10-27'];
  const slots = await findFreeSlots({ policy: 'capture', uid: UID, timezone: TZ, now: NOW, dates, durationMinutes: 30,
    schedule: schedule(), limit: 12, minimumSeparationMinutes: 90, storage });
  assert.ok(slots.length > 0);
  for (const slot of slots) {
    assert.equal(Date.parse(slot.endsAt) - Date.parse(slot.startsAt), 30 * 60_000);
    assert.ok(dates.includes(localTimeSpecFor(new Date(slot.startsAt), TZ)!.date));
  }
  assert.deepEqual([...slots].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)), slots);
});

test('the capture finder reads calendar sources by relevant kind or id, not every manual source', async () => {
  const storage = createMemoryStorage();
  await storage.set(userDoc(UID), { timezone: TZ });
  const window = { startsAt: '2026-10-25T00:00:00.000Z', endsAt: '2026-10-26T00:00:00.000Z' };
  for (let index = 0; index < 60; index += 1) {
    await replaceBusyBlocks(UID, `manual:empty-${index}`, window, [], { storage, platform: null });
  }

  let sourceLists = 0;
  let sourceDocumentsRead = 0;
  const counted: StorageAdapter = {
    get: storage.get.bind(storage),
    list: async <T>(path: string, options?: ListOptions) => {
      const rows = await storage.list<T>(path, options);
      if (path === userCol(UID, CALENDAR_SOURCES)) {
        sourceLists += 1;
        sourceDocumentsRead += rows.length;
        assert.deepEqual(options?.where, [['kind', '==', 'device']]);
      }
      return rows;
    },
    listGroup: storage.listGroup.bind(storage),
    set: storage.set.bind(storage),
    delete: storage.delete.bind(storage),
    runTransaction: storage.runTransaction.bind(storage),
    deleteTree: storage.deleteTree.bind(storage),
  };

  await readFreeSlotSchedule(UID, window, counted);
  assert.equal(sourceLists, 1);
  assert.equal(sourceDocumentsRead, 0, '60 irrelevant manual source documents were read');
});
