/**
 * «احذفها» deletes; «أسقطه بوعي» drops (CA2.3 / CXA2.3, QA audit de7fcb8,
 * confirmed on device and through the API).
 *
 * ── The defect ───────────────────────────────────────────────────
 *
 * `DELETE /api/mobile/commitments/:id` ran the Drop command. The sheet says
 * «بتطلع من قوائمك نهائي. إذا أسقطتها بوعي بتضل بتاريخك.» — it leaves your
 * lists for good, and only a drop stays in your history — yet the deleted item
 * was still found by search as «أسقطته بوعي», still opened in Details with
 * Delete offered again, and a *completed* item that was deleted became
 * `dropped`, rewriting a finished thing as a deliberate drop.
 *
 * ── The rule ─────────────────────────────────────────────────────
 *
 * The two answers are different outcomes (mobile/AGENTS.md):
 *   - drop on purpose: `dropped`, kept, found by search, history says so;
 *   - delete: gone from Today, Upcoming, search and Details, and never
 *     recorded as a drop. A completed item is never turned into `dropped`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as upcomingGet } from '../../src/app/api/mobile/commitments/upcoming/route.ts';
import {
  DELETE as commitmentDelete,
  GET as commitmentGet,
} from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/commitments/[id]/actions/route.ts';
import { searchCommitments } from '../../lib/services/mobile/commitmentSearchService.ts';
import { getCommitment } from '../../lib/services/mobile/commitmentService.ts';
import { applyParticipantCommands } from '../../lib/services/mobile/participantState.ts';
import { listActivity } from '../../lib/services/activity/activityService.ts';
import { buildAccountExport } from '../../lib/account/accountExport.ts';
import { foldForSearch } from '../../src/text/foldForSearch.ts';
import { applyCommand, type Command } from '../../src/domain/stateMachine.ts';
import { readParticipantState } from '../../lib/services/mobile/participantState.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('DeleteIsNotDropUser');

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

/** A confirmed task due in two hours, titled so search can find it. */
async function seed(id: string, title: string): Promise<void> {
  await seedLiveAccount(USER);
  const now = Date.now();
  const commands: Command[] = [
    {
      type: 'CreateDraft',
      now: new Date(now - 60_000).toISOString(),
      commitment: {
        id,
        kind: 'task',
        title,
        timeSpec: { kind: 'due_by', dueAt: new Date(now + 2 * 3_600_000).toISOString(), remindAt: null, timezone: 'UTC' },
      },
      draftStatus: 'pending_confirmation',
    },
    { type: 'ConfirmCommitment', commitmentId: id, now: new Date(now - 59_000).toISOString() },
  ];
  await applyParticipantCommands(USER, commands);
}

function request(path: string, init: { method?: string; body?: unknown } = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${tokenFor(USER)}`, 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function listedIds(): Promise<string[]> {
  const today = await (await todayGet(request('/api/mobile/commitments/today?timezone=UTC'))).json() as { items: Array<{ id: string }> };
  const upcoming = await (await upcomingGet(request('/api/mobile/commitments/upcoming?timezone=UTC'))).json() as { items: Array<{ id: string }> };
  return [...today.items, ...upcoming.items].map((item) => item.id);
}

async function searched(query: string): Promise<string[]> {
  return (await searchCommitments({ participantId: USER, foldedQuery: foldForSearch(query) })).map((c) => c.id);
}

test('CA2.3: a deleted item is gone from the lists, search and Details', async () => {
  const teardown = setup();
  try {
    await seed('del-1', 'Meeting with Jihan');
    assert.deepEqual(await searched('jihan'), ['del-1']);

    const response = await commitmentDelete(request('/api/mobile/commitments/del-1', { method: 'DELETE' }), params('del-1'));
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.success, true);
    assert.notEqual(body.status, 'dropped', 'a delete answered as a drop');

    assert.equal((await listedIds()).includes('del-1'), false, 'still on Today or Upcoming');
    assert.deepEqual(await searched('jihan'), [], 'a deleted item is still found by search');
    const details = await commitmentGet(request('/api/mobile/commitments/del-1'), params('del-1'));
    assert.equal(details.status, 404, 'Details still opens a deleted item');
  } finally {
    teardown();
  }
});

test('CA2.3: deleting a completed item does not turn it into a drop', async () => {
  const teardown = setup();
  try {
    await seed('done-1', 'Pay the rent');
    const complete = await actionPost(request('/api/mobile/commitments/done-1/actions', { method: 'POST', body: { action: 'complete' } }), params('done-1'));
    assert.equal(complete.status, 200);

    const response = await commitmentDelete(request('/api/mobile/commitments/done-1', { method: 'DELETE' }), params('done-1'));
    assert.equal(response.status, 200);
    const stored = await getCommitment('done-1', { participantId: USER });
    assert.notEqual(stored?.status, 'dropped', 'a finished item was rewritten as dropped on purpose');
    assert.equal(stored?.droppedAt ?? null, null, 'a finished item was given a drop time');
    assert.deepEqual(await searched('rent'), [], 'a deleted completed item is still found by search');
  } finally {
    teardown();
  }
});

test('CA2.3: a delete stays in history as «deleted» with its title, never as a drop, and in the export', async () => {
  const teardown = setup();
  try {
    await seed('del-2', 'Private appointment');
    await commitmentDelete(request('/api/mobile/commitments/del-2', { method: 'DELETE' }), params('del-2'));
    const page = await listActivity({ uid: USER, limit: 50 });
    const mine = page.items.filter((item) => item.commitmentId === 'del-2');
    assert.equal(mine.some((item) => item.kind === 'dropped'), false, 'the delete shows as a drop in history');
    assert.equal(mine.some((item) => item.kind === 'deleted'), true, 'the delete is not in history');
    for (const item of mine) assert.equal(item.commitmentTitle, 'Private appointment', 'history lost the title of a deleted item');
    const exported = await buildAccountExport(USER);
    const rows = Object.values(exported.collections).flat() as Array<{ id: string; data: { status?: string } }>;
    assert.equal(rows.some((row) => row.id === 'del-2' && row.data.status === 'archived'), true, 'the account export lost a deleted item');
  } finally {
    teardown();
  }
});

test('CA2.3: dropping on purpose is still a drop — kept, searchable, and in history', async () => {
  const teardown = setup();
  try {
    await seed('drop-1', 'Gym membership');
    const response = await actionPost(request('/api/mobile/commitments/drop-1/actions', { method: 'POST', body: { action: 'cancel' } }), params('drop-1'));
    assert.equal(response.status, 200);
    assert.equal((await getCommitment('drop-1', { participantId: USER }))?.status, 'dropped');
    assert.deepEqual(await searched('gym'), ['drop-1']);
    const details = await commitmentGet(request('/api/mobile/commitments/drop-1'), params('drop-1'));
    assert.equal(details.status, 200);
    const page = await listActivity({ uid: USER, limit: 50 });
    assert.equal(page.items.some((item) => item.commitmentId === 'drop-1' && item.kind === 'dropped' && item.commitmentTitle === 'Gym membership'), true);
  } finally {
    teardown();
  }
});

test('CA2.3: a deleted item can be deleted again without an error, and nothing else acts on it', async () => {
  const teardown = setup();
  try {
    await seed('del-3', 'Old idea');
    assert.equal((await commitmentDelete(request('/api/mobile/commitments/del-3', { method: 'DELETE' }), params('del-3'))).status, 200);
    assert.equal((await commitmentDelete(request('/api/mobile/commitments/del-3', { method: 'DELETE' }), params('del-3'))).status, 200);
    const complete = await actionPost(request('/api/mobile/commitments/del-3/actions', { method: 'POST', body: { action: 'complete' } }), params('del-3'));
    assert.notEqual(complete.status, 200, 'a deleted item was completed');
  } finally {
    teardown();
  }
});

test('CA2.3: a system Drop after a delete is a no-op that keeps the item deleted', async () => {
  const teardown = setup();
  try {
    await seed('del-4', 'Deleted then dropped');
    await commitmentDelete(request('/api/mobile/commitments/del-4', { method: 'DELETE' }), params('del-4'));
    const state = await readParticipantState(USER);
    const result = applyCommand(state, { type: 'Drop', commitmentId: 'del-4', now: new Date().toISOString() });
    assert.equal(result.didChange, false);
    assert.equal(result.newState.commitments['del-4']?.status, 'archived');
    assert.equal(result.events.length, 0, 'a drop event was written for a deleted item');
  } finally {
    teardown();
  }
});
