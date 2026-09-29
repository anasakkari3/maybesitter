/**
 * A weekly fixed block becomes busy time, and stays busy time every week until
 * the person changes it («ثابت أسبوعي», owner request 2026-09-29).
 *
 * What is claimed, each against real storage and the real busy-block writer:
 *
 *   - create materializes the next eight weeks of occurrences under the source
 *     `weekly-{id}`, at the local clock in the block's own zone, title-free;
 *   - pause removes every occurrence that has not ended and nothing that has;
 *   - an edit re-expands the future and leaves the past exactly as it was;
 *   - delete removes the block and every occurrence, past ones included;
 *   - the nightly renewal extends the horizon of due blocks only, and prunes
 *     history older than four weeks;
 *   - the occurrences read joins the title back, for the phone's calendar.
 *
 * The clock is fixed: Tuesday 2026-09-29 12:00 in Jerusalem (UTC+3 until
 * 2026-10-25, which the eight-week horizon crosses — the DST case).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userSubDoc, WEEKLY_BLOCKS } from '../../lib/storage/paths.ts';
import {
  BusyUploadError,
  listBusyBlocksOfSource,
  parseBusyUpload,
  sourceKindOf,
  type BusyBlock,
} from '../../lib/calendar/busyBlocks.ts';
import {
  createWeeklyBlock,
  deleteWeeklyBlock,
  listWeeklyBlockOccurrences,
  listWeeklyBlocks,
  patchWeeklyBlock,
  presentWeeklyBlock,
  runWeeklyBlockRenewal,
  weeklyBlockCovering,
  weeklyBusySourceId,
} from '../../lib/weeklyBlocks/weeklyBlockService.ts';
import type { WeeklyBlockDocument, WeeklyBlockInput } from '../../src/contracts/v1/weeklyBlockContracts.ts';

const UID = 'user_weekly_blocks_1';
const TZ = 'Asia/Jerusalem';
const DAY = 86_400_000;
const T0 = new Date('2026-09-29T09:00:00.000Z');
const SATURDAY_TRAINING: WeeklyBlockInput = {
  title: 'تدريب',
  weekdays: [6],
  start: '10:00',
  end: '16:00',
  timezone: TZ,
  confirmedAt: '2026-09-29T08:59:00.000Z',
};

let storage: MemoryStorageAdapter;
function fresh(): MemoryStorageAdapter {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  return storage;
}
test.afterEach(() => resetStorageForTests());

function jerusalem(instant: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).format(new Date(instant));
}

async function occurrencesOf(id: string): Promise<BusyBlock[]> {
  return listBusyBlocksOfSource(UID, weeklyBusySourceId(id), { storage });
}

test('the weekly source is its own busy kind, and a phone upload cannot claim it', () => {
  assert.equal(sourceKindOf('weekly-0f8e6a4c-0000-4000-8000-000000000001'), 'weekly');
  assert.throws(() => sourceKindOf('weekly-'), BusyUploadError);
  assert.throws(
    () => parseBusyUpload({
      sourceId: 'weekly-0f8e6a4c-0000-4000-8000-000000000001',
      windowStart: '2026-09-29T00:00:00.000Z',
      windowEnd: '2026-10-29T00:00:00.000Z',
      blocks: [],
    }),
    (error: unknown) => error instanceof BusyUploadError && /server/.test((error as Error).message),
  );
});

test('create: eight Saturdays 10:00–16:00 on the Jerusalem clock, across the DST change, title-free', async () => {
  fresh();
  const { block } = await createWeeklyBlock(UID, SATURDAY_TRAINING, { storage, now: T0 });
  assert.equal(block.status, 'active');
  assert.equal(block.source, 'manual');
  assert.equal(block.confirmedAt, SATURDAY_TRAINING.confirmedAt);
  assert.equal(block.startsOn, '2026-10-03');
  assert.equal(block.renewAt, new Date(T0.getTime() + 7 * DAY).toISOString());
  assert.deepEqual(await storage.get(userSubDoc(UID, WEEKLY_BLOCKS, block.id)), block);

  const occurrences = await occurrencesOf(block.id);
  assert.equal(occurrences.length, 8);
  assert.deepEqual(occurrences.map((o) => `${jerusalem(o.startAt)}–${jerusalem(o.endAt).slice(-5)}`), [
    'Sat, 2026-10-03, 10:00–16:00', 'Sat, 2026-10-10, 10:00–16:00', 'Sat, 2026-10-17, 10:00–16:00',
    'Sat, 2026-10-24, 10:00–16:00', 'Sat, 2026-10-31, 10:00–16:00', 'Sat, 2026-11-07, 10:00–16:00',
    'Sat, 2026-11-14, 10:00–16:00', 'Sat, 2026-11-21, 10:00–16:00',
  ]);
  // Before and after 2026-10-25 the offset differs; the local clock does not.
  assert.equal(occurrences[0]!.startAt, '2026-10-03T07:00:00.000Z');
  assert.equal(occurrences[4]!.startAt, '2026-10-31T08:00:00.000Z');
  for (const occurrence of occurrences) {
    assert.deepEqual(Object.keys(occurrence).sort(), ['allDay', 'blockId', 'endAt', 'sourceId', 'sourceKind', 'startAt']);
    assert.equal(occurrence.sourceKind, 'weekly');
    assert.equal(occurrence.allDay, false);
  }
});

test('create on the Saturday itself, mid-session: today\'s occurrence still blocks what is left of it', async () => {
  fresh();
  const saturdayNoon = new Date('2026-10-03T09:00:00.000Z');
  const { block } = await createWeeklyBlock(UID, SATURDAY_TRAINING, { storage, now: saturdayNoon });
  const [first] = await occurrencesOf(block.id);
  assert.equal(first!.startAt, '2026-10-03T07:00:00.000Z');
  assert.equal(block.startsOn, '2026-10-03');
});

test('pause removes every occurrence that has not ended, and keeps the past exactly as it was', async () => {
  fresh();
  const { block } = await createWeeklyBlock(UID, SATURDAY_TRAINING, { storage, now: T0 });
  const before = await occurrencesOf(block.id);
  const later = new Date(T0.getTime() + 15 * DAY); // Wed 2026-10-14: two Saturdays have passed
  const paused = await patchWeeklyBlock(UID, block.id, { status: 'paused' }, { storage, now: later });
  assert.equal(paused?.status, 'paused');
  assert.equal(paused && 'renewAt' in paused, false, 'a paused block leaves the renewal sweep: no renewAt field at all');
  const after = await occurrencesOf(block.id);
  assert.deepEqual(after, before.filter((o) => Date.parse(o.endAt) <= later.getTime()));
  assert.equal(after.length, 2);
  assert.equal(presentWeeklyBlock(paused!).deviceEvent, null);

  const resumed = await patchWeeklyBlock(UID, block.id, { status: 'active' }, { storage, now: later });
  assert.equal(resumed?.startsOn, '2026-10-17');
  const again = await occurrencesOf(block.id);
  assert.equal(again.filter((o) => Date.parse(o.startAt) > later.getTime()).length, 8);
  assert.deepEqual(again.slice(0, 2), after, 'resuming does not touch the past either');
});

test('an edit re-expands the future and never rewrites a past occurrence', async () => {
  fresh();
  const { block } = await createWeeklyBlock(UID, SATURDAY_TRAINING, { storage, now: T0 });
  const later = new Date(T0.getTime() + 15 * DAY);
  const past = (await occurrencesOf(block.id)).filter((o) => Date.parse(o.endAt) <= later.getTime());
  const edited = await patchWeeklyBlock(UID, block.id, { start: '09:00', weekdays: [5, 6] }, { storage, now: later });
  assert.deepEqual(edited?.weekdays, [5, 6]);
  assert.equal(edited?.startsOn, '2026-10-16');
  const all = await occurrencesOf(block.id);
  assert.deepEqual(all.slice(0, 2), past);
  const future = all.filter((o) => Date.parse(o.endAt) > later.getTime());
  assert.equal(future.length, 16);
  assert.ok(future.every((o) => /(Fri|Sat), .*, 09:00/.test(jerusalem(o.startAt))), 'every future occurrence starts 09:00 on Fri or Sat');
});

test('a patch that would put the start after the end is refused and changes nothing', async () => {
  fresh();
  const { block } = await createWeeklyBlock(UID, SATURDAY_TRAINING, { storage, now: T0 });
  const occurrences = await occurrencesOf(block.id);
  await assert.rejects(() => patchWeeklyBlock(UID, block.id, { start: '17:00' }, { storage, now: T0 }), /overnight/);
  assert.deepEqual(await occurrencesOf(block.id), occurrences);
  assert.equal((await listWeeklyBlocks(UID, { storage }))[0]!.start, '10:00');
});

test('delete removes the block and every occurrence, past ones included', async () => {
  fresh();
  const { block } = await createWeeklyBlock(UID, SATURDAY_TRAINING, { storage, now: T0 });
  const later = new Date(T0.getTime() + 15 * DAY);
  assert.equal(await deleteWeeklyBlock(UID, block.id, { storage, now: later }), true);
  assert.deepEqual(await occurrencesOf(block.id), []);
  assert.equal(await storage.get(userSubDoc(UID, WEEKLY_BLOCKS, block.id)), null);
  assert.equal(await deleteWeeklyBlock(UID, block.id, { storage, now: later }), false);
  assert.equal(await patchWeeklyBlock(UID, block.id, { status: 'paused' }, { storage, now: later }), null);
});

test('the renewal sweep extends only the blocks that are due, and prunes history older than four weeks', async () => {
  fresh();
  const { block: due } = await createWeeklyBlock(UID, SATURDAY_TRAINING, { storage, now: T0 });
  const { block: paused } = await createWeeklyBlock(UID, { ...SATURDAY_TRAINING, title: 'دوام', weekdays: [0] }, { storage, now: T0 });
  await patchWeeklyBlock(UID, paused.id, { status: 'paused' }, { storage, now: T0 });

  // Six days on: nothing is due yet.
  const early = await runWeeklyBlockRenewal({ storage, now: new Date(T0.getTime() + 6 * DAY) });
  assert.deepEqual(early, { due: 0, renewed: 0, failed: 0 });

  // Forty-three days on (Wed 2026-11-11): due. Five Saturdays have passed; the
  // first one ended more than 28 days ago and goes.
  const later = new Date(T0.getTime() + 43 * DAY);
  const totals = await runWeeklyBlockRenewal({ storage, now: later });
  assert.deepEqual(totals, { due: 1, renewed: 1, failed: 0 });
  const occurrences = await occurrencesOf(due.id);
  const past = occurrences.filter((o) => Date.parse(o.endAt) <= later.getTime());
  assert.deepEqual(past.map((o) => jerusalem(o.startAt).slice(5, 15)), ['2026-10-17', '2026-10-24', '2026-10-31', '2026-11-07']);
  assert.equal(occurrences.length - past.length, 8, 'the horizon is eight weeks ahead again');
  assert.equal(jerusalem(occurrences.at(-1)!.startAt).slice(5, 15), '2027-01-02');
  const renewed = await storage.get<WeeklyBlockDocument>(userSubDoc(UID, WEEKLY_BLOCKS, due.id));
  assert.equal(renewed?.renewAt, new Date(later.getTime() + 7 * DAY).toISOString());
  assert.deepEqual(await occurrencesOf(paused.id), [], 'a paused block is not renewed');
});

test('the occurrences read joins the title back, in the window asked for', async () => {
  fresh();
  const { block } = await createWeeklyBlock(UID, SATURDAY_TRAINING, { storage, now: T0 });
  const occurrences = await listWeeklyBlockOccurrences(UID, {
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2026-10-15T00:00:00.000Z',
  }, { storage });
  assert.deepEqual(occurrences.map((o) => [o.weeklyBlockId, o.title, o.startAt, o.endAt]), [
    [block.id, 'تدريب', '2026-10-03T07:00:00.000Z', '2026-10-03T13:00:00.000Z'],
    [block.id, 'تدريب', '2026-10-10T07:00:00.000Z', '2026-10-10T13:00:00.000Z'],
  ]);
  assert.match(occurrences[0]!.occurrenceId, /^[0-9a-f]{64}$/);
});

test('covering: inside an active Saturday session, and nowhere else', async () => {
  fresh();
  const { block } = await createWeeklyBlock(UID, SATURDAY_TRAINING, { storage, now: T0 });
  const inside = await weeklyBlockCovering(UID, new Date('2026-10-03T09:00:00.000Z'), { storage });
  assert.equal(inside?.block.id, block.id);
  assert.equal(inside?.occurrence.endAt, '2026-10-03T13:00:00.000Z');
  assert.equal(await weeklyBlockCovering(UID, new Date('2026-10-03T13:00:00.000Z'), { storage }), null, 'the end is exclusive');
  assert.equal(await weeklyBlockCovering(UID, new Date('2026-10-02T09:00:00.000Z'), { storage }), null);
});

test('the device event carries what one recurring calendar event needs', async () => {
  fresh();
  const { block } = await createWeeklyBlock(UID, SATURDAY_TRAINING, { storage, now: T0 });
  assert.deepEqual(presentWeeklyBlock(block).deviceEvent, {
    title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00', timezone: TZ, startsOn: '2026-10-03',
  });
  assert.equal('renewAt' in presentWeeklyBlock(block), false, 'renewAt is operational and stays on the server');
});
