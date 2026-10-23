/**
 * A deletion between authentication and the trust store, through real routes
 * (#794 round 1: Q794-001 and Q794-004).
 *
 * Authentication found a live trust record, so the request is admitted. Then,
 * before the route's own trust read or write, a whole deletion completes. The
 * storage below holds the request just before its Nth transaction — outside any
 * transaction, so the deletion's own transactions are not blocked behind it —
 * while the test runs the real `deleteAccount`, then lets the request go.
 *
 * The trust store must refuse to create a trust record behind the sweep
 * (`applyTrustAction` and `getOrCreateTrust` share one guarded create), and the
 * route must answer that refusal as 403 `deleted`, the same answer the auth
 * guard and the domain-write fence give — not 400, not 503.
 *
 * The legacy routes at the end take no token (they are 404 on Cloud Run, see
 * `src/middleware.ts`), so there the deletion simply precedes the call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resetTokenVerifierForTests, setTokenVerifierForTests, type TokenVerifier } from '../../lib/auth/tokenVerifier.ts';
import { setAccountDirectoryForTests } from '../../lib/auth/accountDirectory.ts';
import { deleteAccount } from '../../lib/account/accountDeletion.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { POST as updateTrust } from '../../src/app/api/mobile/pilot/trust/route.ts';
import { GET as getNextStep } from '../../src/app/api/mobile/recommendations/next-step/route.ts';
import { GET as legacyNextStepGet, POST as legacyNextStepPost } from '../../src/app/api/next-step/route.ts';
import { GET as legacyTrustGet } from '../../src/app/api/pilot/trust/route.ts';
import { POST as legacyIncidentPost } from '../../src/app/api/pilot/incidents/route.ts';
import { GET as legacyCalendarGet } from '../../src/app/api/calendar.ics/route.ts';

const PEPPER = 'trust-race-794-test-pepper';
const UID = 'Tr794RaCeAfTeRaUtH00000001';
/** The legacy routes validate with the same pattern; lowercase keeps them simple. */
const LEGACY_UID = 'tr794_legacy_participant';
const BASE = 'http://127.0.0.1:4321';

function verifierFor(uid: string): TokenVerifier {
  return {
    async verify() {
      return { uid, authTime: 1_800_000_000, signInProvider: 'password', emailVerified: false };
    },
  };
}

/** Holds the request just before its `pauseBefore`-th transaction once armed. */
function pausingStorage(inner: MemoryStorageAdapter) {
  let count = 0;
  let pauseBefore = 0;
  let reached!: () => void;
  let release!: () => void;
  let atPause = Promise.resolve();
  let gate = Promise.resolve();
  const storage = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'runTransaction') {
        return async (fn: Parameters<StorageAdapter['runTransaction']>[0]) => {
          count += 1;
          if (count === pauseBefore) {
            reached();
            await gate;
          }
          return target.runTransaction(fn);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    storage,
    arm(nth: number) {
      count = 0;
      pauseBefore = nth;
      atPause = new Promise<void>((resolve) => { reached = resolve; });
      gate = new Promise<void>((resolve) => { release = resolve; });
    },
    atPause: () => atPause,
    release: () => release(),
  };
}

function begin() {
  const previous = process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
  process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = PEPPER;
  const inner = createMemoryStorage();
  const paused = pausingStorage(inner);
  setStorageForTests(paused.storage);
  setAccountDirectoryForTests({ async exists() { return true; } });
  return {
    inner,
    paused,
    restore() {
      setAccountDirectoryForTests(null);
      resetTokenVerifierForTests();
      resetStorageForTests();
      if (previous === undefined) delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
      else process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = previous;
    },
  };
}

const deletionAuth = { async revokeRefreshTokens() {}, async deleteUser() {} };

function underTree(storage: MemoryStorageAdapter, uid: string): string[] {
  const root = userDoc(uid);
  return storage.pathsForTests().filter((path) => path === root || path.startsWith(`${root}/`));
}

/**
 * Starts the route, waits until it is held before its `nth` transaction, runs
 * the real deletion to completion, optionally lets a stray writer re-create a
 * trust-less root, then releases the route and returns its response.
 */
async function raceDeletion(
  env: ReturnType<typeof begin>,
  nth: number,
  call: () => Promise<Response>,
  afterDeletion: () => Promise<void> = async () => {},
): Promise<Response> {
  env.paused.arm(nth);
  const pending = call();
  const first = await Promise.race([
    env.paused.atPause().then(() => 'paused' as const),
    pending.then(() => 'finished' as const),
  ]);
  assert.equal(first, 'paused', `the route finished without reaching transaction ${nth}, so this is not the race`);
  await deleteAccount(UID, { initiatedBy: 'user', storage: env.inner, hooks: [], auth: deletionAuth });
  assert.deepEqual(underTree(env.inner, UID), [], 'the deletion left the tree, so this is not the race');
  await afterDeletion();
  env.paused.release();
  return pending;
}

function trustPost(): Request {
  return new Request(`${BASE}/api/mobile/pilot/trust`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify({ action: { type: 'set_analytics_consent', granted: true } }),
  });
}

async function assertDeleted(response: Response): Promise<void> {
  const body = await response.json() as { reason?: string };
  assert.equal(response.status, 403, `answered ${response.status} ${JSON.stringify(body)}`);
  assert.equal(body.reason, 'deleted');
}

test('Q794-001/004: a consent change whose account is deleted after authentication is 403 deleted, and re-creates nothing', async () => {
  const env = begin();
  try {
    await seedLiveAccount(UID, env.inner);
    setTokenVerifierForTests(verifierFor(UID));
    // Transaction 1 is `resolveUserAccess`'s read (the record is still there);
    // transaction 2 is `applyTrustAction`. The deletion lands between them.
    const response = await raceDeletion(env, 2, () => updateTrust(trustPost()));
    await assertDeleted(response);
    assert.deepEqual(underTree(env.inner, UID), [], 'the consent action re-created the deleted account');
  } finally {
    env.restore();
  }
});

test('Q794-001/004: the same race against a root a stray writer re-created without trust', async () => {
  const env = begin();
  try {
    await seedLiveAccount(UID, env.inner);
    setTokenVerifierForTests(verifierFor(UID));
    const response = await raceDeletion(env, 2, () => updateTrust(trustPost()), async () => {
      await env.inner.set(userDoc(UID), { locale: 'ar' });
    });
    await assertDeleted(response);
    const root = await env.inner.get<{ trust?: unknown }>(userDoc(UID));
    assert.equal(root?.trust, undefined, 'a trust record was merged into the deleted account\'s root');
  } finally {
    env.restore();
  }
});

test('Q794-004: the next-step route, deleted between authentication and its access check, is 403 deleted', async () => {
  const env = begin();
  try {
    await seedLiveAccount(UID, env.inner);
    setTokenVerifierForTests(verifierFor(UID));
    // Authentication only reads; transaction 1 is `resolveNextStepAccess`.
    const response = await raceDeletion(env, 1, () => getNextStep(new Request(`${BASE}/api/mobile/recommendations/next-step`, {
      headers: { authorization: 'Bearer t' },
    })));
    await assertDeleted(response);
    assert.deepEqual(underTree(env.inner, UID), [], 'the next-step access check re-created the deleted account');
  } finally {
    env.restore();
  }
});

test('Q794-004: the legacy pilot routes answer a deleted account 403 deleted, not 503 or 400', async () => {
  const env = begin();
  const previousFlag = process.env.MAYBESITTER_FEATURE_RECOMMENDATION;
  process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
  try {
    await seedLiveAccount(LEGACY_UID, env.inner);
    await deleteAccount(LEGACY_UID, { initiatedBy: 'user', storage: env.inner, hooks: [], auth: deletionAuth });

    const json = (path: string, body: unknown) => new Request(`${BASE}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const cases: Array<[string, () => Promise<Response>]> = [
      ['GET /api/next-step', () => legacyNextStepGet(new Request(`${BASE}/api/next-step?anonymousUserId=${LEGACY_UID}`))],
      ['POST /api/next-step', () => legacyNextStepPost(json('/api/next-step', { anonymousUserId: LEGACY_UID }))],
      ['GET /api/pilot/trust', () => legacyTrustGet(new Request(`${BASE}/api/pilot/trust?participantId=${LEGACY_UID}`))],
      ['POST /api/pilot/incidents', () => legacyIncidentPost(json('/api/pilot/incidents', {
        participantId: LEGACY_UID, surface: 'recommendation', category: 'other',
      }))],
      ['GET /api/calendar.ics', () => legacyCalendarGet(new Request(`${BASE}/api/calendar.ics?participantId=${LEGACY_UID}`))],
    ];
    for (const [name, call] of cases) {
      const response = await call();
      const body = await response.json() as { reason?: string };
      assert.equal(response.status, 403, `${name} answered ${response.status} ${JSON.stringify(body)}`);
      assert.equal(body.reason, 'deleted', name);
      assert.deepEqual(underTree(env.inner, LEGACY_UID), [], `${name} re-created the deleted account`);
    }
  } finally {
    if (previousFlag === undefined) delete process.env.MAYBESITTER_FEATURE_RECOMMENDATION;
    else process.env.MAYBESITTER_FEATURE_RECOMMENDATION = previousFlag;
    env.restore();
  }
});
