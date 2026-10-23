/**
 * A live account is a `users/{uid}` document with a valid trust record
 * (#772 review, Q772-001).
 *
 * The first #772 fence accepted any user document without a truthy
 * `trust.deletedAt`, `trust: null` included. That let a production sequence
 * slip through: the football PUT authenticates, account deletion sweeps
 * `users/{uid}`, the follow write re-creates a child document,
 * `setUserLocale` re-creates the root from `newUserDocument` (`trust: null`),
 * and the projection's `writeDomainDiff` accepted that root and wrote the
 * account's matches back as commitments.
 *
 * Now:
 *   - liveness requires a trust record `requirePilotTrustState` accepts (the
 *     one authentication validates on every request), with `deletedAt: null`;
 *   - `setUserLocale` never re-creates a missing root;
 *   - `setFollowedClubs` reads liveness in the transaction that writes;
 *   - the football PUT answers a mid-request deletion 403 `deleted`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { newUserDocument } from '../../lib/storage/userDocument.ts';
import { setUserLocale } from '../../lib/storage/userLocale.ts';
import { createPilotTrustState } from '../../lib/pilot/closedPilotControls.ts';
import { AccountUnavailableError, liveAccount } from '../../lib/account/accountLiveness.ts';
import { liveAccount as liveAccountViaMemoryBasis } from '../../lib/intelligence/memoryBasis.ts';
import { applyParticipantCommands } from '../../lib/services/mobile/participantState.ts';
import { upsertFixtures } from '../../lib/football/fixtureStore.ts';
import { listActiveFixtureCommitments } from '../../lib/football/projectFixtures.ts';
import { PUT as footballPut } from '../../src/app/api/mobile/football/route.ts';
import {
  fixtureContentHash,
  FIXTURE_CONTRACT_VERSION,
  FIXTURE_SCHEMA_VERSION,
  type Fixture,
  type FixtureCore,
} from '../../src/contracts/v1/fixtureContracts.ts';

const AT = '2026-10-01T09:00:00.000Z';
const BASE = 'http://127.0.0.1:4321';

/* ── the rule ────────────────────────────────────────────────────────── */

test('liveness: only a root with a valid, undeleted trust record is a live account', () => {
  const trust = createPilotTrustState('alice', AT);
  const cases: Array<[string, unknown, boolean]> = [
    ['no document (swept)', null, false],
    ['undefined', undefined, false],
    ['an empty document', {}, false],
    ['trust: null', { trust: null }, false],
    ['a root re-created by newUserDocument', newUserDocument(AT), false],
    ['a root re-created by newUserDocument with a locale', { ...newUserDocument(AT), locale: 'ar' }, false],
    ['a partial trust object', { trust: { calendarConsent: true } }, false],
    ['a trust array', { trust: [] }, false],
    ['a trust record of another version', { trust: { ...trust, version: 'v0' } }, false],
    ['a trust record marked deleted', { trust: { ...trust, deletedAt: AT } }, false],
    ['the trust record authentication writes', { ...newUserDocument(AT), trust }, true],
  ];
  for (const [what, user, live] of cases) {
    assert.equal(liveAccount(user), live, what);
    // The intelligence writers (M5b-2b) use the same rule through memoryBasis.
    assert.equal(liveAccountViaMemoryBasis(user), live, `${what} (memoryBasis)`);
  }
});

test('writeDomainDiff refuses a root without a trust record and writes nothing', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    const uid = 'trustless-root';
    await storage.set(userDoc(uid), { ...newUserDocument(AT), locale: 'ar' });
    const before = await tree(storage, uid);
    await assert.rejects(applyParticipantCommands(uid, [
      { type: 'CreateDraft', now: AT, commitment: { id: 'c1', kind: 'task', title: 'Renew the passport' }, draftStatus: 'pending_confirmation' },
    ]), AccountUnavailableError);
    assert.deepEqual(await tree(storage, uid), before);
  } finally {
    resetStorageForTests();
  }
});

/* ── setUserLocale never re-creates a root ───────────────────────────── */

test('setUserLocale on a swept account writes nothing and refuses', async () => {
  const storage = createMemoryStorage();
  await assert.rejects(setUserLocale('swept', 'ar', AT, { storage }), AccountUnavailableError);
  assert.equal(await storage.get(userDoc('swept')), null, 'the locale re-created the swept root');
});

test('setUserLocale on a root without a trust record, or one marked deleted, writes nothing and refuses', async () => {
  const storage = createMemoryStorage();
  const trustless = newUserDocument(AT);
  const deleted = { ...newUserDocument(AT), trust: { ...createPilotTrustState('deleted', AT), deletedAt: AT } };
  await storage.set(userDoc('trustless'), trustless);
  await storage.set(userDoc('deleted'), deleted);
  await assert.rejects(setUserLocale('trustless', 'ar', AT, { storage }), AccountUnavailableError);
  await assert.rejects(setUserLocale('deleted', 'ar', AT, { storage }), AccountUnavailableError);
  assert.deepEqual(await storage.get(userDoc('trustless')), trustless);
  assert.deepEqual(await storage.get(userDoc('deleted')), deleted);
});

test('setUserLocale on a live account merges the locale and keeps the trust record', async () => {
  const storage = createMemoryStorage();
  const trust = createPilotTrustState('alive', AT);
  await storage.set(userDoc('alive'), { ...newUserDocument(AT), trust });
  await setUserLocale('alive', 'he', '2026-10-02T09:00:00.000Z', { storage });
  const user = await storage.get<Record<string, unknown>>(userDoc('alive'));
  assert.equal(user?.locale, 'he');
  assert.deepEqual(user?.trust, trust);
});

/* ── the football PUT after a completed sweep ────────────────────────── */

interface Race {
  storage: StorageAdapter;
  /** Sweeps the account at the first write entry for which `when()` holds. */
  armSweep(uid: string, when: () => Promise<boolean>): void;
  fired(): boolean;
}

/**
 * The memory adapter with a one-shot hook in front of every write entry
 * (`set`, `delete`, `runTransaction`). Reads pass straight through, so
 * authentication (a read of the trust record it already wrote) sees the live
 * account. The hook runs the deletion as account deletion does: mark, then
 * sweep the whole tree.
 */
function raceable(base: MemoryStorageAdapter): Race {
  let pending: { uid: string; when: () => Promise<boolean> } | null = null;
  let didFire = false;
  const writes = new Set(['set', 'delete', 'runTransaction']);
  const storage = new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property === 'string' && writes.has(property)) {
        return async (...args: unknown[]) => {
          if (pending && await pending.when()) {
            const { uid } = pending;
            pending = null;
            didFire = true;
            const user = (await base.get<Record<string, any>>(userDoc(uid))) ?? {};
            const now = new Date().toISOString();
            await base.set(userDoc(uid), { ...user, trust: { ...(user.trust ?? {}), deletedAt: now, updatedAt: now } });
            await base.deleteTree(userDoc(uid));
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as unknown as StorageAdapter;
  return {
    storage,
    armSweep(uid, when) { pending = { uid, when }; didFire = false; },
    fired: () => didFire,
  };
}

async function tree(storage: MemoryStorageAdapter, uid: string): Promise<Record<string, unknown>> {
  const paths = storage.pathsForTests().filter((path) => path === userDoc(uid) || path.startsWith(`${userDoc(uid)}/`)).sort();
  const out: Record<string, unknown> = {};
  for (const path of paths) out[path] = await storage.get(path);
  return out;
}

/** A Barcelona match two days from now: inside the projection window, so a live account gets it. */
function upcomingMatch(): Fixture {
  const kickoff = new Date(Date.now() + 2 * 86_400_000);
  kickoff.setUTCMinutes(0, 0, 0);
  const core: FixtureCore = {
    provider: 'football-data', providerMatchId: 'q772-001', competition: 'PD',
    homeTeamId: '81', awayTeamId: '86', homeTeamName: 'FC Barcelona',
    awayTeamName: 'Real Madrid CF', kickoffUtc: kickoff.toISOString(), status: 'scheduled', venue: null,
  };
  return { ...core, version: FIXTURE_CONTRACT_VERSION, schemaVersion: FIXTURE_SCHEMA_VERSION, contentHash: fixtureContentHash(core) };
}

function putRequest(uid: string, body: unknown): Request {
  return new Request(`${BASE}/api/mobile/football`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tokenFor(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function withFootball(name: string, run: (h: { uid: string; base: MemoryStorageAdapter; race: Race }) => Promise<void>): Promise<void> {
  const auth: FakeAuthControls = installFakeAuth();
  const previousKey = process.env.FOOTBALL_DATA_API_KEY;
  process.env.FOOTBALL_DATA_API_KEY = 'test-key';
  const base = createMemoryStorage();
  const race = raceable(base);
  setStorageForTests(race.storage);
  const uid = uidFor(`q772${name}`);
  try {
    await upsertFixtures([upcomingMatch()]);
    // A real first request: authentication writes the user document and its
    // trust record, exactly as in production. Following nothing writes nothing
    // else of note and projects nothing.
    const warm = await footballPut(putRequest(uid, { clubIds: [] }));
    assert.equal(warm.status, 200);
    assert.ok(liveAccount(await base.get(userDoc(uid))), 'fixture: authentication did not leave a live account');
    await run({ uid, base, race });
  } finally {
    auth.restore();
    resetStorageForTests();
    if (previousKey === undefined) delete process.env.FOOTBALL_DATA_API_KEY;
    else process.env.FOOTBALL_DATA_API_KEY = previousKey;
  }
}

async function assertDeleted(response: Response, what: string): Promise<void> {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 403, `${what}: ${JSON.stringify(body)}`);
  assert.equal(body.success, false, what);
  assert.equal(body.reason, 'deleted', what);
}

test('football PUT control: on a live account the follow projects the upcoming match as a commitment', async () => {
  // Without this, "no commitment was created" below could be true of a
  // fixture that never projects anything.
  await withFootball('control', async ({ uid }) => {
    const response = await footballPut(putRequest(uid, { clubIds: ['barcelona'], locale: 'ar' }));
    const body = await response.json() as Record<string, any>;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(body.fixtures.length, 1, JSON.stringify(body));
    assert.equal((await listActiveFixtureCommitments(uid)).length, 1);
  });
});

test('football PUT, account swept before the follow is written: 403 deleted, nothing re-created, no commitment', async () => {
  await withFootball('beforeFollow', async ({ uid, base, race }) => {
    race.armSweep(uid, async () => true);
    const response = await footballPut(putRequest(uid, { clubIds: ['barcelona'], locale: 'ar' }));
    assert.ok(race.fired(), 'the sweep never ran, so the race was not staged');
    await assertDeleted(response, 'football PUT');
    assert.deepEqual(await tree(base, uid), {}, 'documents re-created under a swept account');
    assert.deepEqual(await listActiveFixtureCommitments(uid), []);
  });
});

test('football PUT, account swept after the follow is saved (the Q772-001 sequence): 403 deleted, no root, no commitment', async () => {
  await withFootball('afterFollow', async ({ uid, base, race }) => {
    // The sweep lands at the first write after the follow is in storage: the
    // locale's transaction. That transaction used to re-create the root from
    // newUserDocument (trust: null), and the projection accepted it.
    // (The warm-up already wrote an empty follow list, so the trigger is the
    // saved Barcelona follow, not the document's existence.)
    race.armSweep(uid, async () => {
      const follows = await base.get<{ clubIds?: string[] }>(`${userDoc(uid)}/footballFollows/clubs`);
      return follows?.clubIds?.includes('barcelona') === true;
    });
    const response = await footballPut(putRequest(uid, { clubIds: ['barcelona'], locale: 'ar' }));
    assert.ok(race.fired(), 'the sweep never ran, so the race was not staged');
    await assertDeleted(response, 'football PUT');
    assert.deepEqual(await tree(base, uid), {}, 'documents re-created under a swept account');
    assert.deepEqual(await listActiveFixtureCommitments(uid), []);
  });
});
