/**
 * CX4.5 (QA audit de7fcb8, confirmed through the API): a DELETE or an action
 * on a commitment id the account does not have answered 400 «Could not
 * delete/complete commitment», not 404. The route maps only
 * `Commitment not found` to 404, and the command path never threw it. A client
 * that treats 404 as "already gone, drop it locally" got a generic error.
 *
 * A foreign id and a random id must still get the same answer (no leak).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { DELETE as commitmentDelete } from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/commitments/[id]/actions/route.ts';
import { applyParticipantCommands } from '../../lib/services/mobile/participantState.ts';
import type { Command } from '../../src/domain/stateMachine.ts';

const BASE = 'http://127.0.0.1:4321';
const ALICE = uidFor('UnknownCommitmentAlice');
const BOB = uidFor('UnknownCommitmentBob');

let auth: FakeAuthControls | null = null;

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  return () => { auth?.restore(); auth = null; resetStorageForTests(); };
}

async function seed(uid: string, id: string): Promise<void> {
  await seedLiveAccount(uid);
  const now = Date.now();
  const commands: Command[] = [
    {
      type: 'CreateDraft',
      now: new Date(now - 60_000).toISOString(),
      commitment: {
        id, kind: 'task', title: 'Bob only',
        timeSpec: { kind: 'due_by', dueAt: new Date(now + 2 * 3_600_000).toISOString(), remindAt: null, timezone: 'UTC' },
      },
      draftStatus: 'pending_confirmation',
    },
    { type: 'ConfirmCommitment', commitmentId: id, now: new Date(now - 59_000).toISOString() },
  ];
  await applyParticipantCommands(uid, commands);
}

function request(uid: string, path: string, method: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(uid)}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

test('CX4.5: DELETE and actions on an unknown or foreign commitment answer 404, identically', async () => {
  const teardown = setup();
  try {
    await seedLiveAccount(ALICE);
    await seed(BOB, 'bobs-1');
    for (const id of ['no-such-id', 'bobs-1']) {
      const deleted = await commitmentDelete(request(ALICE, `/api/mobile/commitments/${id}`, 'DELETE'), params(id));
      assert.equal(deleted.status, 404, `DELETE ${id}`);
      for (const action of ['complete', 'cancel']) {
        const acted = await actionPost(request(ALICE, `/api/mobile/commitments/${id}/actions`, 'POST', { action }), params(id));
        assert.equal(acted.status, 404, `${action} ${id}`);
      }
    }
    // Bob's own item is untouched and still his to act on.
    const own = await actionPost(request(BOB, '/api/mobile/commitments/bobs-1/actions', 'POST', { action: 'complete' }), params('bobs-1'));
    assert.equal(own.status, 200);
  } finally {
    teardown();
  }
});
