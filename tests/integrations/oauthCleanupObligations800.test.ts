/**
 * An OAuth completion refused mid-flow never drops its cleanup (#800).
 *
 * With the #772 writer fences a completion can be refused after the provider
 * issued a grant — most sharply when the account is deleted between two steps.
 * It then has to take back the credential it stored and the grant Google just
 * issued. Both cleanups used to be `.catch(() => undefined)`: a failure left a
 * credential, or a live Google authorization, with no connection record
 * through which a disconnect or the account deletion could retry it.
 *
 * Each failure here is injected on purpose and must leave one durable,
 * content-free obligation outside the account's tree; the maintenance job must
 * retry it, keep it while it still fails, and delete it only once the cleanup
 * landed. The happy paths must leave nothing behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryKms } from '../../lib/security/inMemoryKms.ts';
import { KMS_KEY_ENV_VAR, type FieldEncryptionOptions } from '../../lib/security/fieldEncryption.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import {
  OAUTH_CLEANUP_OBLIGATIONS,
  PROVIDER_CONNECTIONS,
  PROVIDER_CREDENTIALS,
  userDoc,
  userSubDoc,
} from '../../lib/storage/paths.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { AccountUnavailableError } from '../../lib/account/accountLiveness.ts';
import {
  EncryptedProviderCredentialVault,
  credentialKeyId,
} from '../../lib/integrations/providers/production/encryptedCredentialVault.ts';
import { StoredProviderOAuthStateStore } from '../../lib/integrations/providers/production/storedOAuthStateStore.ts';
import { StoredIntegrationConnectionStore, connectionIdFor } from '../../lib/integrations/providers/production/storedConnectionStore.ts';
import {
  StoredOAuthCleanupObligations,
  retryOAuthCleanupObligations,
  type OAuthCleanupObligationDocument,
} from '../../lib/integrations/providers/production/oauthCleanupObligations.ts';
import {
  ProviderOAuthCleanupError,
  beginProviderOAuth,
  completeProviderOAuth,
  type ProviderOAuthCleanupObligations,
  type ProviderOAuthClient,
} from '../../lib/integrations/providers/providerOAuthLifecycle.ts';
import type { ProviderCredentialVault, ProviderOAuthTokenSet } from '../../lib/integrations/providers/providerRuntime.ts';
import {
  beginGoogleConnect,
  completeGoogleConnect,
  disconnectGoogle,
  googleAccessToken,
  GoogleConnectError,
} from '../../lib/integrations/google/googleConnectService.ts';
import { googleRuntime, resetGoogleRuntimeForTests, setGoogleRuntimeForTests } from '../../lib/integrations/google/googleRuntime.ts';
import { runMaintenance } from '../../lib/jobs/internalJobs.ts';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_REDIRECT, FakeGoogle } from '../support/fakeGoogle.ts';

const KEY = 'projects/p/locations/l/keyRings/r/cryptoKeys/user-secrets';
const UID = 'cleanup800User';
const T0 = '2026-10-24T09:00:00.000Z';
const T1 = '2026-10-24T09:05:00.000Z';
const TOKENS: ProviderOAuthTokenSet = {
  accessToken: 'ya29.SECRET-ACCESS-TOKEN',
  refreshToken: '1//0gSECRET-REFRESH-TOKEN',
  accessTokenExpiresAt: '2026-10-24T10:00:00.000Z',
  refreshTokenExpiresAt: null,
  grantedScopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
};

function crypto(): FieldEncryptionOptions {
  return { env: { [KMS_KEY_ENV_VAR]: KEY } as unknown as NodeJS.ProcessEnv, kms: createInMemoryKms({ keyName: KEY }) };
}

/** `markDeleted`, as account deletion writes it (the tree is not swept yet). */
async function markDeleted(storage: StorageAdapter, uid: string): Promise<void> {
  const at = new Date().toISOString();
  const user = (await storage.get<Record<string, any>>(userDoc(uid))) ?? {};
  await storage.set(userDoc(uid), { ...user, trust: { ...(user.trust ?? {}), deletedAt: at, updatedAt: at } });
}

async function obligations(storage: StorageAdapter): Promise<Array<{ id: string; data: OAuthCleanupObligationDocument }>> {
  return storage.list<OAuthCleanupObligationDocument>(OAUTH_CLEANUP_OBLIGATIONS);
}

const credentialPath = (uid = UID) => userSubDoc(uid, PROVIDER_CREDENTIALS, credentialKeyId('google'));

/** The memory adapter, whose next `n` transactions fail as an unreachable Firestore would. */
function flakyTransactions(base: MemoryStorageAdapter): { storage: StorageAdapter; failNext(n: number): void } {
  let failures = 0;
  const storage = new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'runTransaction') {
        return async (...args: unknown[]) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('firestore is unreachable');
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value.bind(target);
    },
  }) as StorageAdapter;
  return { storage, failNext: (n) => { failures = n; } };
}

function client(over: Partial<ProviderOAuthClient> = {}): ProviderOAuthClient {
  return {
    provider: 'google',
    exchangeAuthorizationCode: async () => TOKENS,
    loadIdentity: async () => ({ provider: 'google', providerAccountId: 'acct-1', displayName: null }) as never,
    revoke: async () => undefined,
    ...over,
  };
}

/**
 * One completion on the production stores. `deleteMidway` marks the account
 * deleted after the credential is stored and before the connection is, which
 * is the #772 refusal this issue is about.
 */
async function complete(storage: StorageAdapter, options: {
  readonly crypto: FieldEncryptionOptions;
  readonly cleanup: ProviderOAuthCleanupObligations;
  readonly deleteMidway: boolean;
  readonly vaultDeleteFails?: boolean;
  readonly now?: string;
}) {
  const now = options.now ?? T0;
  const states = new StoredProviderOAuthStateStore(UID, storage, options.crypto);
  const real = new EncryptedProviderCredentialVault(UID, storage, options.crypto, () => new Date(now));
  const vault: ProviderCredentialVault = {
    storeOAuthTokenSet: (input) => real.storeOAuthTokenSet(input),
    loadOAuthTokenSet: (ref) => real.loadOAuthTokenSet(ref),
    delete: async (ref) => {
      if (options.vaultDeleteFails) throw new Error('firestore is unreachable');
      await real.delete(ref);
    },
  };
  const base = new StoredIntegrationConnectionStore(UID, storage);
  const connections = Object.create(base) as StoredIntegrationConnectionStore;
  connections.upsert = async (input, at) => {
    if (options.deleteMidway) await markDeleted(storage, UID);
    return base.upsert(input, at);
  };
  const begun = await beginProviderOAuth(states, {
    scopeId: UID,
    provider: 'google',
    capabilities: ['calendar_busy'],
    requestedScopes: TOKENS.grantedScopes,
    redirectUri: 'https://maybesitter.app/oauth/callback',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    clientId: 'client-1',
    now,
  });
  return completeProviderOAuth(states, vault, connections, client(), {
    scopeId: UID, provider: 'google', state: begun.state, code: 'code-1', now,
  }, options.cleanup);
}

/* ── the stored credential ───────────────────────────────────────── */

test('a failed vault delete after the account was deleted mid-completion leaves one sealed obligation, and the job retries it until the credential is gone', async () => {
  const base = createMemoryStorage();
  const { storage, failNext } = flakyTransactions(base);
  const options = crypto();
  await seedLiveAccount(UID, storage);
  const cleanup = new StoredOAuthCleanupObligations(storage, options, () => new Date(T0));

  await assert.rejects(
    complete(storage, { crypto: options, cleanup, deleteMidway: true, vaultDeleteFails: true }),
    AccountUnavailableError,
    'the refusal is still answered as the deleted account it is',
  );

  // The credential could not be deleted, and the obligation to delete it is on record.
  assert.notEqual(await storage.get(credentialPath()), null, 'the fault was not injected: the credential is gone already');
  const recorded = await obligations(storage);
  assert.equal(recorded.length, 1, 'the failed delete was swallowed instead of recorded');
  assert.equal(recorded[0]!.data.kind, 'credential_delete');
  assert.equal(recorded[0]!.data.provider, 'google');
  assert.equal(recorded[0]!.data.attempts, 0);
  const stored = JSON.stringify(recorded[0]!.data);
  assert.ok(!stored.includes(UID), 'the obligation names the account in plaintext');
  assert.ok(!stored.includes('SECRET'), 'a token reached the obligation in plaintext');

  // A retry that fails keeps the obligation and counts the attempt.
  failNext(1);
  assert.deepEqual(await retryOAuthCleanupObligations({ storage, encryption: options, now: new Date(T1), revoke: async () => undefined }), {
    attempted: 1, cleared: 0, failed: 1,
  });
  assert.notEqual(await storage.get(credentialPath()), null);
  const kept = await obligations(storage);
  assert.equal(kept.length, 1, 'a failed retry dropped the obligation');
  assert.equal(kept[0]!.data.attempts, 1);
  assert.equal(kept[0]!.data.updatedAt, T1);

  // The next one lands: the credential and the obligation go together.
  assert.deepEqual(await retryOAuthCleanupObligations({ storage, encryption: options, now: new Date(T1), revoke: async () => undefined }), {
    attempted: 1, cleared: 1, failed: 0,
  });
  assert.equal(await storage.get(credentialPath()), null, 'the retry did not delete the credential');
  assert.deepEqual(await obligations(storage), []);
  assert.deepEqual(await retryOAuthCleanupObligations({ storage, encryption: options, revoke: async () => undefined }), {
    attempted: 0, cleared: 0, failed: 0,
  });
});

test('the happy paths leave no obligation: a completed connection, and a refusal whose vault delete worked', async () => {
  const storage = createMemoryStorage();
  const options = crypto();
  await seedLiveAccount(UID, storage);
  const cleanup = new StoredOAuthCleanupObligations(storage, options, () => new Date(T0));

  const record = await complete(storage, { crypto: options, cleanup, deleteMidway: false });
  assert.equal(record.state, 'connected');
  assert.deepEqual(await obligations(storage), []);

  await assert.rejects(complete(storage, { crypto: options, cleanup, deleteMidway: true }), AccountUnavailableError);
  assert.equal(await storage.get(credentialPath()), null, 'the credential was taken back');
  assert.deepEqual(await obligations(storage), [], 'a cleanup that worked left an obligation behind');
});

test('a credential deletion that cannot be recorded either is answered as a failure carrying the refusal, never as done', async () => {
  const storage = createMemoryStorage();
  const options = crypto();
  await seedLiveAccount(UID, storage);
  const cleanup: ProviderOAuthCleanupObligations = {
    recordCredentialDeletion: async () => { throw new Error('firestore is unreachable'); },
    recordGrantRevocation: async () => { throw new Error('firestore is unreachable'); },
  };
  await assert.rejects(
    complete(storage, { crypto: options, cleanup, deleteMidway: true, vaultDeleteFails: true }),
    (error) => error instanceof ProviderOAuthCleanupError && error.refusal instanceof AccountUnavailableError,
  );
});

/* ── the credential guard: only the exact credential, and never a live one ── */

/** Stores a credential through the real vault and records its deletion as owed, as a refused completion would. */
async function owedCredential(storage: StorageAdapter, options: FieldEncryptionOptions) {
  const vault = new EncryptedProviderCredentialVault(UID, storage, options, () => new Date(T0));
  const credentialRef = await vault.storeOAuthTokenSet({ scopeId: UID, provider: 'google', tokenSet: TOKENS });
  await new StoredOAuthCleanupObligations(storage, options, () => new Date(T0))
    .recordCredentialDeletion({ scopeId: UID, provider: 'google', credentialRef });
  return { vault, credentialRef };
}

async function upsertConnection(storage: StorageAdapter, credentialRef: Awaited<ReturnType<typeof owedCredential>>['credentialRef']) {
  const connections = new StoredIntegrationConnectionStore(UID, storage);
  return connections.upsert({
    scopeId: UID,
    identity: { provider: 'google', providerAccountId: 'acct-1', displayName: null } as never,
    state: 'connected',
    capabilities: ['calendar_busy'],
    grantedScopes: TOKENS.grantedScopes,
    connectedAt: T0,
    expiresAt: null,
    credentialRef,
    sync: { cursor: null, checkpointAt: null },
    provenance: { source: 'oauth', connectedBy: 'user', recordedAt: T0 },
  }, T0);
}

async function retryOnce(storage: StorageAdapter, options: FieldEncryptionOptions) {
  return retryOAuthCleanupObligations({ storage, encryption: options, revoke: async () => undefined });
}

test('guard, live connection alone: the owed credential itself is kept when a live connection points at it', async () => {
  const storage = createMemoryStorage();
  const options = crypto();
  await seedLiveAccount(UID, storage);
  // The connection write landed but answered with an error: same credential, live record.
  const { credentialRef } = await owedCredential(storage, options);
  await upsertConnection(storage, credentialRef);

  assert.deepEqual(await retryOnce(storage, options), { attempted: 1, cleared: 1, failed: 0 });
  assert.notEqual(await storage.get(credentialPath()), null, 'the retry deleted the credential a live connection holds');
  assert.deepEqual(await obligations(storage), []);
});

test('guard, exact credential alone: a different credential in the same vault document is kept, with no connection at all', async () => {
  const storage = createMemoryStorage();
  const options = crypto();
  await seedLiveAccount(UID, storage);
  const { vault } = await owedCredential(storage, options);
  // A concurrent completion stored its own credential in the same per-provider
  // document, with a clock no later than the obligation's: no timestamp can
  // tell the two apart, only the fingerprint can.
  await vault.storeOAuthTokenSet({ scopeId: UID, provider: 'google', tokenSet: { ...TOKENS, accessToken: 'ya29.SECRET-OTHER' } });

  assert.deepEqual(await retryOnce(storage, options), { attempted: 1, cleared: 1, failed: 0 });
  assert.notEqual(await storage.get(credentialPath()), null, 'the retry deleted a credential it was never owed');
  assert.deepEqual(await obligations(storage), []);
});

for (const state of ['revoked', 'not_connected'] as const) {
  test(`guard, ${state} connection: the owed credential is deleted, since that record no longer holds it`, async () => {
    const storage = createMemoryStorage();
    const options = crypto();
    await seedLiveAccount(UID, storage);
    const { credentialRef } = await owedCredential(storage, options);
    const record = await upsertConnection(storage, credentialRef);
    await new StoredIntegrationConnectionStore(UID, storage).markState(record.connectionId, state, T1);

    assert.deepEqual(await retryOnce(storage, options), { attempted: 1, cleared: 1, failed: 0 });
    assert.equal(await storage.get(credentialPath()), null, `a ${state} connection kept the owed credential alive`);
    assert.deepEqual(await obligations(storage), []);
  });
}

test('a credential deletion is never recorded for a reference the vault did not hand out', async () => {
  const storage = createMemoryStorage();
  await assert.rejects(
    new StoredOAuthCleanupObligations(storage, crypto()).recordCredentialDeletion({
      scopeId: UID,
      provider: 'google',
      credentialRef: { vault: 'firestore-envelope-v1', keyId: credentialKeyId('google'), version: null },
    }),
  );
  assert.deepEqual(await obligations(storage), []);
});

/* ── the queue ───────────────────────────────────────────────────── */

test('more obligations than one run takes: the least recently tried go first', async () => {
  const storage = createMemoryStorage();
  const options = crypto();
  // Recorded out of order, so insertion order cannot pass for age order.
  for (const [at, token] of [['2026-10-24T09:02:00.000Z', 'newest'], [T0, 'oldest'], ['2026-10-24T09:01:00.000Z', 'middle']] as const) {
    await new StoredOAuthCleanupObligations(storage, options, () => new Date(at))
      .recordGrantRevocation({ provider: 'google', tokenSet: { ...TOKENS, accessToken: token, refreshToken: null } });
  }
  const revoked: string[] = [];
  const totals = await retryOAuthCleanupObligations({
    storage,
    encryption: options,
    limit: 2,
    revoke: async (_provider, tokenSet) => { revoked.push(tokenSet.accessToken); },
  });
  assert.deepEqual(totals, { attempted: 2, cleared: 2, failed: 0 });
  assert.deepEqual(revoked, ['oldest', 'middle']);
  assert.equal((await obligations(storage)).length, 1);
});

/* ── the Google grant ────────────────────────────────────────────── */

function setupGoogle(): { storage: MemoryStorageAdapter; google: FakeGoogle; done(): void } {
  const storage = createMemoryStorage();
  const google = new FakeGoogle();
  setStorageForTests(storage);
  const kms = createInMemoryKms();
  setGoogleRuntimeForTests({
    storage,
    env: {
      GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URI: FAKE_REDIRECT,
      MAYBESITTER_KMS_KEY_NAME: kms.keyName,
    },
    secrets: null,
    fetchImpl: google.fetch as typeof fetch,
    encryption: { kms, env: { MAYBESITTER_KMS_KEY_NAME: kms.keyName } as unknown as NodeJS.ProcessEnv },
  });
  return {
    storage,
    google,
    done: () => {
      resetGoogleRuntimeForTests();
      resetStorageForTests();
    },
  };
}

/** Starts a Google connect on a live account and plays the consent screen. */
async function consented(google: FakeGoogle, storage: StorageAdapter): Promise<{ code: string; state: string }> {
  await seedLiveAccount(UID, storage);
  const begun = await beginGoogleConnect(UID, 'calendar', googleRuntime());
  return google.consent(begun.authorizationUrl);
}

async function maintenanceStep(storage: StorageAdapter, at: string) {
  const errorLog = console.error;
  console.error = () => undefined;
  try {
    const result = await runMaintenance({ storage, now: new Date(at) });
    return result.steps.find((step) => step.name === 'oauth_cleanups_retried');
  } finally {
    console.error = errorLog;
  }
}

test('a failed Google revoke for an account deleted while Google was asking is recorded, and maintenance revokes it once Google answers', async () => {
  const { storage, google, done } = setupGoogle();
  try {
    const granted = await consented(google, storage);
    await markDeleted(storage, UID);
    google.revokeStatus = 503;

    await assert.rejects(completeGoogleConnect(UID, granted, googleRuntime()), AccountUnavailableError);
    assert.equal(google.liveGrants(), 1, 'the fault was not injected: the grant is revoked already');
    const recorded = await obligations(storage);
    assert.equal(recorded.length, 1, 'the failed revoke was swallowed instead of recorded');
    assert.equal(recorded[0]!.data.kind, 'grant_revoke');
    const stored = JSON.stringify(recorded[0]!.data);
    assert.ok(!/refresh-\d|access-\d/.test(stored), 'a Google token reached the obligation in plaintext');
    assert.ok(!stored.includes(UID), 'the obligation names the account in plaintext');

    // Google still refuses: the job fails loudly and keeps the obligation.
    assert.deepEqual(await maintenanceStep(storage, T0), { name: 'oauth_cleanups_retried', ok: false });
    assert.equal(google.liveGrants(), 1);
    assert.equal((await obligations(storage))[0]?.data.attempts, 1, 'a failed retry dropped the obligation');

    // Google answers: the grant is revoked and the obligation goes.
    google.revokeStatus = 200;
    assert.deepEqual(await maintenanceStep(storage, T1), { name: 'oauth_cleanups_retried', ok: true, count: 1 });
    assert.equal(google.liveGrants(), 0, 'the retry did not revoke the grant');
    assert.deepEqual(await obligations(storage), []);
  } finally {
    done();
  }
});

test('a Google revoke that works on an account deleted while Google was asking leaves no obligation', async () => {
  const { storage, google, done } = setupGoogle();
  try {
    const granted = await consented(google, storage);
    await markDeleted(storage, UID);
    await assert.rejects(completeGoogleConnect(UID, granted, googleRuntime()), AccountUnavailableError);
    assert.equal(google.liveGrants(), 0);
    assert.deepEqual(await obligations(storage), []);
    assert.deepEqual(await maintenanceStep(storage, T0), { name: 'oauth_cleanups_retried', ok: true, count: 0 });
  } finally {
    done();
  }
});

test('a Google grant that can be neither revoked nor recorded is answered as a failure, not as the deleted account', async () => {
  const { storage, google, done } = setupGoogle();
  try {
    const granted = await consented(google, storage);
    await markDeleted(storage, UID);
    google.revokeStatus = 503;
    const broken = new Proxy(storage, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'set') {
          return async (path: string, data: unknown) => {
            if (path.startsWith(`${OAUTH_CLEANUP_OBLIGATIONS}/`)) throw new Error('firestore is unreachable');
            return target.set(path, data);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as StorageAdapter;
    await assert.rejects(
      completeGoogleConnect(UID, granted, { ...googleRuntime(), storage: broken }),
      (error) => error instanceof GoogleConnectError && error.reason === 'google_unavailable',
    );
    assert.equal(google.liveGrants(), 1);
  } finally {
    done();
  }
});

test('a failed revoke of another Google account\'s grant (account mismatch) is recorded too, and the retry spares the connected grant', async () => {
  const { storage, google, done } = setupGoogle();
  try {
    await completeGoogleConnect(UID, await consented(google, storage), googleRuntime());
    google.account = { sub: '2000000000002', email: 'someone.else@example.com' };
    const begun = await beginGoogleConnect(UID, 'gmail', googleRuntime());
    const other = google.consent(begun.authorizationUrl);
    google.revokeStatus = 503;

    await assert.rejects(
      completeGoogleConnect(UID, other, googleRuntime()),
      (error) => error instanceof GoogleConnectError && error.reason === 'google_account_mismatch',
    );
    assert.equal(google.liveGrants(), 2, 'the fault was not injected');
    assert.equal((await obligations(storage)).length, 1, 'the failed revoke was swallowed instead of recorded');

    google.revokeStatus = 200;
    assert.deepEqual(await maintenanceStep(storage, T1), { name: 'oauth_cleanups_retried', ok: true, count: 1 });
    assert.equal(google.liveGrants(), 1, "only the other account's grant was revoked");
    assert.deepEqual(await obligations(storage), []);
  } finally {
    done();
  }
});

/* ── a pending revocation never kills a later connection of the same account ── */

const PEPPER_VAR = 'MAYBESITTER_DELETION_RECEIPT_PEPPER';
const G1 = { sub: '1000000000001', email: 'person@example.com' };
const G2 = { sub: '2000000000002', email: 'someone.else@example.com' };

/** The account key is the deletion pepper's HMAC; production always has the pepper. */
async function withPepper(run: () => Promise<void>): Promise<void> {
  const before = process.env[PEPPER_VAR];
  process.env[PEPPER_VAR] = 'oauth-cleanup-800-test-pepper';
  try {
    await run();
  } finally {
    if (before === undefined) delete process.env[PEPPER_VAR];
    else process.env[PEPPER_VAR] = before;
  }
}

async function connectAs(google: FakeGoogle, uid: string, account: { sub: string; email: string }, feature: 'calendar' | 'gmail' = 'calendar') {
  google.account = account;
  const begun = await beginGoogleConnect(uid, feature, googleRuntime());
  return completeGoogleConnect(uid, google.consent(begun.authorizationUrl), googleRuntime());
}

test('the probe: a mismatch revoke owed for G2 is cancelled when the person disconnects G1 and connects G2, and G2 survives the nightly run', () => withPepper(async () => {
  const { storage, google, done } = setupGoogle();
  try {
    await seedLiveAccount(UID, storage);
    // 1. U connects G1.
    await connectAs(google, UID, G1);
    // 2. U picks G2 by mistake: refused, and Google refuses the revoke.
    google.revokeStatus = 503;
    await assert.rejects(
      connectAs(google, UID, G2, 'gmail'),
      (error) => error instanceof GoogleConnectError && error.reason === 'google_account_mismatch',
    );
    const owed = await obligations(storage);
    assert.equal(owed.length, 1, 'the failed revoke was not recorded');
    assert.match(String(owed[0]!.data.accountKey), /^[0-9a-f]{64}$/, 'the obligation carries no account key');
    assert.ok(!JSON.stringify(owed[0]!.data).includes(G2.sub), 'the Google account id is stored in plaintext');
    // 3. As the refusal says: disconnect G1, connect G2.
    google.revokeStatus = 200;
    assert.deepEqual(await disconnectGoogle(UID, googleRuntime()), { disconnected: true });
    const status = await connectAs(google, UID, G2);
    assert.equal(status.status, 'connected');
    assert.deepEqual(await obligations(storage), [], 'connecting G2 left its pending revocation in place');
    // 4. The nightly run: nothing to revoke, and G2 still refreshes.
    assert.deepEqual(await maintenanceStep(storage, T1), { name: 'oauth_cleanups_retried', ok: true, count: 0 });
    google.expireAccessTokens();
    assert.ok(await googleAccessToken(UID, 'calendar', googleRuntime(), { forceRefresh: true }), 'the G2 connection no longer refreshes');
    assert.equal(google.liveGrants(), 1);
  } finally {
    done();
  }
}));

test('a revocation owed for a deleted account is cancelled when another MaybeSitter account connects that Google account', () => withPepper(async () => {
  const { storage, google, done } = setupGoogle();
  const OTHER_UID = 'cleanup800Other';
  try {
    await seedLiveAccount(UID, storage);
    google.account = G1;
    const begun = await beginGoogleConnect(UID, 'calendar', googleRuntime());
    const granted = google.consent(begun.authorizationUrl);
    await markDeleted(storage, UID);
    google.revokeStatus = 503;
    await assert.rejects(completeGoogleConnect(UID, granted, googleRuntime()), AccountUnavailableError);
    assert.equal((await obligations(storage)).length, 1, 'the failed revoke was not recorded');

    google.revokeStatus = 200;
    await seedLiveAccount(OTHER_UID, storage);
    assert.equal((await connectAs(google, OTHER_UID, G1)).status, 'connected');
    assert.deepEqual(await obligations(storage), [], 'the other account\'s connect left the pending revocation in place');

    assert.deepEqual(await maintenanceStep(storage, T1), { name: 'oauth_cleanups_retried', ok: true, count: 0 });
    google.expireAccessTokens();
    assert.ok(await googleAccessToken(OTHER_UID, 'calendar', googleRuntime(), { forceRefresh: true }));
    assert.equal(google.liveGrants(), 1);
  } finally {
    done();
  }
}));

test('a connect of a different Google account leaves the pending revocation for the other one in place', () => withPepper(async () => {
  const { storage, google, done } = setupGoogle();
  try {
    await seedLiveAccount(UID, storage);
    await connectAs(google, UID, G1);
    google.revokeStatus = 503;
    await assert.rejects(connectAs(google, UID, G2, 'gmail'), GoogleConnectError);
    google.revokeStatus = 200;
    // Adding a feature on G1 again is a connect, of G1: G2's revocation stays owed.
    assert.equal((await connectAs(google, UID, G1, 'gmail')).status, 'connected');
    assert.equal((await obligations(storage)).length, 1, 'a connect of G1 cancelled the revocation owed for G2');
    assert.deepEqual(await maintenanceStep(storage, T1), { name: 'oauth_cleanups_retried', ok: true, count: 1 });
    assert.equal(google.liveGrants(), 1, 'G2 revoked, G1 kept');
  } finally {
    done();
  }
}));

/* ── the retry itself refuses to revoke a grant a live connection holds ── */

/** `storage`, except that listing the obligations collection fails, as a Firestore outage during the clear would. */
function obligationListFails(storage: MemoryStorageAdapter): StorageAdapter {
  return new Proxy(storage, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'list') {
        return async (collection: string, options?: unknown) => {
          if (collection === OAUTH_CLEANUP_OBLIGATIONS) throw new Error('firestore is unreachable');
          return target.list(collection, options as never);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as StorageAdapter;
}

test('the inspector\'s probe: the clear on connect fails, the connect still succeeds, and the nightly run drops the revocation instead of killing G2', () => withPepper(async () => {
  const { storage, google, done } = setupGoogle();
  try {
    await seedLiveAccount(UID, storage);
    await connectAs(google, UID, G1);
    google.revokeStatus = 503;
    await assert.rejects(connectAs(google, UID, G2, 'gmail'), GoogleConnectError);
    assert.equal((await obligations(storage)).length, 1);
    google.revokeStatus = 200;
    await disconnectGoogle(UID, googleRuntime());

    // Connect G2 while the clear's read of the obligations fails.
    google.account = G2;
    const begun = await beginGoogleConnect(UID, 'calendar', googleRuntime());
    const status = await completeGoogleConnect(UID, google.consent(begun.authorizationUrl), {
      ...googleRuntime(),
      storage: obligationListFails(storage),
    });
    assert.equal(status.status, 'connected', 'a failed clear failed a connect that was already stored');
    assert.equal((await obligations(storage)).length, 1, 'the failure was not injected: the clear ran');

    // The nightly run finds G2 held by a live connection: dropped, not revoked.
    assert.deepEqual(await maintenanceStep(storage, T1), { name: 'oauth_cleanups_retried', ok: true, count: 1 });
    assert.deepEqual(await obligations(storage), []);
    google.expireAccessTokens();
    assert.ok(await googleAccessToken(UID, 'calendar', googleRuntime(), { forceRefresh: true }), 'the nightly run killed the live G2 connection');
    assert.equal(google.liveGrants(), 1);
  } finally {
    done();
  }
}));

test('the clear on connect also finds a revocation filed under the previous pepper', () => withPepper(async () => {
  const { storage, google, done } = setupGoogle();
  const before = process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS;
  try {
    await seedLiveAccount(UID, storage);
    await connectAs(google, UID, G1);
    google.revokeStatus = 503;
    await assert.rejects(connectAs(google, UID, G2, 'gmail'), GoogleConnectError);
    google.revokeStatus = 200;
    const [owed] = await obligations(storage);
    // The pepper rotates: the obligation's key is now the previous pepper's.
    process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS = process.env[PEPPER_VAR];
    process.env[PEPPER_VAR] = 'oauth-cleanup-800-rotated-pepper';
    await disconnectGoogle(UID, googleRuntime());
    assert.equal((await connectAs(google, UID, G2)).status, 'connected');
    assert.ok(owed, 'nothing was recorded');
    assert.deepEqual(await obligations(storage), [], 'the clear looked only under the current pepper');
  } finally {
    if (before === undefined) delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS;
    else process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS = before;
    done();
  }
}));

test('a revocation recorded for an account another MaybeSitter account already holds live is dropped as soon as it is written', async () => {
  const { storage, google, done } = setupGoogle();
  const OTHER_UID = 'cleanup800Holder';
  try {
    // No pepper here: the check after recording is by account id, not by key.
    await seedLiveAccount(OTHER_UID, storage);
    assert.equal((await connectAs(google, OTHER_UID, G2)).status, 'connected');
    await seedLiveAccount(UID, storage);
    await connectAs(google, UID, G1);
    google.revokeStatus = 503;
    await assert.rejects(connectAs(google, UID, G2, 'gmail'), GoogleConnectError);
    assert.deepEqual(await obligations(storage), [], 'a revocation of a grant a live connection holds was kept');
  } finally {
    done();
  }
});

test('the retry re-reads an obligation before revoking, so one cleared after the list was read is not revoked', async () => {
  const base = createMemoryStorage();
  const options = crypto();
  await new StoredOAuthCleanupObligations(base, options, () => new Date(T0))
    .recordGrantRevocation({ provider: 'google', tokenSet: TOKENS });
  // A connect's clear lands between the run's list and its revoke.
  const clearedAfterList = new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'list') {
        return async (collection: string, listOptions?: unknown) => {
          const rows = await target.list(collection, listOptions as never);
          if (collection === OAUTH_CLEANUP_OBLIGATIONS) for (const row of rows) await target.delete(`${collection}/${row.id}`);
          return rows;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as StorageAdapter;
  let revokes = 0;
  const totals = await retryOAuthCleanupObligations({
    storage: clearedAfterList,
    encryption: options,
    revoke: async () => { revokes += 1; },
  });
  assert.equal(revokes, 0, 'a cleared obligation was revoked anyway');
  assert.deepEqual(totals, { attempted: 1, cleared: 1, failed: 0 });
});

test('with no pepper on shared storage, a failed revoke is still recorded, with no account key', async () => {
  const storage = createMemoryStorage();
  const saved = { backend: process.env.MAYBESITTER_STORAGE_BACKEND, pepper: process.env[PEPPER_VAR], emulator: process.env.FIRESTORE_EMULATOR_HOST };
  process.env.MAYBESITTER_STORAGE_BACKEND = 'firestore';
  delete process.env[PEPPER_VAR];
  delete process.env.FIRESTORE_EMULATOR_HOST;
  try {
    await new StoredOAuthCleanupObligations(storage, crypto(), () => new Date(T0))
      .recordGrantRevocation({ provider: 'google', tokenSet: TOKENS, providerAccountId: G2.sub });
  } finally {
    for (const [key, value] of [['MAYBESITTER_STORAGE_BACKEND', saved.backend], [PEPPER_VAR, saved.pepper], ['FIRESTORE_EMULATOR_HOST', saved.emulator]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const owed = await obligations(storage);
  assert.equal(owed.length, 1);
  assert.equal(owed[0]!.data.accountKey, null);
});

for (const state of ['revoked', 'not_connected'] as const) {
  test(`a ${state} connection to the same Google account does not stop the revocation`, async () => {
    const storage = createMemoryStorage();
    const options = crypto();
    await seedLiveAccount('cleanup800Former', storage);
    const vault = new EncryptedProviderCredentialVault('cleanup800Former', storage, options);
    const credentialRef = await vault.storeOAuthTokenSet({ scopeId: 'cleanup800Former', provider: 'google', tokenSet: TOKENS });
    const connections = new StoredIntegrationConnectionStore('cleanup800Former', storage);
    const record = await connections.upsert({
      scopeId: 'cleanup800Former',
      identity: { provider: 'google', providerAccountId: G2.sub, displayName: null } as never,
      state: 'connected',
      capabilities: ['calendar_busy'],
      grantedScopes: TOKENS.grantedScopes,
      connectedAt: T0,
      expiresAt: null,
      credentialRef,
      sync: { cursor: null, checkpointAt: null },
      provenance: { source: 'oauth', connectedBy: 'user', recordedAt: T0 },
    }, T0);
    await connections.markState(record.connectionId, state, T0);

    await new StoredOAuthCleanupObligations(storage, options, () => new Date(T0))
      .recordGrantRevocation({ provider: 'google', tokenSet: TOKENS, providerAccountId: G2.sub });
    assert.equal((await obligations(storage)).length, 1, `a ${state} connection was taken for a live holder when recording`);
    let revokes = 0;
    assert.deepEqual(await retryOAuthCleanupObligations({ storage, encryption: options, revoke: async () => { revokes += 1; } }), {
      attempted: 1, cleared: 1, failed: 0,
    });
    assert.equal(revokes, 1, `a ${state} connection was taken for a live holder at retry`);
  });
}

/* ── who counts as a live holder ─────────────────────────────────── */

/**
 * Writes one connection record for G2 straight into an account's tree, so the
 * holder's provider, state and credential can each be set on their own.
 */
async function seedHolder(storage: StorageAdapter, uid: string, holder: {
  readonly provider: 'google' | 'microsoft';
  readonly state: 'connected' | 'needs_reauth';
  readonly credential: boolean;
}): Promise<void> {
  await seedLiveAccount(uid, storage);
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor(holder.provider)), {
    connectionId: connectionIdFor(holder.provider),
    scopeId: uid,
    identity: { provider: holder.provider, providerAccountId: G2.sub, displayName: null },
    state: holder.state,
    capabilities: ['calendar_busy'],
    grantedScopes: TOKENS.grantedScopes,
    ...(holder.credential ? { credentialRef: { vault: 'firestore-envelope-v1', keyId: credentialKeyId(holder.provider), version: null } } : {}),
  });
}

/** Records a revocation owed for G2 next to `holder`, runs the retry, and says what happened. */
async function revocationBeside(holder: Parameters<typeof seedHolder>[2]): Promise<{ keptAtRecord: boolean; revokes: number; left: number }> {
  const storage = createMemoryStorage();
  const options = crypto();
  await seedHolder(storage, 'cleanup800Holder', holder);
  await new StoredOAuthCleanupObligations(storage, options, () => new Date(T0))
    .recordGrantRevocation({ provider: 'google', tokenSet: TOKENS, providerAccountId: G2.sub });
  const keptAtRecord = (await obligations(storage)).length === 1;
  let revokes = 0;
  await retryOAuthCleanupObligations({ storage, encryption: options, revoke: async () => { revokes += 1; } });
  return { keptAtRecord, revokes, left: (await obligations(storage)).length };
}

test('a holder with no credential does not stop the revocation: its disconnect has nothing to revoke with', async () => {
  assert.deepEqual(await revocationBeside({ provider: 'google', state: 'connected', credential: false }), {
    keptAtRecord: true, revokes: 1, left: 0,
  });
});

test('PROBE-C: a holder of another provider with the same account id does not stop a Google revocation', async () => {
  assert.deepEqual(await revocationBeside({ provider: 'microsoft', state: 'connected', credential: true }), {
    keptAtRecord: true, revokes: 1, left: 0,
  });
});

test('a needs_reauth holder with a credential is a live holder: the revocation is dropped, not revoked', async () => {
  assert.deepEqual(await revocationBeside({ provider: 'google', state: 'needs_reauth', credential: true }), {
    keptAtRecord: false, revokes: 0, left: 0,
  });
});

test('PROBE-B: a holder query Firestore refuses keeps the obligation unrevoked and fails the step', async () => {
  const { storage, google, done } = setupGoogle();
  try {
    await new StoredOAuthCleanupObligations(storage, googleRuntime().encryption, () => new Date(T0))
      .recordGrantRevocation({ provider: 'google', tokenSet: TOKENS, providerAccountId: G2.sub });
    assert.equal((await obligations(storage)).length, 1);
    const refusing = new Proxy(storage, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'listGroup') {
          return async (collectionId: string, options?: unknown) => {
            if (collectionId === PROVIDER_CONNECTIONS) {
              throw Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index'), { code: 9 });
            }
            return target.listGroup(collectionId, options as never);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as StorageAdapter;
    assert.deepEqual(await maintenanceStep(refusing, T1), { name: 'oauth_cleanups_retried', ok: false });
    assert.equal(google.revokeCalls(), 0, 'a revoke went out although nobody could say who holds the grant');
    const kept = await obligations(storage);
    assert.equal(kept.length, 1, 'the obligation was dropped on a failed query');
    assert.equal(kept[0]!.data.attempts, 1);
  } finally {
    done();
  }
});

test('PROBE-E: a connection owned by an account being deleted does not cancel the revocation, and the grant is revoked after the sweep', async () => {
  const { storage, google, done } = setupGoogle();
  try {
    await seedLiveAccount(UID, storage);
    await connectAs(google, UID, G1);
    // A re-consent of G1 is under way when the account's deletion starts.
    google.account = G1;
    const begun = await beginGoogleConnect(UID, 'gmail', googleRuntime());
    const granted = google.consent(begun.authorizationUrl);
    await markDeleted(storage, UID);
    google.revokeStatus = 503;
    await assert.rejects(completeGoogleConnect(UID, granted, googleRuntime()), AccountUnavailableError);
    assert.equal((await obligations(storage)).length, 1, 'the account\'s own doomed record cancelled the revocation');

    // The deletion hook's revoke fails in the same outage, and the tree goes.
    await assert.rejects(disconnectGoogle(UID, googleRuntime(), { accountDeletion: true }));
    await storage.deleteTree(userDoc(UID));
    assert.equal(google.liveGrants(), 1);

    google.revokeStatus = 200;
    assert.deepEqual(await maintenanceStep(storage, T1), { name: 'oauth_cleanups_retried', ok: true, count: 1 });
    assert.equal(google.liveGrants(), 0, 'the grant outlived the deleted account');
    assert.deepEqual(await obligations(storage), []);
  } finally {
    done();
  }
});
