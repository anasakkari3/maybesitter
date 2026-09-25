/**
 * "Export my data" (#174 step 7): the engine and `GET /api/mobile/account/export`.
 *
 * Three promises are held here:
 *
 *  1. the export reaches every collection account deletion reaches, and a
 *     collection added to deletion cannot be missing from the export;
 *  2. no secret travels in it — not an OAuth token, not a PKCE verifier, not a
 *     KMS envelope, not an FCM token;
 *  3. it is the caller's account and nobody else's, with the uid taken from the
 *     verified token only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import {
  COMMITMENTS,
  DEVICES,
  ICS_FEEDS,
  INCIDENTS,
  PROVIDER_CONNECTIONS,
  PROVIDER_CREDENTIALS,
  PROVIDER_OAUTH_STATES,
  USER_SCOPED_COLLECTIONS,
  userDoc,
  userSubDoc,
} from '../../lib/storage/paths.ts';
import { JOBS } from '../../lib/scheduler/storageSchedulerStore.ts';
import { TOP_LEVEL_USER_COLLECTIONS } from '../../lib/account/topLevelUserData.ts';
import {
  ACCOUNT_EXPORT_SCHEMA_VERSION,
  EXPORT_EXCLUDED_COLLECTIONS,
  ExportTooLargeError,
  buildAccountExport,
  redactForExport,
} from '../../lib/account/accountExport.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as exportGet } from '../../src/app/api/mobile/account/export/route.ts';

const OWNER = 'user_exporting_one';
const OTHER = 'user_bystander_one';

/** One document in every place deletion would look, carrying its owner. */
async function seedEverywhere(storage: StorageAdapter, uid: string): Promise<void> {
  await storage.set(userDoc(uid), { uid, timezone: 'Asia/Jerusalem' });
  for (const collection of USER_SCOPED_COLLECTIONS) {
    await storage.set(userSubDoc(uid, collection, 'seed'), { owner: uid, collection });
  }
  await storage.set(`${JOBS}/job_${uid}`, { id: `job_${uid}`, uid, status: 'pending', owner: uid });
  await storage.set(`${INCIDENTS}/inc_${uid}`, { incidentId: `inc_${uid}`, participantId: uid, owner: uid });
}

test('the export reads exactly the collections deletion removes, minus the named secrets', async () => {
  const storage = createMemoryStorage();
  await seedEverywhere(storage, OWNER);

  const exported = await buildAccountExport(OWNER, { storage });

  const deletionKnows = [
    ...USER_SCOPED_COLLECTIONS,
    ...TOP_LEVEL_USER_COLLECTIONS.map((entry) => entry.collection),
  ];
  const expected = deletionKnows.filter((name) => !(name in EXPORT_EXCLUDED_COLLECTIONS)).sort();
  // Equality, not inclusion: a collection deletion removes that the export
  // skipped would be data the person can erase but never see.
  assert.deepEqual(Object.keys(exported.collections).sort(), expected);
  for (const name of expected) {
    assert.equal(exported.collections[name]!.length, 1, `${name} did not come back`);
    assert.equal(exported.collections[name]![0]!.data.owner, OWNER, `${name} came back with the wrong owner`);
  }
  assert.equal(exported.account.uid, OWNER);
  assert.equal(exported.account.profile?.timezone, 'Asia/Jerusalem');
  assert.equal(exported.schemaVersion, ACCOUNT_EXPORT_SCHEMA_VERSION);
  assert.deepEqual(exported.excluded, EXPORT_EXCLUDED_COLLECTIONS);
});

test('every excluded collection is one deletion knows, and says why it is left out', () => {
  const deletionKnows = new Set<string>([
    ...USER_SCOPED_COLLECTIONS,
    ...TOP_LEVEL_USER_COLLECTIONS.map((entry) => entry.collection),
  ]);
  for (const [name, reason] of Object.entries(EXPORT_EXCLUDED_COLLECTIONS)) {
    assert.ok(deletionKnows.has(name), `${name} is excluded from an export it was never part of`);
    assert.ok(reason.length > 20, `${name} has no stated reason for being left out`);
  }
  assert.deepEqual(Object.keys(EXPORT_EXCLUDED_COLLECTIONS).sort(), [PROVIDER_CREDENTIALS, PROVIDER_OAUTH_STATES].sort());
});

test('no secret travels: tokens, PKCE verifiers, KMS envelopes and FCM tokens are all removed', async () => {
  const storage = createMemoryStorage();
  await storage.set(userDoc(OWNER), { uid: OWNER, trust: { version: 'v1' } });
  await storage.set(userSubDoc(OWNER, PROVIDER_CREDENTIALS, 'cred'), {
    accessToken: 'SECRET-ACCESS-TOKEN', refreshToken: 'SECRET-REFRESH-TOKEN',
  });
  await storage.set(userSubDoc(OWNER, PROVIDER_OAUTH_STATES, 'state'), { codeVerifier: 'SECRET-PKCE-VERIFIER' });
  await storage.set(userSubDoc(OWNER, ICS_FEEDS, 'feed'), {
    label: 'Moodle',
    encryptedUrl: { v: 1, kmsKeyVersion: 'projects/p/keys/k/1', wrappedDek: 'SECRET-WRAPPED-DEK', iv: 'SECRET-IV', ciphertext: 'SECRET-CIPHERTEXT', tag: 'SECRET-TAG' },
  });
  await storage.set(userSubDoc(OWNER, DEVICES, 'install'), { platform: 'ios', fcmToken: 'SECRET-FCM-TOKEN', inputTokens: 12 });
  await storage.set(userSubDoc(OWNER, PROVIDER_CONNECTIONS, 'conn'), {
    provider: 'google', nested: { idToken: 'SECRET-ID-TOKEN', authorizationCode: 'SECRET-AUTH-CODE' },
  });
  await storage.set(userSubDoc(OWNER, COMMITMENTS, 'c1'), { title: 'Call the bank', expiresAt: new Date('2026-10-01T00:00:00.000Z') });

  const exported = await buildAccountExport(OWNER, { storage });
  const text = JSON.stringify(exported);

  assert.doesNotMatch(text, /SECRET-/, 'a secret value reached the export');
  assert.equal(PROVIDER_CREDENTIALS in exported.collections, false);
  assert.equal(PROVIDER_OAUTH_STATES in exported.collections, false);
  // What is not a secret is still there: this is the person's data.
  assert.equal(exported.collections[ICS_FEEDS]![0]!.data.label, 'Moodle');
  assert.equal(exported.collections[DEVICES]![0]!.data.platform, 'ios');
  assert.equal(exported.collections[DEVICES]![0]!.data.inputTokens, 12);
  assert.equal(exported.collections[PROVIDER_CONNECTIONS]![0]!.data.provider, 'google');
  assert.equal(exported.collections[COMMITMENTS]![0]!.data.title, 'Call the bank');
});

test('a Firestore Timestamp becomes an instant rather than its internals', () => {
  const stamp = { _seconds: 1, _nanoseconds: 0, toDate: () => new Date('2026-09-25T10:00:00.000Z') };
  assert.deepEqual(redactForExport({ expiresAt: stamp }), { expiresAt: '2026-09-25T10:00:00.000Z' });
});

test('another account\'s records never appear, even in the uid-carrying top-level collections', async () => {
  const storage = createMemoryStorage();
  await seedEverywhere(storage, OWNER);
  await seedEverywhere(storage, OTHER);

  const text = JSON.stringify(await buildAccountExport(OWNER, { storage }));

  assert.doesNotMatch(text, new RegExp(OTHER));
});

test('an account over the document cap is refused, not truncated', async () => {
  const storage = createMemoryStorage();
  for (let index = 0; index < 5; index += 1) {
    await storage.set(userSubDoc(OWNER, COMMITMENTS, `c${index}`), { title: `item ${index}` });
  }
  await assert.rejects(buildAccountExport(OWNER, { storage, maxDocuments: 4 }), (error: unknown) =>
    error instanceof ExportTooLargeError && error.limit === 'documents');
  // At the cap exactly, it answers.
  const exported = await buildAccountExport(OWNER, { storage, maxDocuments: 5 });
  assert.equal(exported.collections[COMMITMENTS]!.length, 5);
});

test('an account over the size cap is refused, not truncated', async () => {
  const storage = createMemoryStorage();
  await storage.set(userSubDoc(OWNER, COMMITMENTS, 'big'), { title: 'x'.repeat(2_000) });
  await assert.rejects(buildAccountExport(OWNER, { storage, maxChars: 1_000 }), (error: unknown) =>
    error instanceof ExportTooLargeError && error.limit === 'size');
});

// ── The route ──────────────────────────────────────────────────────

let auth: FakeAuthControls | null = null;

function begin(storage: StorageAdapter): void {
  auth = installFakeAuth();
  setStorageForTests(storage);
}

function end(): void {
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function exportRequest(uid: string | null, query = ''): Request {
  const headers = new Headers();
  if (uid) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`http://localhost:3000/api/mobile/account/export${query}`, { headers });
}

test('GET /api/mobile/account/export answers the caller\'s own account, and only theirs', async () => {
  const storage = createMemoryStorage();
  const owner = uidFor('ExportOwner');
  const other = uidFor('ExportOther');
  await seedEverywhere(storage, owner);
  await seedEverywhere(storage, other);
  begin(storage);
  try {
    // A uid named in the query is not read: the token decides whose account.
    const response = await exportGet(exportRequest(owner, `?uid=${other}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as { account: { uid: string }; collections: Record<string, unknown[]> };
    assert.equal(body.account.uid, owner);
    assert.equal(body.collections[COMMITMENTS]!.length, 1);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(other));
    // The destructive-path check, as deletion does: a session revoked a minute
    // ago must not be able to take a copy of the whole account.
    assert.equal(auth!.lastForceRevocationCheck(), true);
  } finally {
    end();
  }
});

test('GET /api/mobile/account/export refuses without a token', async () => {
  begin(createMemoryStorage());
  try {
    const response = await exportGet(exportRequest(null));
    assert.equal(response.status, 401);
  } finally {
    end();
  }
});
