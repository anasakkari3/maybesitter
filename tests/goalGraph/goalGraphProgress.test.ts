/**
 * Progress, counted from the entities themselves (#526, slice 2).
 *
 * The rule the issue states is "do not let the model set 73% complete", and
 * the failure it guards against is not a model writing a number — it is a
 * *stored* number of any provenance, which is stale the moment somebody ticks
 * something off on another device. So the assertions here are all of the same
 * shape: change the canonical entity, read progress again, and the answer has
 * to have moved without anything having been recomputed or written.
 *
 * The three worked examples in the issue each have a test: how many confirmed
 * nodes are done, how many of a milestone's commitments are done, and how many
 * habit occurrences were achieved this period.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getStorage,
  resetStorageForTests,
  setStorageForTests,
} from '../../lib/storage/index.ts';
import { USER_SCOPED_COLLECTIONS, userCol, userDoc } from '../../lib/storage/paths.ts';
import { createHabitServices } from '../../lib/services/habits/habitService.ts';
import {
  applyParticipantCommand,
  getParticipantStateSnapshot,
} from '../../lib/services/mobile/participantState.ts';
import { generateGoalExecutionGraph } from '../../lib/goalGraph/generateGoalGraph.ts';
import { confirmGoalGraphNodes } from '../../lib/goalGraph/confirmGoalGraph.ts';
import { deriveGoalGraphProgress } from '../../lib/goalGraph/deriveProgress.ts';
import { createStorageGoalNodeLinkStore } from '../../lib/goalGraph/linkStore.ts';
import { goalNodeKeyOf } from '../../lib/goalGraph/ids.ts';
import type { GoalExecutionGraph } from '../../src/contracts/v1/goalGraphContracts.ts';
import { NOW, OWNER, seedGoal } from './goalGraphSupport.ts';

const CONFIRMED_AT = '2026-09-22T12:00:00.000Z';
const DERIVED_AT = '2026-09-24T12:00:00.000Z';
const THIS_WEEK = { fromLocalDate: '2026-09-21', toLocalDate: '2026-09-27' };

const GYM = {
  cadence: { kind: 'weekly_count', count: 3 },
  durationMinutes: 60,
  minimumOccurrences: 3,
  maximumOccurrences: 3,
  flexibility: 'flexible' as const,
  recoveryPolicy: 'skip' as const,
};

async function generatedGraph(): Promise<GoalExecutionGraph> {
  const { storage, goal } = await seedGoal();
  setStorageForTests(storage);
  const { graph } = await generateGoalExecutionGraph({ goal, generatedAt: NOW });
  return graph;
}

function stepNodeIds(graph: GoalExecutionGraph): string[] {
  return graph.nodes
    .filter((node) => node.kind === 'decomposition_step_proposal')
    .map((node) => node.nodeId);
}

function progressOf(graph: GoalExecutionGraph) {
  return deriveGoalGraphProgress({
    scopeId: OWNER,
    goalMemoryId: graph.goalMemoryId,
    period: THIS_WEEK,
    derivedAt: DERIVED_AT,
  });
}

/** Every document in the account, so a "read" that wrote is visible. */
async function snapshot(): Promise<string[]> {
  const storage = getStorage();
  const rows: string[] = [];
  const root = await storage.get(userDoc(OWNER));
  if (root !== null) rows.push(`${userDoc(OWNER)} = ${JSON.stringify(root)}`);
  for (const collection of USER_SCOPED_COLLECTIONS) {
    for (const row of await storage.list(userCol(OWNER, collection))) {
      rows.push(`${userCol(OWNER, collection)}/${row.id} = ${JSON.stringify(row.data)}`);
    }
  }
  return rows.sort();
}

test('a goal with nothing confirmed has nothing to report', async (t) => {
  t.after(resetStorageForTests);
  const graph = await generatedGraph();
  const progress = await progressOf(graph);

  assert.equal(progress.confirmedCount, 0);
  assert.equal(progress.completedCount, 0);
  assert.deepEqual(progress.nodes, []);
  assert.equal(progress.derivedAt, DERIVED_AT);
  // Not "0% of the goal". There is nothing to be a fraction of yet, and the
  // shape has no field that could claim otherwise.
  assert.equal('percent' in progress, false);
});

test('completing a linked commitment moves progress, with nothing rewritten', async (t) => {
  t.after(resetStorageForTests);
  const graph = await generatedGraph();
  const [first, second] = stepNodeIds(graph);
  const { created } = await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'commitment' }, { nodeId: second, as: 'commitment' }],
    confirmedAt: CONFIRMED_AT,
  });

  const before = await progressOf(graph);
  assert.equal(before.confirmedCount, 2);
  assert.equal(before.completedCount, 0);
  assert.deepEqual(before.nodes.map((node) => node.completed), [false, false]);

  // The user ticks one off, through the ordinary domain command — not through
  // anything this feature owns.
  const done = created.find((link) => link.nodeKey === goalNodeKeyOf(first))!;
  await applyParticipantCommand(OWNER, {
    type: 'Complete',
    commitmentId: done.entityId!,
    now: DERIVED_AT,
  });

  const after = await progressOf(graph);
  assert.equal(after.completedCount, 1);
  assert.equal(after.confirmedCount, 2);
  const node = after.nodes.find((entry) => entry.nodeKey === goalNodeKeyOf(first));
  assert.equal(node?.entityKind, 'commitment');
  assert.equal(node?.entityKind === 'commitment' && node.status, 'completed');
  assert.equal(node?.completed, true);
  // The link itself never changed — progress is read through it, not into it.
  const links = await createStorageGoalNodeLinkStore().list(OWNER, graph.goalMemoryId);
  assert.deepEqual(links.map((link) => link.updatedAt), [CONFIRMED_AT, CONFIRMED_AT]);
});

test('deriving progress writes nothing anywhere in the account', async (t) => {
  t.after(resetStorageForTests);
  const graph = await generatedGraph();
  const [first] = stepNodeIds(graph);
  await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'commitment' }],
    confirmedAt: CONFIRMED_AT,
  });

  const before = await snapshot();
  assert.ok(before.length > 0, 'nothing was stored, so this run would prove nothing');
  const once = await progressOf(graph);
  const twice = await progressOf(graph);

  assert.deepEqual(await snapshot(), before);
  // And two reads of an unchanged account agree, which a stored figure being
  // lazily refreshed on read would not guarantee.
  assert.deepEqual(twice, once);
});

test('a dropped commitment is not progress, and a deleted one is not an error', async (t) => {
  t.after(resetStorageForTests);
  const graph = await generatedGraph();
  const [first, second] = stepNodeIds(graph);
  const { created } = await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'commitment' }, { nodeId: second, as: 'commitment' }],
    confirmedAt: CONFIRMED_AT,
  });

  // Giving up on something is not the same as finishing it.
  await applyParticipantCommand(OWNER, {
    type: 'Drop',
    commitmentId: created.find((link) => link.nodeKey === goalNodeKeyOf(first))!.entityId!,
    now: DERIVED_AT,
  });
  const dropped = await progressOf(graph);
  assert.equal(dropped.completedCount, 0);
  assert.equal(
    dropped.nodes.find((node) => node.nodeKey === goalNodeKeyOf(first))?.entityKind === 'commitment'
      && (dropped.nodes.find((node) => node.nodeKey === goalNodeKeyOf(first)) as { status: string }).status,
    'dropped',
  );

  // And the destructive action the user may take separately: the commitment is
  // gone, the link survives, and the goal screen still renders.
  const orphanedId = created.find((link) => link.nodeKey === goalNodeKeyOf(second))!.entityId!;
  await getStorage().delete(`${userCol(OWNER, 'commitments')}/${orphanedId}`);
  const missing = await progressOf(graph);
  const node = missing.nodes.find((entry) => entry.nodeKey === goalNodeKeyOf(second));
  assert.equal(node?.entityKind === 'commitment' && node.status, 'missing');
  assert.equal(node?.completed, false);
  assert.equal(missing.confirmedCount, 2);
});

test('a habit reports occurrences achieved inside the period, and only those', async (t) => {
  t.after(resetStorageForTests);
  const graph = await generatedGraph();
  const [first] = stepNodeIds(graph);
  const { created } = await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'habit', habit: GYM }],
    confirmedAt: CONFIRMED_AT,
  });
  const habitId = created[0].entityId!;
  const store = createHabitServices().occurrences;

  // Three this week, one last week. The habit is met at three.
  const dates: [string, 'completed' | 'pending'][] = [
    ['2026-09-14', 'completed'],
    ['2026-09-21', 'completed'],
    ['2026-09-23', 'completed'],
    ['2026-09-26', 'pending'],
  ];
  await store.putMany(OWNER, dates.map(([localDate, state]) => ({
    occurrenceId: `${habitId}.${localDate}.0`,
    habitId,
    localDate,
    ordinal: 0,
    recoveredFromOccurrenceId: null,
    state,
    durationMinutes: 60,
  })));

  const partway = await progressOf(graph);
  const node = partway.nodes[0];
  assert.equal(node.entityKind, 'habit');
  assert.equal(node.entityKind === 'habit' && node.completedOccurrences, 2, 'last week counted');
  assert.equal(node.entityKind === 'habit' && node.targetOccurrences, 3);
  assert.equal(node.completed, false);
  assert.equal(partway.completedCount, 0);

  // The third one this week meets the habit's own minimum.
  await store.transition(OWNER, habitId, `${habitId}.2026-09-26.0`, 'completed');
  const met = await progressOf(graph);
  assert.equal(met.nodes[0].entityKind === 'habit' && met.nodes[0].completedOccurrences, 3);
  assert.equal(met.nodes[0].completed, true);
  assert.equal(met.completedCount, 1);
});

test('a deleted habit reports a target of zero and is not called achieved', async (t) => {
  t.after(resetStorageForTests);
  const graph = await generatedGraph();
  const [first] = stepNodeIds(graph);
  const { created } = await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'habit', habit: GYM }],
    confirmedAt: CONFIRMED_AT,
  });

  assert.equal(await createHabitServices().habits.remove(OWNER, created[0].entityId!), true);
  const progress = await progressOf(graph);
  const node = progress.nodes[0];

  // Zero of zero must not read as "done" — the one wrong answer here.
  assert.equal(node.entityKind === 'habit' && node.targetOccurrences, 0);
  assert.equal(node.completed, false);
  assert.equal(progress.completedCount, 0);
});

test('a period nobody scoped counts nothing rather than everything', async (t) => {
  t.after(resetStorageForTests);
  const graph = await generatedGraph();
  const [first] = stepNodeIds(graph);
  const { created } = await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'habit', habit: GYM }],
    confirmedAt: CONFIRMED_AT,
  });
  const habitId = created[0].entityId!;
  await createHabitServices().occurrences.putMany(OWNER, ['2026-09-21', '2026-09-23', '2026-09-25'].map((localDate) => ({
    occurrenceId: `${habitId}.${localDate}.0`,
    habitId,
    localDate,
    ordinal: 0,
    recoveredFromOccurrenceId: null,
    state: 'completed' as const,
    durationMinutes: 60,
  })));

  const unscoped = await deriveGoalGraphProgress({
    scopeId: OWNER,
    goalMemoryId: graph.goalMemoryId,
    derivedAt: DERIVED_AT,
  });
  assert.equal(unscoped.nodes[0].entityKind === 'habit' && unscoped.nodes[0].completedOccurrences, 0);
  assert.equal(unscoped.completedCount, 0);
});

test('progress is blind to commitments the goal never linked', async (t) => {
  t.after(resetStorageForTests);
  const graph = await generatedGraph();
  const [first] = stepNodeIds(graph);
  await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'commitment' }],
    confirmedAt: CONFIRMED_AT,
  });

  // An ordinary commitment of the user's, completed, with nothing to do with
  // this goal. Counting it would make every goal look finished.
  await applyParticipantCommand(OWNER, {
    type: 'CreateDraft',
    now: CONFIRMED_AT,
    commitment: { id: 'unrelated-1', kind: 'task', title: 'Buy milk' },
  });
  await applyParticipantCommand(OWNER, { type: 'ConfirmCommitment', commitmentId: 'unrelated-1', now: CONFIRMED_AT });
  await applyParticipantCommand(OWNER, { type: 'Complete', commitmentId: 'unrelated-1', now: DERIVED_AT });

  const progress = await progressOf(graph);
  assert.equal((await getParticipantStateSnapshot(OWNER)).commitments['unrelated-1'].status, 'completed');
  assert.equal(progress.confirmedCount, 1);
  assert.equal(progress.completedCount, 0);
});
