/**
 * Deleting an account, for real (UC-1.5, #149).
 *
 * "Delete my account" is a promise with a legal deadline attached and no way to
 * apologise afterwards. These tests are about the two ways it fails quietly:
 * data that survives because it lived outside the user's tree, and a deletion
 * that stopped halfway when its instance went away.
 *
 * Both are covered here against the memory adapter, with the Firebase Auth
 * calls injected. `tests/storage/accountDeletion.emulator.test.ts` runs the same
 * engine against real Firestore and the real Auth emulator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { INCIDENTS, USER_SCOPED_COLLECTIONS, userDoc, userSubDoc } from '../../lib/storage/paths.ts';
import { JOBS } from '../../lib/scheduler/storageSchedulerStore.ts';
import {
  ACCOUNT_DELETIONS,
  DELETION_RECEIPTS,
  DELETION_STEPS,
  MAX_DELETION_ATTEMPTS,
  RESUME_AFTER_MS,
  deleteAccount,
  resumeStalledDeletions,
  subjectHashFor,
  type DeletionAuthAdmin,
  type DeletionJobRecord,
  type DeletionReceipt,
} from '../../lib/account/accountDeletion.ts';
import { registerDeletionHook, resetDeletionHooksForTests } from '../../lib/account/deletionHooks.ts';

const PEPPER = 'test-pepper-not-the-real-one';
const TARGET = 'user_deleted_one';
const SIBLING = 'user_untouched_one';

/** Records what was asked of Firebase Auth, and can be told to fail. */
function fakeAuth(overrides: Partial<DeletionAuthAdmin> = {}): DeletionAuthAdmin & {
  revoked: string[];
  deleted: string[];
} {
  const revoked: string[] = [];
  const deleted: string[] = [];
  return {
    revoked,
    deleted,
    async revokeRefreshTokens(uid) {
      revoked.push(uid);
      await overrides.revokeRefreshTokens?.(uid);
    },
    async deleteUser(uid) {
      deleted.push(uid);
      await overrides.deleteUser?.(uid);
    },
  };
}

/** One document in every place this account could have left something. */
async function seedAccount(storage: StorageAdapter, uid: string): Promise<void> {
  await storage.set(userDoc(uid), { uid, trust: { version: 'v1', participantId: uid, updatedAt: '2026-09-01T00:00:00.000Z' } });
  for (const collection of USER_SCOPED_COLLECTIONS) {
    await storage.set(userSubDoc(uid, collection, 'seed'), { uid, collection });
  }
  await storage.set(`${JOBS}/job_${uid}`, { id: `job_${uid}`, uid, status: 'pending' });
  await storage.set(`${INCIDENTS}/inc_${uid}`, { incidentId: `inc_${uid}`, participantId: uid });
}

/** Everything still stored anywhere for this uid. */
async function remainingFor(storage: StorageAdapter, uid: string): Promise<string[]> {
  const left: string[] = [];
  const prefix = `${userDoc(uid)}/`;
  for (const collection of USER_SCOPED_COLLECTIONS) {
    const rows = await storage.listGroup(collection);
    left.push(...rows.filter((row) => row.path.startsWith(prefix)).map((row) => row.path));
  }
  if (await storage.get(userDoc(uid))) left.push(userDoc(uid));
  for (const [collection, field] of [[JOBS, 'uid'], [INCIDENTS, 'participantId']] as const) {
    const rows = await storage.list<Record<string, unknown>>(collection, { where: [[field, '==', uid]] });
    left.push(...rows.map((row) => `${collection}/${row.id}`));
  }
  return left;
}

function begin(): StorageAdapter {
  process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = PEPPER;
  resetDeletionHooksForTests();
  return createMemoryStorage();
}

function end(): void {
  resetDeletionHooksForTests();
  delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
}

test('deleting an account leaves nothing of it anywhere, and nothing of anyone else missing', async () => {
  const storage = begin();
  try {
    await seedAccount(storage, TARGET);
    await seedAccount(storage, SIBLING);
    const before = await remainingFor(storage, TARGET);
    assert.ok(before.length > USER_SCOPED_COLLECTIONS.length, 'the seed never landed, so this would prove nothing');

    const auth = fakeAuth();
    const receipt = await deleteAccount(TARGET, { initiatedBy: 'user', storage, auth });

    assert.deepEqual(await remainingFor(storage, TARGET), [], 'the account left documents behind');
    assert.deepEqual(auth.deleted, [TARGET], 'the Firebase user was not deleted exactly once');
    assert.deepEqual(auth.revoked, [TARGET], 'the sessions were not revoked');

    // The neighbour is the control: a deletion that wiped everything would pass
    // every assertion above.
    const sibling = await remainingFor(storage, SIBLING);
    assert.ok(sibling.length > USER_SCOPED_COLLECTIONS.length, 'deleting one account removed another account\'s data');

    assert.equal(receipt.docsDeleted > 0, true, 'the receipt claims nothing was deleted');
    for (const step of DELETION_STEPS) {
      assert.notEqual(receipt.steps[step], 'failed', `${step} failed`);
    }
  } finally {
    end();
  }
});

test('the capture proposals #252 added are deleted with the account', async () => {
  // Named on its own because it is the newest collection and the one most
  // likely to be forgotten: it did not exist when this issue was written.
  const storage = begin();
  try {
    await storage.set(userSubDoc(TARGET, 'captureProposals', 'p1'), { proposalId: 'p1' });
    await deleteAccount(TARGET, { initiatedBy: 'user', storage, auth: fakeAuth() });
    const rows = await storage.listGroup('captureProposals');
    assert.deepEqual(rows.filter((row) => row.path.startsWith(`${userDoc(TARGET)}/`)), []);
  } finally {
    end();
  }
});

test('the receipt proves the deletion without identifying who was deleted', async () => {
  const storage = begin();
  try {
    await seedAccount(storage, TARGET);
    const receipt = await deleteAccount(TARGET, { initiatedBy: 'operator', storage, auth: fakeAuth() });

    assert.equal(receipt.subjectHash, subjectHashFor(TARGET, PEPPER));
    assert.equal(receipt.subjectHash.length, 64, 'the subject is not a SHA-256 hex digest');
    assert.equal(receipt.initiatedBy, 'operator');

    // Nothing in the serialised receipt may contain the uid, and the hash must
    // not be derivable without the pepper — checked by hashing with another one.
    const serialised = JSON.stringify(receipt);
    assert.ok(!serialised.includes(TARGET), `the receipt contains the uid: ${serialised}`);
    assert.notEqual(subjectHashFor(TARGET, 'a-different-pepper'), receipt.subjectHash);

    const stored = await storage.get<DeletionReceipt>(`${DELETION_RECEIPTS}/${receipt.receiptId}`);
    assert.ok(stored, 'the receipt was not persisted, so it cannot be produced later');
    assert.ok(stored.expiresAt instanceof Date || typeof stored.expiresAt === 'string', 'no TTL stamp');

    // And the job record keeps no identifier once it is done.
    const job = await storage.get<DeletionJobRecord>(`${ACCOUNT_DELETIONS}/${receipt.subjectHash}`);
    assert.equal(job?.status, 'done');
    assert.equal(job?.uid, undefined, 'the finished job still names the account');
  } finally {
    end();
  }
});

test('a deletion interrupted partway finishes on resume, with one receipt', async () => {
  const storage = begin();
  try {
    await seedAccount(storage, TARGET);

    // Dies removing the Firebase account, which is now the step before the
    // tree: an ID token verifies offline, so the account has to go first or a
    // request arriving mid-deletion can recreate the tree behind the sweep.
    const failing = fakeAuth({
      deleteUser: async () => {
        throw new Error('instance went away');
      },
    });
    await assert.rejects(() => deleteAccount(TARGET, { initiatedBy: 'user', storage, auth: failing }));

    const subjectHash = subjectHashFor(TARGET, PEPPER);
    const midway = await storage.get<DeletionJobRecord>(`${ACCOUNT_DELETIONS}/${subjectHash}`);
    assert.equal(midway?.status, 'in_progress');
    assert.equal(midway?.steps.topLevelDocs, 'done', 'the sweep did not get as far as the top-level records');
    assert.equal(midway?.steps.userTree, undefined, 'the tree was deleted before the account was removed');
    // Interrupted, so the tree is still there — and the account is already
    // denied, which is what stops it from being used in the meantime.
    const user = await storage.get<{ trust?: { deletedAt?: string } }>(userDoc(TARGET));
    assert.ok(user?.trust?.deletedAt, 'an interrupted deletion left the account usable');

    // The maintenance sweep, once the job looks abandoned.
    const auth = fakeAuth();
    const later = new Date(Date.now() + RESUME_AFTER_MS + 60_000);
    const swept = await resumeStalledDeletions({ now: later, storage, auth });

    assert.equal(swept.resumed, 1, 'the stalled deletion was not resumed');
    assert.deepEqual(auth.deleted, [TARGET]);
    const receipts = await storage.list<DeletionReceipt>(DELETION_RECEIPTS);
    assert.equal(receipts.length, 1, `one deletion produced ${receipts.length} receipts`);
    const job = await storage.get<DeletionJobRecord>(`${ACCOUNT_DELETIONS}/${subjectHash}`);
    assert.equal(job?.status, 'done');
    assert.equal(job?.uid, undefined);
  } finally {
    end();
  }
});

test('a deletion that died after writing its receipt does not write a second one', async () => {
  // The window between "the receipt exists" and "the job says it exists". A run
  // that dies there comes back with every step done and — before the id was
  // reserved up front — no record of the proof it already wrote, so it minted
  // another. One deletion, two receipts, and the criterion says one.
  const storage = begin();
  try {
    await seedAccount(storage, TARGET);
    const subjectHash = subjectHashFor(TARGET, PEPPER);
    const reserved = 'reserved-receipt-id';
    await storage.set<DeletionJobRecord>(`${ACCOUNT_DELETIONS}/${subjectHash}`, {
      version: 'v1',
      uid: TARGET,
      subjectHash,
      status: 'in_progress',
      steps: { markDeleted: 'done', revokeSessions: 'done', externalRevocations: 'skipped', topLevelDocs: 'done', userTree: 'done', authUser: 'done' },
      initiatedBy: 'user',
      startedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      attempts: 1,
      docsDeleted: 3,
      receiptId: reserved,
    });

    const receipt = await deleteAccount(TARGET, { initiatedBy: 'user', storage, auth: fakeAuth() });

    assert.equal(receipt.receiptId, reserved, 'the resumed run minted a new receipt id');
    const receipts = await storage.list<DeletionReceipt>(DELETION_RECEIPTS);
    assert.equal(receipts.length, 1, `one deletion produced ${receipts.length} receipts`);
  } finally {
    end();
  }
});

test('a job that keeps failing becomes an operator problem instead of retrying forever', async () => {
  const storage = begin();
  try {
    await seedAccount(storage, TARGET);
    const subjectHash = subjectHashFor(TARGET, PEPPER);
    await storage.set<DeletionJobRecord>(`${ACCOUNT_DELETIONS}/${subjectHash}`, {
      version: 'v1',
      uid: TARGET,
      subjectHash,
      status: 'in_progress',
      steps: { markDeleted: 'done' },
      initiatedBy: 'user',
      startedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      attempts: MAX_DELETION_ATTEMPTS,
      docsDeleted: 0,
    });

    const swept = await resumeStalledDeletions({ now: new Date(), storage, auth: fakeAuth() });

    assert.equal(swept.stuck, 1);
    assert.equal(swept.resumed, 0);
    const job = await storage.get<DeletionJobRecord>(`${ACCOUNT_DELETIONS}/${subjectHash}`);
    assert.equal(job?.status, 'stuck', 'a hopeless job stays in the resume queue forever');
  } finally {
    end();
  }
});

test('an external revocation that fails is recorded, and does not keep the data alive', async () => {
  const storage = begin();
  try {
    await seedAccount(storage, TARGET);
    registerDeletionHook('worksFine', async () => {});
    registerDeletionHook('cannotReach', async () => {
      throw new Error('third party is down');
    });

    const receipt = await deleteAccount(TARGET, { initiatedBy: 'user', storage, auth: fakeAuth() });

    assert.equal(receipt.steps.externalRevocations, 'failed', 'a failed hook was not recorded on the receipt');
    // The user asked to be deleted. A third party being down is not a reason to
    // keep their commitments.
    assert.deepEqual(await remainingFor(storage, TARGET), []);
    assert.equal(receipt.steps.userTree, 'done');
    assert.equal(receipt.steps.authUser, 'done');
  } finally {
    end();
  }
});

test('deleting the same account twice returns the first receipt and deletes nothing twice', async () => {
  const storage = begin();
  try {
    await seedAccount(storage, TARGET);
    const auth = fakeAuth();
    const first = await deleteAccount(TARGET, { initiatedBy: 'user', storage, auth });
    const second = await deleteAccount(TARGET, { initiatedBy: 'user', storage, auth });

    assert.equal(second.receiptId, first.receiptId, 'a second call minted a second proof for one event');
    assert.equal((await storage.list(DELETION_RECEIPTS)).length, 1);
    assert.deepEqual(auth.deleted, [TARGET], 'the Firebase user was deleted twice');
  } finally {
    end();
  }
});

test('the account is denied before anything is destroyed', async () => {
  // If a deletion fails midway, the user must not be able to carry on using the
  // product with half their data gone. `markDeleted` runs first, so the trust
  // record says deleted even when a later step throws.
  const storage = begin();
  try {
    await seedAccount(storage, TARGET);
    const failing = fakeAuth({
      revokeRefreshTokens: async () => {
        throw new Error('auth unavailable');
      },
    });

    await assert.rejects(() => deleteAccount(TARGET, { initiatedBy: 'user', storage, auth: failing }));

    const user = await storage.get<{ trust?: { deletedAt?: string } }>(userDoc(TARGET));
    assert.ok(user?.trust?.deletedAt, 'the account is still usable after a failed deletion started');
  } finally {
    end();
  }
});
