/**
 * Reading the append-only event log back (UC-3.15, #201).
 *
 * The ordering tests are the reason this file exists. This repository has
 * already shipped a list whose ties broke on a uuid minted at *read* time, so
 * one save's records came back in a different order on every read. The log is
 * paginated, so the same bug here would not merely look untidy: a page
 * boundary that moves between two requests repeats some entries and silently
 * loses others.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { EVENTS, userCol } from '../../lib/storage/paths.ts';
import {
  compareEventsNewestFirst,
  cursorFor,
  listEvents,
  listEventsInRange,
  parseCursor,
  type DomainEventRecord,
} from '../../lib/services/mobile/eventLog.ts';

const UID = 'ActivityLogReader';

function begin() {
  setStorageForTests(createMemoryStorage());
}

async function seed(events: DomainEventRecord[]): Promise<void> {
  const { getStorage } = await import('../../lib/storage/index.ts');
  const storage = getStorage();
  for (const event of events) {
    await storage.set(`${userCol(UID, EVENTS)}/${event.id}`, { ...event, recordedAt: event.at });
  }
}

function event(id: string, at: string, type = 'commitment_completed'): DomainEventRecord {
  return { id, type, at, aggregateId: 'c1', payload: {} };
}

/** Ten events sharing one instant, deliberately written out of id order. */
function tied(at: string, count: number): DomainEventRecord[] {
  return Array.from({ length: count }, (_, index) => event(`t${String(count - index).padStart(2, '0')}`, at))
    .reverse();
}

test('a page is ordered newest first, and ties break on a value that is stored', async () => {
  begin();
  try {
    await seed(tied('2026-09-14T09:00:00.000Z', 5));
    const first = await listEvents(UID, { limit: 5 });
    const second = await listEvents(UID, { limit: 5 });

    assert.deepEqual(first.events.map((e) => e.id), ['t01', 't02', 't03', 't04', 't05']);
    // The same order on a second read. A random read-time tiebreaker would
    // pass the line above and fail this one.
    assert.deepEqual(second.events.map((e) => e.id), first.events.map((e) => e.id));
  } finally {
    resetStorageForTests();
  }
});

test('the comparator is a total order: no two distinct records compare equal', () => {
  const records = [
    event('b', '2026-09-14T09:00:00.000Z'),
    event('a', '2026-09-14T09:00:00.000Z'),
    event('c', '2026-09-14T08:00:00.000Z'),
  ];
  for (const left of records) {
    for (const right of records) {
      assert.equal(compareEventsNewestFirst(left, right) === 0, left.id === right.id);
    }
  }
});

test('pages do not overlap and lose nothing, including across a tie group', async () => {
  begin();
  try {
    // Twelve events at one instant and six at others, so every page boundary
    // that can fall inside a tie group does.
    await seed([
      ...tied('2026-09-14T09:00:00.000Z', 12),
      event('x1', '2026-09-14T10:00:00.000Z'),
      event('x2', '2026-09-14T10:00:00.000Z'),
      event('x3', '2026-09-13T09:00:00.000Z'),
      event('x4', '2026-09-12T09:00:00.000Z'),
      event('x5', '2026-09-11T09:00:00.000Z'),
      event('x6', '2026-09-10T09:00:00.000Z'),
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result: Awaited<ReturnType<typeof listEvents>> = await listEvents(UID, { limit: 5, cursor });
      seen.push(...result.events.map((e) => e.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    assert.equal(seen.length, new Set(seen).size, 'a page repeated an event');
    assert.equal(seen.length, 18, 'the walk lost an event');

    // And it is the same order the log would give in one read.
    const all = await listEvents(UID, { limit: 50 });
    assert.deepEqual(seen, all.events.map((e) => e.id));
  } finally {
    resetStorageForTests();
  }
});

test('a cursor names a record, so a tie group is neither repeated nor skipped', async () => {
  begin();
  try {
    await seed(tied('2026-09-14T09:00:00.000Z', 4));
    const first = await listEvents(UID, { limit: 2 });
    assert.deepEqual(first.events.map((e) => e.id), ['t01', 't02']);
    assert.equal(first.nextCursor, cursorFor(first.events[1]!));

    const second = await listEvents(UID, { limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.events.map((e) => e.id), ['t03', 't04']);
  } finally {
    resetStorageForTests();
  }
});

test('a cursor this server did not write is treated as no cursor, not as an error', async () => {
  begin();
  try {
    await seed([event('a', '2026-09-14T09:00:00.000Z')]);
    for (const bad of ['', 'not-a-cursor', '|abc', '2026-09-14T09:00:00.000Z|', 'nonsense|abc']) {
      assert.equal(parseCursor(bad), null);
      const page = await listEvents(UID, { limit: 5, cursor: bad });
      assert.deepEqual(page.events.map((e) => e.id), ['a']);
    }
  } finally {
    resetStorageForTests();
  }
});

test('the limit is clamped rather than trusted', async () => {
  begin();
  try {
    await seed(Array.from({ length: 60 }, (_, index) =>
      event(`e${String(index).padStart(2, '0')}`, `2026-09-14T09:${String(index).padStart(2, '0')}:00.000Z`)));
    assert.equal((await listEvents(UID, { limit: 9_999 })).events.length, 50);
    assert.equal((await listEvents(UID, { limit: 0 })).events.length, 1);
    assert.equal((await listEvents(UID, { limit: Number.NaN })).events.length, 20);
  } finally {
    resetStorageForTests();
  }
});

test('the range read is half-open and bounded', async () => {
  begin();
  try {
    await seed([
      event('before', '2026-09-13T23:59:59.999Z'),
      event('start', '2026-09-14T00:00:00.000Z'),
      event('inside', '2026-09-14T12:00:00.000Z'),
      event('end', '2026-09-15T00:00:00.000Z'),
    ]);
    const window = await listEventsInRange(UID, '2026-09-14T00:00:00.000Z', '2026-09-15T00:00:00.000Z', 500);
    assert.deepEqual(window.map((e) => e.id), ['start', 'inside']);

    const bounded = await listEventsInRange(UID, '2026-09-14T00:00:00.000Z', '2026-09-15T00:00:00.000Z', 1);
    assert.equal(bounded.length, 1);
  } finally {
    resetStorageForTests();
  }
});

test('one user never reads another user’s log', async () => {
  begin();
  try {
    const { getStorage } = await import('../../lib/storage/index.ts');
    await seed([event('mine', '2026-09-14T09:00:00.000Z')]);
    await getStorage().set(`${userCol('SomebodyElse', EVENTS)}/theirs`, event('theirs', '2026-09-14T10:00:00.000Z'));

    const page = await listEvents(UID, { limit: 50 });
    assert.deepEqual(page.events.map((e) => e.id), ['mine']);
  } finally {
    resetStorageForTests();
  }
});
