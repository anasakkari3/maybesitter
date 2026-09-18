/**
 * The production provider OAuth/credential runtime (UC-3.3, #187).
 *
 * The domain orchestration — `completeProviderOAuth`, `disconnectProviderOAuth`
 * — was already merged and already has tests. What is new is the part that
 * persists things, so what is tested here is the part that can leak: whether a
 * stored token is readable by the wrong account, whether a `state` can be
 * spent twice, and whether any of it ends up in a log line or an error.
 *
 * Everything runs on the in-memory KMS and the in-memory storage adapter, so
 * there is no network, no credentials and no real key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryKms } from '../../lib/security/inMemoryKms.ts';
import { KMS_KEY_ENV_VAR, type FieldEncryptionOptions } from '../../lib/security/fieldEncryption.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import {
  EncryptedProviderCredentialVault,
  credentialKeyId,
} from '../../lib/integrations/providers/production/encryptedCredentialVault.ts';
import { StoredProviderOAuthStateStore } from '../../lib/integrations/providers/production/storedOAuthStateStore.ts';
import {
  StoredIntegrationConnectionStore,
  connectionIdFor,
} from '../../lib/integrations/providers/production/storedConnectionStore.ts';
import { refreshProviderAccessToken } from '../../lib/integrations/providers/production/refreshProviderAccessToken.ts';
import {
  beginProviderOAuth,
  completeProviderOAuth,
  disconnectProviderOAuth,
  type ProviderOAuthClient,
  type ProviderOAuthState,
} from '../../lib/integrations/providers/providerOAuthLifecycle.ts';
import type { ProviderOAuthTokenSet } from '../../lib/integrations/providers/providerRuntime.ts';
import { PROVIDER_CREDENTIALS, PROVIDER_OAUTH_STATES, userSubDoc } from '../../lib/storage/paths.ts';

const KEY = 'projects/p/locations/l/keyRings/r/cryptoKeys/user-secrets';
const UID_A = 'userA';
const UID_B = 'userB';
const NOW = '2026-09-18T09:00:00.000Z';

function crypto(): FieldEncryptionOptions {
  return { env: { [KMS_KEY_ENV_VAR]: KEY } as unknown as NodeJS.ProcessEnv, kms: createInMemoryKms({ keyName: KEY }) };
}

const ACCESS = 'ya29.SECRET-ACCESS-TOKEN';
const REFRESH = '1//0gSECRET-REFRESH-TOKEN';

function tokenSet(over: Partial<ProviderOAuthTokenSet> = {}): ProviderOAuthTokenSet {
  return {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    accessTokenExpiresAt: '2026-09-18T10:00:00.000Z',
    refreshTokenExpiresAt: null,
    grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    ...over,
  };
}

function client(over: Partial<ProviderOAuthClient> = {}): ProviderOAuthClient {
  return {
    provider: 'google',
    exchangeAuthorizationCode: async () => tokenSet(),
    loadIdentity: async () => ({
      provider: 'google',
      providerAccountId: 'acct-1',
      displayName: null,
    }) as never,
    revoke: async () => undefined,
    ...over,
  };
}

async function connect(uid = UID_A, storage = createMemoryStorage(), options = crypto()) {
  const stateStore = new StoredProviderOAuthStateStore(uid, storage, options);
  const vault = new EncryptedProviderCredentialVault(uid, storage, options);
  const connections = new StoredIntegrationConnectionStore(uid, storage);
  const begun = await beginProviderOAuth(stateStore, {
    scopeId: uid,
    provider: 'google',
    capabilities: ['mail_read'],
    requestedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    redirectUri: 'https://maybesitter.app/oauth/callback',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    clientId: 'client-1',
    now: NOW,
  });
  const record = await completeProviderOAuth(stateStore, vault, connections, client(), {
    scopeId: uid,
    provider: 'google',
    state: begun.state,
    code: 'auth-code',
    now: NOW,
  });
  return { storage, stateStore, vault, connections, record, begun, options };
}

test('a real connection is established, persisted and readable back', async () => {
  const { vault, record } = await connect();
  assert.equal(record.state, 'connected');
  assert.ok(record.credentialRef, 'the connection must reference a stored credential');
  const loaded = await vault.loadOAuthTokenSet(record.credentialRef!);
  assert.equal(loaded?.accessToken, ACCESS);
  assert.equal(loaded?.refreshToken, REFRESH);
});

test('the stored credential document contains no plaintext token', async () => {
  const { storage, record } = await connect();
  const path = userSubDoc(UID_A, PROVIDER_CREDENTIALS, credentialKeyId('google'));
  const raw = await storage.get<unknown>(path);
  const serialized = JSON.stringify(raw);
  assert.ok(!serialized.includes(ACCESS), 'access token stored in plaintext');
  assert.ok(!serialized.includes(REFRESH), 'refresh token stored in plaintext');
  assert.ok(!serialized.includes('ya29.'), 'token prefix stored in plaintext');
});

test('the connection record itself never carries a secret', async () => {
  const { record } = await connect();
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes(ACCESS));
  assert.ok(!serialized.includes(REFRESH));
  assert.equal(record.credentialRef?.vault, 'firestore-envelope-v1');
});

test("another uid cannot read this account's credential", async () => {
  const { storage, record, options } = await connect();
  // The attacker has the reference and the same storage. Only the uid differs.
  const asB = new EncryptedProviderCredentialVault(UID_B, storage, options);
  const loaded = await asB.loadOAuthTokenSet(record.credentialRef!).catch(() => 'threw');
  assert.notEqual(loaded, tokenSet(), 'B must not get A token set');
  assert.ok(loaded === null || loaded === 'threw', `B read A's credential: ${JSON.stringify(loaded)}`);
});

test("copying A's ciphertext into B's tree still does not decrypt", async () => {
  const { storage, record, options } = await connect();
  const keyId = credentialKeyId('google');
  const stolen = await storage.get<unknown>(userSubDoc(UID_A, PROVIDER_CREDENTIALS, keyId));
  await storage.set(userSubDoc(UID_B, PROVIDER_CREDENTIALS, keyId), stolen);
  const asB = new EncryptedProviderCredentialVault(UID_B, storage, options);
  // The AAD is uid-bound, so this fails rather than returning A's secret.
  await assert.rejects(() => asB.loadOAuthTokenSet(record.credentialRef!));
});

test('a vault refuses to store a token for a different account', async () => {
  const storage = createMemoryStorage();
  const vault = new EncryptedProviderCredentialVault(UID_A, storage, crypto());
  await assert.rejects(
    () => vault.storeOAuthTokenSet({ scopeId: UID_B, provider: 'google', tokenSet: tokenSet() }),
    /scope does not match/,
  );
});

test('a replayed state is rejected: the second callback fails', async () => {
  const storage = createMemoryStorage();
  const options = crypto();
  const stateStore = new StoredProviderOAuthStateStore(UID_A, storage, options);
  const vault = new EncryptedProviderCredentialVault(UID_A, storage, options);
  const connections = new StoredIntegrationConnectionStore(UID_A, storage);
  const begun = await beginProviderOAuth(stateStore, {
    scopeId: UID_A,
    provider: 'google',
    capabilities: ['mail_read'],
    requestedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    redirectUri: 'https://maybesitter.app/oauth/callback',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    clientId: 'client-1',
    now: NOW,
  });
  const input = { scopeId: UID_A, provider: 'google' as const, state: begun.state, code: 'c', now: NOW };
  await completeProviderOAuth(stateStore, vault, connections, client(), input);
  await assert.rejects(
    () => completeProviderOAuth(stateStore, vault, connections, client(), input),
    /invalid_or_replayed_state/,
  );
});

test('an unknown state is rejected', async () => {
  const { stateStore } = await connect();
  assert.equal(await stateStore.consume('never-issued', NOW), null);
});

test('an expired state is rejected and is still spent', async () => {
  const storage = createMemoryStorage();
  const stateStore = new StoredProviderOAuthStateStore(UID_A, storage, crypto());
  const state: ProviderOAuthState = {
    state: 'st-1',
    scopeId: UID_A,
    provider: 'google',
    capabilities: ['mail_read'],
    requestedScopes: ['s'],
    redirectUri: 'https://maybesitter.app/oauth/callback',
    codeVerifier: 'verifier',
    createdAt: '2026-09-18T08:00:00.000Z',
    expiresAt: '2026-09-18T08:10:00.000Z',
  };
  await stateStore.create(state);
  assert.equal(await stateStore.consume('st-1', NOW), null, 'expired must not be returned');
  assert.equal(await stateStore.consume('st-1', '2026-09-18T08:05:00.000Z'), null, 'expired state must be spent');
});

test("a state minted for another account cannot be spent by this one", async () => {
  const storage = createMemoryStorage();
  // One KMS for both stores, so a failure below is the AAD refusing and not
  // two different keys failing to agree.
  const shared = crypto();
  const asA = new StoredProviderOAuthStateStore(UID_A, storage, shared);
  await asA.create({
    state: 'st-x',
    scopeId: UID_A,
    provider: 'google',
    capabilities: ['mail_read'],
    requestedScopes: ['s'],
    redirectUri: 'https://maybesitter.app/oauth/callback',
    codeVerifier: 'verifier',
    createdAt: NOW,
    expiresAt: '2026-09-18T09:10:00.000Z',
  });
  const asB = new StoredProviderOAuthStateStore(UID_B, storage, shared);
  assert.equal(await asB.consume('st-x', NOW), null);
});

test('the PKCE verifier never appears in the authorization URL', async () => {
  const { begun } = await connect();
  const url = new URL(begun.authorizationUrl);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.get('code_verifier'), null, 'the verifier must never be sent');
});

test('a malformed callback is rejected before anything is stored', async () => {
  const { stateStore, vault, connections } = await connect();
  for (const bad of [{ state: '' }, { code: '' }, { now: 'not-a-date' }]) {
    await assert.rejects(() =>
      completeProviderOAuth(stateStore, vault, connections, client(), {
        scopeId: UID_A,
        provider: 'google',
        state: 'st',
        code: 'c',
        now: NOW,
        ...bad,
      } as never),
    );
  }
});

test('refresh replaces the token and updates the connection atomically', async () => {
  const { vault, connections, record, storage } = await connect();
  const fresh = tokenSet({
    accessToken: 'ya29.NEW-ACCESS',
    refreshToken: null,
    accessTokenExpiresAt: '2026-09-18T11:00:00.000Z',
  });
  const result = await refreshProviderAccessToken(
    vault,
    connections,
    client({ refreshAccessToken: async () => fresh }),
    { scopeId: UID_A, connectionId: record.connectionId, now: NOW },
  );
  assert.equal(result.tokenSet.accessToken, 'ya29.NEW-ACCESS');
  // The provider returned no refresh token, which means "keep yours".
  assert.equal(result.tokenSet.refreshToken, REFRESH);
  assert.equal(result.connection.expiresAt, '2026-09-18T11:00:00.000Z');
  assert.equal(result.connection.state, 'connected');
  const reloaded = await vault.loadOAuthTokenSet(result.connection.credentialRef!);
  assert.equal(reloaded?.accessToken, 'ya29.NEW-ACCESS', 'the vault must hold the new token');
  const raw = JSON.stringify(await storage.get<unknown>(
    userSubDoc(UID_A, PROVIDER_CREDENTIALS, credentialKeyId('google')),
  ));
  assert.ok(!raw.includes('ya29.NEW-ACCESS'), 'the refreshed token must also be encrypted at rest');
});

test('a refused refresh moves the connection to needs_reauth, not error', async () => {
  const { vault, connections, record } = await connect();
  const failing = client({
    refreshAccessToken: async () => {
      throw Object.assign(new Error('invalid_grant'), { httpStatus: 401 });
    },
  });
  await assert.rejects(() =>
    refreshProviderAccessToken(vault, connections, failing, {
      scopeId: UID_A,
      connectionId: record.connectionId,
      now: NOW,
    }),
  );
  const after = await connections.get(record.connectionId);
  assert.equal(after?.state, 'needs_reauth');
});

test('a rate-limited refresh is an error state, not a reauth prompt', async () => {
  const { vault, connections, record } = await connect();
  const limited = client({
    refreshAccessToken: async () => {
      throw Object.assign(new Error('slow down'), { httpStatus: 429 });
    },
  });
  await assert.rejects(() =>
    refreshProviderAccessToken(vault, connections, limited, {
      scopeId: UID_A,
      connectionId: record.connectionId,
      now: NOW,
    }),
  );
  const after = await connections.get(record.connectionId);
  assert.equal(after?.state, 'error', 'a rate limit must not ask the user to reconnect');
});

test('refresh refuses to act for a different account', async () => {
  const { vault, connections, record } = await connect();
  await assert.rejects(
    () =>
      refreshProviderAccessToken(vault, connections, client({ refreshAccessToken: async () => tokenSet() }), {
        scopeId: UID_B,
        connectionId: record.connectionId,
        now: NOW,
      }),
    /state_scope_mismatch/,
  );
});

test('a missing credential fails safely rather than silently reconnecting', async () => {
  const { vault, connections, record, storage } = await connect();
  await storage.delete(userSubDoc(UID_A, PROVIDER_CREDENTIALS, credentialKeyId('google')));
  await assert.rejects(() =>
    refreshProviderAccessToken(vault, connections, client({ refreshAccessToken: async () => tokenSet() }), {
      scopeId: UID_A,
      connectionId: record.connectionId,
      now: NOW,
    }),
  );
  const after = await connections.get(record.connectionId);
  assert.equal(after?.state, 'needs_reauth');
});

test('disconnect revokes, clears the credential and records the revocation', async () => {
  const { vault, connections, record, storage } = await connect();
  let revoked = false;
  const result = await disconnectProviderOAuth(
    vault,
    connections,
    client({ revoke: async () => { revoked = true; } }),
    { scopeId: UID_A, connectionId: record.connectionId, now: NOW },
  );
  assert.equal(revoked, true, 'the provider must be told');
  assert.equal(result?.state, 'revoked');
  assert.ok(result?.revokedAt, 'revocation must carry a time');
  const raw = await storage.get<unknown>(userSubDoc(UID_A, PROVIDER_CREDENTIALS, credentialKeyId('google')));
  assert.equal(raw ?? null, null, 'the credential must be gone');
  assert.equal(await vault.loadOAuthTokenSet(record.credentialRef!), null);
});

test('disconnect does not touch the account, only the grant', async () => {
  // Confirmed canonical commitments are a different tree entirely. Disconnect
  // writes to providerConnections and providerCredentials and nowhere else.
  const { storage, record, connections, vault } = await connect();
  await storage.set(`users/${UID_A}/commitments/c1`, { id: 'c1', title: 'Call the clinic' });
  await disconnectProviderOAuth(vault, connections, client(), {
    scopeId: UID_A,
    connectionId: record.connectionId,
    now: NOW,
  });
  const commitment = await storage.get<{ title: string }>(`users/${UID_A}/commitments/c1`);
  assert.equal(commitment?.title, 'Call the clinic', 'disconnect must not remove confirmed commitments');
});

test('a provider error carries no secret', async () => {
  const { vault, connections, record } = await connect();
  const leaky = client({
    refreshAccessToken: async () => {
      throw new Error(`refused for Authorization: Bearer ${ACCESS} refresh_token=${REFRESH}`);
    },
  });
  const error = await refreshProviderAccessToken(vault, connections, leaky, {
    scopeId: UID_A,
    connectionId: record.connectionId,
    now: NOW,
  }).catch((caught: unknown) => caught);
  const text = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
  assert.ok(!text.includes(ACCESS), `access token leaked: ${text}`);
  assert.ok(!text.includes(REFRESH), `refresh token leaked: ${text}`);
});

test('reconnecting replaces the grant instead of orphaning one', async () => {
  const { storage, connections, record, options } = await connect();
  const stateStore = new StoredProviderOAuthStateStore(UID_A, storage, options);
  const vault = new EncryptedProviderCredentialVault(UID_A, storage, options);
  const begun = await beginProviderOAuth(stateStore, {
    scopeId: UID_A,
    provider: 'google',
    capabilities: ['mail_read'],
    requestedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    redirectUri: 'https://maybesitter.app/oauth/callback',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    clientId: 'client-1',
    now: NOW,
  });
  const again = await completeProviderOAuth(stateStore, vault, connections, client(), {
    scopeId: UID_A,
    provider: 'google',
    state: begun.state,
    code: 'code-2',
    now: NOW,
  });
  assert.equal(again.connectionId, record.connectionId);
  assert.equal(again.connectionId, connectionIdFor('google'));
  const all = await connections.list({ scopeId: UID_A });
  assert.equal(all.length, 1, 'a reconnect must not leave a second connection');
});

test('listing is scoped to the account and refuses another scope', async () => {
  const { connections } = await connect();
  await assert.rejects(() => connections.list({ scopeId: UID_B }), /scope does not match/);
  const mine = await connections.list({ scopeId: UID_A });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].scopeId, UID_A);
});

/*
 * The persisted OAuth-state representation (security review of #491).
 *
 * An earlier version of the store wrote the whole `ProviderOAuthState`, raw
 * `state` and PKCE verifier included, while its own comment claimed the state
 * was not stored. Anyone able to read the document could have completed the
 * authorization. These tests are what would have caught it.
 */

const RAW_STATE = 'RAW-STATE-VALUE-0123456789';
const RAW_VERIFIER = 'RAW-PKCE-VERIFIER-abcdefghij';

function inFlight(over: Partial<ProviderOAuthState> = {}): ProviderOAuthState {
  return {
    state: RAW_STATE,
    scopeId: UID_A,
    provider: 'google',
    capabilities: ['mail_read'],
    requestedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    redirectUri: 'https://maybesitter.app/oauth/callback',
    codeVerifier: RAW_VERIFIER,
    createdAt: NOW,
    expiresAt: '2026-09-18T09:10:00.000Z',
    ...over,
  };
}

async function storedStateDocs(storage: ReturnType<typeof createMemoryStorage>, uid = UID_A) {
  return storage.list<unknown>(`users/${uid}/${PROVIDER_OAUTH_STATES}`);
}

test('the persisted state document contains no raw state', async () => {
  const storage = createMemoryStorage();
  const store = new StoredProviderOAuthStateStore(UID_A, storage, crypto());
  await store.create(inFlight());
  const serialized = JSON.stringify(await storedStateDocs(storage));
  assert.ok(!serialized.includes(RAW_STATE), 'the raw OAuth state is persisted in plaintext');
});

test('the persisted state document contains no PKCE verifier', async () => {
  const storage = createMemoryStorage();
  const store = new StoredProviderOAuthStateStore(UID_A, storage, crypto());
  await store.create(inFlight());
  const serialized = JSON.stringify(await storedStateDocs(storage));
  assert.ok(!serialized.includes(RAW_VERIFIER), 'the PKCE verifier is persisted in plaintext');
});

test('the document still describes the authorization, so it is auditable', async () => {
  const storage = createMemoryStorage();
  const store = new StoredProviderOAuthStateStore(UID_A, storage, crypto());
  await store.create(inFlight());
  const serialized = JSON.stringify(await storedStateDocs(storage));
  // Not secrets: which provider, which scopes, where it returns to.
  assert.match(serialized, /google/);
  assert.match(serialized, /gmail\.readonly/);
  assert.match(serialized, /oauth\/callback/);
});

test('a legitimate consume returns the original verifier', async () => {
  const storage = createMemoryStorage();
  const store = new StoredProviderOAuthStateStore(UID_A, storage, crypto());
  await store.create(inFlight());
  const consumed = await store.consume(RAW_STATE, NOW);
  assert.equal(consumed?.codeVerifier, RAW_VERIFIER, 'the callback must get the verifier back');
  assert.equal(consumed?.state, RAW_STATE, 'the raw state is reconstructed from the callback');
  assert.equal(consumed?.redirectUri, 'https://maybesitter.app/oauth/callback');
});

test("another account cannot decrypt a copied state document", async () => {
  const storage = createMemoryStorage();
  const shared = crypto();
  const asA = new StoredProviderOAuthStateStore(UID_A, storage, shared);
  await asA.create(inFlight());
  // Move the ciphertext into B's tree under the same document id.
  const docs = await storedStateDocs(storage);
  await storage.set(`users/${UID_B}/${PROVIDER_OAUTH_STATES}/${docs[0]!.id}`, docs[0]!.data);
  const asB = new StoredProviderOAuthStateStore(UID_B, storage, shared);
  // Same KMS, same key, same document. Only the AAD's uid differs.
  assert.equal(await asB.consume(RAW_STATE, NOW), null, "B decrypted A's verifier");
});

test('the AAD alone stops another account, with scopeId rewritten too', async () => {
  /*
   * The previous test is satisfied by the plaintext `scopeId` check, which
   * returns null before decryption is ever attempted — so on its own it does
   * not prove the AAD does anything. A mutation that removed the uid from the
   * AAD left it passing.
   *
   * `scopeId` is a plaintext field, so an attacker who can write the document
   * can rewrite it. This does exactly that: same KMS, same key, document in
   * B's tree, `scopeId` claiming to be B. Now the only thing left between B
   * and A's verifier is the AAD.
   */
  const storage = createMemoryStorage();
  const shared = crypto();
  const asA = new StoredProviderOAuthStateStore(UID_A, storage, shared);
  await asA.create(inFlight());
  const docs = await storedStateDocs(storage);
  const doc = docs[0]!.data as Record<string, unknown>;
  await storage.set(`users/${UID_B}/${PROVIDER_OAUTH_STATES}/${docs[0]!.id}`, {
    ...doc,
    scopeId: UID_B,
  });
  const asB = new StoredProviderOAuthStateStore(UID_B, storage, shared);
  assert.equal(
    await asB.consume(RAW_STATE, NOW),
    null,
    "B decrypted A's verifier: the AAD is not binding the uid",
  );
});

test('a replayed state is still rejected after the hardening', async () => {
  const storage = createMemoryStorage();
  const store = new StoredProviderOAuthStateStore(UID_A, storage, crypto());
  await store.create(inFlight());
  assert.ok(await store.consume(RAW_STATE, NOW), 'the first consume must succeed');
  assert.equal(await store.consume(RAW_STATE, NOW), null, 'the second must not');
});

test('an expired state is still spent after the hardening', async () => {
  const storage = createMemoryStorage();
  const store = new StoredProviderOAuthStateStore(UID_A, storage, crypto());
  await store.create(inFlight({ expiresAt: '2026-09-18T08:10:00.000Z' }));
  assert.equal(await store.consume(RAW_STATE, NOW), null, 'expired must not be returned');
  assert.equal(await storedStateDocs(storage).then((d) => d.length), 0, 'expired must still be deleted');
});

test('corrupted ciphertext fails closed and does not restore the state', async () => {
  const storage = createMemoryStorage();
  const store = new StoredProviderOAuthStateStore(UID_A, storage, crypto());
  await store.create(inFlight());
  const docs = await storedStateDocs(storage);
  const doc = docs[0]!.data as { verifier: { ciphertext: string } };
  // Flip the ciphertext. AES-GCM authenticates, so this must not decrypt.
  await storage.set(`users/${UID_A}/${PROVIDER_OAUTH_STATES}/${docs[0]!.id}`, {
    ...doc,
    verifier: { ...doc.verifier, ciphertext: Buffer.from('tampered-value').toString('base64') },
  });
  assert.equal(await store.consume(RAW_STATE, NOW), null, 'a tampered verifier must fail closed');
  // Spent anyway: a failed decrypt must not leave a retryable state behind.
  assert.equal(await storedStateDocs(storage).then((d) => d.length), 0, 'a failed decrypt must still spend the state');
  assert.equal(await store.consume(RAW_STATE, NOW), null, 'and must not become reusable');
});

test('a failed decrypt surfaces no state, verifier or ciphertext', async () => {
  const storage = createMemoryStorage();
  const store = new StoredProviderOAuthStateStore(UID_A, storage, crypto());
  await store.create(inFlight());
  const docs = await storedStateDocs(storage);
  const doc = docs[0]!.data as { verifier: { ciphertext: string } };
  const cipher = doc.verifier.ciphertext;
  await storage.set(`users/${UID_A}/${PROVIDER_OAUTH_STATES}/${docs[0]!.id}`, {
    ...doc,
    verifier: { ...doc.verifier, ciphertext: Buffer.from('tampered').toString('base64') },
  });
  const outcome = await store.consume(RAW_STATE, NOW).catch((error: unknown) => error);
  const text = `${String(outcome)} ${JSON.stringify(outcome ?? null)}`;
  assert.ok(!text.includes(RAW_VERIFIER), 'the verifier leaked');
  assert.ok(!text.includes(cipher), 'the ciphertext leaked');
});

test('create refuses an authorization with no state or no verifier', async () => {
  const storage = createMemoryStorage();
  const store = new StoredProviderOAuthStateStore(UID_A, storage, crypto());
  await assert.rejects(() => store.create(inFlight({ state: '' })));
  await assert.rejects(() => store.create(inFlight({ codeVerifier: '' })));
  assert.equal(await storedStateDocs(storage).then((d) => d.length), 0, 'nothing must be written');
});
