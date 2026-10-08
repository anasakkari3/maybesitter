import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import type { ListOptions, StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { CALENDAR_SOURCES, userCol, userDoc } from '../../lib/storage/paths.ts';
import { replaceBusyBlocks } from '../../lib/calendar/busyBlocks.ts';
import { findFreeSlots, readFreeSlotSchedule, type FreeSlotSchedule } from '../../lib/planning/freeSlots.ts';
import { buildRoutineProfile } from '../../src/contracts/v1/routineContracts.ts';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';

const UID = 'free-slots-unit-user';
const TZ = 'Asia/Jerusalem';
const NOW = '2026-10-24T12:00:00.000Z';
const DATE = '2026-10-25';

function schedule(overrides: Partial<FreeSlotSchedule> = {}): FreeSlotSchedule {
  return { commitments: [], busyBlocks: [], weeklyBlocks: [], routineProfile: null, coverage: [], complete: true, ...overrides };
}

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
