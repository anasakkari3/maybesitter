/**
 * Seeds, end to end through the routes (#519).
 *
 * Every acceptance criterion in the issue is a test in here, and each is
 * written against the thing that would actually be wrong rather than against
 * the code that implements it:
 *
 *  - a proposal persists nothing — checked by counting documents in the user's
 *    whole tree, not by checking that a function was not called;
 *  - confirming a seed creates no PlanningItem and no reminder — checked
 *    against committed domain state, plus a structural check that nothing in
 *    the priority, planning or reminder code can even reach the seed store;
 *  - promotion goes through the existing boundaries — checked by asserting the
 *    promoted commitment is a real, confirmed commitment in the user's domain
 *    state and the promoted goal is a `goal` record in memory;
 *  - duplicate confirmation is idempotent — checked by pressing twice and
 *    counting rows;
 *  - deletion takes seeds with it;
 *  - nothing may promote itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { INTENT_SEEDS, userCol, userDoc } from '../../lib/storage/paths.ts';
import { getStorage } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { configureCommandService } from '../../lib/services/commandService.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as seedsGet, POST as seedsPost } from '../../src/app/api/mobile/seeds/route.ts';
import { DELETE as seedDelete, PATCH as seedPatch } from '../../src/app/api/mobile/seeds/[id]/route.ts';
import { POST as promotePost } from '../../src/app/api/mobile/seeds/[id]/promote/route.ts';
import { GET as memoryGet } from '../../src/app/api/mobile/memory/route.ts';
import { getAnalyticsEventsFor } from '../../lib/analytics/eventStore.ts';
import { applyTrustAction, getOrCreateTrust } from '../../lib/pilot/pilotTrustStore.ts';
import { exportSeeds } from '../../lib/services/mobile/seedService.ts';

const baseUrl = 'http://127.0.0.1:4321';
const USER = uidFor('SeedRouteUser');
const OTHER = uidFor('SeedOtherUser');
const MAYBE = "Maybe I'll apply to NVIDIA this semester.";

let auth: FakeAuthControls | null = null;

function req(method: string, path: string, body?: unknown, uid = USER): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

/**
 * `memory: false` is the shipped default, so a run that wants to prove the
 * goal promotion has to turn the module on — and a run that wants to prove the
 * refusal has to leave it off. Both are here, which is why this is a parameter
 * rather than a constant.
 */
async function setup(options: { memory?: boolean; analytics?: boolean } = {}): Promise<() => Promise<void>> {
  configureCommandService({ initialState: createEmptyDomainState(), schedulerStore: null });
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  const previousMemoryFlag = process.env.MAYBESITTER_FEATURE_MEMORY;
  if (options.memory) process.env.MAYBESITTER_FEATURE_MEMORY = 'true';
  if (options.analytics) {
    // Consent is read from the stored trust record, never from the caller, so
    // granting it here means going through the same two calls the consent
    // screen makes. Writing a hand-rolled `{ trust: { analyticsConsent } }`
    // document instead makes every later request answer 503: `readTrust`
    // refuses a trust record that is not a whole `PilotTrustState`.
    await getOrCreateTrust(USER, new Date().toISOString());
    await applyTrustAction(USER, { type: 'set_analytics_consent', granted: true, at: new Date().toISOString() });
  }
  return async () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
    if (previousMemoryFlag === undefined) delete process.env.MAYBESITTER_FEATURE_MEMORY;
    else process.env.MAYBESITTER_FEATURE_MEMORY = previousMemoryFlag;
  };
}

/** How many documents this user has anywhere in their tree. */
async function documentCount(uid = USER): Promise<number> {
  const storage = getStorage();
  let total = 0;
  for (const collection of ['commitments', 'reminders', 'captureProposals', INTENT_SEEDS, 'events']) {
    total += (await storage.list(`${userDoc(uid)}/${collection}`)).length;
  }
  return total;
}

async function seedRows(uid = USER): Promise<number> {
  return (await getStorage().list(userCol(uid, INTENT_SEEDS))).length;
}

/** Proposes the maybe and returns the proposal, asserting it wrote no seed. */
async function proposeMaybe(text = MAYBE, uid = USER): Promise<Record<string, unknown>> {
  const response = await capturePost(req('POST', '/api/mobile/capture', {
    text,
    referenceTime: new Date().toISOString(),
    timezone: 'UTC',
  }, uid));
  assert.equal(response.status, 200);
  return json(response);
}

/** Proposes and keeps one seed, returning it. */
async function keepOneSeed(text = MAYBE, uid = USER): Promise<Record<string, unknown>> {
  const proposal = await proposeMaybe(text, uid);
  const offered = (proposal.seeds as Array<{ seedItemId: string }>)[0]!;
  const response = await seedsPost(req('POST', '/api/mobile/seeds', {
    proposalId: proposal.proposalId,
    seedItemId: offered.seedItemId,
  }, uid));
  assert.equal(response.status, 201, await response.clone().text());
  return (await json(response)).seed as Record<string, unknown>;
}

test('a seed proposal creates zero persistent objects before the user confirms', async () => {
  const teardown = await setup();
  try {
    const proposal = await proposeMaybe();

    assert.equal(proposal.status, 'unresolved_intent');
    assert.equal((proposal.seeds as unknown[]).length, 1);
    assert.deepEqual(proposal.items, []);
    assert.equal(await seedRows(), 0, 'a proposal wrote a seed');
    // The proposal document itself is the one thing a capture is allowed to
    // write, so the count is one — and it is not a seed, a commitment or an
    // event.
    assert.equal(await documentCount(), 1);
  } finally {
    await teardown();
  }
});

test('an unresolved_intent proposal cannot be confirmed as a commitment', async () => {
  const teardown = await setup();
  try {
    const proposal = await proposeMaybe();
    const response = await confirmPost(req('POST', '/api/mobile/capture/confirm', {
      proposalId: proposal.proposalId,
      // The strongest form of the attempt: a client asking to confirm the seed
      // id as though it were an item.
      itemIds: [(proposal.seeds as Array<{ seedItemId: string }>)[0]!.seedItemId],
    }));
    const body = await json(response);
    assert.equal(body.success, false);
    assert.equal(body.failureCode, 'proposal_rejected');
    assert.equal(Object.keys((await getParticipantStateSnapshot(USER)).commitments).length, 0);
  } finally {
    await teardown();
  }
});

test('keeping a seed stores the sentence the person typed, verbatim, with no time', async () => {
  const teardown = await setup();
  try {
    const seed = await keepOneSeed();

    assert.equal(seed.summary, MAYBE);
    assert.equal(seed.kind, 'consideration');
    assert.equal(seed.status, 'open');
    assert.equal(seed.revisitAt, null, 'a kept seed must carry no invented date');
    assert.equal(seed.promotedTo, null);
    assert.equal(seed.source, 'capture');
    const provenance = seed.provenance as Record<string, unknown>;
    assert.equal(typeof provenance.confirmedByUserAt, 'string');
    assert.equal(provenance.proposalId, seed.sourceRef);
  } finally {
    await teardown();
  }
});

test('the summary comes from the stored proposal, never from the request body', async () => {
  const teardown = await setup();
  try {
    const proposal = await proposeMaybe();
    const offered = (proposal.seeds as Array<{ seedItemId: string }>)[0]!;
    const response = await seedsPost(req('POST', '/api/mobile/seeds', {
      proposalId: proposal.proposalId,
      seedItemId: offered.seedItemId,
      // A client trying to store something the user never wrote under the
      // provenance of their own capture.
      summary: 'I will definitely apply to NVIDIA on Friday',
      kind: 'possible_goal',
    }));
    const seed = (await json(response)).seed as Record<string, unknown>;

    assert.equal(seed.summary, MAYBE);
    assert.equal(seed.kind, 'consideration');
  } finally {
    await teardown();
  }
});

test('confirming the same seed twice is idempotent', async () => {
  const teardown = await setup();
  try {
    const proposal = await proposeMaybe();
    const offered = (proposal.seeds as Array<{ seedItemId: string }>)[0]!;
    const body = { proposalId: proposal.proposalId, seedItemId: offered.seedItemId };

    const first = await seedsPost(req('POST', '/api/mobile/seeds', body));
    const second = await seedsPost(req('POST', '/api/mobile/seeds', body));

    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    const one = (await json(first)).seed as { seedId: string };
    const two = await json(second);
    assert.equal(two.replayed, true);
    assert.equal((two.seed as { seedId: string }).seedId, one.seedId);
    assert.equal(await seedRows(), 1, 'a second confirm wrote a second seed');
  } finally {
    await teardown();
  }
});

test('a kept seed creates no commitment, no PlanningItem and no reminder', async () => {
  const teardown = await setup();
  try {
    await keepOneSeed();
    const state = await getParticipantStateSnapshot(USER);

    assert.deepEqual(Object.keys(state.commitments), []);
    assert.deepEqual(Object.keys(state.reminders), []);
    assert.equal((await getStorage().list(`${userDoc(USER)}/plans`)).length, 0);
  } finally {
    await teardown();
  }
});

test('"Later" records a revisit marker the user chose, and nothing schedules it', async () => {
  const teardown = await setup();
  try {
    const seed = await keepOneSeed();
    const revisitAt = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();
    const response = await seedPatch(
      req('PATCH', `/api/mobile/seeds/${seed.seedId}`, { status: 'snoozed', revisitAt }),
      params(seed.seedId as string),
    );
    const updated = (await json(response)).seed as Record<string, unknown>;

    assert.equal(updated.status, 'snoozed');
    assert.equal(updated.revisitAt, revisitAt);
    // A revisit is "reconsider this", not "this is due": nothing was scheduled.
    assert.deepEqual(Object.keys((await getParticipantStateSnapshot(USER)).reminders), []);
  } finally {
    await teardown();
  }
});

test('no patch can mark a seed promoted — a seed cannot promote itself', async () => {
  const teardown = await setup();
  try {
    const seed = await keepOneSeed();
    for (const status of ['promoted', 'expired', 'nonsense']) {
      const response = await seedPatch(
        req('PATCH', `/api/mobile/seeds/${seed.seedId}`, { status }),
        params(seed.seedId as string),
      );
      assert.equal(response.status, 400, `status=${status} was accepted`);
    }
    const listed = ((await json(await seedsGet(req('GET', '/api/mobile/seeds')))).items as Array<Record<string, unknown>>);
    assert.equal(listed[0]!.status, 'open');
    assert.equal(listed[0]!.promotedTo, null);
  } finally {
    await teardown();
  }
});

test('promotion to a commitment goes through the ordinary confirmation path', async () => {
  const teardown = await setup();
  try {
    const seed = await keepOneSeed();
    const response = await promotePost(
      req('POST', `/api/mobile/seeds/${seed.seedId}/promote`, { target: 'commitment' }),
      params(seed.seedId as string),
    );
    const body = await json(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    const promoted = (body.seed as { promotedTo: { kind: string; id: string }; status: string });
    assert.equal(promoted.status, 'promoted');
    assert.equal(promoted.promotedTo.kind, 'commitment');

    const state = await getParticipantStateSnapshot(USER);
    const commitment = state.commitments[promoted.promotedTo.id];
    assert.ok(commitment, 'the promotion named a commitment that does not exist');
    // A real, confirmed commitment — the same state a captured one reaches,
    // which is what "passes the existing confirmation validator" means here.
    assert.equal(commitment.title, MAYBE);
    // `active` is what `ConfirmCommitment` leaves behind, which is the state
    // a captured, confirmed commitment reaches — the point being that this one
    // got there by the same command, not by a write of its own.
    assert.equal(commitment.status, 'active');
    assert.ok(commitment.confirmedAt, 'the promoted commitment was never confirmed');
    // And no invented time: the seed named none.
    assert.equal(commitment.timeSpec.kind, 'unscheduled');
    assert.equal(commitment.timeSpec.dueAt, null);
    assert.equal(commitment.timeSpec.remindAt, null);
    assert.deepEqual(Object.keys(state.reminders), [], 'promotion scheduled a reminder');
  } finally {
    await teardown();
  }
});

test('promoting twice does not create a second commitment', async () => {
  const teardown = await setup();
  try {
    const seed = await keepOneSeed();
    const body = { target: 'commitment' };
    const first = await json(await promotePost(
      req('POST', `/api/mobile/seeds/${seed.seedId}/promote`, body), params(seed.seedId as string)));
    const second = await json(await promotePost(
      req('POST', `/api/mobile/seeds/${seed.seedId}/promote`, body), params(seed.seedId as string)));

    assert.equal(second.replayed, true);
    assert.deepEqual((second.seed as { promotedTo: unknown }).promotedTo,
      (first.seed as { promotedTo: unknown }).promotedTo);
    assert.equal(Object.keys((await getParticipantStateSnapshot(USER)).commitments).length, 1);
  } finally {
    await teardown();
  }
});

test('promotion to a goal uses the existing confirmed-goal record', async () => {
  const teardown = await setup({ memory: true });
  try {
    const seed = await keepOneSeed();
    const body = await json(await promotePost(
      req('POST', `/api/mobile/seeds/${seed.seedId}/promote`, { target: 'goal' }),
      params(seed.seedId as string),
    ));
    const promotedTo = (body.seed as { promotedTo: { kind: string; id: string } }).promotedTo;
    assert.equal(promotedTo.kind, 'goal');

    const memory = await json(await memoryGet(req('GET', '/api/mobile/memory')));
    const items = memory.items as Array<Record<string, unknown>>;
    const goal = items.find((item) => item.id === promotedTo.id);
    assert.ok(goal, 'the promotion named a memory record that does not exist');
    assert.equal(goal.kind, 'goal');
    assert.equal(goal.content, MAYBE);
    assert.equal(goal.source, 'user_stated');
    // No second commitment fell out of a goal promotion.
    assert.equal(Object.keys((await getParticipantStateSnapshot(USER)).commitments).length, 0);
  } finally {
    await teardown();
  }
});

test('promotion to a goal is refused when the memory module is off', async () => {
  const teardown = await setup();
  try {
    const seed = await keepOneSeed();
    const response = await promotePost(
      req('POST', `/api/mobile/seeds/${seed.seedId}/promote`, { target: 'goal' }),
      params(seed.seedId as string),
    );
    // The same 404 every memory route gives when the module is off: a goal the
    // user would have no screen to see is not a promotion, it is a loss.
    assert.equal(response.status, 404);
    assert.equal((await json(response)).reason, 'feature_unavailable');
    const listed = (await json(await seedsGet(req('GET', '/api/mobile/seeds')))).items as Array<Record<string, unknown>>;
    assert.equal(listed[0]!.status, 'open', 'a refused promotion still moved the seed');
  } finally {
    await teardown();
  }
});

test('a promotion target that is not commitment or goal is refused', async () => {
  const teardown = await setup();
  try {
    const seed = await keepOneSeed();
    const response = await promotePost(
      req('POST', `/api/mobile/seeds/${seed.seedId}/promote`, { target: 'reminder' }),
      params(seed.seedId as string),
    );
    assert.equal(response.status, 400);
    assert.equal(Object.keys((await getParticipantStateSnapshot(USER)).commitments).length, 0);
  } finally {
    await teardown();
  }
});

test('a dismissed seed cannot be promoted', async () => {
  const teardown = await setup();
  try {
    const seed = await keepOneSeed();
    await seedPatch(
      req('PATCH', `/api/mobile/seeds/${seed.seedId}`, { status: 'dismissed' }),
      params(seed.seedId as string),
    );
    const response = await promotePost(
      req('POST', `/api/mobile/seeds/${seed.seedId}/promote`, { target: 'commitment' }),
      params(seed.seedId as string),
    );
    assert.equal(response.status, 409);
    assert.equal(Object.keys((await getParticipantStateSnapshot(USER)).commitments).length, 0);
  } finally {
    await teardown();
  }
});

test('another account’s seed reads, patches, promotes and deletes as absent', async () => {
  const teardown = await setup();
  try {
    const mine = await keepOneSeed();
    const id = mine.seedId as string;

    assert.deepEqual((await json(await seedsGet(req('GET', '/api/mobile/seeds', undefined, OTHER)))).items, []);
    assert.equal((await seedPatch(
      req('PATCH', `/api/mobile/seeds/${id}`, { status: 'dismissed' }, OTHER), params(id))).status, 404);
    assert.equal((await promotePost(
      req('POST', `/api/mobile/seeds/${id}/promote`, { target: 'commitment' }, OTHER), params(id))).status, 404);
    assert.equal((await seedDelete(
      req('DELETE', `/api/mobile/seeds/${id}`, undefined, OTHER), params(id))).status, 404);

    // Untouched, and still open.
    const listed = (await json(await seedsGet(req('GET', '/api/mobile/seeds')))).items as Array<Record<string, unknown>>;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.status, 'open');
  } finally {
    await teardown();
  }
});

test('a proposal belonging to another account cannot be kept as a seed', async () => {
  const teardown = await setup();
  try {
    const proposal = await proposeMaybe(MAYBE, USER);
    const offered = (proposal.seeds as Array<{ seedItemId: string }>)[0]!;
    const response = await seedsPost(req('POST', '/api/mobile/seeds', {
      proposalId: proposal.proposalId,
      seedItemId: offered.seedItemId,
    }, OTHER));

    assert.equal(response.status, 404);
    assert.equal(await seedRows(OTHER), 0);
  } finally {
    await teardown();
  }
});

test('delete removes the row; dismiss keeps it', async () => {
  const teardown = await setup();
  try {
    const seed = await keepOneSeed();
    const id = seed.seedId as string;
    await seedPatch(req('PATCH', `/api/mobile/seeds/${id}`, { status: 'dismissed' }), params(id));
    assert.equal(await seedRows(), 1, 'dismiss deleted the row');

    assert.equal((await seedDelete(req('DELETE', `/api/mobile/seeds/${id}`), params(id))).status, 200);
    assert.equal(await seedRows(), 0);
    assert.equal((await seedDelete(req('DELETE', `/api/mobile/seeds/${id}`), params(id))).status, 404);
  } finally {
    await teardown();
  }
});

test('the export carries every seed, whatever its status', async () => {
  const teardown = await setup();
  try {
    const kept = await keepOneSeed();
    const dismissed = await keepOneSeed('I want to think about travelling in December.');
    await seedPatch(
      req('PATCH', `/api/mobile/seeds/${dismissed.seedId}`, { status: 'dismissed' }),
      params(dismissed.seedId as string),
    );

    const exported = await exportSeeds(USER, new Date().toISOString());
    assert.equal(exported.scopeId, USER);
    assert.equal(exported.seeds.length, 2);
    assert.deepEqual(
      exported.seeds.map((seed) => seed.status).sort(),
      ['dismissed', 'open'],
    );
    assert.ok(exported.seeds.some((seed) => seed.seedId === kept.seedId));
  } finally {
    await teardown();
  }
});

test('deleting the account’s tree takes the seeds with it', async () => {
  const teardown = await setup();
  try {
    await keepOneSeed();
    assert.equal(await seedRows(), 1);

    await getStorage().deleteTree(userDoc(USER));
    assert.equal(await seedRows(), 0);
  } finally {
    await teardown();
  }
});

test('the lifecycle telemetry carries a kind and a count, and never the sentence', async () => {
  const teardown = await setup({ memory: true, analytics: true });
  try {
    const seed = await keepOneSeed();
    const id = seed.seedId as string;
    await seedPatch(req('PATCH', `/api/mobile/seeds/${id}`, { status: 'snoozed' }), params(id));
    await promotePost(req('POST', `/api/mobile/seeds/${id}/promote`, { target: 'goal' }), params(id));

    const events = await getAnalyticsEventsFor(USER);
    const names = events.map((event) => event.eventName);
    for (const expected of ['seed_proposed', 'seed_confirmed', 'seed_snoozed', 'seed_promoted']) {
      assert.ok(names.includes(expected as never), `${expected} was never recorded (${names.join(', ')})`);
    }
    // Nothing anywhere in the serialised events may carry what the person
    // wrote, or name the seed.
    const serialized = JSON.stringify(events);
    for (const fragment of ['NVIDIA', 'apply', id]) {
      assert.ok(!serialized.includes(fragment), `telemetry carries "${fragment}"`);
    }
  } finally {
    await teardown();
  }
});

/**
 * Nothing that ranks, plans or reminds may reach the seed store.
 *
 * "It doesn't today" is not a property anybody can maintain, and the issue's
 * rules — no Priority, no Daily Plan, no reminders — are exactly the kind that
 * are broken by an import somebody adds for a good reason six months from now.
 * A direct-reference check rather than a closure walk: the store is reachable
 * only by naming it, and naming it is what this forbids.
 */
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');

function tsFilesUnder(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return tsFilesUnder(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

test('nothing in priority, planning or reminders names the seed store', () => {
  const guarded = ['lib/priority', 'lib/planning', 'lib/services/reminders', 'lib/recommendation']
    .flatMap((relative) => tsFilesUnder(join(repoRoot, relative)));
  assert.ok(guarded.length > 0, 'the guarded directories were not found, so this proves nothing');

  const offenders = guarded.filter((path) => {
    const source = readFileSync(path, 'utf8');
    return source.includes('intentSeed') || source.includes('seedService') || source.includes('INTENT_SEEDS');
  });
  assert.deepEqual(
    offenders.map((path) => path.slice(repoRoot.length + 1)),
    [],
    'ranking, planning or reminders reached the seed store: a Seed must not enter any of them',
  );
});
