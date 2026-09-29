/**
 * The weekly-blocks routes under `/api/mobile/weekly-blocks` («ثابت أسبوعي»).
 *
 * Authenticated like every mobile route, scoped to the token's own tree (an id
 * from another account answers 404, the same as one that never existed), and
 * only a confirmed body creates a block. The refusals carry a `code` the phone
 * can branch on (`overnight_not_supported` is the one it must explain).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userCol, WEEKLY_BLOCKS, BUSY_BLOCKS } from '../../lib/storage/paths.ts';
import { GET as listGet, POST as createPost } from '../../src/app/api/mobile/weekly-blocks/route.ts';
import { DELETE as blockDelete, PATCH as blockPatch } from '../../src/app/api/mobile/weekly-blocks/[id]/route.ts';
import { GET as occurrencesGet } from '../../src/app/api/mobile/weekly-blocks/occurrences/route.ts';
import { DELETE as manualDelete } from '../../src/app/api/mobile/calendar/manual/route.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('WeeklyBlockRouteUser');
const OTHER = uidFor('WeeklyBlockOtherUser');
const ABSENT = '99999999-9999-4999-8999-999999999999';
const EVERY_DAY = {
  title: 'دوام',
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  start: '10:00',
  end: '16:00',
  timezone: 'Asia/Jerusalem',
  confirmation: { confirmedByUserAt: new Date().toISOString() },
};

let auth: FakeAuthControls | null = null;
let storage: MemoryStorageAdapter;

async function withRoutes(fn: () => Promise<void>): Promise<void> {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  auth = installFakeAuth();
  try {
    await fn();
  } finally {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  }
}

function request(path: string, options: { method?: string; body?: unknown; uid?: string | null } = {}): Request {
  const headers = new Headers();
  if (options.uid !== null) headers.set('authorization', `Bearer ${tokenFor(options.uid ?? USER)}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function create(body: unknown = EVERY_DAY, uid = USER) {
  const response = await createPost(request('/api/mobile/weekly-blocks', { body, uid }));
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test('every handler refuses a request without a token', async () => {
  await withRoutes(async () => {
    assert.equal((await listGet(request('/api/mobile/weekly-blocks', { uid: null }))).status, 401);
    assert.equal((await createPost(request('/api/mobile/weekly-blocks', { uid: null, body: EVERY_DAY }))).status, 401);
    assert.equal((await blockPatch(request(`/api/mobile/weekly-blocks/${ABSENT}`, { uid: null, method: 'PATCH', body: { status: 'paused' } }), params(ABSENT))).status, 401);
    assert.equal((await blockDelete(request(`/api/mobile/weekly-blocks/${ABSENT}`, { uid: null, method: 'DELETE' }), params(ABSENT))).status, 401);
    assert.equal((await occurrencesGet(request('/api/mobile/weekly-blocks/occurrences', { uid: null }))).status, 401);
    assert.deepEqual(await storage.list(userCol(USER, WEEKLY_BLOCKS)), []);
  });
});

test('POST without the person\'s confirmation stores nothing', async () => {
  await withRoutes(async () => {
    const { confirmation: _c, ...unconfirmed } = EVERY_DAY;
    const refused = await create(unconfirmed);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'confirmation_required');
    assert.deepEqual(await storage.list(userCol(USER, WEEKLY_BLOCKS)), []);
    assert.deepEqual(await storage.list(userCol(USER, BUSY_BLOCKS)), []);
  });
});

test('POST refuses an overnight block by its own code', async () => {
  await withRoutes(async () => {
    const refused = await create({ ...EVERY_DAY, start: '22:00', end: '02:00' });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'overnight_not_supported');
    assert.equal(refused.body.success, false);
  });
});

test('POST creates, GET lists, and the block reaches busy time', async () => {
  await withRoutes(async () => {
    const created = await create();
    assert.equal(created.status, 201);
    assert.equal(created.body.success, true);
    const block = created.body.block;
    assert.match(block.id, /^[0-9a-f-]{36}$/);
    assert.equal(block.status, 'active');
    assert.deepEqual(block.deviceEvent, {
      title: 'دوام', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '16:00', timezone: 'Asia/Jerusalem', startsOn: block.startsOn,
    });
    assert.equal('renewAt' in block, false);
    assert.ok((await storage.list(userCol(USER, BUSY_BLOCKS))).length >= 55, 'eight weeks of every day');

    const listed = await (await listGet(request('/api/mobile/weekly-blocks'))).json() as Record<string, any>;
    assert.deepEqual(listed, { success: true, items: [block] });
    const theirs = await (await listGet(request('/api/mobile/weekly-blocks', { uid: OTHER }))).json() as Record<string, any>;
    assert.deepEqual(theirs.items, []);
  });
});

test('PATCH pauses, edits and refuses; another account\'s id is 404', async () => {
  await withRoutes(async () => {
    const { body } = await create();
    const id = body.block.id as string;
    const patch = (payload: unknown, uid = USER) => blockPatch(request(`/api/mobile/weekly-blocks/${id}`, { method: 'PATCH', body: payload, uid }), params(id));

    assert.equal((await patch({ status: 'paused' }, OTHER)).status, 404);
    const paused = await patch({ status: 'paused' });
    assert.equal(paused.status, 200);
    const pausedBody = await paused.json() as Record<string, any>;
    assert.equal(pausedBody.block.status, 'paused');
    assert.equal(pausedBody.block.deviceEvent, null);

    const bad = await patch({ start: '17:00' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as Record<string, any>).code, 'overnight_not_supported');
    assert.equal((await patch({ confirmation: { confirmedByUserAt: new Date().toISOString() } })).status, 400);

    const renamed = await (await patch({ title: 'تدريب', status: 'active' })).json() as Record<string, any>;
    assert.equal(renamed.block.title, 'تدريب');
    assert.equal(renamed.block.deviceEvent.title, 'تدريب');

    const missing = await blockPatch(request(`/api/mobile/weekly-blocks/${ABSENT}`, { method: 'PATCH', body: { status: 'paused' } }), params(ABSENT));
    assert.equal(missing.status, 404);
    const notAnId = await blockPatch(request('/api/mobile/weekly-blocks/..', { method: 'PATCH', body: { status: 'paused' } }), params('..'));
    assert.equal(notAnId.status, 404);
  });
});

test('DELETE removes the block and its busy time; another account cannot', async () => {
  await withRoutes(async () => {
    const { body } = await create();
    const id = body.block.id as string;
    const remove = (uid = USER) => blockDelete(request(`/api/mobile/weekly-blocks/${id}`, { method: 'DELETE', uid }), params(id));
    assert.equal((await remove(OTHER)).status, 404);
    assert.ok((await storage.list(userCol(USER, BUSY_BLOCKS))).length > 0);
    const deleted = await remove();
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { success: true, deleted: true });
    assert.deepEqual(await storage.list(userCol(USER, WEEKLY_BLOCKS)), []);
    assert.deepEqual(await storage.list(userCol(USER, BUSY_BLOCKS)), []);
    assert.equal((await remove()).status, 404);
  });
});

test('occurrences: titled, inside the window, refused past 62 days', async () => {
  await withRoutes(async () => {
    const { body } = await create();
    const from = new Date();
    const to = new Date(from.getTime() + 3 * 86_400_000);
    const response = await occurrencesGet(request(`/api/mobile/weekly-blocks/occurrences?from=${from.toISOString()}&to=${to.toISOString()}`));
    assert.equal(response.status, 200);
    const read = await response.json() as Record<string, any>;
    assert.equal(read.success, true);
    assert.equal(read.from, from.toISOString());
    assert.equal(read.to, to.toISOString());
    assert.ok(read.items.length >= 2 && read.items.length <= 4, `three days of every day, got ${read.items.length}`);
    for (const item of read.items) {
      assert.deepEqual(Object.keys(item).sort(), ['endAt', 'occurrenceId', 'startAt', 'title', 'weeklyBlockId']);
      assert.equal(item.title, 'دوام');
      assert.equal(item.weeklyBlockId, body.block.id);
      assert.ok(Date.parse(item.endAt) > from.getTime() && Date.parse(item.startAt) < to.getTime());
    }
    const defaulted = await (await occurrencesGet(request('/api/mobile/weekly-blocks/occurrences'))).json() as Record<string, any>;
    assert.equal(Date.parse(defaulted.to) - Date.parse(defaulted.from), 7 * 86_400_000);
    const wide = await occurrencesGet(request(`/api/mobile/weekly-blocks/occurrences?from=${from.toISOString()}&to=${new Date(from.getTime() + 63 * 86_400_000).toISOString()}`));
    assert.equal(wide.status, 400);
    const backwards = await occurrencesGet(request(`/api/mobile/weekly-blocks/occurrences?from=${to.toISOString()}&to=${from.toISOString()}`));
    assert.equal(backwards.status, 400);
    const theirs = await (await occurrencesGet(request('/api/mobile/weekly-blocks/occurrences', { uid: OTHER }))).json() as Record<string, any>;
    assert.deepEqual(theirs.items, []);
  });
});

test('the manual busy route cannot delete a weekly block\'s occurrences behind its back', async () => {
  await withRoutes(async () => {
    const { body } = await create();
    const before = (await storage.list(userCol(USER, BUSY_BLOCKS))).length;
    const response = await manualDelete(request(`/api/mobile/calendar/manual?sourceId=weekly-${body.block.id}`, { method: 'DELETE' }));
    assert.equal(response.status, 400);
    assert.equal((await storage.list(userCol(USER, BUSY_BLOCKS))).length, before);
  });
});
