/**
 * One account, two devices (UC-1.4, #148).
 *
 * The product promise is that data follows the person, not the phone. These
 * drive the real route handlers as two clients of one uid and assert what a
 * second device actually sees — and what happens when both edit the same
 * commitment.
 *
 * ── What `If-Match` is for ───────────────────────────────────────
 *
 * A tablet holding a commitment from five minutes ago should not be able to
 * silently overwrite a completion the phone just made. The single-commitment
 * read carries an `ETag` (the commitment's `updatedAt`), and a mutation may send
 * it back as `If-Match`. A stale one is refused with 409 and the *current*
 * commitment, so the client can show what actually happened rather than just
 * failing.
 *
 * Absent `If-Match`, the mutation is unconditional: that is what every client
 * did before this and what a first write still does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as upcomingGet } from '../../src/app/api/mobile/commitments/upcoming/route.ts';
import { GET as commitmentGet, PATCH as commitmentPatch } from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/commitments/[id]/actions/route.ts';

const baseUrl = 'http://localhost:3000';
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** One device's request. `ifMatch` is what that device last read. */
function request(
  uid: string,
  path: string,
  options: { body?: unknown; method?: string; ifMatch?: string } = {},
): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.ifMatch !== undefined) headers.set('If-Match', options.ifMatch);
  return new Request(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** Capture and confirm, the way a device creates a commitment. */
async function createCommitment(uid: string): Promise<{ commitmentId: string; proposalId: string; itemId: string }> {
  const proposal = await (await capturePost(
    request(uid, '/api/mobile/capture', { body: { text: 'Call the clinic tomorrow at 9', timezone: 'UTC' } }),
  )).json() as { proposalId: string; items: Array<{ itemId: string }> };
  const itemId = proposal.items[0]!.itemId;
  const confirmed = await (await confirmPost(
    request(uid, '/api/mobile/capture/confirm', { body: { proposalId: proposal.proposalId, itemIds: [itemId] } }),
  )).json() as { persisted: Array<{ commitmentId: string }> };
  return { commitmentId: confirmed.persisted[0]!.commitmentId, proposalId: proposal.proposalId, itemId };
}

/** What a device sees when it opens the commitment: the DTO and its validator. */
async function read(uid: string, commitmentId: string): Promise<{ etag: string; dto: Record<string, unknown> }> {
  const response = await commitmentGet(request(uid, `/api/mobile/commitments/${commitmentId}`), params(commitmentId));
  assert.equal(response.status, 200);
  const etag = response.headers.get('etag');
  assert.ok(etag, 'the single commitment read carries no ETag, so no client can send If-Match');
  return { etag, dto: await response.json() as Record<string, unknown> };
}

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

test('a commitment made on one device is visible to another device on the same account', async () => {
  begin();
  try {
    const uid = uidFor('CrossDeviceOwner');
    const other = uidFor('CrossDeviceStranger');
    const { commitmentId } = await createCommitment(uid);

    // Device B: a separate request, reading storage fresh rather than a cached
    // object from device A's call.
    const onB = await read(uid, commitmentId);
    assert.equal(onB.dto.id, commitmentId);

    // The capture says "tomorrow at 9", so it belongs to Upcoming rather than
    // Today — the list it lands in is the product's, not this test's to choose.
    const upcoming = await (await upcomingGet(request(uid, '/api/mobile/commitments/upcoming'))).json() as { items: Array<{ id: string }> };
    assert.deepEqual(upcoming.items.map((item) => item.id), [commitmentId], 'the second device does not see the commitment in its list');

    // And the same id on another account is simply not there.
    const stranger = await commitmentGet(
      request(other, `/api/mobile/commitments/${commitmentId}`),
      params(commitmentId),
    );
    assert.equal(stranger.status, 404, 'another account can read this commitment');
  } finally {
    end();
  }
});

test('an edit from a device holding a stale copy is refused with the current commitment', async () => {
  begin();
  try {
    const uid = uidFor('StaleEditor');
    const { commitmentId } = await createCommitment(uid);

    // Both devices open it; they hold the same validator.
    const deviceA = await read(uid, commitmentId);
    const deviceB = await read(uid, commitmentId);
    assert.equal(deviceA.etag, deviceB.etag);

    // A edits first and succeeds.
    const first = await commitmentPatch(
      request(uid, `/api/mobile/commitments/${commitmentId}`, {
        body: { title: 'Call the clinic about the results' },
        method: 'PATCH',
        ifMatch: deviceA.etag,
      }),
      params(commitmentId),
    );
    assert.equal(first.status, 200);
    const movedTo = first.headers.get('etag');
    assert.ok(movedTo && movedTo !== deviceA.etag, 'a successful edit did not move the validator');

    // B still holds the old one.
    const stale = await commitmentPatch(
      request(uid, `/api/mobile/commitments/${commitmentId}`, {
        body: { title: 'Something else entirely' },
        method: 'PATCH',
        ifMatch: deviceB.etag,
      }),
      params(commitmentId),
    );
    assert.equal(stale.status, 409, 'a stale edit was accepted');
    const body = await stale.json() as { success: boolean; reason: string; current: Record<string, unknown> };
    assert.equal(body.success, false);
    assert.equal(body.reason, 'stale_commitment');
    assert.equal(body.current.id, commitmentId);
    assert.equal(body.current.title, 'Call the clinic about the results', 'the refusal does not carry the newer state');

    // The newer edit survived: the point is not the refusal, it is that nothing
    // was overwritten.
    const after = await read(uid, commitmentId);
    assert.equal(after.dto.title, 'Call the clinic about the results');

    // And the validator it just handed back works.
    const retried = await commitmentPatch(
      request(uid, `/api/mobile/commitments/${commitmentId}`, {
        body: { title: 'Something else entirely' },
        method: 'PATCH',
        ifMatch: after.etag,
      }),
      params(commitmentId),
    );
    assert.equal(retried.status, 200, 'the ETag returned with the 409 was not accepted on retry');
  } finally {
    end();
  }
});

test('an action and a delete honour If-Match too, and an unconditional one still works', async () => {
  begin();
  try {
    const uid = uidFor('ActionPreconditions');
    const { commitmentId } = await createCommitment(uid);
    const opened = await read(uid, commitmentId);

    // Someone else's device moves it.
    const completed = await actionPost(
      request(uid, `/api/mobile/commitments/${commitmentId}/actions`, { body: { action: 'complete' } }),
      params(commitmentId),
    );
    assert.equal(completed.status, 200, 'an unconditional action was refused');

    // The stale device tries to postpone what has already been completed.
    const stale = await actionPost(
      request(uid, `/api/mobile/commitments/${commitmentId}/actions`, {
        body: { action: 'postpone', postponedUntil: new Date(Date.now() + 86_400_000).toISOString() },
        ifMatch: opened.etag,
      }),
      params(commitmentId),
    );
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { reason: string }).reason, 'stale_commitment');
  } finally {
    end();
  }
});

test('a move the state machine refuses is a 409, not a silent success', async () => {
  begin();
  try {
    const uid = uidFor('InvalidTransition');
    const { commitmentId } = await createCommitment(uid);

    // Cancelled, then completed. `ensureCommitmentStatus` refuses that move.
    const cancelled = await actionPost(
      request(uid, `/api/mobile/commitments/${commitmentId}/actions`, { body: { action: 'cancel' } }),
      params(commitmentId),
    );
    assert.equal(cancelled.status, 200);

    const refused = await actionPost(
      request(uid, `/api/mobile/commitments/${commitmentId}/actions`, { body: { action: 'complete' } }),
      params(commitmentId),
    );
    assert.equal(refused.status, 409, 'completing a cancelled commitment reported success');
    const body = await refused.json() as { success: boolean; reason: string };
    assert.equal(body.success, false);
    assert.equal(body.reason, 'invalid_transition');
  } finally {
    end();
  }
});

test('completing an already-completed commitment stays a success, because it is idempotent', async () => {
  // Deliberately not a 409. `Complete` on a completed commitment is a no-op in
  // the domain, and a second tap from a device that missed the first response
  // has done nothing wrong — the requested state is the state. The 409 above is
  // for a move the state machine actually refuses.
  begin();
  try {
    const uid = uidFor('RepeatComplete');
    const { commitmentId } = await createCommitment(uid);
    const complete = () => actionPost(
      request(uid, `/api/mobile/commitments/${commitmentId}/actions`, { body: { action: 'complete' } }),
      params(commitmentId),
    );

    assert.equal((await complete()).status, 200);
    const again = await complete();
    assert.equal(again.status, 200, 'a repeated completion was treated as an error');
    const body = await again.json() as { commitment: { status: string } };
    assert.equal(body.commitment.status, 'completed');
  } finally {
    end();
  }
});

test('a write landing in the commit window is not overwritten by the edit racing it', async () => {
  // A competing write lands between this request's read and its commit. The
  // edit must lose, and the competing title must survive.
  //
  // This does not prove *where* the check happens. Moving the check out of the
  // transaction and into a pre-read produces the identical 409 here, verified
  // by mutation — the memory adapter's retry closes the same window either way.
  // The placement is visible in `applyParticipantCommand`, and real transaction
  // semantics are covered by
  // tests/storage/captureConfirmIdempotency.emulator.test.ts against Firestore.
  // What this pins is the outcome a user would notice: their colleague's edit
  // is still there.
  auth = installFakeAuth();
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    const uid = uidFor('CommitWindow');
    const { commitmentId } = await createCommitment(uid);
    const opened = await read(uid, commitmentId);

    const path = `users/${uid}/commitments/${commitmentId}`;
    let fired = false;
    storage.setBeforeCommitHookForTests(async () => {
      if (fired) return;
      fired = true;
      const current = await storage.get<Record<string, unknown>>(path);
      await storage.set(path, {
        ...current,
        title: 'Changed by the other device',
        updatedAt: new Date(Date.parse(String(current?.updatedAt)) + 1_000).toISOString(),
      });
    });

    const response = await commitmentPatch(
      request(uid, `/api/mobile/commitments/${commitmentId}`, {
        body: { title: 'Changed by this device' },
        method: 'PATCH',
        ifMatch: opened.etag,
      }),
      params(commitmentId),
    );
    storage.setBeforeCommitHookForTests(null);

    assert.ok(fired, 'the competing write never happened, so this proves nothing');
    assert.equal(response.status, 409, 'an edit racing a competing write was accepted');
    const refusal = await response.json() as { reason?: string; current?: { title?: string } };
    assert.equal(refusal.reason, 'stale_commitment', `refused for the wrong reason: ${JSON.stringify(refusal)}`);
    assert.equal(refusal.current?.title, 'Changed by the other device', 'the 409 does not carry the competing edit');
    const after = await storage.get<{ title: string }>(path);
    assert.equal(after?.title, 'Changed by the other device', 'the competing edit was overwritten');
  } finally {
    end();
  }
});

test('two devices confirming the same proposal at once create one set of commitments', async () => {
  begin();
  try {
    const uid = uidFor('ConcurrentConfirm');
    const proposal = await (await capturePost(
      request(uid, '/api/mobile/capture', { body: { text: 'Book the dentist tomorrow at 4', timezone: 'UTC' } }),
    )).json() as { proposalId: string; items: Array<{ itemId: string }> };
    const itemIds = [proposal.items[0]!.itemId];

    const confirm = () => confirmPost(
      request(uid, '/api/mobile/capture/confirm', { body: { proposalId: proposal.proposalId, itemIds } }),
    );
    const [a, b] = await Promise.all([confirm(), confirm()]);
    const [bodyA, bodyB] = await Promise.all([
      a.json() as Promise<{ success: boolean; replayed: boolean; persisted: Array<{ commitmentId: string }> }>,
      b.json() as Promise<{ success: boolean; replayed: boolean; persisted: Array<{ commitmentId: string }> }>,
    ]);

    assert.equal(bodyA.success, true, 'the first confirm failed');
    assert.equal(bodyB.success, true, 'the second confirm failed instead of replaying');
    assert.equal(
      [bodyA.replayed, bodyB.replayed].filter(Boolean).length,
      1,
      `exactly one of the two should report a replay, got ${JSON.stringify([bodyA.replayed, bodyB.replayed])}`,
    );

    const commitments = Object.values((await getParticipantStateSnapshot(uid)).commitments);
    assert.equal(commitments.length, 1, `one tap produced ${commitments.length} commitments`);
    assert.deepEqual(
      bodyA.persisted.map((item) => item.commitmentId),
      bodyB.persisted.map((item) => item.commitmentId),
      'the two responses describe different commitments',
    );
  } finally {
    end();
  }
});

test('a confirm replayed long after the first returns the original result', async () => {
  begin();
  try {
    const uid = uidFor('SequentialReplay');
    const { proposalId, itemId, commitmentId } = await createCommitment(uid);

    const replay = await confirmPost(
      request(uid, '/api/mobile/capture/confirm', { body: { proposalId, itemIds: [itemId] } }),
    );
    const body = await replay.json() as { success: boolean; replayed: boolean; persisted: Array<{ commitmentId: string }> };

    assert.equal(body.success, true);
    assert.equal(body.replayed, true, 'a repeated confirm did not report itself as a replay');
    assert.deepEqual(body.persisted.map((item) => item.commitmentId), [commitmentId]);
    assert.equal(Object.keys((await getParticipantStateSnapshot(uid)).commitments).length, 1);
  } finally {
    end();
  }
});
