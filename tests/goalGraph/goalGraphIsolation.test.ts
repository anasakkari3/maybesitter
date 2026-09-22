/**
 * The two acceptance criteria of #526 that are about what does *not* happen.
 *
 *   "Existing stored Goal alone changes nothing in Daily Plan."
 *   "Generate writes no Commitment/Habit."
 *
 * Both are claims about absence, and the usual way of testing one — reading
 * the collection you happen to be worried about and finding it empty — is the
 * shape of test that passes for the wrong reason. It passes if generation
 * wrote to a collection nobody thought to look in, and it passes if the
 * collection was empty for some other reason.
 *
 * So this compares the *whole* account tree before and after: every collection
 * in `USER_SCOPED_COLLECTIONS`, which is the registry `deletionScopeCoverage`
 * and `deletionCoverage` already hold the rest of the repo to, plus the user
 * document itself. A collection added next sprint is covered the day it is
 * added, and a write anywhere at all fails the assertion with the path in the
 * message.
 *
 * The red→green proof in the commit message is against this file: making
 * `generateGoalExecutionGraph` call the real habit writer turns it red, and
 * nothing else in the suite notices.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import {
  COMMITMENTS,
  MEMORY,
  PLANS,
  PLAN_EVENTS,
  REMINDERS,
  USER_SCOPED_COLLECTIONS,
  userCol,
  userDoc,
} from '../../lib/storage/paths.ts';
import { createStorageHabitStore } from '../../lib/habits/habitStore.ts';
import {
  resetStorageForTests,
  setStorageForTests,
  type StorageAdapter,
} from '../../lib/storage/index.ts';
import { generateGoalExecutionGraph } from '../../lib/goalGraph/generateGoalGraph.ts';
import { generateGoalGraph } from '../../lib/services/mobile/goalGraphService.ts';
import { NOW, OWNER, seedGoal } from './goalGraphSupport.ts';

/**
 * Seeds the goal and installs its adapter as the process-wide one.
 *
 * The installation is the load-bearing part. Every canonical writer in this
 * repo reaches storage through `getStorage()`, so a snapshot taken over an
 * adapter that was only ever passed as an argument would miss a write made by
 * the real commitment path entirely — and the test would pass while generation
 * created a commitment. Verified by mutation: with the writer added, the
 * comparison below goes red.
 */
async function installedGoal(content?: string) {
  const seeded = await seedGoal(content);
  setStorageForTests(seeded.storage);
  return seeded;
}

/**
 * Every document in this account's tree, as a sorted list of `path → json`.
 *
 * Registry-driven rather than a hand-written list of the collections a graph
 * "might" touch, for the reason in the header. `userDoc` is included because
 * the account document is outside every collection and is where a lazy writer
 * would most plausibly stamp something.
 */
async function snapshot(storage: StorageAdapter, uid: string): Promise<string[]> {
  const rows: string[] = [];
  const root = await storage.get(userDoc(uid));
  if (root !== null) rows.push(`${userDoc(uid)} = ${JSON.stringify(root)}`);
  for (const collection of USER_SCOPED_COLLECTIONS) {
    for (const row of await storage.list(userCol(uid, collection))) {
      rows.push(`${userCol(uid, collection)}/${row.id} = ${JSON.stringify(row.data)}`);
    }
  }
  return rows.sort();
}

test('generating a graph leaves every collection in the account exactly as it was', async (t) => {
  t.after(resetStorageForTests);
  const { storage, goal } = await installedGoal();
  const before = await snapshot(storage, OWNER);
  // The goal really is stored, so "nothing changed" is not "nothing existed".
  assert.ok(
    before.some((row) => row.includes(goal.id)),
    'the goal was never written, so this run would prove nothing',
  );

  const { graph } = await generateGoalExecutionGraph({ goal, generatedAt: NOW });
  assert.ok(graph.nodes.length > 1, 'the fixture produced no proposal to speak of');

  assert.deepEqual(await snapshot(storage, OWNER), before);
});

test('generate writes no Commitment and no Habit, named collection by collection', async (t) => {
  t.after(resetStorageForTests);
  const { storage, goal } = await installedGoal();

  await generateGoalExecutionGraph({ goal, generatedAt: NOW });

  // The criterion names two things; the daily plan adds three more. Named here
  // in addition to the whole-tree comparison above, because a reader of this
  // file should be able to see the criterion rather than infer it from a loop.
  for (const collection of [COMMITMENTS, PLANS, PLAN_EVENTS, REMINDERS]) {
    assert.deepEqual(
      (await storage.list(userCol(OWNER, collection))).map((row) => row.id),
      [],
      `generate wrote into ${collection}`,
    );
  }
  // Habits now live on the same storage adapter as everything else (#520's
  // reconciliation), so the whole-tree comparison above already covers them —
  // asked of the store directly too, so a reader sees the criterion named
  // rather than only inferred from the tree diff.
  assert.deepEqual(await createStorageHabitStore(storage).list(OWNER), []);
});

test('the service path writes nothing either, including the goal it just read', async (t) => {
  t.after(resetStorageForTests);
  const { storage, goal } = await installedGoal();
  const before = await snapshot(storage, OWNER);

  const graph = await generateGoalGraph(OWNER, goal.id, NOW, { storage });

  assert.equal(graph.goalMemoryId, goal.id);
  assert.deepEqual(await snapshot(storage, OWNER), before);
  // Not even an `updatedAt` on the goal: reading a memory record must not
  // touch it, or "generate is read-only" would be false in the one collection
  // this feature definitely opens.
  const stored = await storage.list(userCol(OWNER, MEMORY));
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].data, goal);
});

test('a generated graph contains no link to a canonical entity', async (t) => {
  t.after(resetStorageForTests);
  const { goal } = await installedGoal();
  const { graph, violations } = await generateGoalExecutionGraph({ goal, generatedAt: NOW });

  assert.deepEqual(violations, [], 'generation produced a graph its own validator refuses');
  const linked = graph.nodes.filter((node) =>
    node.kind === 'linked_commitment' || node.kind === 'linked_habit');
  assert.deepEqual(linked, [], 'generation linked something it cannot have created');
  // And every node is a proposal, not a decision somebody has not made yet.
  assert.deepEqual(Array.from(new Set(graph.nodes.map((node) => node.status))), ['proposed']);
});

test('running generate twice writes nothing the second time either', async (t) => {
  t.after(resetStorageForTests);
  const { storage, goal } = await installedGoal();
  await generateGoalGraph(OWNER, goal.id, NOW, { storage });
  const after = await snapshot(storage, OWNER);
  await generateGoalGraph(OWNER, goal.id, NOW, { storage });
  assert.deepEqual(await snapshot(storage, OWNER), after);
});

test('another account’s goal id is not readable and writes nothing anywhere', async (t) => {
  t.after(resetStorageForTests);
  const storage = createMemoryStorage();
  const { goal } = await seedGoal(undefined, { storage });
  setStorageForTests(storage);
  const before = await snapshot(storage, OWNER);

  await assert.rejects(
    () => generateGoalGraph('goalGraphStranger', goal.id, NOW, { storage }),
    /not found/i,
  );
  assert.deepEqual(await snapshot(storage, OWNER), before);
});
