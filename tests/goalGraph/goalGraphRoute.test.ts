/**
 * `POST /api/mobile/goals/{goalId}/execution/generate` (#526, slice 1).
 *
 * The route is thin, and the two things worth asserting at this level are the
 * two a service test cannot see: that an unauthenticated caller gets nowhere,
 * and that a goal id belonging to somebody else answers exactly as an id that
 * does not exist. A 403 or a 400 there would tell a stranger that an id is
 * real, which for a memory id is the whole of the leak.
 *
 * The "writes nothing" criteria are asserted through the store in
 * `goalGraphIsolation.test.ts`; repeated here only as a document count, so a
 * route that grew a write of its own is caught at this level too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { USER_SCOPED_COLLECTIONS, userCol } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { POST as generatePost } from '../../src/app/api/mobile/goals/[goalId]/execution/generate/route.ts';
import { seedGoal, SPLITTABLE_GOAL } from './goalGraphSupport.ts';

const baseUrl = 'http://127.0.0.1:4321';
const USER = uidFor('GoalGraphRouteUser');
const OTHER = uidFor('GoalGraphOtherUser');

let auth: FakeAuthControls | null = null;

function req(goalId: string, uid: string | null = USER): Request {
  const headers = new Headers();
  if (uid !== null) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`${baseUrl}/api/mobile/goals/${goalId}/execution/generate`, { method: 'POST', headers });
}

function context(goalId: string): { params: Promise<{ goalId: string }> } {
  return { params: Promise.resolve({ goalId }) };
}

async function documentCount(uid: string): Promise<number> {
  const storage = getStorage();
  let total = 0;
  for (const collection of USER_SCOPED_COLLECTIONS) {
    total += (await storage.list(userCol(uid, collection))).length;
  }
  return total;
}

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

test('a confirmed goal answers with its execution graph and writes nothing', async () => {
  const teardown = setup();
  try {
    const { goal } = await seedGoal(SPLITTABLE_GOAL, { scopeId: USER, storage: getStorage() });
    const before = await documentCount(USER);

    const response = await generatePost(req(goal.id), context(goal.id));
    assert.equal(response.status, 200);
    const body = await response.json() as { success: boolean; graph: Record<string, unknown> };

    assert.equal(body.success, true);
    assert.equal(body.graph.goalMemoryId, goal.id);
    assert.equal(body.graph.scopeId, USER);
    assert.equal((body.graph.nodes as unknown[]).length, 3);
    assert.equal(await documentCount(USER), before);
  } finally {
    teardown();
  }
});

test('an unauthenticated caller reaches no goal at all', async () => {
  const teardown = setup();
  try {
    const { goal } = await seedGoal(SPLITTABLE_GOAL, { scopeId: USER, storage: getStorage() });
    const response = await generatePost(req(goal.id, null), context(goal.id));
    assert.equal(response.status, 401);
  } finally {
    teardown();
  }
});

test('another account’s goal id answers as an id that does not exist', async () => {
  const teardown = setup();
  try {
    const { goal } = await seedGoal(SPLITTABLE_GOAL, { scopeId: USER, storage: getStorage() });

    const theirs = await generatePost(req(goal.id, OTHER), context(goal.id));
    const missing = await generatePost(req('no-such-id', OTHER), context('no-such-id'));

    assert.equal(theirs.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await theirs.json(), await missing.json());
  } finally {
    teardown();
  }
});

test('a memory that is not a goal is refused as a bad request, not a 404', async () => {
  const teardown = setup();
  try {
    const { goal: fact } = await seedGoal('I prefer mornings', { scopeId: USER, storage: getStorage() });
    // Written as a goal by the fixture, then demoted in place — the state a
    // client reaches by passing the id of an ordinary memory record.
    const storage = getStorage();
    const path = `${userCol(USER, 'memory')}/${fact.id}`;
    await storage.set(path, { ...(await storage.get<Record<string, unknown>>(path)), kind: 'fact' });

    const response = await generatePost(req(fact.id), context(fact.id));
    assert.equal(response.status, 400);
    const body = await response.json() as { reason: string };
    assert.equal(body.reason, 'not_a_confirmed_goal');
  } finally {
    teardown();
  }
});
