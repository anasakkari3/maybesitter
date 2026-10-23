/**
 * Follow-on writes re-read the account deletion fence (#772 review, Q772C).
 *
 * #772 made every user-content writer re-read `users/{uid}` in its own
 * transaction and refuse unless the account is live. Some operations write in
 * more than one step: a fenced primary write, then a follow-on write in a later
 * transaction. A deletion landing between the two must stop the follow-on too:
 *
 *   - Q772C-001: a routine profile save reconciles its facts in
 *     `users/{uid}/memory` after the profile merge (`put`, `supersede`,
 *     `revoke`), all through `personalizationWriteGuard`;
 *   - Q772C-002: consent, the routine profile and the pilot trust update
 *     appended their audit line with a plain `set` after the commit;
 *   - Q772C-004: a refresh, a resource call or a disconnect that began before
 *     the deletion reaches `markState` after it, and could overwrite the
 *     deletion hook's `revoked`;
 *   - Q772C-005: a reminder-settings save reconciles the hard-reminder index
 *     after its merge, and the backup-push job claimed and sent rows of a
 *     deleted account.
 *
 * Each race stages the deletion — `markDeleted`, and `markDeleted` plus the
 * sweep — right after the primary write commits, and asserts that nothing is
 * written afterwards and that the operation does not report success where a
 * follow-on remained.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { AUDIT_EVENTS, HARD_REMINDERS, MEMORY, PROVIDER_CONNECTIONS, PUSH_LOG, userCol, userDoc } from '../../lib/storage/paths.ts';
import { sendToUser } from '../../lib/push/pushService.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { AccountUnavailableError } from '../../lib/account/accountLiveness.ts';
// Q772C-001
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import {
  createStorageRuntimeMemoryStore,
  MemoryWriteRefusedError,
  personalizationWriteGuard,
} from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import type { CreateMemoryInput } from '../../src/contracts/v1/memoryContracts.ts';
import type { RoutineProfileInput } from '../../src/contracts/v1/routineContracts.ts';
// Q772C-002
import { setConsent } from '../../lib/consents/consentService.ts';
import { setPersonalizationConsent } from '../../lib/consents/personalizationConsentService.ts';
import { createStoragePersonalizationConsentStore } from '../../lib/personalizationControls/consentStore.ts';
import { updateMobilePilotTrust } from '../../lib/services/mobile/pilotService.ts';
import {
  PERSONALIZATION_CONSENT_VERSION,
  RECOMMENDATION_CONSENT,
  RECOMMENDATION_CONSENT_VERSION,
} from '../../src/contracts/v1/consentContracts.ts';
// Q772C-004
import { StoredIntegrationConnectionStore, connectionIdFor } from '../../lib/integrations/providers/production/storedConnectionStore.ts';
import { refreshProviderAccessToken } from '../../lib/integrations/providers/production/refreshProviderAccessToken.ts';
import { disconnectProviderOAuth, type ProviderOAuthClient } from '../../lib/integrations/providers/providerOAuthLifecycle.ts';
import type { ProviderCredentialVault, ProviderOAuthTokenSet } from '../../lib/integrations/providers/providerRuntime.ts';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts.ts';
// Q772C-005
import { saveReminderSettings } from '../../lib/services/mobile/reminderSettingsService.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { hardReminderPath, type HardReminderEntry } from '../../lib/services/reminders/hardReminderIndex.ts';
import { runHardReminderTick } from '../../lib/services/reminders/hardReminderJob.ts';
import { createEmptyDomainState, type Commitment } from '../../src/domain/stateMachine.ts';

const FIRST = '2026-10-03T09:00:00.000Z';
const SECOND = '2026-10-03T09:05:00.000Z';
const TZ = 'Asia/Jerusalem';

type Step = 'markDeleted' | 'swept';
const STEPS: readonly Step[] = ['markDeleted', 'swept'];

/* ── harness ─────────────────────────────────────────────────────────── */

/** `markDeleted`, as account deletion writes it, then the sweep when asked. Straight to the base adapter. */
async function deleteAccount(storage: StorageAdapter, uid: string, step: Step): Promise<void> {
  const at = new Date().toISOString();
  const user = (await storage.get<Record<string, any>>(userDoc(uid))) ?? {};
  await storage.set(userDoc(uid), { ...user, trust: { ...(user.trust ?? {}), deletedAt: at, updatedAt: at } });
  if (step === 'swept') await storage.deleteTree(userDoc(uid));
}

type Tree = Record<string, unknown>;

/** Every stored path under `users/{uid}`, the document itself included, with its data. */
async function snapshot(storage: MemoryStorageAdapter, uid: string): Promise<Tree> {
  const prefix = `${userDoc(uid)}/`;
  const paths = storage.pathsForTests().filter((path) => path === userDoc(uid) || path.startsWith(prefix)).sort();
  const out: Tree = {};
  for (const path of paths) out[path] = await storage.get(path);
  return out;
}

interface Staged {
  /** The adapter the operation runs on (also installed as the global one). */
  readonly storage: StorageAdapter;
  readonly base: MemoryStorageAdapter;
  /**
   * Arms the deletion: it runs right after the first transaction whose commit
   * makes `committed(users/{uid})` true — that is, right after the primary
   * write — and before anything the operation does next.
   */
  arm(step: Step, committed: (user: Record<string, any> | null) => boolean): void;
  fired(): boolean;
  /** The tree as the deletion left it: what must still be there at the end. */
  afterDeletion(): Tree;
}

function staged(uid: string): Staged {
  const base = createMemoryStorage();
  let pending: { step: Step; committed: (user: Record<string, any> | null) => boolean } | null = null;
  let didFire = false;
  let left: Tree = {};
  const storage = new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'runTransaction') {
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => unknown).apply(target, args);
          if (pending && pending.committed(await base.get<Record<string, any>>(userDoc(uid)))) {
            const { step } = pending;
            pending = null;
            didFire = true;
            await deleteAccount(base, uid, step);
            left = await snapshot(base, uid);
          }
          return result;
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as unknown as StorageAdapter;
  return {
    storage,
    base,
    arm(step, committed) { pending = { step, committed }; didFire = false; },
    fired: () => didFire,
    afterDeletion: () => left,
  };
}

async function withStaged(uid: string, run: (s: Staged) => Promise<void>): Promise<void> {
  const s = staged(uid);
  setStorageForTests(s.storage);
  try {
    await seedLiveAccount(uid, s.base);
    await run(s);
  } finally {
    resetStorageForTests();
  }
}

/** Nothing was written after the deletion: the tree is exactly as it left it (empty after a sweep). */
async function assertNothingAfter(s: Staged, uid: string, step: Step, what: string): Promise<void> {
  assert.ok(s.fired(), `${what}: the race was not staged — the primary write never committed`);
  const now = await snapshot(s.base, uid);
  if (step === 'swept') assert.deepEqual(Object.keys(now), [], `${what}: documents re-created under a swept account`);
  assert.deepEqual(now, s.afterDeletion(), `${what}: something was written under the deleted account`);
}

/* ── Q772C-001: runtime memory reconciliation ────────────────────────── */

function routine(overrides: Partial<RoutineProfileInput> = {}): RoutineProfileInput {
  return {
    timezone: TZ,
    sleepWindow: { start: '23:30', end: '07:30' },
    focusWindows: [{ start: '09:00', end: '17:00', label: 'work_study' }],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'softAwareness',
    quietHours: { start: '22:30', end: '07:30' },
    surveySkipped: false,
    ...overrides,
  };
}

const profileSavedAt = (at: string) => (user: Record<string, any> | null) => user?.profile?.routine?.updatedAt === at;

for (const step of STEPS) {
  test(`routine profile: an account ${step} between the profile merge and the fact writes gets no memory, no audit line, and no success`, async () => {
    const uid = `fo772-routinePut-${step}`;
    await withStaged(uid, async (s) => {
      s.arm(step, profileSavedAt(FIRST));
      await assert.rejects(saveRoutineProfile(uid, routine(), FIRST, { storage: s.storage }), AccountUnavailableError);
      await assertNothingAfter(s, uid, step, 'routine put');
      assert.equal((await s.base.list(userCol(uid, MEMORY))).length, 0, 'a fact was written under the deleted account');
    });
  });

  test(`routine profile: an account ${step} between the merge and a removed answer's revocation leaves the fact as it was and reports no success`, async () => {
    const uid = `fo772-routineRevoke-${step}`;
    await withStaged(uid, async (s) => {
      // Live: the survey with quiet hours files a quiet_hours fact.
      await saveRoutineProfile(uid, routine(), FIRST, { storage: s.storage });
      const facts = await s.base.list<{ content: string; status: string }>(userCol(uid, MEMORY));
      assert.ok(facts.some((f) => f.data.content.startsWith('quiet_hours:') && f.data.status === 'active'), 'fixture: no quiet_hours fact');
      // Removing the answer is reconciled as one revocation, after the merge.
      s.arm(step, profileSavedAt(SECOND));
      await assert.rejects(saveRoutineProfile(uid, routine({ quietHours: null }), SECOND, { storage: s.storage }), AccountUnavailableError);
      await assertNothingAfter(s, uid, step, 'routine revoke');
    });
  });
}

/**
 * The races inside reconciliation itself: the guard was taken while the
 * account was live, and the deletion lands between it and a fact write, or
 * after the last fact write and before the audit line. Staged by a memory store
 * whose one method runs the deletion around the real write.
 */
type MemoryMethod = 'put' | 'supersede' | 'revoke';

function racingMemory(s: Staged, uid: string, step: Step, method: MemoryMethod, when: 'before' | 'after') {
  const real = createStorageRuntimeMemoryStore(undefined, s.storage);
  const memory = Object.create(real) as typeof real;
  let fired = false;
  let left: Tree = {};
  const deletion = async () => {
    if (fired) return;
    fired = true;
    await deleteAccount(s.base, uid, step);
    left = await snapshot(s.base, uid);
  };
  (memory as any)[method] = async (...args: unknown[]) => {
    if (when === 'before') await deletion();
    const result = await (real as any)[method](...args);
    if (when === 'after') await deletion();
    return result;
  };
  return { memory, fired: () => fired, left: () => left };
}

for (const step of STEPS) {
  test(`routine profile: an account ${step} after the guard was taken and before a new fact is written gets no fact and no success`, async () => {
    const uid = `fo772-routineGuardPut-${step}`;
    await withStaged(uid, async (s) => {
      const race = racingMemory(s, uid, step, 'put', 'before');
      await assert.rejects(saveRoutineProfile(uid, routine(), FIRST, { storage: s.storage, memory: race.memory }), AccountUnavailableError);
      assert.ok(race.fired(), 'the race was not staged');
      assert.deepEqual(await snapshot(s.base, uid), race.left(), 'a fact was written under the deleted account');
    });
  });
}

test('routine profile: an account markDeleted after the guard was taken and before a removed answer is revoked leaves the fact active and reports no success', async () => {
  const uid = 'fo772-routineGuardRevoke';
  await withStaged(uid, async (s) => {
    await saveRoutineProfile(uid, routine(), FIRST, { storage: s.storage });
    const race = racingMemory(s, uid, 'markDeleted', 'revoke', 'before');
    await assert.rejects(saveRoutineProfile(uid, routine({ quietHours: null }), SECOND, { storage: s.storage, memory: race.memory }), AccountUnavailableError);
    assert.ok(race.fired(), 'the race was not staged');
    assert.deepEqual(await snapshot(s.base, uid), race.left(), 'the revocation landed under the deleted account');
    const quiet = (await s.base.list<{ content: string; status: string }>(userCol(uid, MEMORY))).find((f) => f.data.content.startsWith('quiet_hours:'));
    assert.equal(quiet?.data.status, 'active');
  });
});

for (const step of STEPS) {
  test(`routine profile: an account ${step} after the last fact write and before the audit line gets no audit line and no success`, async () => {
    const uid = `fo772-routineAudit-${step}`;
    await withStaged(uid, async (s) => {
      await saveRoutineProfile(uid, routine(), FIRST, { storage: s.storage });
      // One answer changed: reconciliation is one supersede, then the audit line.
      const race = racingMemory(s, uid, step, 'supersede', 'after');
      await assert.rejects(saveRoutineProfile(uid, routine({ sleepWindow: { start: '00:30', end: '08:30' } }), SECOND, {
        storage: s.storage, memory: race.memory,
      }), AccountUnavailableError);
      assert.ok(race.fired(), 'the race was not staged');
      const now = await snapshot(s.base, uid);
      if (step === 'swept') assert.deepEqual(Object.keys(now), [], 'the audit line re-created the swept tree');
      assert.deepEqual(now, race.left(), 'an audit line was appended under the deleted account');
    });
  });
}

function fact(uid: string, content = 'likes mornings'): CreateMemoryInput {
  return { scopeId: uid, kind: 'fact', content, language: 'en', source: 'user_stated', confidence: 1, observedAt: FIRST };
}

test('personalizationWriteGuard refuses a deleted account when it is taken (the initial predicate)', async () => {
  for (const step of STEPS) {
    const uid = `fo772-guardStart-${step}`;
    await withStaged(uid, async (s) => {
      await deleteAccount(s.base, uid, step);
      await assert.rejects(personalizationWriteGuard(s.storage, uid), AccountUnavailableError);
    });
  }
});

test('a guard taken while live refuses every guarded memory write once the account is deleted (the transactional predicate)', async () => {
  for (const step of STEPS) {
    const uid = `fo772-guardTx-${step}`;
    await withStaged(uid, async (s) => {
      const memory = createStorageRuntimeMemoryStore(undefined, s.storage);
      const existing = await memory.put(fact(uid, 'old'), FIRST);
      const guard = await personalizationWriteGuard(s.storage, uid);
      await deleteAccount(s.base, uid, step);
      const before = await snapshot(s.base, uid);
      await assert.rejects(memory.put(fact(uid), SECOND, guard), AccountUnavailableError);
      await assert.rejects(memory.putIdempotent(fact(uid), SECOND, 'k-1', guard), AccountUnavailableError);
      if (step === 'markDeleted') {
        await assert.rejects(memory.supersede(existing.id, fact(uid, 'new'), SECOND, guard), AccountUnavailableError);
        await assert.rejects(memory.revoke(existing.id, SECOND, guard), AccountUnavailableError);
      } else {
        // Swept: the record went with the tree, so there is nothing to rewrite.
        assert.equal(await memory.revoke(existing.id, SECOND, guard), false);
      }
      assert.deepEqual(await snapshot(s.base, uid), before, 'a guarded memory write landed under the deleted account');
    });
  }
});

test('a live account: the guard accepts and refuses exactly as the personalization fence says (no behaviour change)', async () => {
  const uid = 'fo772-guardLive';
  await withStaged(uid, async (s) => {
    const memory = createStorageRuntimeMemoryStore(undefined, s.storage);
    const guard = await personalizationWriteGuard(s.storage, uid);
    const user = await s.base.get<Record<string, any>>(userDoc(uid));
    assert.equal(guard.accepts(user), true, 'a live account with no fence is accepted');
    assert.equal(guard.accepts({ ...user, personalizationPurge: { state: 'active', epoch: 0 } }), true);
    assert.equal(guard.accepts({ ...user, personalizationPurge: { state: 'purging', epoch: 0 } }), false);
    assert.equal(guard.accepts({ ...user, personalizationPurge: { state: 'withdrawing', epoch: 0 } }), false);
    assert.equal(guard.accepts({ ...user, personalizationPurge: { state: 'active', epoch: 1 } }), false, 'a moved epoch still refuses');
    // And the guarded writes themselves go through, revoke included.
    const written = await memory.put(fact(uid), FIRST, guard);
    assert.equal(await memory.revoke(written.id, SECOND, guard), true);
    assert.equal((await memory.get(written.id))?.status, 'revoked');
    assert.equal(await memory.revoke(written.id, SECOND, guard), true, 'revoking twice stays idempotent');
    assert.equal((await memory.get(written.id))?.revokedAt, SECOND);
    // A purge that began after the guard was taken still refuses the write, as a MemoryWriteRefusedError.
    await s.base.set(userDoc(uid), { ...user, personalizationPurge: { state: 'purging', epoch: 0 } });
    await assert.rejects(memory.put(fact(uid, 'later'), SECOND, guard), MemoryWriteRefusedError);
  });
});

/* ── Q772C-002: audit rows ───────────────────────────────────────────── */

async function auditRows(s: Staged, uid: string): Promise<Array<{ reasonCode: string; eventType: string }>> {
  return (await s.base.list<{ reasonCode: string; eventType: string }>(userCol(uid, AUDIT_EVENTS))).map((row) => row.data);
}

for (const step of STEPS) {
  test(`consent: an account ${step} right after the answer commits gets no audit line appended afterwards`, async () => {
    const uid = `fo772-consentAfter-${step}`;
    await withStaged(uid, async (s) => {
      s.arm(step, (user) => user?.consents?.[RECOMMENDATION_CONSENT.key]?.state === 'granted');
      // The answer and its audit line commit together, before the deletion:
      // there is no later step left for the deletion to fall in front of.
      await setConsent(RECOMMENDATION_CONSENT, uid, {
        state: 'granted', version: RECOMMENDATION_CONSENT_VERSION, at: new Date(FIRST),
      }, { storage: s.storage });
      await assertNothingAfter(s, uid, step, 'consent audit');
      if (step === 'markDeleted') {
        assert.deepEqual((await auditRows(s, uid)).map((row) => row.reasonCode), [`${RECOMMENDATION_CONSENT.auditCode}_granted`],
          'the audit line did not commit with the answer');
      }
    });
  });

  test(`consent: an account ${step} before the write is refused as deleted, with neither the answer nor an audit line`, async () => {
    const uid = `fo772-consentBefore-${step}`;
    await withStaged(uid, async (s) => {
      await deleteAccount(s.base, uid, step);
      const before = await snapshot(s.base, uid);
      await assert.rejects(setConsent(RECOMMENDATION_CONSENT, uid, {
        state: 'granted', version: RECOMMENDATION_CONSENT_VERSION, at: new Date(FIRST),
      }, { storage: s.storage }), AccountUnavailableError);
      assert.deepEqual(await snapshot(s.base, uid), before);
    });
  });

  test(`personalization grant: an account ${step} before the store write leaves no rollback audit line`, async () => {
    const uid = `fo772-grantRollback-${step}`;
    await withStaged(uid, async (s) => {
      const base = createStoragePersonalizationConsentStore(s.storage);
      let left: Tree | null = null;
      const racing = {
        read: (scopeId: string) => base.read(scopeId),
        write: base.write.bind(base),
        deleteScope: base.deleteScope.bind(base),
        writeGuarded: async (...args: Parameters<NonNullable<typeof base.writeGuarded>>) => {
          await deleteAccount(s.base, uid, step);
          left = await snapshot(s.base, uid);
          return base.writeGuarded!(...args);
        },
      };
      await assert.rejects(setPersonalizationConsent(uid, {
        state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(FIRST),
      }, { storage: s.storage, consent: racing, purgeWait: { attempts: 1, delayMs: 1 } }), AccountUnavailableError);
      assert.ok(left, 'the race was not staged');
      assert.deepEqual(await snapshot(s.base, uid), left, 'the rollback wrote under the deleted account');
      assert.ok(!(await auditRows(s, uid)).some((row) => row.reasonCode.endsWith('_declined')), 'the rollback left an audit line');
    });
  });

  test(`pilot trust update: an account ${step} right after the change commits gets no audit line and no re-created root`, async () => {
    const uid = `fo772-trust-${step}`;
    await withStaged(uid, async (s) => {
      s.arm(step, (user) => user?.trust?.quietMode === true);
      await updateMobilePilotTrust(uid, { action: { type: 'set_quiet_mode', enabled: true } });
      await assertNothingAfter(s, uid, step, 'pilot trust audit');
      if (step === 'markDeleted') {
        assert.deepEqual((await auditRows(s, uid)).map((row) => row.eventType), ['quiet_mode_changed'],
          'the audit line did not commit with the change');
      }
    });
  });
}

test('pilot trust update on a deleted account is refused as deleted, with no audit line', async () => {
  for (const step of STEPS) {
    const uid = `fo772-trustBefore-${step}`;
    await withStaged(uid, async (s) => {
      // Past authentication (the access read), then deleted before the change.
      s.arm(step, (user) => Boolean(user?.trust) && user?.trust?.quietMode !== true);
      await assert.rejects(updateMobilePilotTrust(uid, { action: { type: 'set_quiet_mode', enabled: true } }), AccountUnavailableError);
      await assertNothingAfter(s, uid, step, 'pilot trust refused');
    });
  }
});

/* ── Q772C-004: markState ────────────────────────────────────────────── */

const CREDENTIAL = { vault: 'test-vault', keyId: 'google', version: null } as const;
const TOKENS: ProviderOAuthTokenSet = {
  accessToken: 'ACCESS', refreshToken: 'REFRESH', tokenType: 'Bearer',
  accessTokenExpiresAt: '2026-10-03T10:00:00.000Z', refreshTokenExpiresAt: null,
  grantedScopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
} as never;

async function connect(uid: string, storage: StorageAdapter): Promise<StoredIntegrationConnectionStore> {
  const connections = new StoredIntegrationConnectionStore(uid, storage);
  await connections.upsert({
    scopeId: uid,
    identity: { provider: 'google', providerAccountId: 'acct-1', displayName: null } as never,
    state: 'connected',
    capabilities: ['calendar_busy_read'] as never,
    grantedScopes: TOKENS.grantedScopes,
    connectedAt: FIRST,
    credentialRef: CREDENTIAL as never,
  } as never, FIRST);
  return connections;
}

const ID = connectionIdFor('google');

function vault(load: () => Promise<ProviderOAuthTokenSet | null>): ProviderCredentialVault {
  return {
    storeOAuthTokenSet: async () => CREDENTIAL as never,
    loadOAuthTokenSet: load,
    delete: async () => undefined,
  };
}

function client(revoke: () => Promise<void> = async () => undefined): ProviderOAuthClient {
  return {
    provider: 'google',
    exchangeAuthorizationCode: async () => TOKENS,
    loadIdentity: async () => ({ provider: 'google', providerAccountId: 'acct-1', displayName: null }) as never,
    revoke,
  } as ProviderOAuthClient;
}

for (const step of STEPS) {
  test(`refresh: an account ${step} after the refresh began cannot have its connection marked by it`, async () => {
    const uid = `fo772-refresh-${step}`;
    await withStaged(uid, async (s) => {
      const connections = await connect(uid, s.storage);
      let left: Tree | null = null;
      // The refresh read the record while live; the deletion lands before its
      // `markState` (the vault has no credential: `needs_reauth`).
      const racing = vault(async () => {
        await deleteAccount(s.base, uid, step);
        left = await snapshot(s.base, uid);
        return null;
      });
      await assert.rejects(refreshProviderAccessToken(racing, connections, client(), {
        scopeId: uid, connectionId: ID, now: SECOND,
      }), AccountUnavailableError);
      assert.ok(left, 'the race was not staged');
      assert.deepEqual(await snapshot(s.base, uid), left, 'markState wrote under the deleted account');
    });
  });
}

test('the deletion hook marks the connection revoked, and a late refresh cannot overwrite it', async () => {
  const uid = 'fo772-hookRevoked';
  await withStaged(uid, async (s) => {
    const connections = await connect(uid, s.storage);
    await deleteAccount(s.base, uid, 'markDeleted');
    // The account-deletion hook's path: revoke at the provider, drop the
    // credential, mark the record through the deletion-only method.
    const revoked = await disconnectProviderOAuth(vault(async () => TOKENS), connections, client(), {
      scopeId: uid, connectionId: ID, now: SECOND, accountDeletion: true,
    });
    assert.equal(revoked?.state, 'revoked');
    assert.equal(revoked?.revokedAt, SECOND);
    const after = await s.base.get<IntegrationConnectionRecord>(`${userCol(uid, PROVIDER_CONNECTIONS)}/${ID}`);
    assert.equal(after?.state, 'revoked');
    // A refresh begun before the deletion arrives now, and fails at the provider.
    await assert.rejects(connections.markState(ID, 'error', '2026-10-03T09:10:00.000Z', 'refresh_failed'), AccountUnavailableError);
    await assert.rejects(connections.markState(ID, 'needs_reauth', '2026-10-03T09:10:00.000Z', 'resource_unauthorized'), AccountUnavailableError);
    const final = await connections.get(ID);
    assert.equal(final?.state, 'revoked', 'the deletion hook revoked state was overwritten');
    assert.equal(final?.revokedAt, SECOND);
  });
});

test('the deletion-only method: marked-deleted root, existing row, monotonic to revoked; nothing else', async () => {
  // A live account disconnects through markState, not this.
  await withStaged('fo772-deletionOnlyLive', async (s) => {
    const connections = await connect('fo772-deletionOnlyLive', s.storage);
    await assert.rejects(connections.markRevokedForAccountDeletion(ID, SECOND), AccountUnavailableError);
    assert.equal((await connections.get(ID))?.state, 'connected');
    // And the ordinary user disconnect still works on a live account.
    const done = await disconnectProviderOAuth(vault(async () => TOKENS), connections, client(), { scopeId: 'fo772-deletionOnlyLive', connectionId: ID, now: SECOND });
    assert.equal(done?.state, 'revoked');
  });
  // After the sweep there is no root and no row: nothing is re-created.
  await withStaged('fo772-deletionOnlySwept', async (s) => {
    const connections = await connect('fo772-deletionOnlySwept', s.storage);
    await deleteAccount(s.base, 'fo772-deletionOnlySwept', 'swept');
    await assert.rejects(connections.markRevokedForAccountDeletion(ID, SECOND), AccountUnavailableError);
    assert.deepEqual(Object.keys(await snapshot(s.base, 'fo772-deletionOnlySwept')), []);
  });
  // A marked-deleted root with no row: null, nothing created.
  await withStaged('fo772-deletionOnlyNoRow', async (s) => {
    const connections = new StoredIntegrationConnectionStore('fo772-deletionOnlyNoRow', s.storage);
    await deleteAccount(s.base, 'fo772-deletionOnlyNoRow', 'markDeleted');
    const before = await snapshot(s.base, 'fo772-deletionOnlyNoRow');
    assert.equal(await connections.markRevokedForAccountDeletion(ID, SECOND), null);
    assert.deepEqual(await snapshot(s.base, 'fo772-deletionOnlyNoRow'), before);
  });
  // Already revoked: left as it is, the first revokedAt kept.
  await withStaged('fo772-deletionOnlyTwice', async (s) => {
    const connections = await connect('fo772-deletionOnlyTwice', s.storage);
    await deleteAccount(s.base, 'fo772-deletionOnlyTwice', 'markDeleted');
    await connections.markRevokedForAccountDeletion(ID, SECOND);
    const again = await connections.markRevokedForAccountDeletion(ID, '2026-10-03T09:30:00.000Z');
    assert.equal(again?.revokedAt, SECOND);
    assert.equal(again?.updatedAt, SECOND);
  });
});

test('a disconnect on a deleted account outside the hook is refused; the hook path records no error when the provider refuses', async () => {
  const uid = 'fo772-disconnectDeleted';
  await withStaged(uid, async (s) => {
    const connections = await connect(uid, s.storage);
    await deleteAccount(s.base, uid, 'markDeleted');
    const before = await snapshot(s.base, uid);
    await assert.rejects(disconnectProviderOAuth(vault(async () => TOKENS), connections, client(), {
      scopeId: uid, connectionId: ID, now: SECOND,
    }), AccountUnavailableError);
    await assert.rejects(disconnectProviderOAuth(vault(async () => TOKENS), connections, client(async () => { throw new Error('google down'); }), {
      scopeId: uid, connectionId: ID, now: SECOND, accountDeletion: true,
    }), /revocation_failed/);
    assert.deepEqual(await snapshot(s.base, uid), before, 'a connection write landed under the deleted account');
  });
});

/* ── Q772C-005: the hard-reminder index and its job ──────────────────── */

const TODAY = new Date();
/** 06:00 UTC tomorrow, from the real clock: the index skips reminders already past. */
const TOMORROW = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate() + 1, 6));

function mustCommitment(): Commitment {
  const start = new Date(TOMORROW.getTime() + 2 * 3_600_000).toISOString();
  return {
    id: 'c1', kind: 'task', title: 'Dentist', description: null, person: null, status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'scheduled_event', dueAt: start, endAt: null, remindAt: null, allDay: false, timezone: TZ },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: TOMORROW.toISOString(), updatedAt: TOMORROW.toISOString(), confirmedAt: TOMORROW.toISOString(),
    completedAt: null, droppedAt: null,
  } as Commitment;
}

async function storeCommitment(uid: string): Promise<void> {
  const state = createEmptyDomainState();
  const item = mustCommitment();
  state.commitments[item.id] = item;
  await persistParticipantState(uid, state);
}

for (const step of STEPS) {
  test(`reminder settings: an account ${step} between the settings merge and the index reconcile indexes nothing and reports no success`, async () => {
    const uid = `fo772-reminders-${step}`;
    await withStaged(uid, async (s) => {
      // Stored while Must reminders are off, so only the reconcile could index it.
      await storeCommitment(uid);
      assert.equal((await s.base.list(userCol(uid, HARD_REMINDERS))).length, 0, 'fixture: indexed before the settings changed');
      const at = new Date().toISOString();
      s.arm(step, (user) => user?.reminderSettings?.updatedAt === at);
      await assert.rejects(saveReminderSettings(uid, { hardEnabled: true, escalationCeiling: 'hard' }, at, { storage: s.storage }), AccountUnavailableError);
      await assertNothingAfter(s, uid, step, 'hard reminder index');
      assert.equal((await s.base.list(userCol(uid, HARD_REMINDERS))).length, 0, 'a due reminder row was indexed under the deleted account');
    });
  });
}

test('reminder settings on a live account still index the Must commitment (the fence is not a blanket refusal)', async () => {
  const uid = 'fo772-remindersLive';
  await withStaged(uid, async (s) => {
    await storeCommitment(uid);
    await saveReminderSettings(uid, { hardEnabled: true, escalationCeiling: 'hard' }, new Date().toISOString(), { storage: s.storage });
    assert.equal((await s.base.list(userCol(uid, HARD_REMINDERS))).length, 1);
  });
});

async function indexedRow(uid: string, s: Staged): Promise<HardReminderEntry> {
  await saveReminderSettings(uid, { hardEnabled: true, escalationCeiling: 'hard' }, new Date().toISOString(), { storage: s.storage });
  await storeCommitment(uid);
  const row = await s.base.get<HardReminderEntry>(hardReminderPath(uid, 'c1'));
  assert.equal(row?.status, 'pending', 'fixture: no pending row');
  return row!;
}

test('the reminder job neither claims nor sends a deleted account s due row (the no-op outcome)', async () => {
  const uid = 'fo772-tickDeleted';
  await withStaged(uid, async (s) => {
    const row = await indexedRow(uid, s);
    await deleteAccount(s.base, uid, 'markDeleted');
    const before = await snapshot(s.base, uid);
    let sends = 0;
    const totals = await runHardReminderTick({
      now: () => new Date(row.fireAt),
      storage: s.storage,
      send: (async () => { sends += 1; return { status: 'sent', delivered: 1, removed: 0 }; }) as never,
    });
    assert.equal(sends, 0, 'a push went out for a deleted account');
    assert.equal(totals.due, 1, 'the row was not even due: the test proves nothing');
    assert.deepEqual({ sent: totals.sent, failed: totals.failed, suppressed: totals.suppressed, cancelled: totals.cancelled }, { sent: 0, failed: 0, suppressed: 0, cancelled: 0 });
    assert.deepEqual(await snapshot(s.base, uid), before, 'the job wrote under the deleted account');
  });
});

test('the reminder job still claims and sends a live account s due row', async () => {
  const uid = 'fo772-tickLive';
  await withStaged(uid, async (s) => {
    const row = await indexedRow(uid, s);
    let sends = 0;
    const totals = await runHardReminderTick({
      now: () => new Date(row.fireAt),
      storage: s.storage,
      send: (async () => { sends += 1; return { status: 'sent', delivered: 1, removed: 0 }; }) as never,
    });
    assert.equal(sends, 1);
    assert.equal(totals.sent, 1);
    assert.equal((await s.base.get<HardReminderEntry>(hardReminderPath(uid, 'c1')))?.status, 'sent');
  });
});

// ── Q772F-001: a deletion that lands after the claim, during the send ──────

for (const outcome of ['no_devices', 'throws'] as const) {
  test(`Q772F-001 the reminder job's write-back after a send (${outcome}) never re-creates a row the deletion swept`, async () => {
    const uid = `fo772-tickSwept-${outcome}`;
    await withStaged(uid, async (s) => {
      const row = await indexedRow(uid, s);
      const run = runHardReminderTick({
        now: () => new Date(row.fireAt),
        storage: s.storage,
        // The claim committed under a live account; the deletion sweeps while
        // the push is out, then the send answers.
        send: (async () => {
          await deleteAccount(s.base, uid, 'swept');
          if (outcome === 'throws') throw new Error('fcm down');
          return { status: 'no_devices', delivered: 0, removed: 0 };
        }) as never,
      });
      // The tick counts a send that threw as failed; it does not rethrow.
      await run.catch(() => undefined);
      assert.deepEqual(await snapshot(s.base, uid), {}, 'the write-back re-created a document under the swept account');
    });
  });
}

test('Q772F-001 a push whose account is swept after the access and device reads takes no lock, writes no log row and sends nothing', async () => {
  const uid = 'fo772-pushSwept';
  await withStaged(uid, async (s) => {
    // The access check and the device list read a live account; the deletion
    // then sweeps just before the lock's transaction (the first transaction
    // sendToUser runs).
    let first = true;
    const racing = new Proxy(s.base, {
      get(target, prop, receiver) {
        if (prop === 'runTransaction') {
          return async (fn: never) => {
            if (first) { first = false; await deleteAccount(target, uid, 'swept'); }
            return target.runTransaction(fn);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    let sends = 0;
    const messaging = { send: async () => { sends += 1; return 'id'; } };
    await s.base.set(`${userDoc(uid)}/devices/inst-1`, {
      installationId: 'inst-1', fcmToken: 'tok', platform: 'ios', pushPermission: 'granted',
      updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    });
    const result = await sendToUser({
      uid, kind: 'hard_reminder', dedupeKey: 'k1', title: 't', body: 'b', data: {}, respectQuietHours: false, urgency: 'normal',
    } as never, new Date(), { storage: racing as never, messaging: messaging as never });
    assert.equal(first, false, 'the lock transaction never ran: the race was not staged');
    assert.equal(sends, 0, 'a push went out after the deletion');
    assert.equal(result.status, 'suppressed_no_access');
    assert.deepEqual(await snapshot(s.base, uid), {}, 'a push-log row or other document was re-created under the swept account');
  });
});

test('Q772F-001 a push to an account with no root at all is refused as deleted, not allowed as untouched', async () => {
  const uid = 'fo772-pushNoRoot';
  await withStaged(uid, async (s) => {
    await deleteAccount(s.base, uid, 'swept');
    const result = await sendToUser({
      uid, kind: 'hard_reminder', dedupeKey: 'k2', title: 't', body: 'b', data: {}, respectQuietHours: false, urgency: 'normal',
    } as never, new Date(), { storage: s.base as never, messaging: { send: async () => 'id' } as never });
    assert.equal(result.status, 'suppressed_no_access');
  });
});
