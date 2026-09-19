/**
 * "Give me a usable bearer token", and nothing more than the bearer.
 *
 * The seam exists because the two ways to get a token before Phase B —
 * `loadOAuthTokenSet` and `refreshProviderAccessToken` — both hand the caller a
 * `ProviderOAuthTokenSet`, which carries the plaintext **refresh** token. A
 * transport has no business holding the credential that mints new ones, so the
 * first test here is the one that matters: what comes back contains the access
 * token and no trace of the refresh token.
 *
 * The other half is *when* to refresh. Refreshing on every read would work and
 * would be wrong; `providerTokenState` already encodes the answer, and these
 * tests pin that the seam consults it rather than guessing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderAccessTokenProvider,
  loadProviderAccessToken,
  ProviderAccessTokenError,
} from '../../lib/integrations/providers/production/providerAccessToken.ts';
import { MemoryIntegrationConnectionStore } from '../../lib/integrations/connections/connectionRegistry.ts';
import { GMAIL_SCOPES } from '../../lib/integrations/gmail/adapter.ts';
import type {
  ProviderCredentialVault,
  ProviderOAuthTokenSet,
} from '../../lib/integrations/providers/providerRuntime.ts';
import type { ProviderOAuthClient } from '../../lib/integrations/providers/providerOAuthLifecycle.ts';
import type {
  IntegrationConnectionRecord,
  IntegrationCredentialReference,
} from '../../src/contracts/v1/integrationConnectionContracts.ts';

const NOW = '2026-09-19T12:00:00.000Z';
const ACCESS = 'ya29.ACCESS-TOKEN-fixture';
const REFRESH = '1//REFRESH-TOKEN-fixture-must-never-leave-the-vault';
const REFRESHED_ACCESS = 'ya29.ACCESS-TOKEN-fixture-rotated';

const REF: IntegrationCredentialReference = { vault: 'kms', keyId: 'gmail-1', version: '1' };

function tokenSet(over: Partial<ProviderOAuthTokenSet> = {}): ProviderOAuthTokenSet {
  return {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    // Comfortably in the future, so `providerTokenState` says `active`.
    accessTokenExpiresAt: '2026-09-19T14:00:00.000Z',
    refreshTokenExpiresAt: null,
    grantedScopes: [GMAIL_SCOPES.read],
    ...over,
  };
}

/** A vault that records what it was asked for and refuses another account's scope. */
function memoryVault(initial: ProviderOAuthTokenSet | null, uid = 'scope-a') {
  let held = initial;
  const stored: ProviderOAuthTokenSet[] = [];
  const vault: ProviderCredentialVault = {
    async storeOAuthTokenSet(input) {
      // The real vault is built per-uid and throws on a mismatch. Reproduced
      // here because the seam's isolation guarantee depends on it.
      if (input.scopeId !== uid) throw new Error('credential scope does not match the vault account');
      stored.push(input.tokenSet);
      held = input.tokenSet;
      return REF;
    },
    async loadOAuthTokenSet() {
      return held;
    },
    async delete() {
      held = null;
    },
  };
  return { vault, stored };
}

async function connectionWith(
  store: MemoryIntegrationConnectionStore,
  over: Partial<Parameters<MemoryIntegrationConnectionStore['upsert']>[0]> = {},
): Promise<IntegrationConnectionRecord> {
  return store.upsert({
    scopeId: 'scope-a',
    identity: { provider: 'google', providerAccountId: 'google-1', providerSpaceId: null, displayName: 'Work' },
    state: 'connected',
    capabilities: ['mail_read'],
    grantedScopes: [GMAIL_SCOPES.read],
    credentialRef: REF,
    ...over,
  }, NOW);
}

function oauthClient(over: Partial<ProviderOAuthClient> = {}): ProviderOAuthClient {
  return {
    provider: 'google',
    async exchangeAuthorizationCode() { throw new Error('not used'); },
    async loadIdentity() { throw new Error('not used'); },
    async revoke() {},
    async refreshAccessToken(current) {
      return {
        ...current,
        accessToken: REFRESHED_ACCESS,
        accessTokenExpiresAt: '2026-09-19T15:00:00.000Z',
      };
    },
    ...over,
  };
}

/* ── The guarantee the seam exists for ─────────────────────────── */

test('the seam returns the bearer and never the refresh token', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const connection = await connectionWith(store);
  const { vault } = memoryVault(tokenSet());

  const token = await loadProviderAccessToken(
    { vault, connections: store },
    { scopeId: 'scope-a', connectionId: connection.connectionId, now: NOW },
  );

  assert.equal(token.accessToken, ACCESS);
  assert.equal(token.refreshed, false);
  // The whole point: nothing that came back can be used to mint a new grant.
  assert.equal(JSON.stringify(token).includes(REFRESH), false);
  assert.deepEqual(Object.keys(token).sort(), ['accessToken', 'expiresAt', 'refreshed']);
  assert.equal('refreshToken' in token, false);
  assert.equal('credentialRef' in token, false);
});

test('the convenience provider hands a transport a bare string', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const connection = await connectionWith(store);
  const { vault } = memoryVault(tokenSet());

  const provider = createProviderAccessTokenProvider(
    { vault, connections: store },
    { scopeId: 'scope-a', connectionId: connection.connectionId, now: () => NOW },
  );

  const bearer = await provider();
  assert.equal(bearer, ACCESS);
  assert.equal(typeof bearer, 'string');
});

/* ── When to refresh ───────────────────────────────────────────── */

test('an active token is used as is, with no call to the provider', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const connection = await connectionWith(store);
  const { vault, stored } = memoryVault(tokenSet());
  let refreshes = 0;
  const client = oauthClient({
    async refreshAccessToken(current) {
      refreshes += 1;
      return { ...current, accessToken: REFRESHED_ACCESS };
    },
  });

  const token = await loadProviderAccessToken(
    { vault, connections: store, client },
    { scopeId: 'scope-a', connectionId: connection.connectionId, now: NOW },
  );

  assert.equal(token.accessToken, ACCESS);
  // Refreshing unconditionally would burn a token request on every read and
  // rotate the credential far more often than the grant needs.
  assert.equal(refreshes, 0);
  assert.deepEqual(stored, []);
});

test('a token inside the refresh window is refreshed and the new bearer returned', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const connection = await connectionWith(store);
  // Five minutes out, inside `providerTokenState`'s ten-minute skew.
  const { vault } = memoryVault(tokenSet({ accessTokenExpiresAt: '2026-09-19T12:05:00.000Z' }));

  const token = await loadProviderAccessToken(
    { vault, connections: store, client: oauthClient() },
    { scopeId: 'scope-a', connectionId: connection.connectionId, now: NOW },
  );

  assert.equal(token.accessToken, REFRESHED_ACCESS);
  assert.equal(token.refreshed, true);
  assert.equal(JSON.stringify(token).includes(REFRESH), false);
});

test('an expired grant with no refresh token asks for re-consent instead of retrying', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const connection = await connectionWith(store);
  const { vault } = memoryVault(tokenSet({
    accessTokenExpiresAt: '2026-09-19T11:00:00.000Z',
    refreshToken: null,
  }));

  await assert.rejects(
    () => loadProviderAccessToken(
      { vault, connections: store, client: oauthClient() },
      { scopeId: 'scope-a', connectionId: connection.connectionId, now: NOW },
    ),
    (error: unknown) => error instanceof ProviderAccessTokenError && error.code === 'reauth_required',
  );
});

test('a revoked grant is refused', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const connection = await connectionWith(store, { state: 'revoked', revokedAt: NOW });
  // The store keeps the record; the vault still holds a token. Neither is a
  // licence to use it.
  const { vault } = memoryVault(tokenSet());

  await assert.rejects(
    () => loadProviderAccessToken(
      { vault, connections: store },
      { scopeId: 'scope-a', connectionId: connection.connectionId, now: NOW },
    ),
    (error: unknown) => error instanceof ProviderAccessTokenError && error.code === 'token_revoked',
  );
});

test('a refresh the provider refuses becomes re-consent, not an endless retry', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const connection = await connectionWith(store);
  const { vault } = memoryVault(tokenSet({ accessTokenExpiresAt: '2026-09-19T12:05:00.000Z' }));
  const client = oauthClient({
    async refreshAccessToken() {
      // What a dead refresh token looks like: `invalid_grant` from the token
      // endpoint. The user changed their password, or revoked access.
      throw Object.assign(new Error('invalid_grant'), { httpStatus: 400 });
    },
  });

  await assert.rejects(
    () => loadProviderAccessToken(
      { vault, connections: store, client },
      { scopeId: 'scope-a', connectionId: connection.connectionId, now: NOW },
    ),
    (error: unknown) => error instanceof ProviderAccessTokenError && error.code === 'reauth_required',
  );

  const after = await store.get(connection.connectionId);
  assert.notEqual(after?.state, 'connected');
});

/* ── Isolation ─────────────────────────────────────────────────── */

test('a read for another account is refused before a credential is loaded', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const connection = await connectionWith(store);
  let loads = 0;
  const { vault } = memoryVault(tokenSet());
  const spying: ProviderCredentialVault = {
    ...vault,
    async loadOAuthTokenSet(ref) {
      loads += 1;
      return vault.loadOAuthTokenSet(ref);
    },
  };

  await assert.rejects(
    () => loadProviderAccessToken(
      { vault: spying, connections: store },
      { scopeId: 'someone-else', connectionId: connection.connectionId, now: NOW },
    ),
    (error: unknown) => error instanceof ProviderAccessTokenError && error.code === 'scope_mismatch',
  );
  // The vault would have refused too, but failing first means one account's
  // credential is never even read on another account's behalf.
  assert.equal(loads, 0);
});

test('a connection that does not exist, and one with no credential, both fail closed', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const { vault } = memoryVault(tokenSet());

  await assert.rejects(
    () => loadProviderAccessToken({ vault, connections: store }, {
      scopeId: 'scope-a', connectionId: 'nope', now: NOW,
    }),
    (error: unknown) => error instanceof ProviderAccessTokenError && error.code === 'connection_missing',
  );

  const noCredential = await connectionWith(store, { credentialRef: undefined });
  await assert.rejects(
    () => loadProviderAccessToken({ vault, connections: store }, {
      scopeId: 'scope-a', connectionId: noCredential.connectionId, now: NOW,
    }),
    (error: unknown) => error instanceof ProviderAccessTokenError && error.code === 'credential_missing',
  );

  const emptyVault = memoryVault(null);
  const present = await connectionWith(store);
  await assert.rejects(
    () => loadProviderAccessToken({ vault: emptyVault.vault, connections: store }, {
      scopeId: 'scope-a', connectionId: present.connectionId, now: NOW,
    }),
    (error: unknown) => error instanceof ProviderAccessTokenError && error.code === 'credential_missing',
  );
});

/* ── What the errors may say ───────────────────────────────────── */

test('no error message carries a token, a vault key, or the providers reply', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const connection = await connectionWith(store);
  const { vault } = memoryVault(tokenSet({ accessTokenExpiresAt: '2026-09-19T12:05:00.000Z' }));
  const client = oauthClient({
    async refreshAccessToken() {
      throw Object.assign(new Error(`invalid_grant for ${REFRESH} at https://oauth2.googleapis.com/token`), {
        httpStatus: 400,
      });
    },
  });

  const error = await loadProviderAccessToken(
    { vault, connections: store, client },
    { scopeId: 'scope-a', connectionId: connection.connectionId, now: NOW },
  ).catch((caught: unknown) => caught);

  assert.ok(error instanceof ProviderAccessTokenError);
  // A fixed message per code, in the manner of `SafeFetchError`.
  assert.equal(error.message, 'provider access token unavailable: reauth_required');
  const surfaced = `${error.message}${error.stack ?? ''}`;
  for (const secret of [REFRESH, ACCESS, 'oauth2.googleapis.com', REF.keyId]) {
    assert.equal(surfaced.includes(secret), false, `leaked ${secret}`);
  }
});

test('NEGATIVE CONTROL: that leak sweep can fail', async () => {
  // The sweep above asserts absence; this proves absence is not vacuous.
  const leaky = `provider access token unavailable, token was ${REFRESH}`;
  assert.throws(() => {
    for (const secret of [REFRESH, ACCESS]) {
      assert.equal(leaky.includes(secret), false, `leaked ${secret}`);
    }
  }, /leaked 1\/\/REFRESH-TOKEN/);
});
