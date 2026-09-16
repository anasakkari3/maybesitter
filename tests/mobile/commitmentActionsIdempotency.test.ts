/**
 * A notification button pressed once is applied once (UC-3.14, #200).
 *
 * The phone's outbox replays a tap until the server answers, so the same
 * `clientActionId` can arrive twice: after a timeout whose request did land,
 * after a relaunch, or from two flushes racing. The server has to recognise
 * the second one, and it has to recognise it inside the transaction that
 * writes the domain event — a check made before the transaction is a check two
 * racing requests both pass.
 *
 * Every assertion counts events in the domain log (`users/{uid}/events`),
 * because that log is what activity (#201) and the growth rules (#202) read.
 * A receipt count of one next to two `commitment_completed` events would be a
 * pass here for nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { applyParticipantCommands } from '../../lib/services/mobile/participantState.ts';
import { COMMITMENT_ACTION_RECEIPTS, EVENTS, userCol } from '../../lib/storage/paths.ts';
import { listEvents } from '../../lib/services/mobile/eventLog.ts';
import { projectActivity } from '../../lib/services/activity/activityProjection.ts';
import { applyCommitmentAction } from '../../lib/services/mobile/commitmentService.ts';
import { POST as actionPost } from '../../src/app/api/mobile/commitments/[id]/actions/route.ts';

const BASE = 'http://127.0.0.1:4321';
const OWNER = uidFor('ActionOwner');
const OTHER = uidFor('ActionOther');
const ID_A = '3f0e8a52-7c1b-4d2e-9a61-0b5c7d9e1f24';
const ID_B = '8b2d4c61-1e3f-4a5b-8c7d-9e0f1a2b3c4d';

let auth: FakeAuthControls | null = null;

function begin(): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
}

function end(): void {
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function post(uid: string, commitmentId: string, body: Record<string, unknown>) {
  return actionPost(
    new Request(`${BASE}/api/mobile/commitments/${commitmentId}/actions`, {
      method: 'POST',
      headers: new Headers({ authorization: `Bearer ${tokenFor(uid)}`, 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: commitmentId }) },
  );
}

async function seed(uid: string, id: string): Promise<void> {
  const now = new Date().toISOString();
  await applyParticipantCommands(uid, [
    {
      type: 'CreateDraft',
      now,
      commitment: {
        id, kind: 'task', title: 'Call the clinic',
        timeSpec: { kind: 'due_by', dueAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), timezone: 'UTC' },
      },
    },
    { type: 'ConfirmCommitment', commitmentId: id, now },
  ]);
}

async function eventsOfType(uid: string, type: string) {
  const page = await listEvents(uid, { limit: 50 });
  return page.events.filter((event) => event.type === type);
}

async function receiptCount(uid: string): Promise<number> {
  return (await getStorage().list(userCol(uid, COMMITMENT_ACTION_RECEIPTS))).length;
}

test('the same clientActionId twice completes once and answers the replay with 200', async () => {
  begin();
  try {
    await seed(OWNER, 'c1');
    const first = await post(OWNER, 'c1', { action: 'complete', clientActionId: ID_A });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as Record<string, any>;
    const second = await post(OWNER, 'c1', { action: 'complete', clientActionId: ID_A });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as Record<string, any>;
    assert.equal(secondBody.replayed, true);
    assert.equal(secondBody.commitment.status, 'completed');
    assert.equal(firstBody.commitment.status, 'completed');
    assert.equal((await eventsOfType(OWNER, 'commitment_completed')).length, 1);
    assert.equal(await receiptCount(OWNER), 1);
  } finally {
    end();
  }
});

test('two racing deliveries of one tap write one event', async () => {
  begin();
  try {
    await seed(OWNER, 'c1');
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const responses = await Promise.all([
      post(OWNER, 'c1', { action: 'postpone', postponedUntil: until, clientActionId: ID_A }),
      post(OWNER, 'c1', { action: 'postpone', postponedUntil: until, clientActionId: ID_A }),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    // The defer is a domain event growth rule R2 (#202) can read.
    const postponed = await eventsOfType(OWNER, 'commitment_postponed');
    assert.equal(postponed.length, 1);
    assert.equal(await receiptCount(OWNER), 1);
  } finally {
    end();
  }
});

test('a defer delivered after its own instant has passed replays rather than failing validation', async () => {
  begin();
  try {
    await seed(OWNER, 'c1');
    const tappedAt = new Date();
    const until = new Date(tappedAt.getTime() + 3_600_000).toISOString();
    const input = { postponedUntil: until, clientActionId: ID_A, participantId: OWNER };
    const first = await applyCommitmentAction('c1', 'postpone', { ...input, now: tappedAt });
    assert.equal(first.replayed, false);
    // The outbox's retry lands two hours later: `until` is now in the past.
    const retry = await applyCommitmentAction('c1', 'postpone', {
      ...input, now: new Date(tappedAt.getTime() + 2 * 3_600_000),
    });
    assert.equal(retry.replayed, true);
    assert.equal((await eventsOfType(OWNER, 'commitment_postponed')).length, 1);
  } finally {
    end();
  }
});

test('a different clientActionId is a different tap', async () => {
  begin();
  try {
    await seed(OWNER, 'c1');
    const first = new Date(Date.now() + 3_600_000).toISOString();
    const later = new Date(Date.now() + 7_200_000).toISOString();
    assert.equal((await post(OWNER, 'c1', { action: 'postpone', postponedUntil: first, clientActionId: ID_A })).status, 200);
    assert.equal((await post(OWNER, 'c1', { action: 'postpone', postponedUntil: later, clientActionId: ID_B })).status, 200);
    assert.equal((await eventsOfType(OWNER, 'commitment_postponed')).length, 2);
  } finally {
    end();
  }
});

test('a clientActionId reused for a different action is refused, not replayed', async () => {
  begin();
  try {
    await seed(OWNER, 'c1');
    assert.equal((await post(OWNER, 'c1', { action: 'complete', clientActionId: ID_A })).status, 200);
    const reused = await post(OWNER, 'c1', { action: 'cancel', clientActionId: ID_A });
    assert.equal(reused.status, 409);
    assert.equal((await reused.json() as Record<string, unknown>).reason, 'client_action_id_reused');
    assert.equal((await eventsOfType(OWNER, 'commitment_dropped')).length, 0);
  } finally {
    end();
  }
});

test('receipts are per account: another user’s id does not replay into this one', async () => {
  begin();
  try {
    await seed(OWNER, 'c1');
    await seed(OTHER, 'c1');
    assert.equal((await post(OWNER, 'c1', { action: 'complete', clientActionId: ID_A })).status, 200);
    const other = await post(OTHER, 'c1', { action: 'complete', clientActionId: ID_A });
    assert.equal(other.status, 200);
    assert.notEqual((await other.json() as Record<string, unknown>).replayed, true);
    assert.equal((await eventsOfType(OTHER, 'commitment_completed')).length, 1);
  } finally {
    end();
  }
});

test('completing a dropped commitment is 409 and leaves no receipt, so nothing replays it as success', async () => {
  begin();
  try {
    await seed(OWNER, 'c1');
    assert.equal((await post(OWNER, 'c1', { action: 'cancel', clientActionId: ID_B })).status, 200);
    const refused = await post(OWNER, 'c1', { action: 'complete', clientActionId: ID_A });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json() as Record<string, unknown>).reason, 'invalid_transition');
    assert.equal(await receiptCount(OWNER), 1);
    assert.equal((await eventsOfType(OWNER, 'commitment_completed')).length, 0);
  } finally {
    end();
  }
});

test('a missing commitment is 404', async () => {
  begin();
  try {
    const missing = await post(OWNER, 'nope', { action: 'complete', clientActionId: ID_A });
    assert.equal(missing.status, 404);
    assert.equal(await receiptCount(OWNER), 0);
  } finally {
    end();
  }
});

test('a malformed clientActionId is refused before anything is written', async () => {
  begin();
  try {
    await seed(OWNER, 'c1');
    for (const clientActionId of ['', 'not-a-uuid', 42, '٣f0e8a52-7c1b-4d2e-9a61-0b5c7d9e1f24', `${ID_A}/x`]) {
      const response = await post(OWNER, 'c1', { action: 'complete', clientActionId });
      assert.equal(response.status, 400, `accepted ${String(clientActionId)}`);
    }
    assert.equal((await eventsOfType(OWNER, 'commitment_completed')).length, 0);
  } finally {
    end();
  }
});

test('aware records reminder_acknowledged once, and activity shows it', async () => {
  begin();
  try {
    await seed(OWNER, 'c1');
    assert.equal((await post(OWNER, 'c1', { action: 'aware', clientActionId: ID_A })).status, 200);
    assert.equal((await post(OWNER, 'c1', { action: 'aware', clientActionId: ID_A })).status, 200);
    const acknowledged = await eventsOfType(OWNER, 'reminder_acknowledged');
    assert.equal(acknowledged.length, 1);
    assert.equal(acknowledged[0]!.payload.commitmentId, 'c1');
    // Not the «لسّا» event: a tap on a reminder is its own kind (#201).
    assert.equal((await eventsOfType(OWNER, 'commitment_aware')).length, 0);
    const items = projectActivity(acknowledged, new Map([['c1', { title: 'Call the clinic' }]]));
    assert.deepEqual(items.map((item) => item.kind), ['reminder_acknowledged']);
    assert.equal(items[0]!.commitmentId, 'c1');
  } finally {
    end();
  }
});

test('without a clientActionId the route behaves as before', async () => {
  begin();
  try {
    await seed(OWNER, 'c1');
    assert.equal((await post(OWNER, 'c1', { action: 'complete' })).status, 200);
    assert.equal(await receiptCount(OWNER), 0);
    assert.equal((await getStorage().list(userCol(OWNER, EVENTS))).length > 0, true);
  } finally {
    end();
  }
});
