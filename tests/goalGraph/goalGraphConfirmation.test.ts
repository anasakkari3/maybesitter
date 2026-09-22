/**
 * Confirming selected nodes into real work (#526, slice 2).
 *
 * The claims this file has to make are the ones a reviewer cannot check by
 * reading: that the entities appear in the account's own collections and not
 * somewhere this feature invented, that a node nobody selected produces
 * nothing at all, and that pressing confirm twice leaves one commitment.
 *
 * The idempotency test is the one checked by mutation — see the commit
 * message. Removing the claim's replay branch leaves every other test in this
 * file green and puts a second gym session in somebody's week on the second
 * tap, which is a defect no shape assertion can see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getStorage,
  resetStorageForTests,
  setStorageForTests,
} from '../../lib/storage/index.ts';
import { COMMITMENTS, GOAL_GRAPH_LINKS, userCol } from '../../lib/storage/paths.ts';
import { createHabitServices } from '../../lib/services/habits/habitService.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { generateGoalExecutionGraph } from '../../lib/goalGraph/generateGoalGraph.ts';
import { confirmGoalGraphNodes } from '../../lib/goalGraph/confirmGoalGraph.ts';
import { createStorageGoalNodeLinkStore, goalNodeLinkIdFor } from '../../lib/goalGraph/linkStore.ts';
import { goalNodeKeyOf } from '../../lib/goalGraph/ids.ts';
import { validateGoalExecutionGraph } from '../../lib/goalGraph/validateGoalGraph.ts';
import type { GoalExecutionGraph } from '../../src/contracts/v1/goalGraphContracts.ts';
import { NOW, OWNER, seedGoal } from './goalGraphSupport.ts';

const CONFIRMED_AT = '2026-09-22T12:00:00.000Z';

/** A weekly cadence the person stated. Nothing here defaults one. */
const GYM = {
  cadence: { kind: 'weekly_count', count: 3 },
  durationMinutes: 60,
  minimumOccurrences: 3,
  maximumOccurrences: 3,
  flexibility: 'flexible' as const,
  recoveryPolicy: 'skip' as const,
};

async function generatedGraph(): Promise<{ graph: GoalExecutionGraph; goalId: string }> {
  const { storage, goal } = await seedGoal();
  setStorageForTests(storage);
  const { graph } = await generateGoalExecutionGraph({ goal, generatedAt: NOW });
  return { graph, goalId: goal.id };
}

function stepNodeIds(graph: GoalExecutionGraph): string[] {
  return graph.nodes
    .filter((node) => node.kind === 'decomposition_step_proposal')
    .map((node) => node.nodeId);
}

async function commitmentIds(): Promise<string[]> {
  const state = await getParticipantStateSnapshot(OWNER);
  return Object.keys(state.commitments).sort();
}

test('confirming one node creates one commitment, and the graph links it', async (t) => {
  t.after(resetStorageForTests);
  const { graph, goalId } = await generatedGraph();
  const [first, second] = stepNodeIds(graph);

  const result = await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'commitment' }],
    confirmedAt: CONFIRMED_AT,
  });

  assert.equal(result.created.length, 1);
  assert.deepEqual(result.replayed, []);
  assert.deepEqual(result.refused, []);

  const link = result.created[0];
  assert.equal(link.nodeKey, goalNodeKeyOf(first));
  assert.equal(link.confirmedFromGeneration, graph.generation);
  assert.equal(link.entityKind, 'commitment');
  assert.equal(link.state, 'linked');
  assert.equal(link.goalMemoryId, goalId);
  assert.equal(link.confirmedByUserAt, CONFIRMED_AT);
  assert.ok(link.entityId);

  // The commitment is in the account's own collection, active, titled by the
  // node — created through the same boundary a captured commitment is.
  const state = await getParticipantStateSnapshot(OWNER);
  assert.deepEqual(Object.keys(state.commitments), [link.entityId]);
  const commitment = state.commitments[link.entityId!];
  assert.equal(commitment.status, 'active');
  assert.equal(commitment.title, 'Launch the side project: build the landing page');
  // No invented time, one slice after generation was built to refuse one.
  assert.equal(commitment.timeSpec.dueAt, null);
  assert.equal(commitment.timeSpec.remindAt, null);

  // The node is now a link, at the same nodeId, so the edges still hold.
  const confirmed = result.graph.nodes.find((node) => node.nodeId === first);
  assert.equal(confirmed?.kind, 'linked_commitment');
  assert.equal(confirmed?.kind === 'linked_commitment' && confirmed.commitmentId, link.entityId);
  assert.equal(confirmed?.status, 'confirmed');
  assert.deepEqual(result.graph.edges, graph.edges);
  assert.deepEqual(
    validateGoalExecutionGraph(result.graph, { goalText: 'unused for topology' })
      .filter((violation) => violation.code !== 'INVENTED_TIMING'),
    [],
  );

  // And the node nobody selected is untouched and created nothing.
  assert.equal(result.graph.nodes.find((node) => node.nodeId === second)?.kind, 'decomposition_step_proposal');
});

test('an unselected node creates nothing at all', async (t) => {
  t.after(resetStorageForTests);
  const { graph } = await generatedGraph();
  const [first] = stepNodeIds(graph);

  await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'commitment' }],
    confirmedAt: CONFIRMED_AT,
  });

  // Exactly one commitment and exactly one link, for a graph of three nodes.
  assert.equal((await commitmentIds()).length, 1);
  const links = await createStorageGoalNodeLinkStore().list(OWNER, graph.goalMemoryId);
  assert.deepEqual(links.map((link) => link.nodeKey), [goalNodeKeyOf(first)]);
  assert.deepEqual(await createHabitServices().habits.list(OWNER), []);
});

test('confirming the same node twice creates one commitment', async (t) => {
  t.after(resetStorageForTests);
  const { graph } = await generatedGraph();
  const [first] = stepNodeIds(graph);
  const selections = [{ nodeId: first, as: 'commitment' as const }];

  const once = await confirmGoalGraphNodes({ graph, selections, confirmedAt: CONFIRMED_AT });
  const twice = await confirmGoalGraphNodes({ graph, selections, confirmedAt: '2026-09-23T12:00:00.000Z' });

  assert.equal(once.created.length, 1);
  assert.deepEqual(twice.created, [], 'the second confirm created something');
  assert.equal(twice.replayed.length, 1);
  assert.equal(twice.replayed[0].entityId, once.created[0].entityId);
  // And the second press did not restamp the first decision.
  assert.equal(twice.replayed[0].confirmedByUserAt, CONFIRMED_AT);

  assert.deepEqual(await commitmentIds(), [once.created[0].entityId]);
  assert.equal((await createStorageGoalNodeLinkStore().list(OWNER, graph.goalMemoryId)).length, 1);
});

test('one request naming a node twice is the same double press', async (t) => {
  t.after(resetStorageForTests);
  const { graph } = await generatedGraph();
  const [first] = stepNodeIds(graph);

  const result = await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'commitment' }, { nodeId: first, as: 'commitment' }],
    confirmedAt: CONFIRMED_AT,
  });

  assert.equal(result.created.length, 1);
  assert.deepEqual(result.replayed, [], 'a duplicate inside one request is not a replay of anything');
  assert.equal((await commitmentIds()).length, 1);
});

test('a node confirmed as a habit goes through the habits API’s own validator', async (t) => {
  t.after(resetStorageForTests);
  const { graph } = await generatedGraph();
  const [first, second] = stepNodeIds(graph);

  const result = await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'habit', habit: GYM }],
    confirmedAt: CONFIRMED_AT,
  });

  assert.equal(result.created.length, 1);
  const habits = await createHabitServices().habits.list(OWNER);
  assert.equal(habits.length, 1);
  assert.equal(habits[0].habitId, result.created[0].entityId);
  assert.equal(habits[0].title, 'Launch the side project: build the landing page');
  assert.deepEqual(habits[0].cadence, { kind: 'weekly_count', count: 3 });
  // Where it came from is the server's to say, never the caller's.
  assert.equal(habits[0].source, 'goal_confirmed');
  assert.equal(result.graph.nodes.find((node) => node.nodeId === first)?.kind, 'linked_habit');
  // A commitment was not also created for it.
  assert.deepEqual(await commitmentIds(), []);

  // A habit with no cadence is refused, and leaves nothing behind — the whole
  // of "a cadence is never inferred from a goal sentence".
  const refused = await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: second, as: 'habit', habit: { durationMinutes: 30 } }],
    confirmedAt: CONFIRMED_AT,
  });
  assert.deepEqual(refused.created, []);
  assert.deepEqual(refused.refused.map((entry) => entry.code), ['habit_input_invalid']);
  assert.equal((await createHabitServices().habits.list(OWNER)).length, 1);
  assert.equal(
    await createStorageGoalNodeLinkStore().get(OWNER, goalNodeLinkIdFor(graph.goalMemoryId, second)),
    null,
    'a refused habit left a pending claim behind',
  );
});

test('the checkpoint and an unknown id are refused rather than created', async (t) => {
  t.after(resetStorageForTests);
  const { graph } = await generatedGraph();
  const checkpoint = graph.nodes.find((node) => node.kind === 'checkpoint');

  const result = await confirmGoalGraphNodes({
    graph,
    selections: [
      { nodeId: checkpoint!.nodeId, as: 'commitment' },
      { nodeId: 'g1.step.nowhere', as: 'commitment' },
    ],
    confirmedAt: CONFIRMED_AT,
  });

  assert.deepEqual(result.created, []);
  assert.deepEqual(result.refused.map((entry) => [entry.nodeId, entry.code]), [
    [checkpoint!.nodeId, 'node_not_confirmable'],
    ['g1.step.nowhere', 'unknown_node'],
  ]);
  // A refusal names both, because the id is what the client sent and the key
  // is what a link would have been filed under.
  assert.deepEqual(result.refused.map((entry) => entry.nodeKey), ['checkpoint.goal', 'step.nowhere']);
  assert.deepEqual(await commitmentIds(), []);
  assert.deepEqual(
    await createStorageGoalNodeLinkStore().list(OWNER, graph.goalMemoryId),
    [],
  );
});

test('confirming two nodes creates exactly those two, and nothing for the third', async (t) => {
  t.after(resetStorageForTests);
  const { graph } = await generatedGraph();
  const [first, second] = stepNodeIds(graph);

  const result = await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'commitment' }, { nodeId: second, as: 'habit', habit: GYM }],
    confirmedAt: CONFIRMED_AT,
  });

  assert.equal(result.created.length, 2);
  assert.equal((await commitmentIds()).length, 1);
  assert.equal((await createHabitServices().habits.list(OWNER)).length, 1);
  assert.deepEqual(
    result.graph.nodes.map((node) => node.kind).sort(),
    ['checkpoint', 'linked_commitment', 'linked_habit'],
  );
});

test('unlinking removes the link and leaves the commitment in the account', async (t) => {
  t.after(resetStorageForTests);
  const { graph } = await generatedGraph();
  const [first] = stepNodeIds(graph);
  const links = createStorageGoalNodeLinkStore();

  const { created } = await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'commitment' }],
    confirmedAt: CONFIRMED_AT,
  });
  const commitmentId = created[0].entityId!;

  assert.equal(await links.remove(OWNER, created[0].linkId), true);
  assert.equal(await links.remove(OWNER, created[0].linkId), false);

  // #526: unlinking a node does not delete canonical work. The commitment is
  // still there, still active, still the user's — only the goal no longer
  // claims it.
  const state = await getParticipantStateSnapshot(OWNER);
  assert.deepEqual(Object.keys(state.commitments), [commitmentId]);
  assert.equal(state.commitments[commitmentId].status, 'active');
  assert.deepEqual(await links.list(OWNER, graph.goalMemoryId), []);
});

test('the link collection holds the decision and no copy of the commitment', async (t) => {
  t.after(resetStorageForTests);
  const { graph } = await generatedGraph();
  const [first] = stepNodeIds(graph);
  await confirmGoalGraphNodes({
    graph,
    selections: [{ nodeId: first, as: 'commitment' }],
    confirmedAt: CONFIRMED_AT,
  });

  const rows = await getStorage().list<Record<string, unknown>>(userCol(OWNER, GOAL_GRAPH_LINKS));
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0].data).sort(), [
    'confirmedByUserAt',
    'confirmedFromGeneration',
    'createdAt',
    'entityId',
    'entityKind',
    'goalMemoryId',
    'linkId',
    'nodeKey',
    'schemaVersion',
    'scopeId',
    'state',
    'updatedAt',
  ]);
  // Not a title, not a status, not a due date. The commitment is over there.
  assert.equal((await getStorage().list(userCol(OWNER, COMMITMENTS))).length, 1);
});
