/**
 * Settings, watcher, consent and device writers re-read the account deletion
 * fence (#772 follow-up).
 *
 * #772 made `writeDomainDiff`, the habit stores, `setUserLocale` and
 * `setFollowedClubs` read `users/{uid}` in the transaction that writes and
 * refuse unless the account is live (`lib/account/accountLiveness.ts`). This
 * file covers the next set of writers: settings and preferences, football and
 * memory growth, feedback and decisions, watchers and packs, and the writers
 * that could re-create the root or store a token (devices, consents, the
 * OAuth state, credential and connection stores).
 *
 * Every case runs twice, once per deletion step, staged before the write:
 *
 *   - markDeleted: `trust.deletedAt` is set, the tree is still there. The
 *     write is refused and the tree is exactly as the deletion left it;
 *   - swept: markDeleted and then the whole tree deleted. The write is
 *     refused and nothing at all is under `users/{uid}`: no re-created root,
 *     no re-created child document.
 *
 * The routes are raced the way tests/account/domainWriteFence772.test.ts
 * races them (the deletion commits at the request's first storage write,
 * after authentication) and must answer 403 `reason: 'deleted'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import {
  CALENDAR_CHOICE,
  PACK_INSTALLATIONS,
  PROVIDER_CREDENTIALS,
  userDoc,
  userSubDoc,
} from '../../lib/storage/paths.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { AccountUnavailableError } from '../../lib/account/accountLiveness.ts';
import { createInMemoryKms } from '../../lib/security/inMemoryKms.ts';
import { KMS_KEY_ENV_VAR, type FieldEncryptionOptions } from '../../lib/security/fieldEncryption.ts';

// Settings and preferences
import { StoredManualFinancialStore } from '../../lib/services/financial/manualFinancialStore.ts';
import { saveCategoryPreferences } from '../../lib/services/categories/categoryPreferences.ts';
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import { saveReminderSettings } from '../../lib/services/mobile/reminderSettingsService.ts';
import { saveCalendarWriteTarget } from '../../lib/services/calendar/calendarSettings.ts';
import { putDeviceCalendarLink } from '../../lib/services/calendar/deviceCalendarLinks.ts';
import { registerDeviceSource } from '../../lib/calendar/calendarChoice.ts';
// Football and memory growth
import { putRef, putRefCarryingForwardDetachment } from '../../lib/football/externalTaskRefStore.ts';
import { reconcileFootballWatchers } from '../../lib/football/footballWatchers.ts';
import { recordDismissal } from '../../lib/memoryGrowth/dismissals.ts';
import { R1_FOCUS_WINDOW } from '../../lib/memoryGrowth/rules.ts';
// Feedback and decisions
import { createStorageFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { prepareMeeting } from '../../lib/services/mobile/meetingPrepService.ts';
import { describeProfile } from '../../lib/services/mobile/profileDescribeService.ts';
import { appendNextStepDecision } from '../../lib/services/mobile/nextStepDecisionLog.ts';
import { saveSubjectiveEnergyCheckIn } from '../../lib/userState/userStateService.ts';
import { answerEveningImpact } from '../../lib/planning/eveningImpactDecision.ts';
import { NO_QUIET_HOURS } from '../../lib/push/quietHours.ts';
// Watchers and packs
import { createWatcherStore, type NewWatcherInput } from '../../lib/watchers/watcherStore.ts';
import { saveMonitoringSettings } from '../../lib/watchers/monitoringSettings.ts';
import { disablePack } from '../../lib/packs/packLifecycle.ts';
import { forgetPackWatcher } from '../../lib/packs/packWatcherGuard.ts';
// Root and token writers
import { upsertDevice } from '../../lib/push/deviceRegistry.ts';
import { setConsent } from '../../lib/consents/consentService.ts';
import { setPersonalizationConsent } from '../../lib/consents/personalizationConsentService.ts';
import { createStoragePersonalizationConsentStore } from '../../lib/personalizationControls/consentStore.ts';
import { StoredProviderOAuthStateStore } from '../../lib/integrations/providers/production/storedOAuthStateStore.ts';
import { StoredIntegrationConnectionStore } from '../../lib/integrations/providers/production/storedConnectionStore.ts';
import {
  EncryptedProviderCredentialVault,
  credentialKeyId,
} from '../../lib/integrations/providers/production/encryptedCredentialVault.ts';
import {
  beginProviderOAuth,
  completeProviderOAuth,
  MemoryProviderOAuthCleanupObligations,
  type ProviderOAuthClient,
} from '../../lib/integrations/providers/providerOAuthLifecycle.ts';
import type { ProviderOAuthTokenSet } from '../../lib/integrations/providers/providerRuntime.ts';
import {
  PERSONALIZATION_CONSENT_VERSION,
  RECOMMENDATION_CONSENT,
  RECOMMENDATION_CONSENT_VERSION,
} from '../../src/contracts/v1/consentContracts.ts';
import {
  PACK_INSTALLATION_SCHEMA_VERSION,
  VERTICAL_PACK_CONTRACT_VERSION,
} from '../../src/contracts/v1/verticalPackContracts.ts';
// Daily plan (added to this lane by the coordinator)
import { claimDueDeliveryOutcome, savePlanSettings } from '../../lib/services/dailyPlan/dailyPlanService.ts';
// Routes
import { GET as habitsGet } from '../../src/app/api/mobile/habits/route.ts';
import { PUT as categoriesPut } from '../../src/app/api/mobile/settings/categories/route.ts';
import { PUT as calendarSettingsPut } from '../../src/app/api/mobile/settings/calendar/route.ts';
import { POST as devicesPost } from '../../src/app/api/mobile/devices/route.ts';
import { PATCH as monitoringPatch } from '../../src/app/api/mobile/settings/monitoring/route.ts';
import { PUT as recommendationsPut } from '../../src/app/api/mobile/consents/recommendations/route.ts';
import { PUT as planSettingsPut } from '../../src/app/api/mobile/settings/plan/route.ts';

const NOW = '2026-10-03T09:13:00.000Z';
const TZ = 'Asia/Jerusalem';
const BASE = 'http://127.0.0.1:4321';

type Step = 'markDeleted' | 'swept';
const STEPS: readonly Step[] = ['markDeleted', 'swept'];

/* ── harness ─────────────────────────────────────────────────────────── */

/** `markDeleted`, as account deletion writes it, then the sweep when asked. */
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

interface Ctx {
  readonly uid: string;
  readonly storage: MemoryStorageAdapter;
}

/**
 * A live account; `setup` writes whatever the writer needs while it is live
 * and returns the write. The deletion step then runs, and the write must be
 * refused with `AccountUnavailableError` and leave the tree as the deletion
 * left it (markDeleted) or empty (swept).
 */
async function fenced(name: string, step: Step, setup: (ctx: Ctx) => Promise<() => Promise<unknown>>): Promise<void> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const uid = `w772c-${name}`;
  try {
    await seedLiveAccount(uid, storage);
    const write = await setup({ uid, storage });
    await deleteAccount(storage, uid, step);
    const expected = step === 'swept' ? {} : await snapshot(storage, uid);
    await assert.rejects(write(), AccountUnavailableError, `${name}: the write was not refused`);
    const after = await snapshot(storage, uid);
    if (step === 'swept') {
      assert.deepEqual(Object.keys(after), [], `${name}: documents re-created under a swept account`);
    } else {
      assert.deepEqual(Object.keys(after), Object.keys(expected), `${name}: the set of documents changed`);
      for (const path of Object.keys(expected)) assert.deepEqual(after[path], expected[path], `${name}: ${path} was written`);
    }
  } finally {
    resetStorageForTests();
  }
}

/** One test per deletion step. */
function both(title: string, name: string, setup: (ctx: Ctx) => Promise<() => Promise<unknown>>): void {
  for (const step of STEPS) {
    test(`${title}, after the account is ${step}: refused, nothing written`, () => fenced(`${name}-${step}`, step, setup));
  }
}

/** Only markDeleted: after a sweep there is nothing left for this writer to rewrite. */
function markedOnly(title: string, name: string, setup: (ctx: Ctx) => Promise<() => Promise<unknown>>): void {
  test(`${title}, after the account is markDeleted: refused, nothing written`, () => fenced(`${name}-markDeleted`, 'markDeleted', setup));
}

/* ── settings and preferences ────────────────────────────────────────── */

both('manual financial input', 'financial', async ({ uid, storage }) => {
  const store = new StoredManualFinancialStore(uid, storage);
  return () => store.putField({ field: 'monthlyIncome', value: 4200, enteredAt: NOW } as never);
});

both('category preferences', 'categories', async ({ uid, storage }) =>
  () => saveCategoryPreferences(uid, { enabled: ['work', 'family'], grouping: true }, { storage }));

both('routine profile', 'routine', async ({ uid, storage }) =>
  () => saveRoutineProfile(uid, {
    timezone: TZ,
    sleepWindow: { start: '23:30', end: '07:30' },
    focusWindows: [{ start: '09:00', end: '17:00', label: 'work_study' }],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'softAwareness',
    quietHours: { start: '22:30', end: '07:30' },
    surveySkipped: false,
  }, NOW, { storage }));

both('reminder settings', 'reminders', async ({ uid, storage }) =>
  () => saveReminderSettings(uid, { softEnabled: true, softLeadMinutes: 30 }, NOW, { storage }));

both('calendar write target', 'calendarSettings', async ({ uid, storage }) =>
  () => saveCalendarWriteTarget(uid, 'device', new Date(NOW), { storage }));

both('device calendar link', 'deviceLink', async ({ uid, storage }) =>
  () => putDeviceCalendarLink(uid, 'commitment-1', {
    writerId: 'writer-phone', calendarId: 'cal-1', eventId: 'evt-1', contentHash: 'hash-1', state: 'linked',
  }, new Date(NOW), { storage }));

both('calendar device-source registration', 'calendarChoice', async ({ uid, storage }) => {
  await storage.set(userSubDoc(uid, CALENDAR_CHOICE, 'state'), {
    v: 1, generation: 1, state: 'active', enrolledAt: NOW, purge: null,
  });
  return () => registerDeviceSource(uid, {
    sourceInstallationId: 'install-1', sourceSecret: 's'.repeat(32), registrationId: 'reg-1',
  }, storage);
});

/* ── football and memory growth ──────────────────────────────────────── */

const REF = {
  taskRefId: 'football-data:1',
  linkState: 'linked',
  detachedAt: null,
  linkedCommitmentId: 'fixture-commitment-1',
  fingerprint: 'fp-1',
  lastSyncedAt: NOW,
  updatedAt: NOW,
} as never;

both('external task ref (putRef)', 'putRef', async ({ uid, storage }) =>
  () => putRef(uid, REF, { storage }));

both('external task ref carrying a detachment forward', 'putRefCarry', async ({ uid, storage }) =>
  () => putRefCarryingForwardDetachment(uid, REF, { storage }));

both('football watcher reconciliation', 'reconcile', async ({ uid }) =>
  () => reconcileFootballWatchers(uid, ['barcelona'], NOW, { language: 'en' }));

both('memory-growth dismissal', 'dismissal', async ({ uid, storage }) =>
  () => recordDismissal(storage, uid, `${R1_FOCUS_WINDOW}:abc`, NOW));

/* ── feedback and decisions ──────────────────────────────────────────── */

both('feedback event append (account-scoped store)', 'feedbackAppend', async ({ uid, storage }) => {
  const store = createStorageFeedbackEventStore(storage, { accountScoped: true });
  return () => store.append({
    scopeId: uid, outcome: 'complete', subjectId: 'commitment-1', actor: 'user', source: 'mobile_action', occurredAt: NOW,
  }, NOW);
});

markedOnly('feedback event revocation (account-scoped store)', 'feedbackRevoke', async ({ uid, storage }) => {
  const store = createStorageFeedbackEventStore(storage, { accountScoped: true });
  const event = await store.append({
    scopeId: uid, outcome: 'complete', subjectId: 'commitment-1', actor: 'user', source: 'mobile_action', occurredAt: NOW,
  }, NOW);
  return () => store.revoke(event.id, NOW);
});

both('meeting preparation proposal', 'meetingPrep', async ({ uid, storage }) => {
  const now = new Date();
  return () => prepareMeeting(uid, {
    notes: 'Review the slides before the meeting.',
    startAt: new Date(now.getTime() + 180 * 60_000).toISOString(),
    endAt: new Date(now.getTime() + 225 * 60_000).toISOString(),
    timezone: TZ,
  }, { now, storage, consent: async () => 'declined', quietHours: NO_QUIET_HOURS });
});

both('profile description proposal', 'describe', async ({ uid, storage }) =>
  () => describeProfile(uid, '', new Date(NOW), { storage }));

both('next-step decision log', 'decision', async ({ uid }) =>
  () => appendNextStepDecision(uid, {
    proposalId: 'proposal-1', commitmentId: 'commitment-1', decision: 'defer' as never, arm: 'control',
    evidenceCodes: [], deferUntil: '2026-10-04T09:13:00.000Z', at: NOW,
  }));

both('readiness check-in', 'readiness', async ({ uid, storage }) =>
  () => saveSubjectiveEnergyCheckIn(uid, { energy: 3, observedAt: NOW }, { storage, now: NOW }));

both('evening impact answer', 'eveningImpact', async ({ uid }) =>
  () => answerEveningImpact(uid, { proposalId: 'proposal-1', revision: 1, itemId: 'item-1', readiness: 'ready' }));

/* ── watchers and packs ──────────────────────────────────────────────── */

const WATCHER: NewWatcherInput = {
  enabled: true,
  label: 'Barcelona',
  source: { provider: 'football_data', connectionId: null, signalKind: 'football_team_fixtures', subjectRef: 'barcelona' } as never,
  condition: { kind: 'digest_changed' } as never,
  effect: 'replan_if_impacted',
  createdBy: 'user',
};

both('watcher create', 'watcherCreate', async ({ uid, storage }) =>
  () => createWatcherStore(uid, storage).create(WATCHER, NOW));

both('watcher update', 'watcherUpdate', async ({ uid, storage }) => {
  const store = createWatcherStore(uid, storage);
  const created = await store.create(WATCHER, NOW);
  return () => store.update(created.definition.watcherId, (current) => ({
    ...current,
    definition: { ...current.definition, enabled: false, updatedAt: NOW },
  }));
});

both('monitoring settings', 'monitoring', async ({ uid, storage }) =>
  () => saveMonitoringSettings(uid, true, NOW, { storage }));

async function seedInstallation(storage: StorageAdapter, uid: string, watcherIds: string[]): Promise<void> {
  await storage.set(userSubDoc(uid, PACK_INSTALLATIONS, 'student'), {
    version: VERTICAL_PACK_CONTRACT_VERSION,
    schemaVersion: PACK_INSTALLATION_SCHEMA_VERSION,
    packId: 'student',
    scopeId: uid,
    state: 'enabled',
    reason: 'user_enabled',
    watcherIds,
    templateIds: watcherIds.map((_, index) => `template-${index}`),
    enabledAt: NOW,
    updatedAt: NOW,
  });
}

markedOnly('pack installation record (disable)', 'packDisable', async ({ uid, storage }) => {
  await seedInstallation(storage, uid, []);
  return () => disablePack({ scopeId: uid, packId: 'student', now: NOW, storage });
});

markedOnly('pack installation record (forget a deleted watcher)', 'packForget', async ({ uid, storage }) => {
  await seedInstallation(storage, uid, ['wtc_gone']);
  return () => forgetPackWatcher(uid, 'wtc_gone', NOW, { storage });
});

/* ── writers that can re-create the root or store a token ────────────── */

const DEVICE = {
  installationId: '9b2f6a1e-3c4d-4e5f-8a6b-7c8d9e0f1a2b',
  fcmToken: 'x'.repeat(40),
  platform: 'ios',
  appVersion: '1.0.0',
  locale: 'ar',
  timezone: TZ,
  pushPermission: 'granted',
} as const;

both('push device registration', 'device', async ({ uid, storage }) =>
  () => upsertDevice(uid, DEVICE as never, NOW, { storage }));

both('versioned consent answer', 'consent', async ({ uid, storage }) =>
  () => setConsent(RECOMMENDATION_CONSENT, uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION, at: new Date(NOW) }, { storage }));

both('personalization consent grant', 'personalizationGrant', async ({ uid, storage }) =>
  () => setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(NOW) }, {
    storage, purgeWait: { attempts: 1, delayMs: 1 },
  }));

markedOnly('personalization consent withdrawal', 'personalizationWithdraw', async ({ uid, storage }) => {
  await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(NOW) }, { storage });
  return () => setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(NOW) }, {
    storage, purgeWait: { attempts: 1, delayMs: 1 },
  });
});

const KEY = 'projects/p/locations/l/keyRings/r/cryptoKeys/user-secrets';
function encryption(): FieldEncryptionOptions {
  return { env: { [KMS_KEY_ENV_VAR]: KEY } as unknown as NodeJS.ProcessEnv, kms: createInMemoryKms({ keyName: KEY }) };
}
const TOKENS: ProviderOAuthTokenSet = {
  accessToken: 'ya29.SECRET-ACCESS-TOKEN',
  refreshToken: '1//0gSECRET-REFRESH-TOKEN',
  accessTokenExpiresAt: '2026-10-03T10:13:00.000Z',
  refreshTokenExpiresAt: null,
  grantedScopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
};

both('OAuth state', 'oauthState', async ({ uid, storage }) => {
  const states = new StoredProviderOAuthStateStore(uid, storage, encryption());
  return () => beginProviderOAuth(states, {
    scopeId: uid,
    provider: 'google',
    capabilities: ['calendar_busy_read'] as never,
    requestedScopes: TOKENS.grantedScopes,
    redirectUri: 'https://maybesitter.app/oauth/callback',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    clientId: 'client-1',
    now: NOW,
  });
});

both('encrypted provider credential', 'vault', async ({ uid, storage }) => {
  const vault = new EncryptedProviderCredentialVault(uid, storage, encryption());
  return () => vault.storeOAuthTokenSet({ scopeId: uid, provider: 'google', tokenSet: TOKENS });
});

both('integration connection record', 'connection', async ({ uid, storage }) => {
  const connections = new StoredIntegrationConnectionStore(uid, storage);
  return () => connections.upsert({
    scopeId: uid,
    identity: { provider: 'google', providerAccountId: 'acct-1', displayName: null } as never,
    state: 'connected',
    capabilities: ['calendar_busy_read'] as never,
    grantedScopes: TOKENS.grantedScopes,
    connectedAt: NOW,
  } as never, NOW);
});

/* ── daily plan settings and delivery ────────────────────────────────── */

both('plan settings', 'planSettings', async ({ uid, storage }) =>
  () => savePlanSettings(uid, { enabled: true, deliveryLocalTime: '08:00' }, new Date(NOW), { storage }));

/**
 * The delivery claim runs in the background sweep, one account among many, so
 * it does not throw: a deleted account answers the no-op outcome and nothing
 * under it is written — no re-armed `nextRunAt`, no re-created root.
 */
for (const step of STEPS) {
  test(`plan delivery claim, after the account is ${step}: the no-op outcome, nothing written`, async () => {
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    const uid = `w772c-planClaim-${step}`;
    try {
      await seedLiveAccount(uid, storage);
      await savePlanSettings(uid, { enabled: true, deliveryLocalTime: '08:00' }, new Date('2026-10-01T00:00:00.000Z'), { storage });
      // Live, the claim would be taken now: the delivery is due.
      const due = new Date('2026-10-05T12:00:00.000Z');
      await deleteAccount(storage, uid, step);
      const expected = step === 'swept' ? {} : await snapshot(storage, uid);
      assert.deepEqual(await claimDueDeliveryOutcome(uid, due, { storage }), { kind: 'not_due' });
      assert.deepEqual(await snapshot(storage, uid), expected, 'the claim wrote under a deleted account');
    } finally {
      resetStorageForTests();
    }
  });
}

test('plan delivery claim on a live account is still taken (the fence is not a blanket no-op)', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const uid = 'w772c-planClaim-live';
  try {
    await seedLiveAccount(uid, storage);
    await savePlanSettings(uid, { enabled: true, deliveryLocalTime: '08:00' }, new Date('2026-10-01T00:00:00.000Z'), { storage });
    const outcome = await claimDueDeliveryOutcome(uid, new Date('2026-10-05T12:00:00.000Z'), { storage });
    assert.equal(outcome.kind, 'claimed');
  } finally {
    resetStorageForTests();
  }
});

/* ── the races inside one operation ──────────────────────────────────── */

for (const step of STEPS) {
  test(`OAuth completion: an account ${step} between the credential and the connection keeps no secret and answers AccountUnavailableError`, async () => {
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    const uid = `w772c-oauthRace-${step}`;
    try {
      await seedLiveAccount(uid, storage);
      const options = encryption();
      const states = new StoredProviderOAuthStateStore(uid, storage, options);
      const vault = new EncryptedProviderCredentialVault(uid, storage, options);
      const base = new StoredIntegrationConnectionStore(uid, storage);
      const begun = await beginProviderOAuth(states, {
        scopeId: uid,
        provider: 'google',
        capabilities: ['calendar_busy_read'] as never,
        requestedScopes: TOKENS.grantedScopes,
        redirectUri: 'https://maybesitter.app/oauth/callback',
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        clientId: 'client-1',
        now: NOW,
      });
      // The deletion lands after the vault stored the token, before the record.
      let credentialStored = false;
      const connections = Object.create(base) as StoredIntegrationConnectionStore;
      connections.upsert = async (input, now) => {
        credentialStored = (await storage.get(userSubDoc(uid, PROVIDER_CREDENTIALS, credentialKeyId('google')))) !== null;
        await deleteAccount(storage, uid, step);
        return base.upsert(input, now);
      };
      const client: ProviderOAuthClient = {
        provider: 'google',
        exchangeAuthorizationCode: async () => TOKENS,
        loadIdentity: async () => ({ provider: 'google', providerAccountId: 'acct-1', displayName: null }) as never,
        revoke: async () => undefined,
      };
      await assert.rejects(completeProviderOAuth(states, vault, connections, client, {
        scopeId: uid, provider: 'google', state: begun.state, code: 'code-1', now: NOW,
      }, new MemoryProviderOAuthCleanupObligations()), AccountUnavailableError);
      assert.equal(credentialStored, true, 'the race was not staged: the credential was never stored');
      const after = await snapshot(storage, uid);
      // The state was spent, the credential taken back, no connection stored.
      assert.deepEqual(Object.keys(after), step === 'swept' ? [] : [userDoc(uid)]);
      assert.ok(!JSON.stringify(after).includes('SECRET'), 'a token survived the refusal');
    } finally {
      resetStorageForTests();
    }
  });

  test(`personalization grant: an account ${step} between the answer and the store write writes no store record and is answered as deleted`, async () => {
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    const uid = `w772c-grantRace-${step}`;
    try {
      await seedLiveAccount(uid, storage);
      const base = createStoragePersonalizationConsentStore(storage);
      let staged = false;
      const racing = {
        read: (scopeId: string) => base.read(scopeId),
        write: base.write.bind(base),
        deleteScope: base.deleteScope.bind(base),
        writeGuarded: async (...args: Parameters<NonNullable<typeof base.writeGuarded>>) => {
          staged = true;
          await deleteAccount(storage, uid, step);
          return base.writeGuarded!(...args);
        },
      };
      await assert.rejects(
        setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date(NOW) }, {
          storage, consent: racing, purgeWait: { attempts: 1, delayMs: 1 },
        }),
        AccountUnavailableError,
      );
      assert.equal(staged, true, 'the race was not staged');
      assert.equal(await storage.get(`${userDoc(uid)}/consents/personalization`), null, 'the store record was written under a deleted account');
      if (step === 'swept') assert.deepEqual(Object.keys(await snapshot(storage, uid)), []);
    } finally {
      resetStorageForTests();
    }
  });
}

/* ── routes answer 403 deleted ───────────────────────────────────────── */

/**
 * The memory adapter with a one-shot hook in front of every write entry
 * (`set`, `delete`, `runTransaction`); reads pass straight through, so
 * authentication sees the live account. The hook runs the deletion step.
 */
function raceable(base: MemoryStorageAdapter): { storage: StorageAdapter; arm(fn: () => Promise<void>): void; fired(): boolean } {
  let pending: (() => Promise<void>) | null = null;
  let didFire = false;
  const writes = new Set(['set', 'delete', 'runTransaction']);
  const storage = new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property === 'string' && writes.has(property)) {
        return async (...args: unknown[]) => {
          if (pending) {
            const deletion = pending;
            pending = null;
            didFire = true;
            await deletion();
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as unknown as StorageAdapter;
  return { storage, arm(fn) { pending = fn; didFire = false; }, fired: () => didFire };
}

function request(method: string, path: string, uid: string, body?: unknown): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('timezone', TZ);
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const ROUTES: ReadonlyArray<readonly [string, (uid: string) => Promise<Response>]> = [
  ['PUT /settings/categories', (uid) => categoriesPut(request('PUT', '/api/mobile/settings/categories', uid, { enabled: ['work'], grouping: true }))],
  ['PUT /settings/plan', (uid) => planSettingsPut(request('PUT', '/api/mobile/settings/plan', uid, { enabled: true, deliveryLocalTime: '08:00' }))],
  ['PUT /settings/calendar', (uid) => calendarSettingsPut(request('PUT', '/api/mobile/settings/calendar', uid, { writeTarget: 'device' }))],
  ['POST /devices', (uid) => devicesPost(request('POST', '/api/mobile/devices', uid, DEVICE))],
  ['PATCH /settings/monitoring', (uid) => monitoringPatch(request('PATCH', '/api/mobile/settings/monitoring', uid, { paused: true }))],
  ['PUT /consents/recommendations', (uid) => recommendationsPut(request('PUT', '/api/mobile/consents/recommendations', uid, {
    state: 'granted', version: RECOMMENDATION_CONSENT_VERSION, locale: 'en', platform: 'ios',
  }))],
];

for (const [name, call] of ROUTES) {
  for (const step of STEPS) {
    test(`${name}: a request in flight when the account is ${step} writes nothing and answers 403 deleted`, async () => {
      let auth: FakeAuthControls | null = installFakeAuth();
      const base = createMemoryStorage();
      const wrapped = raceable(base);
      setStorageForTests(wrapped.storage);
      const uid = uidFor(`w772c${name.replace(/[^A-Za-z0-9]/g, '')}${step}`);
      try {
        // A real first request: authentication creates the trust record.
        assert.equal((await habitsGet(request('GET', '/api/mobile/habits', uid))).status, 200);
        const expected = async () => (step === 'swept' ? {} : snapshot(base, uid));
        let want: Tree = {};
        wrapped.arm(async () => {
          await deleteAccount(base, uid, step);
          want = await expected();
        });
        const response = await call(uid);
        const body = await response.json() as Record<string, unknown>;
        assert.ok(wrapped.fired(), `${name}: the deletion never ran, so the race was not staged`);
        assert.equal(response.status, 403, `${name}: ${JSON.stringify(body)}`);
        assert.equal(body.reason, 'deleted');
        assert.deepEqual(await snapshot(base, uid), want, `${name}: something was written under the deleted account`);
      } finally {
        auth?.restore();
        auth = null;
        resetStorageForTests();
      }
    });
  }
}
