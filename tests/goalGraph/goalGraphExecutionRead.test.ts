/**
 * The read route the whole feature was missing (#526).
 *
 *   GET /api/mobile/goals/{goalId}/execution
 *
 * `generate`, `confirm`, `regenerate` and the node PATCH all shipped without
 * the one route the issue's API list starts with, and the consequence was not
 * cosmetic: `deriveGoalGraphProgress` had no caller outside its own unit test,
 * so #526's "a linked Commitment's completion changes derived progress
 * automatically" was true of a library function and of nothing a client could
 * observe. The headline test below is that criterion stated over HTTP —
 * complete the commitment through the ordinary domain command, ask the route
 * again, and the number it returns has moved.
 *
 * The unit-level counting is already pinned by `goalGraphProgress.test.ts`.
 * What only this layer can be wrong about is the composition: whether the
 * route reaches progress at all, whose account it derives it for, and what it
 * does with a period nobody supplied.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { USER_SCOPED_COLLECTIONS, userCol } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { applyParticipantCommand } from '../../lib/services/mobile/participantState.ts';
import { createHabitServices } from '../../lib/services/habits/habitService.ts';
import { addDays } from '../../lib/habits/civilDate.ts';
import { readGoalExecutionState } from '../../lib/services/mobile/goalGraphService.ts';
import { POST as occurrenceCompletePost } from '../../src/app/api/mobile/habits/[id]/occurrences/[occurrenceId]/complete/route.ts';
import { goalNodeKeyOf } from '../../lib/goalGraph/ids.ts';
import { GET as executionGet } from '../../src/app/api/mobile/goals/[goalId]/execution/route.ts';
import { POST as generatePost } from '../../src/app/api/mobile/goals/[goalId]/execution/generate/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/goals/[goalId]/execution/confirm/route.ts';
import { seedGoal, SPLITTABLE_GOAL } from './goalGraphSupport.ts';

const baseUrl = 'http://127.0.0.1:4321';
const USER = uidFor('GoalExecutionReadUser');
const OTHER = uidFor('GoalExecutionReadOtherUser');

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

function get(path: string, uid: string | null = USER): Request {
  const headers = new Headers();
  if (uid !== null) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`${baseUrl}${path}`, { method: 'GET', headers });
}

function post(path: string, body?: unknown, uid: string | null = USER): Request {
  const headers = new Headers();
  if (uid !== null) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function goalContext(goalId: string) {
  return { params: Promise.resolve({ goalId }) };
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
  const body = await json(await generatePost(post(`/api/mobile/goals/${goalId}/execution/generate`), goalContext(goalId)));
  return (body.graph.nodes as { kind: string; nodeId: string }[])
    .filter((node) => node.kind === 'decomposition_step_proposal')
    .map((node) => node.nodeId);
}

async function read(goalId: string, query = '', uid: string | null = USER): Promise<Response> {
  return await executionGet(
    get(`/api/mobile/goals/${goalId}/execution${query}`, uid),
    goalContext(goalId),
  );
}

test('the read route answers with the graph and a progress reading beside it', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);

  const response = await read(goalId);
  assert.equal(response.status, 200);
  const body = await json(response);

  assert.equal(body.success, true);
  assert.equal(body.graph.goalMemoryId, goalId);
  assert.equal(body.graph.generation, 1);
  // Nothing confirmed yet, so there is nothing to report — and no percentage
  // to report it as. #526: progress is counted, never set.
  assert.equal(body.progress.confirmedCount, 0);
  assert.equal(body.progress.completedCount, 0);
  assert.deepEqual(body.progress.nodes, []);
  assert.equal('percent' in body.progress, false);
  // Nobody scoped a period, and the answer says so rather than leaving a
  // client to read an unscoped zero as a real one.
  assert.equal(body.progress.period, null);
});

test('completing a linked commitment changes the progress this route returns', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first, second] = await stepNodeIds(goalId);

  const confirmed = await json(await confirmPost(
    post(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: first, as: 'commitment' }, { nodeId: second, as: 'commitment' }],
    }),
    goalContext(goalId),
  ));
  assert.equal(confirmed.created.length, 2);

  const before = await json(await read(goalId));
  assert.equal(before.progress.confirmedCount, 2);
  assert.equal(before.progress.completedCount, 0);
  assert.deepEqual(
    (before.progress.nodes as { completed: boolean }[]).map((node) => node.completed),
    [false, false],
  );

  // The user ticks one off, through the ordinary domain command — nothing this
  // feature owns, and nothing that knows a goal graph exists.
  const done = (confirmed.created as { nodeKey: string; entityId: string }[])
    .find((link) => link.nodeKey === goalNodeKeyOf(first))!;
  await applyParticipantCommand(USER, {
    type: 'Complete',
    commitmentId: done.entityId,
    now: '2026-09-24T12:00:00.000Z',
  });

  const after = await json(await read(goalId));
  assert.equal(after.progress.confirmedCount, 2);
  assert.equal(after.progress.completedCount, 1, 'the route did not reach the derivation');
  const node = (after.progress.nodes as { nodeKey: string; status?: string; completed: boolean }[])
    .find((entry) => entry.nodeKey === goalNodeKeyOf(first));
  assert.equal(node?.status, 'completed');
  assert.equal(node?.completed, true);
});

test('the read route derives a habit node over the period the caller names', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first] = await stepNodeIds(goalId);

  const confirmed = await json(await confirmPost(
    post(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: first, as: 'habit', habit: GYM }],
    }),
    goalContext(goalId),
  ));
  const habitId = (confirmed.created as { entityId: string }[])[0].entityId;

  // The dates the habit materialized for itself, completed through the
  // canonical seam — `POST /habits/{id}/occurrences/{occurrenceId}/complete`,
  // the same route the user's thumb reaches. Writing `state: 'completed'`
  // straight into the store would still pass if that route ever recorded a
  // different string, which is exactly the drift this test should catch.
  const materialized = (await createHabitServices().occurrences.listForHabit(USER, habitId))
    .map((occurrence) => occurrence)
    .sort((left, right) => (left.localDate < right.localDate ? -1 : 1));
  assert.ok(materialized.length >= 2, 'the habit materialized nothing to complete');
  const [one, two] = materialized;
  for (const occurrence of [one, two]) {
    const response = await occurrenceCompletePost(
      post(`/api/mobile/habits/${habitId}/occurrences/${occurrence.occurrenceId}/complete`),
      { params: Promise.resolve({ id: habitId, occurrenceId: occurrence.occurrenceId }) },
    );
    assert.equal(response.status, 200);
  }

  // A window that contains both, stated in the habit's own civil dates rather
  // than in anything read off a clock.
  const inside = await json(await read(
    goalId,
    `?fromLocalDate=${one.localDate}&toLocalDate=${two.localDate}`,
  ));
  const node = (inside.progress.nodes as { entityKind: string; completedOccurrences: number; targetOccurrences: number }[])[0];
  assert.equal(node.entityKind, 'habit');
  assert.equal(node.completedOccurrences, 2);
  assert.equal(node.targetOccurrences, 3, "the habit's own minimum, not a threshold this feature chose");
  assert.deepEqual(inside.progress.period, { fromLocalDate: one.localDate, toLocalDate: two.localDate });

  // A window that contains neither counts neither: the bounds are the answer,
  // not a suggestion.
  const before = await json(await read(
    goalId,
    `?fromLocalDate=${addDays(one.localDate, -14)}&toLocalDate=${addDays(one.localDate, -1)}`,
  ));
  assert.equal((before.progress.nodes as { completedOccurrences: number }[])[0].completedOccurrences, 0);
});

test('an unscoped read says it is unscoped rather than reporting zero as a result', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  const [first] = await stepNodeIds(goalId);

  const confirmed = await json(await confirmPost(
    post(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: first, as: 'habit', habit: GYM }],
    }),
    goalContext(goalId),
  ));
  const habitId = (confirmed.created as { entityId: string }[])[0].entityId;
  const occurrence = (await createHabitServices().occurrences.listForHabit(USER, habitId))[0];
  await occurrenceCompletePost(
    post(`/api/mobile/habits/${habitId}/occurrences/${occurrence.occurrenceId}/complete`),
    { params: Promise.resolve({ id: habitId, occurrenceId: occurrence.occurrenceId }) },
  );

  // The cheap read a goal screen opens with carries no period, so the count is
  // zero — and the count alone is byte-identical to a user who has done
  // nothing. `period: null` is the field that lets the screen say "not scoped"
  // instead of telling somebody who went to the gym that they went nowhere.
  const body = await json(await read(goalId));
  const node = (body.progress.nodes as { completedOccurrences: number; completed: boolean }[])[0];
  assert.equal(node.completedOccurrences, 0);
  assert.equal(node.completed, false);
  assert.equal(body.progress.period, null);
  // And the occurrence really is completed, so the zero above is the window's
  // doing and not a failed completion.
  assert.equal(
    (await createHabitServices().occurrences.listForHabit(USER, habitId))
      .find((entry) => entry.occurrenceId === occurrence.occurrenceId)?.state,
    'completed',
  );
});

test('another account cannot read this goal, and is told nothing about it', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  await confirmPost(
    post(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: (await stepNodeIds(goalId))[0], as: 'commitment' }],
    }),
    goalContext(goalId),
  );

  const response = await read(goalId, '', OTHER);
  assert.equal(response.status, 404);
  const body = await json(response);
  assert.equal(body.success, false);
  assert.equal(body.reason, 'goal_not_found');
  // A real id answers exactly as an invented one, or the difference is itself
  // a read of somebody else's account.
  const invented = await read('mem_does_not_exist', '', OTHER);
  assert.equal(invented.status, 404);
  assert.deepEqual(await json(invented), body);
  // And nothing of the stranger's was created by asking.
  assert.equal(await documentCount(OTHER), 0);
});

test('an unauthenticated caller is refused before anything is read', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);

  const response = await read(goalId, '', null);
  assert.equal(response.status, 401);
});

test('reading writes nothing, and two reads of an unchanged account agree', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  await confirmPost(
    post(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: (await stepNodeIds(goalId))[0], as: 'commitment' }],
    }),
    goalContext(goalId),
  );

  const before = await documentCount(USER);
  assert.ok(before > 0, 'nothing was stored, so this run would prove nothing');
  const once = await json(await read(goalId));
  const twice = await json(await read(goalId));

  assert.equal(await documentCount(USER), before);
  assert.deepEqual(twice.progress.nodes, once.progress.nodes);
  assert.equal(twice.progress.completedCount, once.progress.completedCount);
});

test('the reading the client asks for is the one it gets, and a bad one is refused', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);

  const second = await json(await read(goalId, '?generation=2'));
  assert.equal(second.graph.generation, 2);
  assert.ok((second.graph.nodes as { nodeId: string }[]).every((node) => node.nodeId.startsWith('g2.')));

  for (const [query, reason] of [
    ['?generation=nonsense', 'invalid_generation'],
    ['?generation=0', 'invalid_generation'],
    ['?generation=1.5', 'invalid_generation'],
    ['?fromLocalDate=2026-09-21', 'invalid_period'],
    ['?toLocalDate=2026-09-27', 'invalid_period'],
    ['?fromLocalDate=yesterday&toLocalDate=2026-09-27', 'invalid_period'],
    ['?fromLocalDate=2026-09-28&toLocalDate=2026-09-27', 'invalid_period'],
    // Shape is not validity. A lexicographic comparison against a real
    // occurrence date does not fail on an impossible month or day — it
    // silently shifts the window and answers 200 with a zero that looks real.
    ['?fromLocalDate=2026-02-30&toLocalDate=2026-02-30', 'invalid_period'],
    ['?fromLocalDate=2026-13-01&toLocalDate=2026-13-31', 'invalid_period'],
    ['?fromLocalDate=0000-00-00&toLocalDate=9999-99-99', 'invalid_period'],
    ['?fromLocalDate=2027-02-29&toLocalDate=2027-03-01', 'invalid_period'],
  ] as const) {
    const response = await read(goalId, query);
    assert.equal(response.status, 400, `${query} was accepted`);
    assert.equal((await json(response)).reason, reason, `${query} gave the wrong reason`);
  }
});

test('a memory that is not a goal is refused as a bad request, not a 404', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);

  // Written as a goal by the fixture, then demoted in place — the state a
  // client reaches by passing the id of an ordinary memory record. 400 rather
  // than 404 because the id names something real that cannot have an
  // execution graph, which is a fact about the request, not about the id.
  const storage = getStorage();
  const path = `${userCol(USER, 'memory')}/${goalId}`;
  await storage.set(path, { ...(await storage.get<Record<string, unknown>>(path)), kind: 'fact' });

  const response = await read(goalId);
  assert.equal(response.status, 400);
  assert.equal((await json(response)).reason, 'not_a_confirmed_goal');
});

test('both halves of the read are built over the adapter the caller handed in', async (t) => {
  const { goalId, teardown } = await setup();
  t.after(teardown);
  await confirmPost(
    post(`/api/mobile/goals/${goalId}/execution/confirm`, {
      generation: 1,
      selections: [{ nodeId: (await stepNodeIds(goalId))[0], as: 'commitment' }],
    }),
    goalContext(goalId),
  );

  // The account, and then a process-global adapter that knows nothing about
  // it. `readGoalExecutionGraph` honours the storage seam, so a composition
  // that forwarded the adapter to the graph and not to the derivation would
  // answer with a graph full of linked nodes and a progress reading of zero —
  // two halves reading two different accounts, with no error to say so.
  const account = getStorage();
  setStorageForTests(createMemoryStorage());

  const { graph, progress } = await readGoalExecutionState(
    USER,
    goalId,
    '2026-09-24T12:00:00.000Z',
    { storage: account },
  );
  assert.equal(graph.goalMemoryId, goalId);
  assert.equal(progress.confirmedCount, 1, 'progress was derived against a different adapter');
  const node = progress.nodes[0];
  assert.equal(node.entityKind, 'commitment');
  assert.notEqual(
    node.entityKind === 'commitment' && node.status,
    'missing',
    'the commitment was read from an adapter that never had it',
  );
});
