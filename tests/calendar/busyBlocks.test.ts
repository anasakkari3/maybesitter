/**
 * Busy time from somebody's own calendar, on the server (UC-3.2, #186).
 *
 * Three claims are load-bearing here, and each of them is a thing that has
 * gone wrong in a shipped product rather than a unit somebody wanted covered.
 *
 * **Nothing but four fields is stored.** `expo-calendar` hands event *titles*
 * to the app's memory — the Flutter bridge it replaced never did — so the only
 * thing standing between "your 14:00 is busy" and "your 14:00 is Oncology,
 * Dr Haddad" is that the mapper drops the title and this route refuses a body
 * that carries one. `parseBusyUpload` is therefore an allowlist that *rejects*
 * rather than a parser that ignores: a body with a `title` is an incident, and
 * a route that silently dropped it would be one that stopped noticing.
 *
 * **A re-upload replaces.** The phone re-sends its window on connect, on
 * refresh and every fifteen minutes. If a sync appended instead of replacing,
 * a week of syncs would leave a week of copies and the planner would refuse to
 * place anything. The case that actually catches it is the one where every
 * event *moved*: a deterministic `blockId` means an unchanged event overwrites
 * itself and a broken replace still looks like it worked.
 *
 * **All-day events do not block.** A birthday is not eight hours of unavailable
 * time, and treating it as one wipes out the day. They are stored, and they are
 * shown as conflict hints, and `toFixedEvents` leaves them out by default.
 *
 * ── No wall-clock literals ───────────────────────────────────────
 *
 * Every instant below is derived from the clock this test is running on. A
 * fixture pinned to a date in 2026 is a fixture that is fine until the day the
 * suite runs in a zone, or a year, somebody did not think about.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { userCol, userSubDoc, docIdForKey } from '../../lib/storage/paths.ts';
import {
  BUSY_BLOCKS,
  CALENDAR_SOURCES,
  BUSY_BLOCK_UPLOAD_LIMIT,
  BusyUploadError,
  busyBlockId,
  deleteBusySource,
  listBusyBlocks,
  listCalendarSources,
  parseBusyUpload,
  readCalendarSource,
  replaceBusyBlocks,
  toFixedEvents,
  type BusyBlock,
} from '../../lib/calendar/busyBlocks.ts';

const UID = 'user_busy_1';
const OTHER = 'user_busy_2';
const SOURCE = 'device:6f1d1a2e-2c5f-4a7b-9f0e-3b2d4c5e6f70';
const OTHER_SOURCE = 'device:0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

/** Today at midnight UTC, as an anchor nothing in this file hard-codes. */
const ANCHOR = (() => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
})();

/** `at(90)` — ninety minutes after the anchor, as an Instant. */
function at(minutes: number): string {
  return new Date(ANCHOR + minutes * 60_000).toISOString();
}

function window(fromMinutes: number, toMinutes: number) {
  return { startsAt: at(fromMinutes), endsAt: at(toMinutes) };
}

function block(id: string, fromMinutes: number, toMinutes: number, allDay = false): BusyBlock {
  return {
    blockId: docIdForKey(`${SOURCE}|${id}|${at(fromMinutes)}`),
    sourceId: SOURCE,
    sourceKind: 'device',
    startAt: at(fromMinutes),
    endAt: at(toMinutes),
    allDay,
  };
}

function blocksPath(uid: string): string {
  return userCol(uid, BUSY_BLOCKS);
}

async function countBlocks(storage: ReturnType<typeof createMemoryStorage>, uid: string): Promise<number> {
  return (await storage.list(blocksPath(uid))).length;
}

/* ── The allowlist: what a phone is allowed to say ───────────────── */

test('a block carrying an event title is refused, not quietly trimmed', () => {
  assert.throws(
    () => parseBusyUpload({
      sourceId: SOURCE,
      platform: 'ios',
      windowStart: at(0),
      windowEnd: at(60 * 24 * 28),
      blocks: [{ blockId: 'a'.repeat(64), startAt: at(600), endAt: at(660), allDay: false, title: 'Oncology' }],
    }),
    (error: unknown) => error instanceof BusyUploadError && /title/.test(error.message),
  );
});

test('notes, location and attendees are refused by the same rule', () => {
  for (const extra of ['notes', 'location', 'attendees', 'organizer', 'nativeId']) {
    assert.throws(
      () => parseBusyUpload({
        sourceId: SOURCE,
        platform: 'android',
        windowStart: at(0),
        windowEnd: at(60),
        blocks: [{ blockId: 'b'.repeat(64), startAt: at(10), endAt: at(20), allDay: false, [extra]: 'x' }],
      }),
      (error: unknown) => error instanceof BusyUploadError && error.message.includes(extra),
      `a block carrying ${extra} was accepted`,
    );
  }
});

test('an extra key on the envelope is refused too', () => {
  assert.throws(
    () => parseBusyUpload({
      sourceId: SOURCE,
      platform: 'ios',
      windowStart: at(0),
      windowEnd: at(60),
      blocks: [],
      calendarTitles: ['Work'],
    }),
    (error: unknown) => error instanceof BusyUploadError && /calendarTitles/.test(error.message),
  );
});

test('a well-formed body parses into exactly the four block fields', () => {
  const parsed = parseBusyUpload({
    sourceId: SOURCE,
    platform: 'ios',
    windowStart: at(0),
    windowEnd: at(60 * 24),
    blocks: [{ blockId: 'c'.repeat(64), startAt: at(600), endAt: at(660), allDay: false }],
  });
  assert.equal(parsed.sourceKind, 'device');
  assert.deepEqual(Object.keys(parsed.blocks[0]!).sort(), ['allDay', 'blockId', 'endAt', 'startAt']);
});

test('a source id with no known prefix is refused, so #187 and #188 cannot arrive by accident', () => {
  assert.throws(
    () => parseBusyUpload({
      sourceId: 'exchange:abc',
      platform: 'ios',
      windowStart: at(0),
      windowEnd: at(60),
      blocks: [],
    }),
    (error: unknown) => error instanceof BusyUploadError,
  );
});

test('more blocks than the limit is refused rather than truncated', () => {
  const blocks = Array.from({ length: BUSY_BLOCK_UPLOAD_LIMIT + 1 }, (_, index) => ({
    blockId: docIdForKey(`over-${index}`),
    startAt: at(index),
    endAt: at(index + 1),
    allDay: false,
  }));
  assert.throws(
    () => parseBusyUpload({ sourceId: SOURCE, platform: 'ios', windowStart: at(0), windowEnd: at(60 * 24 * 28), blocks }),
    (error: unknown) => error instanceof BusyUploadError && /1000/.test(error.message),
  );
});

test('a block that ends before it starts is refused', () => {
  assert.throws(
    () => parseBusyUpload({
      sourceId: SOURCE,
      platform: 'ios',
      windowStart: at(0),
      windowEnd: at(60),
      blocks: [{ blockId: 'd'.repeat(64), startAt: at(30), endAt: at(10), allDay: false }],
    }),
    (error: unknown) => error instanceof BusyUploadError,
  );
});

/* ── Replace, not accumulate ─────────────────────────────────────── */

test('uploading the same window twice leaves the same number of blocks', async () => {
  const storage = createMemoryStorage();
  const span = window(0, 60 * 24);
  const first = [block('a', 600, 660), block('b', 700, 760)];
  await replaceBusyBlocks(UID, SOURCE, span, first, { storage });
  assert.equal(await countBlocks(storage, UID), 2);
  await replaceBusyBlocks(UID, SOURCE, span, first, { storage });
  assert.equal(await countBlocks(storage, UID), 2);
});

/**
 * The case a deterministic block id hides.
 *
 * `blockId` is the hash of the source, the native id and the *start*, so an
 * unchanged event overwrites its own row and an append-only bug still looks
 * like a replace. Here every event has moved, so every id is new — and a
 * replace that does not delete leaves four rows where there should be two.
 */
test('uploading a window where every event moved still leaves only the new blocks', async () => {
  const storage = createMemoryStorage();
  const span = window(0, 60 * 24);
  await replaceBusyBlocks(UID, SOURCE, span, [block('a', 600, 660), block('b', 700, 760)], { storage });
  await replaceBusyBlocks(UID, SOURCE, span, [block('a', 615, 675), block('b', 715, 775)], { storage });
  assert.equal(await countBlocks(storage, UID), 2);
  const stored = await listBusyBlocks(UID, span, { storage });
  assert.deepEqual(stored.map((row) => row.startAt), [at(615), at(715)]);
});

test('a replace does not touch another source inside the same window', async () => {
  const storage = createMemoryStorage();
  const span = window(0, 60 * 24);
  const theirs: BusyBlock = { ...block('x', 600, 660), blockId: docIdForKey('theirs'), sourceId: OTHER_SOURCE };
  await replaceBusyBlocks(UID, OTHER_SOURCE, span, [theirs], { storage });
  await replaceBusyBlocks(UID, SOURCE, span, [block('a', 600, 660)], { storage });
  assert.equal(await countBlocks(storage, UID), 2);
  await replaceBusyBlocks(UID, SOURCE, span, [], { storage });
  const left = await listBusyBlocks(UID, span, { storage });
  assert.deepEqual(left.map((row) => row.sourceId), [OTHER_SOURCE]);
});

/**
 * Flipped deliberately after adversarial review of #418.
 *
 * This test used to be called "a replace does not touch the same source outside
 * the window" and asserted `2` here. It was encoding the defect: the device's
 * window moves a day every night, so a row outside the new window is a row the
 * window has already left behind, and keeping it is how a month of daily syncs
 * became twenty-eight rows with twenty-seven of them dead. An upload is a
 * source's whole state; `busyBlockBounds.test.ts` holds the rest of that rule.
 */
test('a replace removes the same source\'s rows even outside the new window', async () => {
  const storage = createMemoryStorage();
  await replaceBusyBlocks(UID, SOURCE, window(0, 60 * 24), [block('a', 600, 660)], { storage });
  await replaceBusyBlocks(UID, SOURCE, window(60 * 24, 60 * 48), [block('b', 60 * 25, 60 * 26)], { storage });
  assert.equal(await countBlocks(storage, UID), 1);
});

test('a block that straddles the start of the window is replaced, not left behind', async () => {
  const storage = createMemoryStorage();
  const span = window(60 * 24, 60 * 48);
  await replaceBusyBlocks(UID, SOURCE, span, [block('overnight', 60 * 23, 60 * 25)], { storage });
  await replaceBusyBlocks(UID, SOURCE, span, [block('overnight', 60 * 23 + 30, 60 * 25)], { storage });
  assert.equal(await countBlocks(storage, UID), 1);
});

test('one account\'s upload never reaches another account', async () => {
  const storage = createMemoryStorage();
  const span = window(0, 60 * 24);
  await replaceBusyBlocks(OTHER, SOURCE, span, [block('a', 600, 660)], { storage });
  await replaceBusyBlocks(UID, SOURCE, span, [], { storage });
  assert.equal(await countBlocks(storage, OTHER), 1);
});

test('the stored row holds no key beyond the six the contract names', async () => {
  const storage = createMemoryStorage();
  const span = window(0, 60 * 24);
  const one = block('a', 600, 660);
  await replaceBusyBlocks(UID, SOURCE, span, [{ ...one, title: 'Oncology' } as BusyBlock], { storage });
  const rows = await storage.list<Record<string, unknown>>(blocksPath(UID));
  assert.equal(rows.length, 1);
  assert.deepEqual(
    Object.keys(rows[0]!.data).sort(),
    ['allDay', 'blockId', 'endAt', 'sourceId', 'sourceKind', 'startAt'],
  );
});

/* ── The id, which the phone computes too ────────────────────────── */

/**
 * The vector `mobile/src/features/calendar/__tests__/busySync.test.ts` pins.
 *
 * The phone and the server compute `blockId` independently — they are two
 * runtimes and cannot share a function — and if they ever disagree, every sync
 * writes a second row for every event and nothing else notices until somebody's
 * account has a month of duplicates in it. One hard-coded digest on each side is
 * the cheapest thing that fails the day either preimage changes.
 */
test('the block id is the digest the phone computes for the same three strings', () => {
  assert.equal(
    busyBlockId('device:11111111-2222-4333-8444-555555555555', 'evt-1', '2026-09-16T11:00:00.000Z'),
    'b28be7bd48db3877fcbb73e97de365fe3fe312b927d2c5ec876193366974f36c',
  );
});

test('the id changes when the event moves, and not otherwise', () => {
  const same = () => busyBlockId('device:a', 'evt-1', at(600));
  assert.equal(same(), same());
  assert.notEqual(same(), busyBlockId('device:a', 'evt-1', at(615)));
  assert.notEqual(same(), busyBlockId('device:b', 'evt-1', at(600)));
  assert.notEqual(same(), busyBlockId('device:a', 'evt-2', at(600)));
});

/* ── The source document ─────────────────────────────────────────── */

test('a sync records the source, its platform and the window it covered', async () => {
  const storage = createMemoryStorage();
  const span = window(0, 60 * 24 * 28);
  const syncedAt = new Date(ANCHOR + 90 * 60_000);
  await replaceBusyBlocks(UID, SOURCE, span, [block('a', 600, 660)], { storage, platform: 'ios', now: syncedAt });
  const source = await readCalendarSource(UID, SOURCE, { storage });
  assert.deepEqual(source, {
    sourceId: SOURCE,
    kind: 'device',
    platform: 'ios',
    lastSyncedAt: syncedAt.toISOString(),
    windowStart: span.startsAt,
    windowEnd: span.endsAt,
  });
  assert.deepEqual((await listCalendarSources(UID, { storage })).map((row) => row.sourceId), [SOURCE]);
});

test('the source document lives under a hashed id, because a source id is free text', async () => {
  const storage = createMemoryStorage();
  await replaceBusyBlocks(UID, SOURCE, window(0, 60), [], { storage });
  const path = userSubDoc(UID, CALENDAR_SOURCES, docIdForKey(SOURCE));
  assert.notEqual(await storage.get(path), null);
});

/* ── Reading a window ────────────────────────────────────────────── */

test('listing a window returns the blocks that overlap it, in time order', async () => {
  const storage = createMemoryStorage();
  await replaceBusyBlocks(UID, SOURCE, window(0, 60 * 48), [
    block('late', 700, 760),
    block('early', 600, 660),
    block('before', 100, 200),
    block('after', 60 * 30, 60 * 31),
  ], { storage });
  const found = await listBusyBlocks(UID, window(600, 760), { storage });
  assert.deepEqual(found.map((row) => row.startAt), [at(600), at(700)]);
});

test('a block that merely touches the window edge is not in it', async () => {
  const storage = createMemoryStorage();
  await replaceBusyBlocks(UID, SOURCE, window(0, 60 * 48), [
    block('ends-at-start', 540, 600),
    block('starts-at-end', 760, 800),
  ], { storage });
  assert.deepEqual(await listBusyBlocks(UID, window(600, 760), { storage }), []);
});

test('a block that straddles the whole window is in it', async () => {
  const storage = createMemoryStorage();
  await replaceBusyBlocks(UID, SOURCE, window(0, 60 * 48), [block('all-morning', 500, 900)], { storage });
  assert.equal((await listBusyBlocks(UID, window(600, 760), { storage })).length, 1);
});

/* ── Into the planner ────────────────────────────────────────────── */

test('a busy block becomes a blocking fixed event that belongs to no commitment', () => {
  const [event] = toFixedEvents([block('a', 600, 660)], { includeAllDay: false });
  assert.equal(event!.eventId, block('a', 600, 660).blockId);
  assert.equal(event!.blocking, true);
  assert.equal(event!.sourceCommitmentId, null);
  assert.deepEqual(event!.interval, { startsAt: at(600), endsAt: at(660) });
});

test('an all-day event does not block the day', () => {
  const day = block('holiday', 0, 60 * 24, true);
  assert.deepEqual(toFixedEvents([day], { includeAllDay: false }), []);
  assert.equal(toFixedEvents([day], { includeAllDay: true }).length, 1);
});

test('a timed event is never dropped by the all-day rule', () => {
  assert.equal(toFixedEvents([block('a', 600, 660)], { includeAllDay: false }).length, 1);
});

/* ── Disconnect and delete ───────────────────────────────────────── */

test('deleting a source removes its blocks and its record, and nothing else', async () => {
  const storage = createMemoryStorage();
  const span = window(0, 60 * 24);
  await replaceBusyBlocks(UID, SOURCE, span, [block('a', 600, 660), block('b', 700, 760)], { storage });
  await replaceBusyBlocks(UID, OTHER_SOURCE, span, [
    { ...block('x', 600, 660), blockId: docIdForKey('theirs'), sourceId: OTHER_SOURCE },
  ], { storage });

  const result = await deleteBusySource(UID, SOURCE, { storage });
  assert.equal(result.deleted, 2);
  assert.equal(await readCalendarSource(UID, SOURCE, { storage }), null);
  assert.deepEqual(
    (await listBusyBlocks(UID, span, { storage })).map((row) => row.sourceId),
    [OTHER_SOURCE],
  );
  assert.notEqual(await readCalendarSource(UID, OTHER_SOURCE, { storage }), null);
});

test('deleting a source that was never connected is not an error', async () => {
  const storage = createMemoryStorage();
  assert.deepEqual(await deleteBusySource(UID, SOURCE, { storage }), { deleted: 0 });
});
