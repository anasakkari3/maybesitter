import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { COMMITMENTS, userCol } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import * as manualRoute from '../../src/app/api/mobile/calendar/manual/route.ts';
import {
  POST as manualPost,
  DELETE as manualDelete,
} from '../../src/app/api/mobile/calendar/manual/route.ts';
import {
  listBusyBlocks,
  readCalendarSource,
  replaceBusyBlocks,
} from '../../lib/calendar/busyBlocks.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('ManualBusyUser');
const PROPOSAL_ID = 'syllabus-proposal-999';

let auth: FakeAuthControls | null = null;
let storage: ReturnType<typeof createMemoryStorage>;

function setup(): () => void {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

/** Calendar consent on: manual busy time is calendar data (QA audit CA10.4). */
async function withConsent(uid = USER): Promise<void> {
  await applyTrustAction(uid, { type: 'record_first_value', at: '2026-09-01T08:00:00.000Z' });
  await applyTrustAction(uid, { type: 'set_calendar_consent', granted: true, at: '2026-09-01T08:00:00.000Z' });
}

test('POST /api/mobile/calendar/manual requires authentication', async () => {
  const cleanup = setup();
  try {
    const res = await manualPost(new Request(`${BASE}/api/mobile/calendar/manual`, {
      method: 'POST',
      body: JSON.stringify({ proposalId: PROPOSAL_ID, sessions: [] }),
    }));
    assert.equal(res.status, 401);
  } finally {
    cleanup();
  }
});

test('POST /api/mobile/calendar/manual validates request body', async () => {
  const cleanup = setup();
  try {
    const token = await tokenFor(USER);
    await withConsent();

    // Missing proposalId
    const res1 = await manualPost(new Request(`${BASE}/api/mobile/calendar/manual`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessions: [] }),
    }));
    assert.equal(res1.status, 400);

    // Invalid sessions format
    const res2 = await manualPost(new Request(`${BASE}/api/mobile/calendar/manual`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ proposalId: PROPOSAL_ID, sessions: 'not-an-array' }),
    }));
    assert.equal(res2.status, 400);

    // Invalid session weekday
    const res3 = await manualPost(new Request(`${BASE}/api/mobile/calendar/manual`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        proposalId: PROPOSAL_ID,
        sessions: [{ weekday: 7, start: '10:00', end: '12:00' }],
      }),
    }));
    assert.equal(res3.status, 400);
  } finally {
    cleanup();
  }
});

test('POST /api/mobile/calendar/manual stores 16 weeks of busy blocks and zero commitments', async () => {
  const cleanup = setup();
  try {
    const token = await tokenFor(USER);
    await withConsent();
    const sessions = [
      { weekday: 1, start: '09:00', end: '11:00', label: 'Lecture' },
      { weekday: 3, start: '13:00', end: '15:00', label: 'Lab' },
    ];

    const res = await manualPost(new Request(`${BASE}/api/mobile/calendar/manual`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        proposalId: PROPOSAL_ID,
        sessions,
        timezone: 'Asia/Jerusalem',
        referenceTime: '2026-09-01T08:00:00.000Z',
      }),
    }));

    assert.equal(res.status, 200);
    const body = await res.json() as { success: boolean; sourceId: string; blocks: number; windowStart: string; windowEnd: string };
    assert.equal(body.success, true);
    assert.equal(body.sourceId, `manual-${PROPOSAL_ID}`);
    assert.equal(body.blocks, 32); // 2 sessions * 16 weeks

    // Verify busy blocks in storage
    const storedBlocks = await listBusyBlocks(USER, { startsAt: body.windowStart, endsAt: body.windowEnd }, { storage });
    assert.equal(storedBlocks.length, 32);

    // Verify calendar source in storage
    const source = await readCalendarSource(USER, body.sourceId, { storage });
    assert.ok(source);
    assert.equal(source.kind, 'manual');

    // Verify zero commitments
    const commitments = await storage.list(userCol(USER, COMMITMENTS));
    assert.equal(commitments.length, 0);
  } finally {
    cleanup();
  }
});

test('DELETE /api/mobile/calendar/manual prunes the manual busy blocks', async () => {
  const cleanup = setup();
  try {
    const token = await tokenFor(USER);
    await withConsent();
    const sessions = [{ weekday: 2, start: '10:00', end: '12:00', label: 'Lecture' }];

    const postRes = await manualPost(new Request(`${BASE}/api/mobile/calendar/manual`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        proposalId: PROPOSAL_ID,
        sessions,
        timezone: 'Asia/Jerusalem',
      }),
    }));
    assert.equal(postRes.status, 200);
    const postBody = await postRes.json() as { windowStart: string; windowEnd: string };

    // Delete by proposalId
    const delRes = await manualDelete(new Request(`${BASE}/api/mobile/calendar/manual?proposalId=${PROPOSAL_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(delRes.status, 200);
    const delBody = await delRes.json() as { success: boolean; deleted: number };
    assert.equal(delBody.success, true);
    assert.equal(delBody.deleted, 16);

    // Verify pruned from storage
    const blocksAfter = await listBusyBlocks(USER, { startsAt: postBody.windowStart, endsAt: postBody.windowEnd }, { storage });
    assert.equal(blocksAfter.length, 0);

    const sourceAfter = await readCalendarSource(USER, `manual-${PROPOSAL_ID}`, { storage });
    assert.equal(sourceAfter, null);
  } finally {
    cleanup();
  }
});

/* ── QA audit CA10.4 / CXA10.3 (#749): consent, limits, removal ───────── */

function postManual(body: unknown, uid = USER): Request {
  return new Request(`${BASE}/api/mobile/calendar/manual`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(uid)}` },
    body: JSON.stringify(body),
  });
}

function lectures(proposalId: string, count = 2) {
  return {
    proposalId,
    timezone: 'Asia/Jerusalem',
    referenceTime: '2026-09-01T08:00:00.000Z',
    sessions: Array.from({ length: count }, (_, index) => ({ weekday: index % 7, start: '09:00', end: '10:00', label: null })),
  };
}

test('CA10.4: manual busy time is refused without calendar consent, and nothing is stored', async () => {
  const cleanup = setup();
  try {
    const res = await manualPost(postManual(lectures('no-consent')));
    assert.equal(res.status, 403);
    const body = await res.json() as { reason?: string };
    assert.equal(body.reason, 'calendar_consent_required');
    assert.equal(await readCalendarSource(USER, 'manual-no-consent', { storage }), null);
  } finally {
    cleanup();
  }
});

test('CA10.4: one request cannot carry more than 20 sessions', async () => {
  const cleanup = setup();
  try {
    await withConsent();
    const res = await manualPost(postManual(lectures('too-many', 21)));
    assert.equal(res.status, 400);
    const body = await res.json() as { reason?: string };
    assert.equal(body.reason, 'too_many_sessions');
    assert.equal(await readCalendarSource(USER, 'manual-too-many', { storage }), null);
  } finally {
    cleanup();
  }
});

test('CA10.4 (#749): an account holds at most 10 manual sources; deleting one frees its place', async () => {
  const cleanup = setup();
  try {
    await withConsent();
    for (let index = 0; index < 10; index += 1) {
      const res = await manualPost(postManual(lectures(`p${index}`)));
      assert.equal(res.status, 200, `source ${index}`);
    }
    // Re-accepting a source the account already has replaces it, not counted twice.
    assert.equal((await manualPost(postManual(lectures('p3', 3)))).status, 200);

    const refused = await manualPost(postManual(lectures('p10')));
    assert.equal(refused.status, 409);
    assert.equal((await refused.json() as { reason?: string }).reason, 'manual_busy_limit');
    assert.equal(await readCalendarSource(USER, 'manual-p10', { storage }), null);

    const deleted = await manualDelete(new Request(`${BASE}/api/mobile/calendar/manual?proposalId=p0`, {
      method: 'DELETE', headers: { authorization: `Bearer ${tokenFor(USER)}` },
    }));
    assert.equal(deleted.status, 200);
    assert.equal((await manualPost(postManual(lectures('p10')))).status, 200);
  } finally {
    cleanup();
  }
});

test('CA10.4 (#749): concurrent creates at the limit admit exactly one', async () => {
  const cleanup = setup();
  try {
    await withConsent();
    for (let index = 0; index < 9; index += 1) {
      assert.equal((await manualPost(postManual(lectures(`c${index}`)))).status, 200);
    }
    const results = await Promise.all(['x1', 'x2', 'x3'].map((id) => manualPost(postManual(lectures(id)))));
    assert.deepEqual(results.map((res) => res.status).sort(), [200, 409, 409]);
  } finally {
    cleanup();
  }
});

test('CXA10.3: the app can list what it added and remove it; the delete names the source it removed', async () => {
  const cleanup = setup();
  try {
    await withConsent();
    assert.equal((await manualPost(postManual(lectures('listed')))).status, 200);
    const GET = (manualRoute as { GET?: (request: Request) => Promise<Response> }).GET;
    assert.equal(typeof GET, 'function', 'GET /api/mobile/calendar/manual is missing');
    const listed = await GET!(new Request(`${BASE}/api/mobile/calendar/manual`, { headers: { authorization: `Bearer ${tokenFor(USER)}` } }));
    assert.equal(listed.status, 200);
    const body = await listed.json() as { success: boolean; sources: { sourceId: string; proposalId: string; addedAt: string; windowEnd: string }[] };
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0]!.proposalId, 'listed');
    assert.equal(body.sources[0]!.sourceId, 'manual-listed');

    const deleted = await manualDelete(new Request(`${BASE}/api/mobile/calendar/manual?proposalId=listed`, {
      method: 'DELETE', headers: { authorization: `Bearer ${tokenFor(USER)}` },
    }));
    const deletedBody = await deleted.json() as { success: boolean; sourceId?: string; deleted: number };
    // The app's schema (manualCalendarDeletedSchema) requires sourceId.
    assert.equal(deletedBody.sourceId, 'manual-listed');
    assert.equal(deletedBody.deleted, 2 * 16);
  } finally {
    cleanup();
  }
});

test('CA10.4 (#749): manual sources stored before the limit existed are counted', async () => {
  const cleanup = setup();
  try {
    await withConsent();
    const window = { startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-12-01T00:00:00.000Z' };
    for (let index = 0; index < 10; index += 1) {
      await replaceBusyBlocks(USER, `manual-old${index}`, window, [], { storage, platform: null });
    }
    const refused = await manualPost(postManual(lectures('new-one')));
    assert.equal(refused.status, 409);
  } finally {
    cleanup();
  }
});
