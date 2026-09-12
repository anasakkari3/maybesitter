/**
 * `DELETE /api/mobile/account`, the endpoint behind "Delete account" (#149).
 *
 * The engine is covered in tests/account/accountDeletion.test.ts. This file is
 * about the three things the endpoint itself decides: who is allowed to ask,
 * whether they meant it, and whose account gets deleted.
 *
 * The last one matters most. A uid taken from the request body would be an
 * endpoint that deletes other people's accounts, so the only uid it ever sees
 * is the verified token's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { setDeletionAuthForTests } from '../../lib/account/accountDeletion.ts';
import { resetDeletionHooksForTests } from '../../lib/account/deletionHooks.ts';
import { getOrCreateTrust } from '../../lib/pilot/pilotTrustStore.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { DELETE as accountDelete } from '../../src/app/api/mobile/account/route.ts';
import { POST as trustPost } from '../../src/app/api/mobile/pilot/trust/route.ts';

const baseUrl = 'http://localhost:3000';
const CONFIRMATION = { confirmation: 'delete-my-account' };

function request(uid: string | null, body: unknown, path = '/api/mobile/account'): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (uid) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`${baseUrl}${path}`, { method: 'DELETE', headers, body: JSON.stringify(body) });
}

let auth: FakeAuthControls | null = null;

/** What the route asked Firebase Auth to do. */
let firebase = { revoked: [] as string[], deleted: [] as string[] };

function begin(): void {
  process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = 'route-test-pepper';
  resetDeletionHooksForTests();
  auth = installFakeAuth();
  firebase = { revoked: [], deleted: [] };
  // There is no Firebase in a unit test, and the route has no parameter to pass
  // one through, so the engine's admin seam is filled here.
  setDeletionAuthForTests({
    async revokeRefreshTokens(uid) { firebase.revoked.push(uid); },
    async deleteUser(uid) { firebase.deleted.push(uid); },
  });
  setStorageForTests(createMemoryStorage());
}

function end(): void {
  setDeletionAuthForTests(null);
  resetStorageForTests();
  auth?.restore();
  auth = null;
  resetDeletionHooksForTests();
  delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
}

/**
 * The route calls Firebase Auth for real. Under test there is no Firebase, so
 * the deletion of the auth user is the one thing that cannot run here — it is
 * covered against the Auth emulator instead. Seeding the user document is
 * enough for everything this file asserts.
 */
async function seed(uid: string): Promise<void> {
  // Through the real store, so the trust record is the shape the auth layer
  // validates. A hand-written one missing a field is refused as
  // `auth_unavailable`, and the test would then be asserting about a 503.
  await getOrCreateTrust(uid, new Date().toISOString());
}

test('a session that signed in too long ago is told to re-authenticate', async () => {
  begin();
  try {
    const uid = uidFor('StaleSession');
    await seed(uid);
    auth!.setAuthAge(uid, 600); // ten minutes

    const response = await accountDelete(request(uid, CONFIRMATION));

    assert.equal(response.status, 401);
    const body = await response.json() as { success: boolean; reason: string };
    assert.equal(body.success, false);
    assert.equal(body.reason, 'recent_login_required');
    // And nothing was touched on the way to refusing.
    const { getStorage } = await import('../../lib/storage/index.ts');
    assert.ok(await getStorage().get(userDoc(uid)), 'a refused deletion still removed the account');
  } finally {
    end();
  }
});

test('a request without the exact confirmation is refused', async () => {
  begin();
  try {
    const uid = uidFor('NoConfirmation');
    await seed(uid);
    const { getStorage } = await import('../../lib/storage/index.ts');

    for (const body of [{}, { confirmation: '' }, { confirmation: 'yes' }, { confirmation: true }]) {
      const response = await accountDelete(request(uid, body));
      assert.equal(response.status, 400, `${JSON.stringify(body)} was accepted as a confirmation`);
      assert.equal((await response.json() as { reason: string }).reason, 'confirmation_required');
    }
    assert.ok(await getStorage().get(userDoc(uid)), 'an unconfirmed request deleted the account');
  } finally {
    end();
  }
});

test('an unauthenticated request cannot delete anything', async () => {
  begin();
  try {
    const uid = uidFor('NeverSignedIn');
    await seed(uid);
    const response = await accountDelete(request(null, CONFIRMATION));
    assert.equal(response.status, 401);
    const { getStorage } = await import('../../lib/storage/index.ts');
    assert.ok(await getStorage().get(userDoc(uid)), 'an anonymous request deleted an account');
  } finally {
    end();
  }
});

test('the account deleted is the token\'s, whatever the body claims', async () => {
  // The dangerous version of this endpoint takes a uid. This asserts it does
  // not: a body naming someone else changes nothing about whose data goes.
  begin();
  try {
    const victim = uidFor('SomeoneElse');
    const caller = uidFor('TheCaller');
    await seed(victim);
    await seed(caller);
    const { getStorage } = await import('../../lib/storage/index.ts');

    const response = await accountDelete(request(caller, { ...CONFIRMATION, uid: victim, participantId: victim }));

    assert.equal(response.status, 200);
    assert.ok(await getStorage().get(userDoc(victim)), 'a body field deleted another account');
    assert.equal(await getStorage().get(userDoc(caller)), null, 'the caller\'s own account survived');
    assert.deepEqual(firebase.deleted, [caller], 'the wrong Firebase user was deleted');
  } finally {
    end();
  }
});

test('the retired trust action says to use account deletion instead', async () => {
  begin();
  try {
    const uid = uidFor('PartialDelete');
    await seed(uid);

    const response = await trustPost(new Request(`${baseUrl}/api/mobile/pilot/trust`, {
      method: 'POST',
      headers: new Headers({ authorization: `Bearer ${tokenFor(uid)}`, 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: { type: 'delete' } }),
    }));

    assert.equal(response.status, 400);
    const body = await response.json() as { success: boolean; reason: string };
    assert.equal(body.success, false);
    assert.equal(body.reason, 'use_account_deletion');

    // The old action deleted domain state. It must not still be doing that
    // quietly while returning an error.
    const { getStorage } = await import('../../lib/storage/index.ts');
    assert.ok(await getStorage().get(userDoc(uid)), 'the retired action still deleted something');
  } finally {
    end();
  }
});
