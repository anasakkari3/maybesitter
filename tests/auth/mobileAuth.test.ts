/**
 * The mobile guard, one row of its error table at a time (UC-1.0e, #144).
 *
 * Every case here drives `requireMobileUser` through a fake verifier, so the
 * table is tested as a table rather than as whatever Firebase happened to
 * throw that day. The real signature path is
 * `tests/auth/firebaseTokens.emulator.test.ts`, against the Auth emulator.
 *
 * The two properties worth naming: nothing admits without a token, and no
 * failure admits. The guard this replaced ended its validation in a `try`
 * whose unrecognised failures fell through to "valid", so "a storage outage
 * refuses" is asserted here directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MobileAuthError,
  mobileAuthErrorResponse,
  requireMobileUser,
} from '../../lib/auth/mobileAuth.ts';
import {
  TokenVerificationError,
  resetTokenVerifierForTests,
  setTokenVerifierForTests,
  type TokenVerificationCode,
  type TokenVerifier,
  type VerifyOptions,
} from '../../lib/auth/tokenVerifier.ts';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { setAccountDirectoryForTests } from '../../lib/auth/accountDirectory.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';

/** A Firebase uid's real shape: 28 characters, mixed case. */
const UID = 'Ab3XyZ90QwErTyUiOpAsDfGhJkL1';
const OTHER_UID = 'Zz9PlMkOnIjBhUvGyCtFxRd2';

/** Accepts any token and reports the uid the test asked for. */
function verifierFor(uid: string, onVerify?: (options: VerifyOptions) => void): TokenVerifier {
  return {
    async verify(_token: string, options: VerifyOptions) {
      onVerify?.(options);
      return { uid, authTime: 1_800_000_000, signInProvider: 'password', emailVerified: false };
    },
  };
}

/** Refuses every token with one code from the table. */
function refusingVerifier(code: TokenVerificationCode): TokenVerifier {
  return {
    async verify() {
      throw new TokenVerificationError(code, `refused: ${code}`);
    },
  };
}

function request(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request('http://127.0.0.1:4321/api/mobile/commitments/today', { headers });
}

function setup(verifier: TokenVerifier, storage: StorageAdapter = createMemoryStorage()): () => void {
  setStorageForTests(storage);
  setTokenVerifierForTests(verifier);
  // The uid this verifier reports is an account that exists, unless a test says
  // otherwise. Since #149 the auth path checks before creating a tree.
  setAccountDirectoryForTests({ async exists() { return true; } });
  return () => {
    setAccountDirectoryForTests(null);
    resetTokenVerifierForTests();
    resetStorageForTests();
  };
}

/** Runs the guard and returns what the route would have answered. */
async function refusalOf(request: Request, verifier: TokenVerifier, storage?: StorageAdapter) {
  const teardown = setup(verifier, storage);
  try {
    await requireMobileUser(request);
    return null;
  } catch (error) {
    const response = mobileAuthErrorResponse(error);
    return { status: response.status, body: await response.json() as { reason?: string; success?: boolean } };
  } finally {
    teardown();
  }
}

/* ── The error table ──────────────────────────────────────────────── */

test('mobile auth: a request with no Authorization header is 401 missing_token', async () => {
  const refusal = await refusalOf(request(), verifierFor(UID));
  assert.equal(refusal?.status, 401);
  assert.equal(refusal?.body.reason, 'missing_token');
  assert.equal(refusal?.body.success, false);
});

test('mobile auth: an Authorization header that is not a Bearer token is 401 invalid_token', async () => {
  for (const header of ['', '   ', 'Basic abc', 'Bearer', 'Bearer ', 'p-token.a.b.c']) {
    const refusal = await refusalOf(request(header), verifierFor(UID));
    assert.equal(refusal?.status, 401, `header ${JSON.stringify(header)}`);
    // A blank or whitespace header has no credential at all, which is the
    // missing case; a present-but-wrong one is the malformed case.
    const expected = header.trim() === '' ? 'missing_token' : 'invalid_token';
    assert.equal(refusal?.body.reason, expected, `header ${JSON.stringify(header)}`);
  }
});

test('mobile auth: every verifier refusal maps to its documented status and reason', async () => {
  const table: ReadonlyArray<[TokenVerificationCode, number]> = [
    ['invalid_token', 401],
    ['token_expired', 401],
    ['token_revoked', 401],
    ['user_disabled', 403],
    ['auth_unavailable', 503],
  ];
  for (const [code, status] of table) {
    const refusal = await refusalOf(request('Bearer any.jwt.here'), refusingVerifier(code));
    assert.equal(refusal?.status, status, `${code} should be ${status}`);
    assert.equal(refusal?.body.reason, code);
  }
});

test('mobile auth: an unrecognised verifier failure refuses rather than admits', async () => {
  // The defect this whole change closed was an unrecognised failure falling
  // through to "valid". A verifier that throws something arbitrary must not
  // produce a user.
  const exploding: TokenVerifier = {
    async verify() {
      throw new Error('something nobody anticipated');
    },
  };
  const refusal = await refusalOf(request('Bearer any.jwt.here'), exploding);
  assert.equal(refusal?.status, 503);
  assert.equal(refusal?.body.reason, 'auth_unavailable');
});

test('mobile auth: a storage failure refuses instead of admitting the caller', async () => {
  const broken = {
    get: async () => { throw new Error('firestore is unreachable'); },
    list: async () => { throw new Error('firestore is unreachable'); },
    listGroup: async () => { throw new Error('firestore is unreachable'); },
    set: async () => { throw new Error('firestore is unreachable'); },
    delete: async () => { throw new Error('firestore is unreachable'); },
    deleteTree: async () => { throw new Error('firestore is unreachable'); },
    runTransaction: async () => { throw new Error('firestore is unreachable'); },
  } as unknown as StorageAdapter;

  const refusal = await refusalOf(request('Bearer any.jwt.here'), verifierFor(UID), broken);
  assert.equal(refusal?.status, 503);
  assert.equal(refusal?.body.reason, 'auth_unavailable');
});

/* ── Trust states ─────────────────────────────────────────────────── */

test('mobile auth: a revoked account is 403 revoked', async () => {
  const teardown = setup(verifierFor(UID));
  try {
    await applyTrustAction(UID, { type: 'revoke', at: new Date().toISOString() });
    await assert.rejects(
      requireMobileUser(request('Bearer any.jwt.here')),
      (error: unknown) => error instanceof MobileAuthError && error.status === 403 && error.reason === 'revoked',
    );
  } finally {
    teardown();
  }
});

test('mobile auth: a deleted account is 403 deleted, and deleted outranks revoked', async () => {
  const teardown = setup(verifierFor(UID));
  try {
    // `delete` stamps both timestamps; the more explanatory one is reported.
    await applyTrustAction(UID, { type: 'delete', at: new Date().toISOString() });
    await assert.rejects(
      requireMobileUser(request('Bearer any.jwt.here')),
      (error: unknown) => error instanceof MobileAuthError && error.status === 403 && error.reason === 'deleted',
    );
  } finally {
    teardown();
  }
});

/* ── The happy path, and what it writes ───────────────────────────── */

test('mobile auth: a brand-new mixed-case uid is admitted and gets one user record', async () => {
  const storage = createMemoryStorage();
  const teardown = setup(verifierFor(UID), storage);
  try {
    const user = await requireMobileUser(request('Bearer any.jwt.here'));
    assert.equal(user.uid, UID);
    assert.equal(user.authTime, 1_800_000_000);

    const record = await storage.get<{ schemaVersion: number; trust: { participantId: string } | null }>(userDoc(UID));
    assert.ok(record, 'first sight of a uid must create users/{uid}');
    assert.equal(record?.schemaVersion, 1);
    assert.equal(record?.trust?.participantId, UID);
  } finally {
    teardown();
  }
});

test('mobile auth: no email or display name is written to the user record', async () => {
  const storage = createMemoryStorage();
  const teardown = setup(verifierFor(UID), storage);
  try {
    await requireMobileUser(request('Bearer any.jwt.here'));
    const record = await storage.get<Record<string, unknown>>(userDoc(UID));
    // Those live in Firebase Auth. A copy here would be a second place to
    // leak them from and a second place to forget to delete them.
    assert.doesNotMatch(JSON.stringify(record), /email|displayName|phoneNumber|photoURL/i);
  } finally {
    teardown();
  }
});

test('mobile auth: concurrent first requests for one uid produce one record, not two', async () => {
  const storage = createMemoryStorage();
  const teardown = setup(verifierFor(UID), storage);
  try {
    const users = await Promise.all(
      Array.from({ length: 8 }, () => requireMobileUser(request('Bearer any.jwt.here'))),
    );
    assert.equal(new Set(users.map((user) => user.uid)).size, 1);
    const record = await storage.get<{ trust: { updatedAt: string } | null }>(userDoc(UID));
    assert.ok(record?.trust);
  } finally {
    teardown();
  }
});

test('mobile auth: the uid comes from the token, never from the request', async () => {
  const teardown = setup(verifierFor(UID));
  try {
    const spoofed = new Request(
      `http://127.0.0.1:4321/api/mobile/commitments/today?participantId=${OTHER_UID}&scopeId=${OTHER_UID}`,
      { headers: new Headers({ authorization: 'Bearer any.jwt.here' }) },
    );
    assert.equal((await requireMobileUser(spoofed)).uid, UID);
  } finally {
    teardown();
  }
});

/* ── The revocation-check bypass ──────────────────────────────────── */

test('mobile auth: forceRevocationCheck is passed through, and is off by default', async () => {
  const seen: boolean[] = [];
  const teardown = setup(verifierFor(UID, (options) => seen.push(options.forceRevocationCheck)));
  try {
    await requireMobileUser(request('Bearer any.jwt.here'));
    await requireMobileUser(request('Bearer any.jwt.here'), { forceRevocationCheck: true });
    assert.deepEqual(seen, [false, true]);
  } finally {
    teardown();
  }
});

/* ── A deleted account cannot rebuild itself ─────────────────────── */

test('mobile auth: a token for an account Firebase no longer has is refused, and no tree is created', async () => {
  // Found on staging, not here and not in the emulator (#149). Verifying an ID
  // token is offline work, so a token minted before a deletion keeps verifying
  // until it expires. The first request after the deletion found no
  // `users/{uid}` document, created one, and answered 200 — the account shell
  // restored and the deletion undone.
  const storage = createMemoryStorage();
  const teardown = setup(verifierFor(UID), storage);
  setAccountDirectoryForTests({ async exists() { return false; } });
  try {
    await assert.rejects(
      () => requireMobileUser(request('Bearer any.jwt.here')),
      (error: unknown) => (error as { reason?: string }).reason === 'deleted',
      'a token for a deleted account still authenticated',
    );
    assert.equal(await storage.get(userDoc(UID)), null, 'the refused request created an account document anyway');
  } finally {
    setAccountDirectoryForTests(null);
    teardown();
  }
});

test('mobile auth: a genuine first sign-in still gets a trust record', async () => {
  // The guard above must not turn every new user away. This is the case it has
  // to keep working, and the reason the check runs only when there is no record.
  const storage = createMemoryStorage();
  const teardown = setup(verifierFor(UID), storage);
  const asked: string[] = [];
  setAccountDirectoryForTests({ async exists(uid) { asked.push(uid); return true; } });
  try {
    assert.equal((await requireMobileUser(request('Bearer any.jwt.here'))).uid, UID);
    assert.ok(await storage.get(userDoc(UID)), 'a real first sign-in got no account document');
    assert.deepEqual(asked, [UID]);

    // Second request: the record exists, so Firebase is not asked again.
    await requireMobileUser(request('Bearer any.jwt.here'));
    assert.deepEqual(asked, [UID], 'every request now costs a Firebase lookup');
  } finally {
    setAccountDirectoryForTests(null);
    teardown();
  }
});

test('mobile auth: an unreachable directory refuses rather than admitting', async () => {
  const teardown = setup(verifierFor(UID));
  setAccountDirectoryForTests({ async exists() { throw new Error('firebase unreachable'); } });
  try {
    await assert.rejects(
      () => requireMobileUser(request('Bearer any.jwt.here')),
      (error: unknown) => (error as { status?: number }).status === 503,
      'an unreachable directory admitted the caller',
    );
  } finally {
    setAccountDirectoryForTests(null);
    teardown();
  }
});
