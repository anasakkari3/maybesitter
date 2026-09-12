/**
 * Account deletion against real Firestore and real Firebase Auth (#149).
 *
 * The memory-backed tests prove the engine's logic. They cannot prove the two
 * claims that matter most to the person asking, because both are somebody
 * else's system: the sign-in account is really gone, and the token they were
 * holding stops working.
 *
 * So this runs the real engine against the emulators, with a real account
 * created through the same `accounts:signUp` endpoint the app's client calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuth } from 'firebase-admin/auth';
import { getAdminApp } from '../../lib/firebase/admin.ts';
import { createFirestoreStorage, resetFirestoreForTests } from '../../lib/storage/firestoreAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc, USER_SCOPED_COLLECTIONS } from '../../lib/storage/paths.ts';
import { JOBS } from '../../lib/scheduler/storageSchedulerStore.ts';
import { deleteAccount, DELETION_RECEIPTS, subjectHashFor } from '../../lib/account/accountDeletion.ts';
import { resetDeletionHooksForTests } from '../../lib/account/deletionHooks.ts';
import { requireMobileUser } from '../../lib/auth/mobileAuth.ts';
import { proposeMobileCapture, confirmMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!AUTH_HOST) {
  throw new Error(
    'FIREBASE_AUTH_EMULATOR_HOST is unset. Run this file through `npm run test:emulator`, never against a real project.',
  );
}

const PEPPER = 'emulator-test-pepper';

/** A real account, with the ID token its client would hold. */
async function signUp(): Promise<{ uid: string; idToken: string }> {
  const response = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `delete-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.test`,
        password: 'not-a-real-password',
        returnSecureToken: true,
      }),
    },
  );
  const raw = await response.text();
  assert.equal(response.status, 200, `emulator signUp failed: ${raw}`);
  const body = JSON.parse(raw) as { idToken: string; localId: string };
  return { uid: body.localId, idToken: body.idToken };
}

function authorized(idToken: string): Request {
  return new Request('http://localhost:3000/api/mobile/commitments/today', {
    headers: new Headers({ authorization: `Bearer ${idToken}` }),
  });
}

test('firestore + auth: deleting an account removes the data, the user, and the session', async () => {
  process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = PEPPER;
  resetDeletionHooksForTests();
  setStorageForTests(createFirestoreStorage());
  const account = await signUp();
  try {
    // Real data, made the way the app makes it.
    const proposal = await proposeMobileCapture(
      { text: 'Renew the passport tomorrow at 2', timezone: 'UTC' },
      { participantId: account.uid },
    );
    assert.equal(proposal.status, 'proposed');
    const confirmed = await confirmMobileCapture(
      { proposalId: proposal.proposalId, itemIds: [proposal.items[0]!.itemId] },
      { participantId: account.uid },
    );
    assert.equal(confirmed.success, true, 'the fixture capture did not persist, so there would be nothing to delete');

    const storage = createFirestoreStorage();
    await storage.set(`${JOBS}/job_${account.uid}`, { id: `job_${account.uid}`, uid: account.uid, status: 'pending' });

    // The token works before the deletion. Without this the assertion after it
    // could pass for the wrong reason.
    const before = await requireMobileUser(authorized(account.idToken));
    assert.equal(before.uid, account.uid);

    const receipt = await deleteAccount(account.uid, { initiatedBy: 'user' });

    // 1. Firestore: nothing left, anywhere.
    const prefix = `${userDoc(account.uid)}/`;
    for (const collection of USER_SCOPED_COLLECTIONS) {
      const rows = await storage.listGroup(collection);
      assert.deepEqual(
        rows.filter((row) => row.path.startsWith(prefix)).map((row) => row.path),
        [],
        `${collection} survived the deletion`,
      );
    }
    assert.equal(await storage.get(userDoc(account.uid)), null, 'the user document survived');
    assert.deepEqual(
      await storage.list(JOBS, { where: [['uid', '==', account.uid]] }),
      [],
      'a scheduled job outlived its owner',
    );

    // 2. Firebase Auth: the account itself.
    await assert.rejects(
      () => getAuth(getAdminApp()).getUser(account.uid),
      /no user record|user-not-found/i,
      'the Firebase user still exists',
    );

    // 3. The session: the token the client is still holding must stop working.
    await assert.rejects(
      () => requireMobileUser(authorized(account.idToken)),
      'the pre-deletion token still authenticates',
    );

    // 4. The receipt, readable afterwards and naming nobody.
    const stored = await storage.get<{ subjectHash: string }>(`${DELETION_RECEIPTS}/${receipt.receiptId}`);
    assert.ok(stored, 'the receipt was not persisted');
    assert.equal(stored.subjectHash, subjectHashFor(account.uid, PEPPER));
    assert.ok(!JSON.stringify(stored).includes(account.uid), 'the stored receipt contains the uid');
  } finally {
    resetStorageForTests();
    resetDeletionHooksForTests();
    delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
    // Best effort: the account should already be gone.
    await getAuth(getAdminApp()).deleteUser(account.uid).catch(() => {});
    await createFirestoreStorage().deleteTree(userDoc(account.uid)).catch(() => {});
    resetFirestoreForTests();
  }
});
