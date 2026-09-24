/**
 * Manual busy time from syllabus lecture sessions (UC-3.7, #191 Step 7).
 *
 * Accepting a syllabus's recurring sessions writes them as a `manual-{proposalId}`
 * busy source via `replaceBusyBlocks` (UC-3.2, #186), expanded for 16 weeks.
 *
 * Invariants:
 *  - 'manual' is a recognized BusySourceKind.
 *  - Lecture times become busy blocks only after the user accepts, NEVER commitments.
 *  - Re-accepting replaces the source's blocks cleanly.
 *  - Deleting the manual source prunes all blocks and the CalendarSource record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { COMMITMENTS, userCol } from '../../lib/storage/paths.ts';
import {
  BUSY_SOURCE_KINDS,
  BusyUploadError,
  deleteBusySource,
  listBusyBlocks,
  readCalendarSource,
  sourceKindOf,
} from '../../lib/calendar/busyBlocks.ts';
import {
  acceptLectureSessionsAsBusyBlocks,
  expandLectureSessionsToBusyBlocks,
  manualBusySourceId,
} from '../../lib/calendar/manualBusy.ts';
import type { ShareRecurringSession } from '../../lib/services/share/shareTypes.ts';

const UID = 'user_syllabus_191';
const PROPOSAL_ID = 'prop-syllabus-001';
const TIMEZONE = 'Asia/Jerusalem';
const REFERENCE_TIME = '2026-09-01T09:00:00.000Z'; // Tuesday 12:00 in Asia/Jerusalem (UTC+3)

const SAMPLE_SESSIONS: readonly ShareRecurringSession[] = [
  { weekday: 2, start: '10:00', end: '12:00', label: 'Lecture' }, // Tuesday
  { weekday: 4, start: '14:00', end: '16:00', label: 'Lab' },     // Thursday
];

test('BUSY_SOURCE_KINDS includes manual', () => {
  assert.ok(BUSY_SOURCE_KINDS.includes('manual' as any), 'manual must be in BUSY_SOURCE_KINDS');
});

test('sourceKindOf accepts manual source ids', () => {
  assert.equal(sourceKindOf('manual-prop-123'), 'manual');
  assert.equal(sourceKindOf('manual:prop-123'), 'manual');
  assert.throws(() => sourceKindOf('manual-'), BusyUploadError);
  assert.throws(() => sourceKindOf('manual:'), BusyUploadError);
  assert.throws(() => sourceKindOf('other-123'), BusyUploadError);
});

test('manualBusySourceId produces expected format', () => {
  assert.equal(manualBusySourceId('abc-123'), 'manual-abc-123');
});

test('expandLectureSessionsToBusyBlocks expands sessions across 16 weeks', () => {
  const result = expandLectureSessionsToBusyBlocks(PROPOSAL_ID, SAMPLE_SESSIONS, {
    timezone: TIMEZONE,
    referenceTime: REFERENCE_TIME,
    weeks: 16,
  });

  // 2 sessions * 16 weeks = 32 blocks
  assert.equal(result.blocks.length, 32);
  assert.equal(result.sourceId, 'manual-prop-syllabus-001');

  for (const block of result.blocks) {
    assert.equal(block.sourceId, 'manual-prop-syllabus-001');
    assert.equal(block.sourceKind, 'manual');
    assert.equal(block.allDay, false);
    assert.ok(Date.parse(block.startAt) < Date.parse(block.endAt));
    // Must fall within the declared window
    assert.ok(Date.parse(block.startAt) >= Date.parse(result.window.startsAt));
    assert.ok(Date.parse(block.endAt) <= Date.parse(result.window.endsAt));
  }

  // All block IDs must be unique
  const ids = new Set(result.blocks.map((b) => b.blockId));
  assert.equal(ids.size, 32);
});

test('acceptLectureSessionsAsBusyBlocks stores busy blocks and never commitments', async () => {
  const storage = createMemoryStorage();

  const outcome = await acceptLectureSessionsAsBusyBlocks(UID, PROPOSAL_ID, SAMPLE_SESSIONS, {
    timezone: TIMEZONE,
    referenceTime: REFERENCE_TIME,
    weeks: 16,
    storage,
    now: new Date(REFERENCE_TIME),
  });

  assert.equal(outcome.written, 32);
  assert.equal(outcome.removed, 0);

  // Stored source record
  const source = await readCalendarSource(UID, outcome.sourceId, { storage });
  assert.ok(source);
  assert.equal(source.kind, 'manual');
  assert.equal(source.sourceId, 'manual-prop-syllabus-001');

  // Stored busy blocks can be queried
  const blocks = await listBusyBlocks(UID, outcome.window, { storage });
  assert.equal(blocks.length, 32);

  // CRITICAL INVARIANT: Commitments collection must remain completely empty!
  const commitments = await storage.list(userCol(UID, COMMITMENTS));
  assert.equal(commitments.length, 0, 'lecture sessions must become busy blocks, NEVER commitments');
});

test('accepting updated lecture sessions replaces prior blocks cleanly', async () => {
  const storage = createMemoryStorage();

  // First accept: 2 sessions = 32 blocks
  await acceptLectureSessionsAsBusyBlocks(UID, PROPOSAL_ID, SAMPLE_SESSIONS, {
    timezone: TIMEZONE,
    referenceTime: REFERENCE_TIME,
    weeks: 16,
    storage,
    now: new Date(REFERENCE_TIME),
  });

  // Second accept with only 1 session = 16 blocks
  const oneSession: readonly ShareRecurringSession[] = [
    { weekday: 2, start: '10:00', end: '12:00', label: 'Lecture' },
  ];

  const updateOutcome = await acceptLectureSessionsAsBusyBlocks(UID, PROPOSAL_ID, oneSession, {
    timezone: TIMEZONE,
    referenceTime: REFERENCE_TIME,
    weeks: 16,
    storage,
    now: new Date(REFERENCE_TIME),
  });

  assert.equal(updateOutcome.written, 16);
  assert.equal(updateOutcome.removed, 16); // The 16 Thursday lab blocks were removed

  const blocks = await listBusyBlocks(UID, updateOutcome.window, { storage });
  assert.equal(blocks.length, 16);
});

test('deleteBusySource deletes all manual lecture blocks and calendar source', async () => {
  const storage = createMemoryStorage();

  const outcome = await acceptLectureSessionsAsBusyBlocks(UID, PROPOSAL_ID, SAMPLE_SESSIONS, {
    timezone: TIMEZONE,
    referenceTime: REFERENCE_TIME,
    weeks: 16,
    storage,
    now: new Date(REFERENCE_TIME),
  });

  const deleted = await deleteBusySource(UID, outcome.sourceId, { storage });
  assert.equal(deleted.deleted, 32);

  const sourceAfter = await readCalendarSource(UID, outcome.sourceId, { storage });
  assert.equal(sourceAfter, null);

  const blocksAfter = await listBusyBlocks(UID, outcome.window, { storage });
  assert.equal(blocksAfter.length, 0);
});
