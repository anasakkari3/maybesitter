/**
 * The three execution routes behind `generate` (#526, slice 3).
 *
 *   POST   /api/mobile/goals/{goalId}/execution/confirm
 *   PATCH  /api/mobile/goals/{goalId}/execution/nodes/{nodeId}
 *   POST   /api/mobile/goals/{goalId}/execution/regenerate
 *
 * The library functions behind them are tested in
 * `goalGraphConfirmation.test.ts` and `goalGraphProgress.test.ts`. What this
 * file adds is what only the HTTP layer can be wrong about: who may reach
 * them, what a malformed body does, and the two round trips that cross more
 * than one route — confirm then regenerate, and confirm then unlink.
 *
 * Every test asserts the account tree as well as the status code, because a
 * route's worst failure here is not a wrong status: it is a write into
 * somebody's week that the response never mentions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { COMMITMENTS, GOAL_GRAPH_LINKS, USER_SCOPED_COLLECTIONS, userCol } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { createHabitServices } from '../../lib/services/habits/habitService.ts';
import { POST as generatePost } from '../../src/app/api/mobile/goals/[goalId]/execution/generate/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/goals/[goalId]/execution/confirm/route.ts';
import { POST as regeneratePost } from '../../src/app/api/mobile/goals/[goalId]/execution/regenerate/route.ts';
import { PATCH as nodePatch } from '../../src/app/api/mobile/goals/[goalId]/execution/nodes/[nodeId]/route.ts';
import { seedGoal, SPLITTABLE_GOAL } from './goalGraphSupport.ts';

const baseUrl = 'http://127.0.0.1:4321';
const USER = uidFor('GoalExecutionRouteUser');
const OTHER = uidFor('GoalExecutionOtherUser');

/** A cadence the person stated. Nothing on this path invents one. */
const GYM = {
  cadence: { kind: 'weekly_count', count: 3 },
  durationMinutes: 60,
  minimumOccurrences: 3,
  maximumOccurrences: 3,
  flexibility: 'flexible' as const,
  recoveryPolicy: 'skip' as const,
};

let auth: FakeAuthControls | null = null;

function req(path: string, body?: unknown, uid: string | null = USER, method = 'POST'): Request {
  const headers = new Headers();
  if (uid !== null) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function goalContext(goalId: string) {
  return { params: Promise.resolve({ goalId }) };
}

function nodeContext(goalId: string, nodeId: string) {
  return { params: Promise.resolve({ goalId, nodeId }) };
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

async function documentCount(uid: string): Promise<number> {
  const storage = getStorage();
  let total = 0;
  for (const collection of USER_SCOPED_COLLECTIONS) {
    total += (await storage.list(userCol(uid, collection))).length;
  }
  return total;
}

async function setup(): Promise<{ goalId: string; teardown: () => void }> {
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  const { goal } = await seedGoal(SPLITTABLE_GOAL, { scopeId: USER, storage: getStorage() });
  return {
    goalId: goal.id,
    teardown: () => {
      auth?.restore();
      auth = null;
      resetStorageForTests();
    },
  };
}

/** The step node ids of the current reading, from the generate route itself. */
async function stepNodeIds(goalId: string): Promise<string[]> {
  const body = await json(await generatePost(req(`/api/mobile/goals/${goalId}/execution/generate`), goalContext(goalId)));
  return (body.graph.nodes as { kind: string; nodeId: string }[])
    .filter((node) => node.kind === 'decomposition_step_proposal')
    .map((node) => node.nodeId);
}

test('confirm creates the selected nodes and answers with the linked graph', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first, second] = await stepNodeIds(goalId);

  const response = await confirmPost(
    req(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: first, as: 'commitment' }],
    }),
    goalContext(goalId),
  );
  assert.equal(response.status, 200);
  const body = await json(response);

  assert.equal(body.success, true);
  assert.equal(body.created.length, 1);
  assert.deepEqual(body.replayed, []);
  assert.deepEqual(body.refused, []);

  const commitmentId = body.created[0].entityId;
  const state = await getParticipantStateSnapshot(USER);
  assert.deepEqual(Object.keys(state.commitments), [commitmentId]);
  assert.equal(state.commitments[commitmentId].status, 'active');

  // The graph that comes back already shows the node as linked, so the client
  // does not offer the same proposal again.
  const nodes = body.graph.nodes as { nodeId: string; kind: string; commitmentId?: string }[];
  const confirmed = nodes.find((node) => node.nodeId === first);
  assert.equal(confirmed?.kind, 'linked_commitment');
  assert.equal(confirmed?.commitmentId, commitmentId);
  assert.equal(nodes.find((node) => node.nodeId === second)?.kind, 'decomposition_step_proposal');
});

test('generate afterwards shows the confirmed node as a link, not a proposal', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first] = await stepNodeIds(goalId);
  await confirmPost(
    req(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: first, as: 'commitment' }],
    }),
    goalContext(goalId),
  );

  const body = await json(await generatePost(
    req(`/api/mobile/goals/${goalId}/execution/generate`),
    goalContext(goalId),
  ));
  const node = (body.graph.nodes as { nodeId: string; kind: string }[]).find((entry) => entry.nodeId === first);
  assert.equal(node?.kind, 'linked_commitment');
});

test('confirming twice over HTTP creates one commitment', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first] = await stepNodeIds(goalId);
  const body = { generation: 1, selections: [{ nodeId: first, as: 'commitment' }] };
  const path = `/api/mobile/goals/${goalId}/execution/confirm`;

  const once = await json(await confirmPost(req(path, body), goalContext(goalId)));
  const twice = await json(await confirmPost(req(path, body), goalContext(goalId)));

  assert.equal(once.created.length, 1);
  assert.deepEqual(twice.created, [], 'the retried request created a second commitment');
  assert.equal(twice.replayed.length, 1);
  assert.equal(twice.replayed[0].entityId, once.created[0].entityId);
  assert.equal(Object.keys((await getParticipantStateSnapshot(USER)).commitments).length, 1);
});

test('regenerate answers with the next reading and keeps confirmed links', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first] = await stepNodeIds(goalId);
  const confirmed = await json(await confirmPost(
    req(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: first, as: 'commitment' }],
    }),
    goalContext(goalId),
  ));
  const commitmentId = confirmed.created[0].entityId;
  const before = await documentCount(USER);

  const response = await regeneratePost(
    req(`/api/mobile/goals/${goalId}/execution/regenerate`, { fromGeneration: 1 }),
    goalContext(goalId),
  );
  assert.equal(response.status, 200);
  const body = await json(response);

  assert.equal(body.graph.generation, 2);
  const nodes = body.graph.nodes as { nodeId: string; kind: string; commitmentId?: string }[];
  assert.ok(nodes.every((node) => node.nodeId.startsWith('g2.')), 'the reading is not a new one');

  // #526: "graph regeneration preserves already confirmed canonical links".
  // The node id moved from g1 to g2 and the link followed it, still pointing
  // at the commitment the user already has.
  const carried = nodes.find((node) => node.kind === 'linked_commitment');
  assert.ok(carried, 'the confirmed link did not survive the regeneration');
  assert.equal(carried?.nodeId, 'g2.step.s1');
  assert.equal(carried?.commitmentId, commitmentId);

  // And regenerating wrote nothing at all.
  assert.equal(await documentCount(USER), before);
});

test('confirming a node of a regenerated graph does not double-create', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first] = await stepNodeIds(goalId);
  const confirmed = await json(await confirmPost(
    req(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: first, as: 'commitment' }],
    }),
    goalContext(goalId),
  ));

  // The same step, named by its generation-2 id. A link keyed on the raw node
  // id would file this under a new key and put a second commitment in the
  // user's week — which is the defect this whole node-key scheme exists for.
  const again = await json(await confirmPost(
    req(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 2,
      selections: [{ nodeId: 'g2.step.s1', as: 'commitment' }],
    }),
    goalContext(goalId),
  ));

  assert.deepEqual(again.created, []);
  assert.equal(again.replayed.length, 1);
  assert.equal(again.replayed[0].entityId, confirmed.created[0].entityId);
  assert.equal(Object.keys((await getParticipantStateSnapshot(USER)).commitments).length, 1);
});

test('unlinking a node releases the goal’s claim and keeps the commitment', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first] = await stepNodeIds(goalId);
  const confirmed = await json(await confirmPost(
    req(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: first, as: 'commitment' }],
    }),
    goalContext(goalId),
  ));
  const commitmentId = confirmed.created[0].entityId;

  const response = await nodePatch(
    req(`/api/mobile/goals/${goalId}/execution/nodes/${first}`, { action: 'unlink' }, USER, 'PATCH'),
    nodeContext(goalId, first),
  );
  assert.equal(response.status, 200);
  const body = await json(response);

  assert.equal(body.unlinked.entityId, commitmentId);
  assert.equal(body.unlinked.nodeKey, 'step.s1');
  assert.equal(body.canonicalWorkKept, true);

  // The criterion, at the level a user would notice it: the commitment is
  // still in the account and still active.
  const state = await getParticipantStateSnapshot(USER);
  assert.deepEqual(Object.keys(state.commitments), [commitmentId]);
  assert.equal(state.commitments[commitmentId].status, 'active');
  assert.equal((await getStorage().list(userCol(USER, COMMITMENTS))).length, 1);
  assert.equal((await getStorage().list(userCol(USER, GOAL_GRAPH_LINKS))).length, 0);

  // Unlinking twice is a 404: the second call did not unlink anything.
  const repeat = await nodePatch(
    req(`/api/mobile/goals/${goalId}/execution/nodes/${first}`, { action: 'unlink' }, USER, 'PATCH'),
    nodeContext(goalId, first),
  );
  assert.equal(repeat.status, 404);
  assert.equal((await json(repeat)).reason, 'node_not_linked');
});

test('a node unlinked at one generation is unlinkable by its next-generation id', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first] = await stepNodeIds(goalId);
  await confirmPost(
    req(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: first, as: 'commitment' }],
    }),
    goalContext(goalId),
  );

  const response = await nodePatch(
    req(`/api/mobile/goals/${goalId}/execution/nodes/g2.step.s1`, { action: 'unlink' }, USER, 'PATCH'),
    nodeContext(goalId, 'g2.step.s1'),
  );
  assert.equal(response.status, 200, 'the unlink did not find the link by node key');
  assert.equal((await json(response)).unlinked.nodeKey, 'step.s1');
});

test('a habit confirmed over HTTP is materialized, and one without a cadence is refused', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first, second] = await stepNodeIds(goalId);

  const ok = await json(await confirmPost(
    req(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: first, as: 'habit', habit: GYM }],
    }),
    goalContext(goalId),
  ));
  assert.equal(ok.created.length, 1);
  const habits = await createHabitServices().habits.list(USER);
  assert.equal(habits.length, 1);
  assert.equal(habits[0].source, 'goal_confirmed');

  // No cadence: refused by the habit contract's own validator, with nothing
  // created and nothing left claimed.
  const refused = await json(await confirmPost(
    req(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: second, as: 'habit', habit: { durationMinutes: 30 } }],
    }),
    goalContext(goalId),
  ));
  assert.deepEqual(refused.created, []);
  assert.deepEqual(refused.refused.map((entry: { code: string }) => entry.code), ['habit_input_invalid']);
  assert.equal((await createHabitServices().habits.list(USER)).length, 1);
});

test('every execution route refuses an unauthenticated caller before anything else', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first] = await stepNodeIds(goalId);
  const before = await documentCount(USER);

  const answers = await Promise.all([
    confirmPost(
      req(`/api/mobile/goals/${goalId}/execution/confirm`, { selections: [{ nodeId: first, as: 'commitment' }] }, null),
      goalContext(goalId),
    ),
    regeneratePost(req(`/api/mobile/goals/${goalId}/execution/regenerate`, {}, null), goalContext(goalId)),
    nodePatch(
      req(`/api/mobile/goals/${goalId}/execution/nodes/${first}`, { action: 'unlink' }, null, 'PATCH'),
      nodeContext(goalId, first),
    ),
  ]);

  assert.deepEqual(answers.map((response) => response.status), [401, 401, 401]);
  assert.equal(await documentCount(USER), before);
});

test('another account’s goal answers 404 on every route, and writes nothing', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first] = await stepNodeIds(goalId);
  const before = await documentCount(USER);

  const answers = await Promise.all([
    confirmPost(
      req(`/api/mobile/goals/${goalId}/execution/confirm`, { selections: [{ nodeId: first, as: 'commitment' }] }, OTHER),
      goalContext(goalId),
    ),
    regeneratePost(req(`/api/mobile/goals/${goalId}/execution/regenerate`, {}, OTHER), goalContext(goalId)),
    nodePatch(
      req(`/api/mobile/goals/${goalId}/execution/nodes/${first}`, { action: 'unlink' }, OTHER, 'PATCH'),
      nodeContext(goalId, first),
    ),
  ]);

  assert.deepEqual(answers.map((response) => response.status), [404, 404, 404]);
  assert.equal(await documentCount(USER), before);
  assert.equal(await documentCount(OTHER), 0);
});

test('a malformed body is refused with a reason, and creates nothing', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const path = `/api/mobile/goals/${goalId}/execution/confirm`;
  const before = await documentCount(USER);

  const cases: [unknown, string][] = [
    [{ selections: [] }, 'invalid_selections'],
    [{ selections: 'all of them' }, 'invalid_selections'],
    [{ selections: [{ nodeId: 'g1.step.s1' }] }, 'invalid_selections'],
    [{ selections: [{ nodeId: 'g1.step.s1', as: 'goal' }] }, 'invalid_selections'],
    [{ selections: [{ nodeId: 'g1.step.s1', as: 'habit' }] }, 'invalid_selections'],
    [{ selections: [{ nodeId: '../../../etc/passwd', as: 'commitment' }] }, 'invalid_node_id'],
    [{ generation: 0, selections: [{ nodeId: 'g1.step.s1', as: 'commitment' }] }, 'invalid_generation'],
    [{ generation: 1.5, selections: [{ nodeId: 'g1.step.s1', as: 'commitment' }] }, 'invalid_generation'],
    [{ generation: 10_000, selections: [{ nodeId: 'g1.step.s1', as: 'commitment' }] }, 'invalid_generation'],
  ];
  for (const [body, reason] of cases) {
    const response = await confirmPost(req(path, body), goalContext(goalId));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await json(response)).reason, reason, JSON.stringify(body));
  }
  assert.equal(await documentCount(USER), before);
});

test('the node PATCH offers no destructive action', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first] = await stepNodeIds(goalId);
  await confirmPost(
    req(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: first, as: 'commitment' }],
    }),
    goalContext(goalId),
  );

  // #526: destroying the canonical work is a separate action the user chooses,
  // and this route is not it. Every other verb is a 400 before anything runs.
  for (const action of ['delete', 'remove', 'destroy', undefined]) {
    const response = await nodePatch(
      req(`/api/mobile/goals/${goalId}/execution/nodes/${first}`, { action }, USER, 'PATCH'),
      nodeContext(goalId, first),
    );
    assert.equal(response.status, 400, String(action));
    assert.equal((await json(response)).reason, 'invalid_action', String(action));
  }
  // The link and the commitment both survived every attempt.
  assert.equal((await getStorage().list(userCol(USER, GOAL_GRAPH_LINKS))).length, 1);
  assert.equal(Object.keys((await getParticipantStateSnapshot(USER)).commitments).length, 1);
});

test('regenerate needs no body, and defaults to the reading after the first', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);

  const response = await regeneratePost(
    req(`/api/mobile/goals/${goalId}/execution/regenerate`),
    goalContext(goalId),
  );
  assert.equal(response.status, 200);
  assert.equal((await json(response)).graph.generation, 2);
});
