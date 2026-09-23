import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { COMMITMENTS, userCol } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import {
  POST as manualPost,
  DELETE as manualDelete,
} from '../../src/app/api/mobile/calendar/manual/route.ts';
import {
  listBusyBlocks,
  readCalendarSource,
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
