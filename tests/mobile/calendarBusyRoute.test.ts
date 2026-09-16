/**
 * The one route busy time travels over (UC-3.2, #186).
 *
 * Its job is mostly refusal. Three of this issue's acceptance criteria are
 * statements about what must *not* happen, and all three are decided here
 * rather than on the phone, because the phone is the thing that could be wrong:
 *
 *   an event title must never reach storage — so a body carrying one is 400,
 *   not a body with the title dropped;
 *
 *   busy time must not be held for somebody who has not turned the calendar on
 *   — so the route reads the trust record itself rather than trusting the
 *   client to have checked;
 *
 *   a re-upload must replace — so uploading twice leaves one window's worth of
 *   rows, and the case that proves it moves every event, because a block id
 *   derived from the start makes an unchanged calendar overwrite itself.
 *
 * No instant below is a literal. They are all derived from the clock this
 * process is running on, so the file says the same thing in every zone and in
 * every year.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userCol } from '../../lib/storage/paths.ts';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import {
  DELETE as busyDelete,
  POST as busyPost,
} from '../../src/app/api/mobile/calendar/busy/route.ts';
import {
  BUSY_BLOCKS,
  busyBlockId,
  listBusyBlocks,
  readCalendarSource,
} from '../../lib/calendar/busyBlocks.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('CalendarBusyUser');
const SOURCE = 'device:1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';

const ANCHOR = (() => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
})();

function at(minutes: number): string {
  return new Date(ANCHOR + minutes * 60_000).toISOString();
}

let auth: FakeAuthControls | null = null;

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

/** Somebody who has turned "read my calendar" on, which most of these need. */
async function withConsent(uid = USER): Promise<void> {
  // `set_calendar_consent` refuses before the account has seen its first value
  // (lib/pilot/closedPilotControls). That is the pilot's rule and not this
  // issue's, so the switch is armed the way the product arms it.
  await applyTrustAction(uid, { type: 'record_first_value', at: new Date(ANCHOR).toISOString() });
  await applyTrustAction(uid, { type: 'set_calendar_consent', granted: true, at: new Date(ANCHOR).toISOString() });
}

function post(body: unknown, uid: string | null = USER): Request {
  return new Request(`${BASE}/api/mobile/calendar/busy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(uid === null ? {} : { authorization: `Bearer ${tokenFor(uid)}` }),
    },
    body: JSON.stringify(body),
  });
}

function del(sourceId: string | null, uid: string | null = USER): Request {
  const query = sourceId === null ? '' : `?sourceId=${encodeURIComponent(sourceId)}`;
  return new Request(`${BASE}/api/mobile/calendar/busy${query}`, {
    method: 'DELETE',
    headers: uid === null ? {} : { authorization: `Bearer ${tokenFor(uid)}` },
  });
}

function upload(blocks: { nativeId: string; from: number; to: number; allDay?: boolean }[]) {
  return {
    sourceId: SOURCE,
    platform: 'ios',
    windowStart: at(0),
    windowEnd: at(60 * 24 * 28),
    blocks: blocks.map((block) => ({
      blockId: busyBlockId(SOURCE, block.nativeId, at(block.from)),
      startAt: at(block.from),
      endAt: at(block.to),
      allDay: block.allDay ?? false,
    })),
  };
}

async function blockCount(uid = USER): Promise<number> {
  const { getStorage } = await import('../../lib/storage/index.ts');
  return (await getStorage().list(userCol(uid, BUSY_BLOCKS))).length;
}

/* ── Who may speak ───────────────────────────────────────────────── */

test('an unauthenticated upload is refused before anything is read', async () => {
  const teardown = setup();
  try {
    const response = await busyPost(post(upload([{ nativeId: 'a', from: 600, to: 660 }]), null));
    assert.equal(response.status, 401);
    assert.equal(await blockCount(), 0);
  } finally {
    teardown();
  }
});

test('an account that has not turned the calendar on cannot store busy time', async () => {
  const teardown = setup();
  try {
    const response = await busyPost(post(upload([{ nativeId: 'a', from: 600, to: 660 }])));
    assert.equal(response.status, 403);
    const body = await response.json() as { reason?: string };
    assert.equal(body.reason, 'calendar_consent_required');
    assert.equal(await blockCount(), 0);
  } finally {
    teardown();
  }
});

test('withdrawing consent stops the next sync', async () => {
  const teardown = setup();
  try {
    await withConsent();
    assert.equal((await busyPost(post(upload([{ nativeId: 'a', from: 600, to: 660 }])))).status, 200);
    await applyTrustAction(USER, { type: 'set_calendar_consent', granted: false, at: at(1) });
    assert.equal((await busyPost(post(upload([{ nativeId: 'b', from: 700, to: 760 }])))).status, 403);
  } finally {
    teardown();
  }
});

/* ── The title that must never arrive ────────────────────────────── */

test('a block carrying a title is refused and nothing at all is stored', async () => {
  const teardown = setup();
  try {
    await withConsent();
    const body = upload([{ nativeId: 'a', from: 600, to: 660 }]) as Record<string, unknown>;
    (body.blocks as Record<string, unknown>[])[0]!.title = 'Oncology, Dr Haddad';
    const response = await busyPost(post(body));
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /title/);
    assert.equal(await blockCount(), 0);
  } finally {
    teardown();
  }
});

test('nothing a phone could send puts a title in a stored row', async () => {
  const teardown = setup();
  try {
    await withConsent();
    await busyPost(post(upload([{ nativeId: 'a', from: 600, to: 660 }, { nativeId: 'b', from: 700, to: 760 }])));
    const { getStorage } = await import('../../lib/storage/index.ts');
    const rows = await getStorage().list<Record<string, unknown>>(userCol(USER, BUSY_BLOCKS));
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(
        Object.keys(row.data).sort(),
        ['allDay', 'blockId', 'endAt', 'sourceId', 'sourceKind', 'startAt'],
      );
    }
  } finally {
    teardown();
  }
});

/* ── Replace, and the counting that proves it ────────────────────── */

test('a second sync of the same window does not double the rows', async () => {
  const teardown = setup();
  try {
    await withConsent();
    const same = upload([{ nativeId: 'a', from: 600, to: 660 }, { nativeId: 'b', from: 700, to: 760 }]);
    await busyPost(post(same));
    await busyPost(post(same));
    assert.equal(await blockCount(), 2);
  } finally {
    teardown();
  }
});

test('a sync after every meeting moved leaves two rows, not four', async () => {
  const teardown = setup();
  try {
    await withConsent();
    await busyPost(post(upload([{ nativeId: 'a', from: 600, to: 660 }, { nativeId: 'b', from: 700, to: 760 }])));
    await busyPost(post(upload([{ nativeId: 'a', from: 615, to: 675 }, { nativeId: 'b', from: 715, to: 775 }])));
    assert.equal(await blockCount(), 2);
    const left = await listBusyBlocks(USER, { startsAt: at(0), endsAt: at(60 * 24) });
    assert.deepEqual(left.map((row) => row.startAt), [at(615), at(715)]);
  } finally {
    teardown();
  }
});

test('an emptied calendar empties the window', async () => {
  const teardown = setup();
  try {
    await withConsent();
    await busyPost(post(upload([{ nativeId: 'a', from: 600, to: 660 }])));
    const response = await busyPost(post(upload([])));
    assert.equal(response.status, 200);
    assert.equal(await blockCount(), 0);
  } finally {
    teardown();
  }
});

test('the response says what the account now holds, without saying what it is', async () => {
  const teardown = setup();
  try {
    await withConsent();
    const response = await busyPost(post(upload([
      { nativeId: 'a', from: 600, to: 660 },
      { nativeId: 'h', from: 0, to: 60 * 24, allDay: true },
    ])));
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['blocks', 'source', 'success']);
    assert.equal(body.blocks, 2);
    assert.deepEqual(Object.keys(body.source as object).sort(), ['lastSyncedAt', 'sourceId', 'windowEnd', 'windowStart']);
  } finally {
    teardown();
  }
});

/* ── One account's calendar is not another's ─────────────────────── */

test('an upload lands in the caller\'s tree and no one else\'s', async () => {
  const teardown = setup();
  const other = uidFor('CalendarBusyOther');
  try {
    await withConsent();
    await withConsent(other);
    await busyPost(post(upload([{ nativeId: 'a', from: 600, to: 660 }])));
    assert.equal(await blockCount(USER), 1);
    assert.equal(await blockCount(other), 0);
  } finally {
    teardown();
  }
});

test('deleting a source deletes only the caller\'s copy of it', async () => {
  const teardown = setup();
  const other = uidFor('CalendarBusyOther');
  try {
    await withConsent();
    await withConsent(other);
    await busyPost(post(upload([{ nativeId: 'a', from: 600, to: 660 }])));
    await busyPost(post(upload([{ nativeId: 'a', from: 600, to: 660 }]), other));

    const response = await busyDelete(del(SOURCE));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, deleted: 1 });
    assert.equal(await blockCount(USER), 0);
    assert.equal(await readCalendarSource(USER, SOURCE), null);
    assert.equal(await blockCount(other), 1);
  } finally {
    teardown();
  }
});

test('a delete with no source named is refused rather than deleting everything', async () => {
  const teardown = setup();
  try {
    await withConsent();
    await busyPost(post(upload([{ nativeId: 'a', from: 600, to: 660 }])));
    assert.equal((await busyDelete(del(null))).status, 400);
    assert.equal(await blockCount(), 1);
  } finally {
    teardown();
  }
});

/**
 * Disconnecting is not consenting.
 *
 * The delete half deliberately does not require calendar consent: somebody who
 * has just turned the switch off is exactly the person who most needs "and
 * remove what you already have" to work, and a 403 there would strand their
 * data on the server for ever.
 */
test('a source can be deleted after consent has been withdrawn', async () => {
  const teardown = setup();
  try {
    await withConsent();
    await busyPost(post(upload([{ nativeId: 'a', from: 600, to: 660 }])));
    await applyTrustAction(USER, { type: 'set_calendar_consent', granted: false, at: at(1) });
    assert.equal((await busyDelete(del(SOURCE))).status, 200);
    assert.equal(await blockCount(), 0);
  } finally {
    teardown();
  }
});

test('an unauthenticated delete removes nothing', async () => {
  const teardown = setup();
  try {
    await withConsent();
    await busyPost(post(upload([{ nativeId: 'a', from: 600, to: 660 }])));
    assert.equal((await busyDelete(del(SOURCE, null))).status, 401);
    assert.equal(await blockCount(), 1);
  } finally {
    teardown();
  }
});

/* ── Malformed ───────────────────────────────────────────────────── */

test('a body that is not JSON is a 400, not a 500', async () => {
  const teardown = setup();
  try {
    await withConsent();
    const request = new Request(`${BASE}/api/mobile/calendar/busy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${tokenFor(USER)}` },
      body: 'not json',
    });
    assert.equal((await busyPost(request)).status, 400);
  } finally {
    teardown();
  }
});

test('a source id the server does not recognise is refused', async () => {
  const teardown = setup();
  try {
    await withConsent();
    const body = { ...upload([]), sourceId: 'exchange:something' };
    assert.equal((await busyPost(post(body))).status, 400);
  } finally {
    teardown();
  }
});
