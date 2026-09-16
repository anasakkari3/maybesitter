/**
 * What stops the busy-block store growing for ever (UC-3.2, #186).
 *
 * Adversarial review of #418 found the original `replaceBusyBlocks` sound for
 * one window and unbounded across many. The device's window is today's local
 * midnight to +28 days, so it *moves* every night, and the delete half only
 * ever considered rows overlapping the window being written. A row left behind
 * when the date rolled over could never be a deletion candidate again: one
 * evening event a day left twenty-seven dead rows after twenty-eight days, and
 * nothing but "Disconnect and delete" would ever clear them.
 *
 * That compounds rather than merely wasting space. `listBusyBlocks` reads the
 * whole collection and filters in memory — a design whose only justification is
 * a hard cap per source — and it runs on every daily-plan composition. So the
 * cost of building somebody's morning grew with how long they had had the
 * feature switched on.
 *
 * ── The answer, and why it is one answer and not three patches ───
 *
 * An upload is a source saying *this is my whole state*, not *these are my new
 * facts*. There is exactly one window per source at any moment (the phone
 * always sends today→+28d), so a row of that source which is not in the upload
 * is stale whatever its dates. Deleting on that rule instead of on overlap
 * makes three separate problems go away at once:
 *
 *   nothing survives a window that moved (the growth above);
 *   the per-source total is bounded by the upload cap, because after a sync a
 *     source holds exactly what it just sent — which is the premise the
 *     read-everything-filter-in-memory design rests on;
 *   a block dated 2099, which no honest future window would ever overlap, is
 *     prunable like anything else.
 *
 * The declared window is still validated and still recorded: a block must
 * overlap it, and it may not be longer than `MAX_BUSY_WINDOW_DAYS`. Without
 * both, "blocks must be inside the window" is satisfied by declaring a window
 * of a thousand years.
 *
 * ── And the id is namespaced by source ───────────────────────────
 *
 * `blockId` is the document key and is chosen entirely by the client; the
 * server cannot re-derive it, because the preimage contains the calendar's own
 * event id, which by design never leaves the phone. So a second source
 * presenting a colliding id used to overwrite the first source's row and re-file
 * it under its own name — after which the first phone's "Disconnect and delete"
 * returned `{deleted: 0}` and left the row behind. The path now hashes the
 * source in with the id, so the collision cannot be expressed rather than being
 * detected after the fact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { userCol } from '../../lib/storage/paths.ts';
import {
  BUSY_BLOCKS,
  BUSY_BLOCK_UPLOAD_LIMIT,
  MAX_BUSY_WINDOW_DAYS,
  BusyUploadError,
  busyBlockId,
  deleteBusySource,
  listBusyBlocks,
  parseBusyUpload,
  replaceBusyBlocks,
  type BusyBlock,
} from '../../lib/calendar/busyBlocks.ts';

const UID = 'user_bounds_1';
const SOURCE = 'device:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_SOURCE = 'device:11111111-2222-4333-8444-555555555555';
const DAY = 24 * 60 * 60_000;

/** Midnight UTC today. Nothing here is a wall-clock literal. */
const ANCHOR = (() => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
})();

function at(minutes: number): string {
  return new Date(ANCHOR + minutes * 60_000).toISOString();
}

/** The window the phone sends on day `n`: that day's midnight, +28 days. */
function dayWindow(n: number) {
  return { startsAt: at(n * 24 * 60), endsAt: at((n + 28) * 24 * 60) };
}

function block(source: string, nativeId: string, fromMinutes: number, toMinutes: number, allDay = false): BusyBlock {
  return {
    blockId: busyBlockId(source, nativeId, at(fromMinutes)),
    sourceId: source,
    sourceKind: 'device',
    startAt: at(fromMinutes),
    endAt: at(toMinutes),
    allDay,
  };
}

async function rowCount(storage: ReturnType<typeof createMemoryStorage>, uid = UID): Promise<number> {
  return (await storage.list(userCol(uid, BUSY_BLOCKS))).length;
}

/* ── F1: the window moves, and nothing is left behind ────────────── */

/**
 * Twenty-eight nights of one evening event each.
 *
 * Each day the phone sends that day's window, which contains that evening's
 * event and no earlier one. Under the overlap rule the previous evenings were
 * outside every subsequent window and survived for ever.
 */
test('a month of daily syncs leaves one row, not twenty-eight', async () => {
  const storage = createMemoryStorage();
  for (let day = 0; day < 28; day += 1) {
    const evening = block(SOURCE, `evening-${day}`, day * 24 * 60 + 18 * 60, day * 24 * 60 + 19 * 60);
    await replaceBusyBlocks(UID, SOURCE, dayWindow(day), [evening], { storage });
  }
  assert.equal(await rowCount(storage), 1, 'rows left behind by a window that moved');
});

test('a row that fell behind the window is gone on the next sync', async () => {
  const storage = createMemoryStorage();
  await replaceBusyBlocks(UID, SOURCE, dayWindow(0), [block(SOURCE, 'yesterday', 60, 120)], { storage });
  assert.equal(await rowCount(storage), 1);
  // The next day's window begins after that block ended, so under the old rule
  // it was neither re-sent nor deletable.
  await replaceBusyBlocks(UID, SOURCE, dayWindow(1), [block(SOURCE, 'tomorrow', 25 * 60, 26 * 60)], { storage });
  assert.equal(await rowCount(storage), 1);
  assert.deepEqual(
    (await listBusyBlocks(UID, { startsAt: at(0), endsAt: at(60 * 24 * 60) }, { storage })).map((row) => row.startAt),
    [at(25 * 60)],
  );
});

test('an upload is a source\'s whole state, so an emptied calendar empties the source', async () => {
  const storage = createMemoryStorage();
  await replaceBusyBlocks(UID, SOURCE, dayWindow(0), [
    block(SOURCE, 'a', 600, 660), block(SOURCE, 'b', 700, 760),
  ], { storage });
  await replaceBusyBlocks(UID, SOURCE, dayWindow(3), [], { storage });
  assert.equal(await rowCount(storage), 0);
});

test('one source being restated never reaches another source\'s rows', async () => {
  const storage = createMemoryStorage();
  await replaceBusyBlocks(UID, OTHER_SOURCE, dayWindow(0), [block(OTHER_SOURCE, 'theirs', 600, 660)], { storage });
  await replaceBusyBlocks(UID, SOURCE, dayWindow(9), [block(SOURCE, 'mine', 9 * 24 * 60, 9 * 24 * 60 + 60)], { storage });
  assert.equal(await rowCount(storage), 2);
  const left = await listBusyBlocks(UID, { startsAt: at(0), endsAt: at(60 * 24 * 60) }, { storage });
  assert.deepEqual(left.map((row) => row.sourceId).sort(), [OTHER_SOURCE, SOURCE].sort());
});

/* ── F2: the store is bounded, and a block belongs to its window ─── */

test('two windows of the cap do not leave twice the cap stored', async () => {
  const storage = createMemoryStorage();
  const many = (offsetDays: number) => Array.from({ length: BUSY_BLOCK_UPLOAD_LIMIT }, (_, index) => (
    block(SOURCE, `e-${index}`, offsetDays * 24 * 60 + index, offsetDays * 24 * 60 + index + 1)
  ));
  await replaceBusyBlocks(UID, SOURCE, dayWindow(0), many(0), { storage });
  await replaceBusyBlocks(UID, SOURCE, dayWindow(40), many(40), { storage });
  assert.equal(await rowCount(storage), BUSY_BLOCK_UPLOAD_LIMIT);
});

test('a block that does not touch the declared window is refused', () => {
  const far = new Date(ANCHOR + 900 * DAY).toISOString();
  assert.throws(
    () => parseBusyUpload({
      sourceId: SOURCE,
      platform: 'ios',
      windowStart: at(0),
      windowEnd: at(60),
      blocks: [{ blockId: 'a'.repeat(64), startAt: far, endAt: new Date(Date.parse(far) + 60_000).toISOString(), allDay: false }],
    }),
    (error: unknown) => error instanceof BusyUploadError && /window/.test(error.message),
  );
});

test('a block from before the epoch of the window is refused too', () => {
  const longAgo = new Date(ANCHOR - 900 * DAY).toISOString();
  assert.throws(
    () => parseBusyUpload({
      sourceId: SOURCE,
      platform: 'ios',
      windowStart: at(0),
      windowEnd: at(60),
      blocks: [{ blockId: 'b'.repeat(64), startAt: longAgo, endAt: new Date(Date.parse(longAgo) + 60_000).toISOString(), allDay: false }],
    }),
    (error: unknown) => error instanceof BusyUploadError && /window/.test(error.message),
  );
});

/** The overnight case, which is the reason the rule is overlap and not containment. */
test('a block that began before the window and runs into it is kept', () => {
  const parsed = parseBusyUpload({
    sourceId: SOURCE,
    platform: 'ios',
    windowStart: at(24 * 60),
    windowEnd: at(52 * 60),
    blocks: [{ blockId: 'c'.repeat(64), startAt: at(23 * 60), endAt: at(25 * 60), allDay: false }],
  });
  assert.equal(parsed.blocks.length, 1);
});

test('a window longer than the maximum is refused, so the window check cannot be dodged', () => {
  assert.throws(
    () => parseBusyUpload({
      sourceId: SOURCE,
      platform: 'ios',
      windowStart: at(0),
      windowEnd: new Date(ANCHOR + (MAX_BUSY_WINDOW_DAYS + 1) * DAY).toISOString(),
      blocks: [],
    }),
    (error: unknown) => error instanceof BusyUploadError && /window/.test(error.message),
  );
});

test('the window the phone actually sends is comfortably inside the maximum', () => {
  assert.ok(MAX_BUSY_WINDOW_DAYS >= 28, 'the device window would be refused');
  const parsed = parseBusyUpload({
    sourceId: SOURCE,
    platform: 'ios',
    windowStart: at(0),
    windowEnd: at(28 * 24 * 60),
    blocks: [],
  });
  assert.equal(parsed.blocks.length, 0);
});

test('the same block id twice in one upload is refused rather than counted twice', () => {
  const one = { blockId: 'd'.repeat(64), startAt: at(600), endAt: at(660), allDay: false };
  assert.throws(
    () => parseBusyUpload({
      sourceId: SOURCE, platform: 'ios', windowStart: at(0), windowEnd: at(60 * 24),
      blocks: [one, { ...one }],
    }),
    (error: unknown) => error instanceof BusyUploadError && /twice|duplicate/i.test(error.message),
  );
});

/* ── F3: one source cannot overwrite another's row ───────────────── */

/**
 * The collision the server cannot detect by arithmetic.
 *
 * `blockId` is the client's to choose and the server cannot re-derive it — the
 * preimage holds the calendar's own event id, which never leaves the phone. So
 * the guarantee has to be structural: the document path hashes the source in
 * with the id, and two sources presenting the same id are two documents.
 */
test('a second source presenting the same block id does not take over the first\'s row', async () => {
  const storage = createMemoryStorage();
  const shared = busyBlockId(SOURCE, 'collide', at(600));
  await replaceBusyBlocks(UID, SOURCE, dayWindow(0), [
    { blockId: shared, sourceId: SOURCE, sourceKind: 'device', startAt: at(600), endAt: at(660), allDay: false },
  ], { storage });
  await replaceBusyBlocks(UID, OTHER_SOURCE, dayWindow(0), [
    { blockId: shared, sourceId: OTHER_SOURCE, sourceKind: 'device', startAt: at(600), endAt: at(660), allDay: false },
  ], { storage });

  assert.equal(await rowCount(storage), 2, 'one source overwrote the other\'s document');
  const sources = (await listBusyBlocks(UID, dayWindow(0), { storage })).map((row) => row.sourceId).sort();
  assert.deepEqual(sources, [OTHER_SOURCE, SOURCE].sort());
});

test('disconnecting after such a collision still removes that source\'s own row', async () => {
  const storage = createMemoryStorage();
  const shared = busyBlockId(SOURCE, 'collide', at(600));
  for (const source of [SOURCE, OTHER_SOURCE]) {
    await replaceBusyBlocks(UID, source, dayWindow(0), [
      { blockId: shared, sourceId: source, sourceKind: 'device', startAt: at(600), endAt: at(660), allDay: false },
    ], { storage });
  }
  assert.deepEqual(await deleteBusySource(UID, SOURCE, { storage }), { deleted: 1 });
  assert.equal(await rowCount(storage), 1);
  assert.deepEqual(
    (await listBusyBlocks(UID, dayWindow(0), { storage })).map((row) => row.sourceId),
    [OTHER_SOURCE],
  );
});

/* ── F8: what a source may call itself ───────────────────────────── */

test('a source id carrying a control character or a dot-dot is refused', () => {
  for (const sourceId of ['device:../../admin', 'device:a\nb', 'device:a b']) {
    assert.throws(
      () => parseBusyUpload({ sourceId, platform: 'ios', windowStart: at(0), windowEnd: at(60), blocks: [] }),
      (error: unknown) => error instanceof BusyUploadError,
      `${JSON.stringify(sourceId)} was accepted`,
    );
  }
});

test('an ordinary installation id is still accepted', () => {
  assert.equal(
    parseBusyUpload({ sourceId: SOURCE, platform: 'ios', windowStart: at(0), windowEnd: at(60), blocks: [] }).sourceId,
    SOURCE,
  );
});
