import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryKms } from '../../lib/security/inMemoryKms.ts';
import { KMS_KEY_ENV_VAR, type FieldEncryptionOptions } from '../../lib/security/fieldEncryption.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { OAUTH_CLEANUP_OBLIGATIONS } from '../../lib/storage/paths.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import type { ProviderOAuthTokenSet } from '../../lib/integrations/providers/providerRuntime.ts';
import {
  StoredOAuthCleanupObligations, retryOAuthCleanupObligations,
} from '../../lib/integrations/providers/production/oauthCleanupObligations.ts';
import { beginGoogleConnect, GoogleConnectError } from '../../lib/integrations/google/googleConnectService.ts';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime.ts';

// Phase 5.2 security tests: the Gmail connect gate, and what a revocation keeps
// after it is recorded. Nothing here reaches a hosted service: the KMS is the
// in-memory one and the storage is the memory adapter.

const KEY = 'projects/p/locations/l/keyRings/r/cryptoKeys/user-secrets';
const T0 = '2026-11-07T09:00:00.000Z';
const ACCESS = 'ya29.SECRET-ACCESS-FOR-TEST';
const REFRESH = '1//0gSECRET-REFRESH-FOR-TEST';

function crypto(): FieldEncryptionOptions {
  return { env: { [KMS_KEY_ENV_VAR]: KEY } as unknown as NodeJS.ProcessEnv, kms: createInMemoryKms({ keyName: KEY }) };
}

function tokenSet(overrides: Partial<ProviderOAuthTokenSet>): ProviderOAuthTokenSet {
  return {
    accessToken: ACCESS, refreshToken: REFRESH, accessTokenExpiresAt: null, refreshTokenExpiresAt: null,
    grantedScopes: [], ...overrides,
  };
}

/** The reason a connect is refused, or null when it got past the gate to the config check. */
async function refusalFor(feature: 'gmail' | 'calendar', env: Record<string, string>): Promise<string | null> {
  const storage = createMemoryStorage();
  const runtime = { storage, env, secrets: null, fetchImpl: fetch, now: () => new Date(T0) } as unknown as GoogleRuntime;
  try {
    await beginGoogleConnect('u-gate', feature, runtime);
    return null;
  } catch (error) {
    if (error instanceof GoogleConnectError) return error.reason;
    throw error;
  }
}

// ── The Gmail connect gate ─────────────────────────────────────────────

test('a Gmail grant is refused before any config or store is touched when neither Gmail feature is on', async () => {
  assert.equal(await refusalFor('gmail', {}), 'google_feature_unavailable');
});

test('local with the email flag is an allowed M5a environment, so a Gmail grant passes the gate there', async () => {
  assert.equal(await refusalFor('gmail', { MAYBESITTER_ENV: 'local', MAYBESITTER_FEATURE_EMAIL_SOURCES: 'true' }),
    'provider_not_configured');
});

test('a Gmail grant is refused when M5a email is switched on in production, which pins it off', async () => {
  assert.equal(await refusalFor('gmail', { MAYBESITTER_ENV: 'production', MAYBESITTER_FEATURE_EMAIL_SOURCES: 'true' }),
    'google_feature_unavailable');
});

test('a Gmail grant is refused when the email kill switch is set', async () => {
  assert.equal(await refusalFor('gmail', {
    MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_EMAIL_SOURCES: 'true', MAYBESITTER_KILL_SWITCH_EMAIL_SOURCES: 'true',
  }), 'google_feature_unavailable');
});

test('a Gmail grant passes the gate in staging with the email flag, and in production with the proactive loop', async () => {
  // Past the gate, the refusal comes from the missing Google client config.
  assert.equal(await refusalFor('gmail', { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_EMAIL_SOURCES: 'true' }),
    'provider_not_configured');
  assert.equal(await refusalFor('gmail', { MAYBESITTER_ENV: 'production', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' }),
    'provider_not_configured', 'the released monitor keeps its Gmail connect in production');
});

test('calendar and drive connects are not gated by the Gmail rule', async () => {
  assert.equal(await refusalFor('calendar', {}), 'provider_not_configured');
});

// ── What a revocation keeps ────────────────────────────────────────────

test('a revocation keeps only the refresh token when there is one, and revokes with it', async () => {
  const storage = createMemoryStorage();
  const enc = crypto();
  await new StoredOAuthCleanupObligations(storage, enc, () => new Date(T0))
    .recordGrantRevocation({ provider: 'google', tokenSet: tokenSet({}), providerAccountId: 'sub-keep' });

  const rows = await storage.list<Record<string, unknown>>(OAUTH_CLEANUP_OBLIGATIONS);
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows[0]!.data).includes(ACCESS), false, 'no access token in the stored record, sealed or not');

  const seen: ProviderOAuthTokenSet[] = [];
  const totals = await retryOAuthCleanupObligations({
    storage, encryption: enc, now: new Date(T0), revoke: async (_p, set) => { seen.push(set); },
  });
  assert.deepEqual(totals, { attempted: 1, cleared: 1, failed: 0 });
  assert.equal(seen[0]!.refreshToken, REFRESH);
  assert.equal(seen[0]!.accessToken, '', 'the access token was not retained');
  assert.equal((await storage.list(OAUTH_CLEANUP_OBLIGATIONS)).length, 0, 'cleared obligations are deleted');
});

test('a revocation with no refresh token keeps the access token, the only one there is', async () => {
  const storage = createMemoryStorage();
  const enc = crypto();
  await new StoredOAuthCleanupObligations(storage, enc, () => new Date(T0))
    .recordGrantRevocation({ provider: 'google', tokenSet: tokenSet({ refreshToken: null }), providerAccountId: 'sub-access' });
  const seen: ProviderOAuthTokenSet[] = [];
  await retryOAuthCleanupObligations({ storage, encryption: enc, now: new Date(T0), revoke: async (_p, set) => { seen.push(set); } });
  assert.equal(seen[0]!.accessToken, ACCESS);
  assert.equal(seen[0]!.refreshToken, null);
});

test('a revocation that holds no token at all is not counted as done, and is not sent to Google', async () => {
  const storage = createMemoryStorage();
  const enc = crypto();
  await new StoredOAuthCleanupObligations(storage, enc, () => new Date(T0))
    .recordGrantRevocation({ provider: 'google', tokenSet: tokenSet({ accessToken: '', refreshToken: null }), providerAccountId: 'sub-empty' });
  let calls = 0;
  const totals = await retryOAuthCleanupObligations({
    storage, encryption: enc, now: new Date(T0), revoke: async () => { calls += 1; },
  });
  assert.deepEqual(totals, { attempted: 1, cleared: 0, failed: 1 });
  assert.equal(calls, 0);
  assert.equal((await storage.list(OAUTH_CLEANUP_OBLIGATIONS)).length, 1, 'the obligation stays owed');
});

test('a failed revocation keeps the record with its refresh token for the next run, and only the attempt count moves', async () => {
  const storage: StorageAdapter = createMemoryStorage();
  const enc = crypto();
  await new StoredOAuthCleanupObligations(storage, enc, () => new Date(T0))
    .recordGrantRevocation({ provider: 'google', tokenSet: tokenSet({}), providerAccountId: 'sub-retry' });
  const before = (await storage.list<{ sealed: unknown }>(OAUTH_CLEANUP_OBLIGATIONS))[0]!.data.sealed;
  const totals = await retryOAuthCleanupObligations({
    storage, encryption: enc, now: new Date(T0), revoke: async () => { throw new Error('provider 503'); },
  });
  assert.deepEqual(totals, { attempted: 1, cleared: 0, failed: 1 });
  const after = (await storage.list<{ sealed: unknown; attempts: number }>(OAUTH_CLEANUP_OBLIGATIONS))[0]!.data;
  assert.deepEqual(after.sealed, before, 'the sealed token is not rewritten by a failed run');
  assert.equal(after.attempts, 1);
});
