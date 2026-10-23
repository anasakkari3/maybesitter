/**
 * A deletion that finishes inside a first request cannot be undone by it (#794).
 *
 * `requireMobileUser` on a uid's first request: `readTrust` finds nothing,
 * `accountExists` asks Firebase Auth, `getOrCreateTrust` creates the root. The
 * race is a whole deletion completing between the second step and the third.
 * The fake directory below answers "exists", then holds that answer until the
 * test has run the real `deleteAccount` to completion, then lets the request
 * carry on — the pause, made deterministic.
 *
 * The tombstone is the deletion job record (`lib/account/deletionTombstone.ts`),
 * so the other tests here pin the properties it depends on: it survives the
 * sweep, it is there even when a deletion stops after its first step, it names
 * nobody once done, and it blocks only the uid it was written for. Round 1
 * (Q794-002/003) adds the previous pepper after a rotation, and the rule that a
 * missing pepper is allowed only where storage cannot hold another process's
 * tombstone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MobileAuthError, mobileAuthErrorResponse, requireMobileUser } from '../../lib/auth/mobileAuth.ts';
import { resetTokenVerifierForTests, setTokenVerifierForTests, type TokenVerifier } from '../../lib/auth/tokenVerifier.ts';
import { setAccountDirectoryForTests } from '../../lib/auth/accountDirectory.ts';
import { deleteAccount, type DeletionAuthAdmin, type DeletionJobRecord } from '../../lib/account/accountDeletion.ts';
import { deletionTombstonePaths } from '../../lib/account/deletionTombstone.ts';
import { AccountUnavailableError } from '../../lib/account/accountLiveness.ts';
import { applyTrustAction, getOrCreateTrust, readTrust } from '../../lib/pilot/pilotTrustStore.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import type { StorageAdapter, StorageTransaction } from '../../lib/storage/storageAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc, userSubDoc } from '../../lib/storage/paths.ts';

const PEPPER = 'tombstone-794-test-pepper';
const ROTATED_PEPPER = 'tombstone-794-rotated-pepper';
const ENV_NAMES = [
  'MAYBESITTER_DELETION_RECEIPT_PEPPER',
  'MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS',
  'FIRESTORE_EMULATOR_HOST',
  'MAYBESITTER_STORAGE_BACKEND',
  'K_SERVICE',
] as const;
/** Firebase uids: 28 characters, mixed case. */
const UID = 'Tm794DeLeTeDaCcOuNt00000001';
const NEW_UID = 'Tm794NeWaCcOuNtSaMeEmAiL002';

function verifierFor(uid: string): TokenVerifier {
  return {
    async verify() {
      return { uid, authTime: 1_800_000_000, signInProvider: 'password', emailVerified: false };
    },
  };
}

function request(): Request {
  return new Request('http://127.0.0.1:4321/api/mobile/commitments/today', {
    headers: { authorization: 'Bearer test-token' },
  });
}

/** The Firebase Auth calls deletion makes, with the directory told when the account goes. */
function fakeDeletionAuth(onDeleted: (uid: string) => void = () => {}): DeletionAuthAdmin {
  return {
    async revokeRefreshTokens() {},
    async deleteUser(uid) { onDeleted(uid); },
  };
}

interface Env {
  storage: MemoryStorageAdapter;
  restore: () => void;
}

/** The same memory store, counting the tombstone reads its transactions make. */
function sharedView(inner: MemoryStorageAdapter): StorageAdapter & { tombstoneReads: string[] } {
  const tombstoneReads: string[] = [];
  const countingTx = (tx: StorageTransaction): StorageTransaction => new Proxy(tx, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'get') return typeof value === 'function' ? value.bind(target) : value;
      return (path: string) => {
        if (path.startsWith('accountDeletions/')) tombstoneReads.push(path);
        return target.get(path);
      };
    },
  });
  return {
    tombstoneReads,
    get: (path) => inner.get(path),
    getMany: (paths) => inner.getMany(paths),
    list: (path, options) => inner.list(path, options),
    listGroup: (id, options) => inner.listGroup(id, options),
    set: (path, value) => inner.set(path, value),
    delete: (path) => inner.delete(path),
    deleteTree: (path) => inner.deleteTree(path),
    runTransaction: (fn) => inner.runTransaction((tx) => fn(countingTx(tx))),
  } as StorageAdapter & { tombstoneReads: string[] };
}

function begin(
  env: Partial<Record<(typeof ENV_NAMES)[number], string>> = { MAYBESITTER_DELETION_RECEIPT_PEPPER: PEPPER },
  view?: (storage: MemoryStorageAdapter) => StorageAdapter,
): Env {
  const previous: Record<string, string | undefined> = {};
  for (const name of ENV_NAMES) {
    previous[name] = process.env[name];
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  const storage = createMemoryStorage();
  setStorageForTests(view ? view(storage) : storage);
  return {
    storage,
    restore() {
      setAccountDirectoryForTests(null);
      resetTokenVerifierForTests();
      resetStorageForTests();
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

/** Every stored path at or under `users/{uid}`. */
function underTree(storage: MemoryStorageAdapter, uid: string): string[] {
  const root = userDoc(uid);
  return storage.pathsForTests().filter((path) => path === root || path.startsWith(`${root}/`));
}

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    const response = mobileAuthErrorResponse(error);
    return { error, status: response.status, body: await response.json() as { reason?: string } };
  }
}

test('#794: a deletion that completes between the Auth check and the create is not undone by the first request', async () => {
  const { storage, restore } = begin();
  try {
    setTokenVerifierForTests(verifierFor(UID));

    // The directory answers from a live set, so after `deleteUser` it would say
    // no — but the paused request already has its "yes" in hand.
    const live = new Set([UID]);
    let reachedDirectory!: () => void;
    const atDirectory = new Promise<void>((resolve) => { reachedDirectory = resolve; });
    let releaseRequest!: () => void;
    const held = new Promise<void>((resolve) => { releaseRequest = resolve; });
    let directoryCalls = 0;
    setAccountDirectoryForTests({
      async exists(uid) {
        directoryCalls += 1;
        const answer = live.has(uid);
        reachedDirectory();
        await held;
        return answer;
      },
    });

    const firstRequest = refusalOf(requireMobileUser(request()));
    await atDirectory;
    assert.deepEqual(underTree(storage, UID), [], 'the first request already had a record, so this is not the race');

    // The real deletion path, run to completion while the request is paused.
    const receipt = await deleteAccount(UID, {
      initiatedBy: 'operator',
      storage,
      hooks: [],
      auth: fakeDeletionAuth((uid) => live.delete(uid)),
    });
    assert.equal(receipt.steps.userTree, 'done');
    assert.equal(live.has(UID), false, 'the Firebase account was not deleted, so this is not the race');

    releaseRequest();
    const refusal = await firstRequest;

    assert.equal(directoryCalls, 1, 'the request did not take the first-request path');
    assert.ok(refusal, 'the first request was admitted after the account was deleted');
    assert.ok(refusal.error instanceof MobileAuthError);
    assert.equal(refusal.status, 403);
    assert.equal(refusal.body.reason, 'deleted');
    assert.deepEqual(underTree(storage, UID), [], 'the first request re-created the deleted account\'s tree');
    assert.equal(await readTrust(UID), null);
  } finally {
    restore();
  }
});

test('#794: the tombstone survives the deletion sweep, names nobody, and keeps refusing trust creation', async () => {
  const { storage, restore } = begin();
  try {
    // A full account, so the sweep has a tree to remove.
    await getOrCreateTrust(UID, '2026-10-01T00:00:00.000Z');
    await storage.set(userSubDoc(UID, 'commitments', 'c1'), { title: 'something private' });
    assert.ok(underTree(storage, UID).length >= 2, 'the seed never landed');

    await deleteAccount(UID, { initiatedBy: 'user', storage, hooks: [], auth: fakeDeletionAuth() });
    assert.deepEqual(underTree(storage, UID), [], 'the sweep left part of the tree');

    const [tombstonePath] = deletionTombstonePaths(UID, { sharedStorage: true });
    assert.ok(tombstonePath, 'with the pepper set there is somewhere to look');
    const tombstone = await storage.get<DeletionJobRecord>(tombstonePath);
    assert.ok(tombstone, 'the tombstone did not survive the deletion');
    assert.equal(tombstone.status, 'done');
    // Content-free: the id is the peppered hash, and nothing in it is the uid.
    assert.equal(tombstonePath.includes(UID), false, 'the tombstone is keyed by the raw uid');
    assert.equal(JSON.stringify(tombstone).includes(UID), false, 'the finished tombstone still carries the uid');

    await assert.rejects(getOrCreateTrust(UID, '2026-10-02T00:00:00.000Z'), AccountUnavailableError);
    assert.deepEqual(underTree(storage, UID), [], 'a refused create still wrote something');
  } finally {
    restore();
  }
});

test('#794: a deletion that stops after its first step has already left the tombstone', async () => {
  // The claim is the first write. A process that dies right after it — here,
  // the session revocation fails — must not leave a window in which a first
  // request creates the account it was deleting.
  const { storage, restore } = begin();
  try {
    await assert.rejects(deleteAccount(UID, {
      initiatedBy: 'user',
      storage,
      hooks: [],
      auth: {
        async revokeRefreshTokens() { throw new Error('instance went away'); },
        async deleteUser() {},
      },
    }));
    assert.deepEqual(underTree(storage, UID), [], 'there was no account to begin with');

    await assert.rejects(getOrCreateTrust(UID, '2026-10-02T00:00:00.000Z'), AccountUnavailableError);
    assert.deepEqual(underTree(storage, UID), [], 'a refused create still wrote something');
  } finally {
    restore();
  }
});

test('#794: a root a stray writer re-created without trust is not completed into a live account', async () => {
  // The merge half of the create path: `users/{uid}` exists with no trust
  // record (Q772-001's shape). Merging a fresh trust record into it would make
  // the deleted account live again just the same.
  const { storage, restore } = begin();
  try {
    await deleteAccount(UID, { initiatedBy: 'user', storage, hooks: [], auth: fakeDeletionAuth() });
    await storage.set(userDoc(UID), { locale: 'ar' });

    await assert.rejects(getOrCreateTrust(UID, '2026-10-02T00:00:00.000Z'), AccountUnavailableError);
    const root = await storage.get<{ trust?: unknown }>(userDoc(UID));
    assert.equal(root?.trust, undefined, 'a trust record was merged into a deleted account\'s root');
  } finally {
    restore();
  }
});

test('#794: an ordinary first request still creates the trust record, and another uid\'s tombstone does not block it', async () => {
  // A new account is a new uid: Firebase never reuses one, so the person who
  // deleted UID and signs up again arrives as NEW_UID.
  const { storage, restore } = begin();
  try {
    await deleteAccount(UID, { initiatedBy: 'user', storage, hooks: [], auth: fakeDeletionAuth() });

    setTokenVerifierForTests(verifierFor(NEW_UID));
    setAccountDirectoryForTests({ async exists() { return true; } });
    const user = await requireMobileUser(request());

    assert.equal(user.uid, NEW_UID);
    const trust = await readTrust(NEW_UID);
    assert.ok(trust, 'a genuine first request got no trust record');
    assert.equal(trust.deletedAt, null);
  } finally {
    restore();
  }
});

test('#794: without the pepper, the in-memory backend still creates trust: no other process can have deleted anyone there', async () => {
  for (const env of [{}, { MAYBESITTER_STORAGE_BACKEND: 'memory' }] as const) {
    const { restore } = begin(env);
    try {
      assert.deepEqual(deletionTombstonePaths(UID, { sharedStorage: false }), []);
      setTokenVerifierForTests(verifierFor(UID));
      setAccountDirectoryForTests({ async exists() { return true; } });
      await requireMobileUser(request());
      assert.ok(await readTrust(UID), `a first request on the memory backend got no trust record (${JSON.stringify(env)})`);
    } finally {
      restore();
    }
  }
});

test('Q794-003: the Firestore backend without the pepper refuses a first request (503), on Cloud Run or off it', async () => {
  // An operator shell against real Firestore (no K_SERVICE) is refused just as
  // Cloud Run is: the backend decides, not the host.
  for (const env of [{ MAYBESITTER_STORAGE_BACKEND: 'firestore' }, { K_SERVICE: 'maybesitter-api' }] as const) {
    let view!: ReturnType<typeof sharedView>;
    const { storage, restore } = begin(env, (inner) => (view = sharedView(inner)));
    try {
      setTokenVerifierForTests(verifierFor(UID));
      setAccountDirectoryForTests({ async exists() { return true; } });
      const refusal = await refusalOf(requireMobileUser(request()));
      assert.equal(refusal?.status, 503, JSON.stringify(env));
      assert.equal(refusal?.body.reason, 'auth_unavailable');
      assert.deepEqual(underTree(storage, UID), [], 'a refused first request still wrote a root');
      assert.deepEqual(view.tombstoneReads, []);
    } finally {
      restore();
    }
  }
});

test('Q794-003: the Firestore backend on the local emulator without the pepper still creates trust', async () => {
  const { restore } = begin({ MAYBESITTER_STORAGE_BACKEND: 'firestore', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
  try {
    setTokenVerifierForTests(verifierFor(UID));
    setAccountDirectoryForTests({ async exists() { return true; } });
    await requireMobileUser(request());
    assert.ok(await readTrust(UID), 'an emulator first request got no trust record');
  } finally {
    restore();
  }
});

test('Q794-002: after a pepper rotation, the previous pepper still finds a tombstone written before it', async () => {
  // Deleted under the old pepper.
  let view!: ReturnType<typeof sharedView>;
  const { storage, restore } = begin({ MAYBESITTER_DELETION_RECEIPT_PEPPER: PEPPER }, (inner) => (view = sharedView(inner)));
  try {
    await deleteAccount(UID, { initiatedBy: 'user', storage, hooks: [], auth: fakeDeletionAuth() });

    // Rotated without PREVIOUS: the old tombstone is invisible, one read, and
    // the deleted uid gets a fresh record. This is why the runbook forbids it.
    process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = ROTATED_PEPPER;
    view.tombstoneReads.length = 0;
    await getOrCreateTrust(UID, '2026-10-02T00:00:00.000Z');
    assert.equal(view.tombstoneReads.length, 1, 'without PREVIOUS the lookup is one point read');
    await storage.deleteTree(userDoc(UID));

    // Rotated with PREVIOUS: both paths are read in the transaction, and the
    // old one refuses.
    process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS = PEPPER;
    view.tombstoneReads.length = 0;
    await assert.rejects(getOrCreateTrust(UID, '2026-10-03T00:00:00.000Z'), AccountUnavailableError);
    assert.equal(view.tombstoneReads.length, 2, 'with PREVIOUS the lookup reads both paths');
    assert.deepEqual(underTree(storage, UID), [], 'a refused create still wrote something');

    // And through authentication: 403 deleted.
    setTokenVerifierForTests(verifierFor(UID));
    setAccountDirectoryForTests({ async exists() { return true; } });
    const refusal = await refusalOf(requireMobileUser(request()));
    assert.equal(refusal?.status, 403);
    assert.equal(refusal?.body.reason, 'deleted');
  } finally {
    restore();
  }
});

test('Q794-001: applyTrustAction will not create trust for a deleted account, absent root or trust-less root', async () => {
  const { storage, restore } = begin();
  try {
    await deleteAccount(UID, { initiatedBy: 'user', storage, hooks: [], auth: fakeDeletionAuth() });
    const action = { type: 'set_analytics_consent', granted: true, at: '2026-10-02T00:00:00.000Z' } as const;

    await assert.rejects(applyTrustAction(UID, action), AccountUnavailableError);
    assert.deepEqual(underTree(storage, UID), [], 'a consent action re-created the deleted account');

    await storage.set(userDoc(UID), { locale: 'ar' });
    await assert.rejects(applyTrustAction(UID, { type: 'record_first_value', at: action.at }), AccountUnavailableError);
    const root = await storage.get<{ trust?: unknown }>(userDoc(UID));
    assert.equal(root?.trust, undefined, 'a first-value action merged trust into a deleted account\'s root');
  } finally {
    restore();
  }
});

test('Q794-001: applyTrustAction on a never-deleted uid with no record still creates one', async () => {
  const { restore } = begin();
  try {
    const trust = await applyTrustAction(NEW_UID, { type: 'set_analytics_consent', granted: true, at: '2026-10-02T00:00:00.000Z' });
    assert.equal(trust.analyticsConsent, true);
    assert.ok(await readTrust(NEW_UID));
  } finally {
    restore();
  }
});
