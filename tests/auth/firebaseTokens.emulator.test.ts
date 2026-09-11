/**
 * Real Firebase ID tokens, against the Auth emulator (UC-1.0e, #144).
 *
 * `tests/auth/mobileAuth.test.ts` proves the error table with a fake
 * verifier. This file proves the part a fake cannot: that a token Google's
 * own libraries produced verifies, that the uid inside it is the scope
 * everything else keys off, and that a revocation actually lands. The
 * signature path, the uid shape and `revokeRefreshTokens` are all real here.
 *
 * Emulator-only. Run `npm run test:emulator`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuth } from 'firebase-admin/auth';

import { getAdminApp } from '../../lib/firebase/admin.ts';
import {
  FirebaseTokenVerifier,
  resetTokenVerifierForTests,
  setTokenVerifierForTests,
} from '../../lib/auth/tokenVerifier.ts';
import { MobileAuthError, requireMobileUser } from '../../lib/auth/mobileAuth.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as commitmentGet } from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error(
    'FIREBASE_AUTH_EMULATOR_HOST is unset. Run this file through `npm run test:emulator`, never against a real project.',
  );
}
// The Admin SDK needs a project to bind to; the emulator accepts a demo one
// and never reaches the network for it. `getAdminApp` reads this lazily on
// first use, so setting it after the imports hoist is still in time.
process.env.GOOGLE_CLOUD_PROJECT ??= 'demo-maybesitter';

const BASE = 'http://127.0.0.1:4321';
const REFERENCE_TIME = '2026-08-09T08:00:00.000Z';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;

interface EmulatorAccount {
  uid: string;
  idToken: string;
}

/**
 * A real account with a real ID token, through the emulator's REST API.
 *
 * `accounts:signUp` is the same endpoint the client SDK calls, so the token
 * that comes back is shaped exactly like a production one — including a uid
 * the emulator mints, which is where the mixed-case 28-character id under
 * test comes from rather than from a literal in this file.
 */
async function signUp(): Promise<EmulatorAccount> {
  const email = `user-${Math.random().toString(36).slice(2)}@example.com`;
  const response = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'not-a-real-password', returnSecureToken: true }),
    },
  );
  const raw = await response.text();
  assert.equal(response.status, 200, `emulator signUp failed: ${raw}`);
  const body = JSON.parse(raw) as { idToken: string; localId: string };
  return { uid: body.localId, idToken: body.idToken };
}

function request(path: string, token: string | null, options: { method?: string; body?: unknown } = {}): Request {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  // The real verifier: this file exists to exercise it.
  setTokenVerifierForTests(new FirebaseTokenVerifier());
  return () => {
    resetTokenVerifierForTests();
    resetStorageForTests();
  };
}

/** Capture and confirm one commitment as this account, through the routes. */
async function createCommitment(account: EmulatorAccount, text: string, spoofedScope?: string): Promise<string> {
  const proposalResponse = await capturePost(request('/api/mobile/capture', account.idToken, {
    body: { text, referenceTime: REFERENCE_TIME, timezone: 'UTC', scopeId: spoofedScope, participantId: spoofedScope },
  }));
  // Read the body once: an `await …text()` inside the assertion message is
  // evaluated eagerly and would consume it before `JSON.parse` sees it.
  const proposalRaw = await proposalResponse.text();
  assert.equal(proposalResponse.status, 200, proposalRaw);
  const proposal = JSON.parse(proposalRaw) as { proposalId: string; items: Array<{ itemId: string }> };

  const confirmResponse = await confirmPost(request('/api/mobile/capture/confirm', account.idToken, {
    body: {
      proposalId: proposal.proposalId,
      itemIds: [proposal.items[0].itemId],
      scopeId: spoofedScope,
      participantId: spoofedScope,
      idempotencyKey: `confirm-${account.uid}-${proposal.items[0].itemId}`,
    },
  }));
  const confirmRaw = await confirmResponse.text();
  assert.equal(confirmResponse.status, 200, confirmRaw);
  const confirmation = JSON.parse(confirmRaw) as { persisted: Array<{ commitmentId: string }> };
  return confirmation.persisted[0].commitmentId;
}

test('a real emulator ID token authenticates, and the uid is the one Firebase minted', async () => {
  const teardown = setup();
  try {
    const account = await signUp();
    const user = await requireMobileUser(request('/api/mobile/commitments/today', account.idToken));
    assert.equal(user.uid, account.uid);
    // The shape the old lowercase-only participant pattern would have rejected.
    assert.match(account.uid, /^[A-Za-z0-9]{20,36}$/);
    assert.ok(user.authTime > 0, 'auth_time must come out of the token');
  } finally {
    teardown();
  }
});

test('a brand-new uid can capture and confirm with no allowlist configured anywhere', async () => {
  const teardown = setup();
  try {
    const account = await signUp();
    const commitmentId = await createCommitment(account, 'Remind me to call Maya tomorrow at 3pm');

    const detail = await commitmentGet(request(`/api/mobile/commitments/${commitmentId}`, account.idToken), params(commitmentId));
    assert.equal(detail.status, 200);
    assert.equal((await detail.json() as { id: string }).id, commitmentId);
  } finally {
    teardown();
  }
});

test("A's token cannot read or change B's commitments, even with B's uid in the body or query", async () => {
  const teardown = setup();
  try {
    const [a, b] = [await signUp(), await signUp()];
    const bCommitment = await createCommitment(b, 'Remind me to email Blake at 4pm');

    // Straight read of B's id with A's token.
    const direct = await commitmentGet(request(`/api/mobile/commitments/${bCommitment}`, a.idToken), params(bCommitment));
    assert.equal(direct.status, 404);

    // The same read with B's uid supplied in the query, which the route does
    // not consult: the scope is the token's uid and nothing else.
    const spoofedQuery = await commitmentGet(
      request(`/api/mobile/commitments/${bCommitment}?participantId=${b.uid}&scopeId=${b.uid}`, a.idToken),
      params(bCommitment),
    );
    assert.equal(spoofedQuery.status, 404);

    // A capture that names B in the body lands in A's tree, not B's.
    await createCommitment(a, 'Remind me to call Ada at 9am', b.uid);
    const aToday = await todayGet(request(`/api/mobile/commitments/today?timezone=UTC&referenceTime=${encodeURIComponent(REFERENCE_TIME)}`, a.idToken));
    const bToday = await todayGet(request(`/api/mobile/commitments/today?timezone=UTC&referenceTime=${encodeURIComponent(REFERENCE_TIME)}`, b.idToken));
    const idsOf = async (response: Response) =>
      ((await response.json() as { items: Array<{ id: string }> }).items).map((item) => item.id);
    const [aIds, bIds] = [await idsOf(aToday), await idsOf(bToday)];
    assert.equal(aIds.includes(bCommitment), false, "A must never see B's commitment");
    assert.equal(bIds.includes(bCommitment), true, "B must still see B's own commitment");
    assert.equal(bIds.length, 1, "the spoofed capture must not have landed in B's tree");

    // B's commitment is still readable by B: the refusal above was about
    // ownership, not about the route being inert.
    const bReads = await commitmentGet(request(`/api/mobile/commitments/${bCommitment}`, b.idToken), params(bCommitment));
    assert.equal(bReads.status, 200);
  } finally {
    teardown();
  }
});

test('revoking refresh tokens stops the ID token, immediately with forceRevocationCheck', async () => {
  const teardown = setup();
  try {
    const account = await signUp();
    // The token works first, which is what makes the refusal below meaningful.
    assert.equal((await requireMobileUser(request('/api/mobile/commitments/today', account.idToken))).uid, account.uid);

    // `tokensValidAfterTime` has one-second resolution, so a revocation in the
    // same second as the sign-in would be a tie rather than a revocation.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await getAuth(getAdminApp()).revokeRefreshTokens(account.uid);

    await assert.rejects(
      requireMobileUser(request('/api/mobile/commitments/today', account.idToken), { forceRevocationCheck: true }),
      (error: unknown) => error instanceof MobileAuthError && error.status === 401 && error.reason === 'token_revoked',
      'forceRevocationCheck must see the revocation with no delay',
    );

    // And a fresh instance — an instance whose 60 s cache has never seen this
    // uid, which is what every other instance in the fleet is — refuses too.
    setTokenVerifierForTests(new FirebaseTokenVerifier());
    await assert.rejects(
      requireMobileUser(request('/api/mobile/commitments/today', account.idToken)),
      (error: unknown) => error instanceof MobileAuthError && error.reason === 'token_revoked',
    );
  } finally {
    teardown();
  }
});

test('a disabled account is refused with user_disabled rather than signed out', async () => {
  const teardown = setup();
  try {
    const account = await signUp();
    await getAuth(getAdminApp()).updateUser(account.uid, { disabled: true });

    await assert.rejects(
      requireMobileUser(request('/api/mobile/commitments/today', account.idToken), { forceRevocationCheck: true }),
      (error: unknown) => error instanceof MobileAuthError && error.status === 403 && error.reason === 'user_disabled',
    );
  } finally {
    teardown();
  }
});

test('a forged or malformed token is refused by the real verifier', async () => {
  const teardown = setup();
  try {
    const account = await signUp();
    for (const token of [
      'not-a-jwt',
      'p-token.p-100.abc.def',
      `${account.idToken.slice(0, -4)}AAAA`,
    ]) {
      await assert.rejects(
        requireMobileUser(request('/api/mobile/commitments/today', token)),
        (error: unknown) => error instanceof MobileAuthError && error.status === 401,
        `token ${token.slice(0, 24)}… must be refused`,
      );
    }
  } finally {
    teardown();
  }
});

test('an unauthenticated request never reaches a route, whatever it claims in the body', async () => {
  const teardown = setup();
  try {
    const response = await capturePost(request('/api/mobile/capture', null, {
      body: { text: 'Call Maya tomorrow at 3pm', referenceTime: REFERENCE_TIME, timezone: 'UTC', participantId: 'anonymous' },
    }));
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { reason: string }).reason, 'missing_token');
  } finally {
    teardown();
  }
});
