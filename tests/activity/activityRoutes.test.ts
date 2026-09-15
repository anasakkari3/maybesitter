/**
 * `/api/mobile/activity` and `/api/mobile/activity/summary` (UC-3.15, #201).
 *
 * These go through the real commands, so what they assert is the whole path:
 * a command produces events, the events are appended in the same transaction
 * that advances the counters, and the routes read both back. A test that
 * hand-wrote event documents would prove the projection and nothing about
 * whether anything ever writes one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { applyParticipantCommands } from '../../lib/services/mobile/participantState.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { activityStatsPath } from '../../lib/services/activity/activityStats.ts';
import type { UserDocument } from '../../lib/storage/userDocument.ts';
import { GET as activityGet } from '../../src/app/api/mobile/activity/route.ts';
import { GET as summaryGet } from '../../src/app/api/mobile/activity/summary/route.ts';

const BASE = 'http://127.0.0.1:4321';
const OWNER = uidFor('ActivityOwner');
const STRANGER = uidFor('ActivityStranger');
const ZONE = 'Asia/Jerusalem';

let auth: FakeAuthControls | null = null;

function begin(): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
}

function end(): void {
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function request(uid: string | null, path: string): Request {
  const headers = new Headers();
  if (uid) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`${BASE}${path}`, { headers });
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

/** Sets the zone and language the summary reads the week boundary from. */
async function setProfile(uid: string, locale: 'ar' | 'en' | 'he'): Promise<void> {
  const storage = getStorage();
  const existing = await storage.get<UserDocument>(userDoc(uid));
  await storage.set<UserDocument>(userDoc(uid), { ...(existing as UserDocument), timezone: ZONE, locale });
}

/**
 * Capture → confirm → complete, through the real state machine.
 *
 * Each step gets its own instant, because each is its own request in the
 * product and `command.now` is what stamps the event. Giving all three the
 * same instant would make the three entries genuinely simultaneous, which is a
 * different thing to test (see the ordering tests in eventLog.test.ts).
 */
async function completeOne(uid: string, id: string, title: string, at: string, dueAt: string): Promise<void> {
  const plus = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
  await applyParticipantCommands(uid, [
    {
      type: 'CreateDraft',
      now: at,
      commitment: {
        id, kind: 'task', title,
        priority: { level: 'high' },
        timeSpec: { kind: 'due_by', dueAt, timezone: ZONE },
      },
    },
    { type: 'ConfirmCommitment', commitmentId: id, now: plus(1) },
    { type: 'Complete', commitmentId: id, now: plus(2) },
  ]);
}

/** Every document in a user collection, removed. `deleteTree` takes a document. */
async function wipeCollection(path: string): Promise<void> {
  const storage = getStorage();
  for (const row of await storage.list<unknown>(path)) await storage.delete(`${path}/${row.id}`);
}

test('both routes refuse a request with no token', async () => {
  begin();
  try {
    for (const response of [
      await activityGet(request(null, '/api/mobile/activity')),
      await summaryGet(request(null, '/api/mobile/activity/summary')),
    ]) {
      assert.equal(response.status, 401);
      assert.equal((await json(response)).success, false);
    }
  } finally {
    end();
  }
});

test('both routes refuse a token the verifier rejects', async () => {
  begin();
  try {
    auth!.refuse(OWNER, 'token_expired');
    const response = await activityGet(request(OWNER, '/api/mobile/activity'));
    assert.equal(response.status, 401);
    assert.equal((await json(response)).reason, 'token_expired');
  } finally {
    end();
  }
});

test('history shows what the user did, newest first, with the current title', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    await completeOne(OWNER, 'c1', 'Call the clinic', '2026-09-14T09:00:00.000Z', '2026-09-14T12:00:00.000Z');

    const body = await json(await activityGet(request(OWNER, '/api/mobile/activity')));
    const kinds = (body.items as Array<{ kind: string }>).map((item) => item.kind);
    assert.deepEqual(kinds, ['completed', 'confirmed', 'captured']);
    for (const item of body.items as Array<{ commitmentTitle: string; commitmentId: string }>) {
      assert.equal(item.commitmentTitle, 'Call the clinic');
      assert.equal(item.commitmentId, 'c1');
    }
  } finally {
    end();
  }
});

test('a pressure delivery in the same log never reaches the response', async () => {
  begin();
  try {
    await completeOne(OWNER, 'c1', 'Call the clinic', '2026-09-14T09:00:00.000Z', '2026-09-14T12:00:00.000Z');
    // Written straight into the log, as another track's event would be.
    const { EVENTS, userCol } = await import('../../lib/storage/paths.ts');
    await getStorage().set(`${userCol(OWNER, EVENTS)}/leak`, {
      id: 'leak', type: 'escalation_delivered', at: '2026-09-14T10:00:00.000Z',
      aggregateId: 'c1', payload: { level: 3 },
    });

    const body = await json(await activityGet(request(OWNER, '/api/mobile/activity')));
    const ids = (body.items as Array<{ id: string }>).map((item) => item.id);
    assert.ok(!ids.includes('leak'), 'an escalation delivery reached the activity screen');
  } finally {
    end();
  }
});

test('one account never sees another account’s activity', async () => {
  begin();
  try {
    await completeOne(OWNER, 'c1', 'Call the clinic', '2026-09-14T09:00:00.000Z', '2026-09-14T12:00:00.000Z');
    const body = await json(await activityGet(request(STRANGER, '/api/mobile/activity')));
    assert.deepEqual(body.items, []);
    assert.equal(body.nextCursor, null);
  } finally {
    end();
  }
});

test('the pages a cursor walks are stable and do not overlap', async () => {
  begin();
  try {
    for (let index = 0; index < 6; index += 1) {
      await completeOne(
        OWNER, `c${index}`, `Item ${index}`,
        `2026-09-14T0${index}:00:00.000Z`, `2026-09-14T12:00:00.000Z`,
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const path = `/api/mobile/activity?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await json(await activityGet(request(OWNER, path)));
      seen.push(...(body.items as Array<{ id: string }>).map((item) => item.id));
      cursor = body.nextCursor as string | null;
      if (cursor === null) break;
    }

    // Three events per item, six items.
    assert.equal(seen.length, 18);
    assert.equal(new Set(seen).size, 18, 'a page repeated an entry');
  } finally {
    end();
  }
});

test('the summary defaults to the account’s own week and counts what happened in it', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    // Sunday 13 September 2026 through Saturday 19 September, Asia/Jerusalem.
    await completeOne(OWNER, 'c1', 'One', '2026-09-14T08:00:00.000Z', '2026-09-14T09:00:00.000Z');
    await completeOne(OWNER, 'c2', 'Two', '2026-09-15T08:00:00.000Z', '2026-09-15T09:00:00.000Z');
    // Last week: outside the window, and it must not be counted.
    await completeOne(OWNER, 'c3', 'Three', '2026-09-08T08:00:00.000Z', '2026-09-08T09:00:00.000Z');

    const body = await json(await summaryGet(
      request(OWNER, '/api/mobile/activity/summary?weekStart=2026-09-13'),
    ));
    assert.equal(body.weekStart, '2026-09-13');
    assert.equal(body.completedCount, 2);
    assert.equal(body.keptCount, 2);
    assert.equal(body.plannedDaysCount, 0);
  } finally {
    end();
  }
});

test('a weekStart the server did not expect falls back to the current week', async () => {
  begin();
  try {
    await setProfile(OWNER, 'en');
    const body = await json(await summaryGet(
      request(OWNER, '/api/mobile/activity/summary?weekStart=last-tuesday'),
    ));
    assert.match(body.weekStart as string, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(body.completedCount, 0);
  } finally {
    end();
  }
});

test('a fresh account gets an all-zero summary and an empty history', async () => {
  begin();
  try {
    const summary = await json(await summaryGet(request(OWNER, '/api/mobile/activity/summary')));
    assert.deepEqual(
      [summary.completedCount, summary.plannedDaysCount, summary.keptCount, summary.moments],
      [0, 0, 0, []],
    );
    const history = await json(await activityGet(request(OWNER, '/api/mobile/activity')));
    assert.deepEqual(history.items, []);
  } finally {
    end();
  }
});

test('Moments outlive the commitments they came from', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    await completeOne(OWNER, 'c1', 'One', '2026-09-14T08:00:00.000Z', '2026-09-14T09:00:00.000Z');

    // Delete the commitment and its whole event log, as an account tidy-up
    // would. The counter is a separate document and is what answers.
    const { COMMITMENTS, EVENTS, userCol } = await import('../../lib/storage/paths.ts');
    await wipeCollection(userCol(OWNER, COMMITMENTS));
    await wipeCollection(userCol(OWNER, EVENTS));

    const body = await json(await summaryGet(request(OWNER, '/api/mobile/activity/summary')));
    assert.deepEqual((body.moments as Array<{ id: string }>).map((moment) => moment.id), ['first_capture', 'first_done']);
    assert.equal(body.completedCount, 0);

    const history = await json(await activityGet(request(OWNER, '/api/mobile/activity')));
    assert.deepEqual(history.items, []);
  } finally {
    end();
  }
});

test('the counter is advanced in the same write as the event, not afterwards', async () => {
  begin();
  try {
    await completeOne(OWNER, 'c1', 'One', '2026-09-14T08:00:00.000Z', '2026-09-14T09:00:00.000Z');
    const stats = await getStorage().get<{ doneTotal: number; firstCaptureAt: string; firstDoneAt: string }>(
      activityStatsPath(OWNER),
    );
    assert.deepEqual(
      [stats?.doneTotal, stats?.firstCaptureAt, stats?.firstDoneAt],
      // The capture stamped the first, the completion two minutes later the
      // second: each date is the instant of its own event, not of the write.
      [1, '2026-09-14T08:00:00.000Z', '2026-09-14T08:02:00.000Z'],
    );
  } finally {
    end();
  }
});
