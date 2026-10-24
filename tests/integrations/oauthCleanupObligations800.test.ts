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
import { StoredIntegrationConnectionStore } from '../../lib/integrations/providers/production/storedConnectionStore.ts';
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

test('the retry never deletes a credential a later connection now holds', async () => {
  const storage = createMemoryStorage();
  const options = crypto();
  await seedLiveAccount(UID, storage);
  // A refused completion owed this deletion at T0 …
  await new StoredOAuthCleanupObligations(storage, options, () => new Date(T0)).recordCredentialDeletion({
    scopeId: UID,
    provider: 'google',
    credentialRef: { vault: 'firestore-envelope-v1', keyId: credentialKeyId('google'), version: null },
  });
  // … and the person connected again before the job ran: same vault key, live record.
  const unused = new StoredOAuthCleanupObligations(storage, options, () => new Date(T1));
  const record = await complete(storage, { crypto: options, cleanup: unused, deleteMidway: false, now: T1 });
  assert.equal(record.state, 'connected');

  assert.deepEqual(await retryOAuthCleanupObligations({ storage, encryption: options, revoke: async () => undefined }), {
    attempted: 1, cleared: 1, failed: 0,
  });
  assert.notEqual(await storage.get(credentialPath()), null, 'the retry deleted the live connection\'s credential');
  assert.deepEqual(await obligations(storage), []);
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
