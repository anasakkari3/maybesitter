/**
 * The shared vertical-pack conformance suite (#528, slice 1).
 *
 * One harness, every pack — the issue's list of checks implemented once, as
 * generic assertions over the *real* machinery: the watcher engine, the
 * watcher store, the connection record, the global pause, account deletion
 * and the RevenueCat entitlement projection. A pack supplies its manifest and
 * a provider kind; the harness supplies the signal source, the account, the
 * connection and the clock. Nothing here is written per pack, and a check
 * that cannot fail proves nothing — the deliberately broken packs in
 * `syntheticPackConformance.test.ts` are this suite's own test.
 *
 * Each check runs against a fresh in-memory storage, so a check that writes
 * cannot contaminate the next one, and the account-deletion check cannot
 * leave a deleted account behind for the others to trip over.
 *
 * The harness asserts behavior, never pack internals: what a sweep did, what
 * the runtime recorded, what paths were written. That is what makes it
 * reusable — a real pack (football, athlete, travel) plugs in exactly the
 * same way the synthetic one does, and the retrofit is the follow-up slice.
 */
import {
  createMemoryStorage,
  type MemoryStorageAdapter,
} from '../../lib/storage/memoryAdapter.ts';
import type { StorageAdapter } from '../../lib/storage/index.ts';
import {
  PLANNING_STATE_CHANGES,
  PROVIDER_CONNECTIONS,
  userDoc,
  userSubDoc,
  WATCHER_EVENTS,
  WATCHER_NOTIFICATIONS,
  WATCHER_PROPOSALS,
  WATCHERS,
} from '../../lib/storage/paths.ts';
import { createWatcherStore, type StoredWatcher } from '../../lib/watchers/watcherStore.ts';
import { runWatcherSweep } from '../../lib/watchers/watcherEngine.ts';
import { saveMonitoringSettings } from '../../lib/watchers/monitoringSettings.ts';
import {
  createWatcherSignalRegistry,
  type WatcherSignalObserver,
  type WatcherSignalRegistry,
} from '../../lib/watchers/signals.ts';
import { deleteAccount, type DeletionAuthAdmin } from '../../lib/account/accountDeletion.ts';
import { resetDeletionHooksForTests } from '../../lib/account/deletionHooks.ts';
import { decidePackEntitlement } from '../../lib/packs/packEntitlement.ts';
import { instantiateWatcherTemplate } from '../../lib/packs/instantiate.ts';
import { projectRevenueCatEntitlements } from '../../lib/integrations/revenuecat/entitlements.ts';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts.ts';
import {
  WATCHER_SIGNAL_SCHEMA_VERSION,
  type PlanningStateChange,
  type WatcherFireEvent,
} from '../../src/contracts/v1/watcherContracts.ts';
import {
  validateVerticalPackDefinition,
  type VerticalPackDefinition,
  type WatcherTemplate,
} from '../../src/contracts/v1/verticalPackContracts.ts';

export interface PackConformanceFixture {
  readonly pack: VerticalPackDefinition;
  /** The provider the pack's connections are made of. */
  readonly provider: string;
  readonly subjectRef?: string;
  readonly connectionId?: string;
  /**
   * A pack whose observer does something other than observe supplies its own.
   * The canonical-write check exists precisely to catch that pack.
   */
  readonly observerOverride?: (deps: { storage: StorageAdapter; signalKind: string; state: SignalState }) => WatcherSignalObserver;
}

export interface PackConformanceResult {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface PackConformanceReport {
  readonly packId: string;
  readonly results: readonly PackConformanceResult[];
  readonly passed: boolean;
}

const UID = 'pack_conformance_user_00001';
const T0 = Date.parse('2026-09-21T09:00:00.000Z');
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);
const atIso = (minutes: number): string => at(minutes).toISOString();

const DELETION_PEPPER = 'pack-conformance-pepper';

function fakeAuth(): DeletionAuthAdmin {
  return { async revokeRefreshTokens() {}, async deleteUser() {} };
}

/** The harness-owned signal: what the provider "currently shows". */
export interface SignalState {
  digest: string;
}

/**
 * The generic observer every conforming pack gets: it reads the harness-owned
 * signal state and projects it into a `WatcherSignal`, exactly the shape a
 * real adapter produces — a digest, a provenance pointer, no payload.
 */
function genericObserver(
  fixture: PackConformanceFixture,
  signalKind: string,
  state: SignalState,
): WatcherSignalObserver {
  return {
    supports: (source) => source.provider === fixture.provider && source.signalKind === signalKind,
    async observe(source, context) {
      return {
        schemaVersion: WATCHER_SIGNAL_SCHEMA_VERSION,
        signalId: `${signalKind}:${source.subjectRef}:${state.digest}`,
        provider: source.provider,
        signalKind,
        subjectRef: source.subjectRef,
        observedAt: context.now,
        stateDigest: state.digest,
        provenanceRef: `pack-conformance/${fixture.pack.packId}/${source.subjectRef}`,
        measures: [],
      };
    },
  };
}

interface Rig {
  storage: MemoryStorageAdapter;
  registry: WatcherSignalRegistry;
  state: SignalState;
  watcherId: string;
  connectionId: string | null;
}

function connectionRecord(
  fixture: PackConformanceFixture,
  connectionId: string,
  state: IntegrationConnectionRecord['state'],
): IntegrationConnectionRecord {
  return {
    version: 'v1',
    schemaVersion: 'integration-connection-v1',
    connectionId,
    scopeId: UID,
    identity: { provider: fixture.provider, providerAccountId: 'pacct_1', providerSpaceId: null, displayName: null },
    state,
    capabilities: [...fixture.pack.requiredCapabilities, ...fixture.pack.optionalCapabilities],
    grantedScopes: [],
    connectedAt: atIso(0),
    lastSyncedAt: null,
    expiresAt: null,
    revokedAt: state === 'revoked' ? atIso(0) : null,
    updatedAt: atIso(0),
  };
}

/**
 * A watcher installed from one of the pack's own templates, through the real
 * instantiation path and the real store, with a connection when the template
 * requires one.
 */
async function provision(
  fixture: PackConformanceFixture,
  template: WatcherTemplate,
  options: { connectionState?: IntegrationConnectionRecord['state']; withConnection?: boolean } = {},
): Promise<Rig> {
  const storage = createMemoryStorage();
  await storage.set(userDoc(UID), { uid: UID });

  const connectionId = fixture.connectionId ?? 'conn_conformance';
  const wantsConnection = options.withConnection ?? template.requiresConnection;
  if (wantsConnection) {
    await storage.set(
      userSubDoc(UID, PROVIDER_CONNECTIONS, connectionId),
      connectionRecord(fixture, connectionId, options.connectionState ?? 'connected'),
    );
  }

  const state: SignalState = { digest: 'digest-1' };
  const observer = fixture.observerOverride
    ? fixture.observerOverride({ storage, signalKind: template.signalKind, state })
    : genericObserver(fixture, template.signalKind, state);
  const registry = createWatcherSignalRegistry([observer]);

  const input = instantiateWatcherTemplate({
    pack: fixture.pack,
    templateId: template.templateId,
    provider: fixture.provider,
    connectionId: wantsConnection ? connectionId : null,
    subjectRef: fixture.subjectRef ?? 'subject_1',
  });
  const stored = await createWatcherStore(UID, storage).create(input, atIso(0));
  return { storage, registry, state, watcherId: stored.definition.watcherId, connectionId: wantsConnection ? connectionId : null };
}

async function sweep(rig: Rig, minutes: number) {
  return runWatcherSweep({ storage: rig.storage, now: at(minutes), registry: rig.registry });
}

async function watcher(rig: Rig): Promise<StoredWatcher> {
  const stored = await createWatcherStore(UID, rig.storage).get(rig.watcherId);
  if (!stored) throw new Error('watcher vanished between checks');
  return stored;
}

async function fireEvents(rig: Rig): Promise<readonly WatcherFireEvent[]> {
  const rows = await rig.storage.listGroup<WatcherFireEvent>(WATCHER_EVENTS);
  return rows.map((row) => row.data).filter((event) => event.watcherId === rig.watcherId);
}

function result(check: string, ok: boolean, detail: string): PackConformanceResult {
  return { check, ok, detail };
}

/* ── The checks ──────────────────────────────────────────────────── */

type Check = (fixture: PackConformanceFixture) => Promise<PackConformanceResult>;

/** Every template's manifest-level validity, as one check over the pack. */
const manifestValid: Check = async (fixture) => {
  const problems = validateVerticalPackDefinition(fixture.pack);
  return problems.length === 0
    ? result('manifest_valid', true, 'the manifest validates')
    : result('manifest_valid', false, problems.join(', '));
};

/** A granted connection carries every capability the pack says it needs. */
const capabilityAvailability: Check = async (fixture) => {
  const template = fixture.pack.watcherTemplates.find((entry) => entry.requiresConnection);
  if (!template) {
    if (fixture.pack.requiredCapabilities.length > 0) {
      return result('capability_availability', false, 'the pack declares required capabilities but has no connection-requiring templates');
    }
    return result('capability_availability', true, 'the pack requires no connection, so requires no capabilities');
  }
  const rig = await provision(fixture, template, { withConnection: true });
  if (rig.connectionId === null) return result('capability_availability', false, 'no connection was provisioned');
  const record = await rig.storage.get<IntegrationConnectionRecord>(
    userSubDoc(UID, PROVIDER_CONNECTIONS, rig.connectionId),
  );
  const granted = new Set(record?.capabilities ?? []);
  const missing = fixture.pack.requiredCapabilities.filter((capability) => !granted.has(capability));
  if (missing.length > 0) {
    return result('capability_availability', false, `connection lacks required capabilities: ${missing.join(', ')}`);
  }
  // The functional half: with its capabilities granted, the pack's watcher
  // actually reaches active and fires on a real change.
  await sweep(rig, 1); // absorb the baseline
  rig.state.digest = 'digest-2';
  const totals = await sweep(rig, 2);
  return totals.fired === 1
    ? result('capability_availability', true, 'granted capabilities serve the pack; a change fired')
    : result('capability_availability', false, `expected one firing, got ${JSON.stringify(totals)}`);
};

/** A connected watcher whose connection is revoked stops firing. */
const providerDisconnected: Check = async (fixture) => {
  const template = fixture.pack.watcherTemplates.find((entry) => entry.requiresConnection);
  if (!template) return result('provider_disconnected', false, 'no connection-requiring template to exercise');
  const rig = await provision(fixture, template, { connectionState: 'revoked' });
  await sweep(rig, 1);
  rig.state.digest = 'digest-2';
  const totals = await sweep(rig, 2);
  const stored = await watcher(rig);
  const ok = totals.fired === 0
    && stored.runtime.status === 'blocked'
    && stored.runtime.blockedReason === 'provider_disconnected';
  return result('provider_disconnected', ok,
    ok ? 'revoked connection blocked the watcher' : `fired=${totals.fired} status=${stored.runtime.status}/${stored.runtime.blockedReason}`);
};

/** A narrowed grant is a re-auth request, not a running watcher. */
const permissionLimited: Check = async (fixture) => {
  const template = fixture.pack.watcherTemplates.find((entry) => entry.requiresConnection);
  if (!template) return result('permission_limited', false, 'no connection-requiring template to exercise');
  const rig = await provision(fixture, template, { connectionState: 'permission_limited' });
  await sweep(rig, 1);
  rig.state.digest = 'digest-2';
  const totals = await sweep(rig, 2);
  const stored = await watcher(rig);
  const ok = totals.fired === 0
    && stored.runtime.status === 'blocked'
    && stored.runtime.blockedReason === 'provider_needs_reauth';
  return result('permission_limited', ok,
    ok ? 'permission_limited reads as needs_reauth' : `fired=${totals.fired} status=${stored.runtime.status}/${stored.runtime.blockedReason}`);
};

/** The connection document going away mid-flight stops firing just the same. */
const revoke: Check = async (fixture) => {
  const template = fixture.pack.watcherTemplates.find((entry) => entry.requiresConnection);
  if (!template) return result('revoke', false, 'no connection-requiring template to exercise');
  const rig = await provision(fixture, template);
  await sweep(rig, 1);
  rig.state.digest = 'digest-2';
  const before = await sweep(rig, 2);
  if (before.fired !== 1) return result('revoke', false, 'the watcher never fired while connected; the check proves nothing');
  if (rig.connectionId === null) return result('revoke', false, 'no connection was provisioned');
  await rig.storage.delete(userSubDoc(UID, PROVIDER_CONNECTIONS, rig.connectionId));
  rig.state.digest = 'digest-3';
  const after = await sweep(rig, 3);
  const stored = await watcher(rig);
  const ok = after.fired === 0 && stored.runtime.status === 'blocked';
  return result('revoke', ok,
    ok ? 'removing the connection document stopped firing' : `fired after revoke: ${after.fired}`);
};

/** The same signal, delivered repeatedly, fires at most once per real change. */
const staleAndDuplicateSignal: Check = async (fixture) => {
  const template = fixture.pack.watcherTemplates[0];
  if (!template) return result('stale_and_duplicate_signal', false, 'the pack declares no watcher templates');
  const rig = await provision(fixture, template);
  await sweep(rig, 1); // prime
  const stale = await sweep(rig, 2); // nothing changed
  rig.state.digest = 'digest-2';
  const fired = await sweep(rig, 3);
  const redelivery = await sweep(rig, 4); // the same change, delivered again
  const events = await fireEvents(rig);
  const stored = await watcher(rig);
  const ok = stale.fired === 0 && fired.fired === 1 && redelivery.fired === 0
    && events.length === 1 && stored.runtime.fireCount === 1;
  return result('stale_and_duplicate_signal', ok,
    ok ? 'one change, one firing; stale and redelivered signals are absorbed'
      : `stale=${stale.fired} fired=${fired.fired} redelivery=${redelivery.fired} events=${events.length}`);
};

/** The global pause switch silences the pack's watchers without deleting them. */
const userPause: Check = async (fixture) => {
  const template = fixture.pack.watcherTemplates[0];
  if (!template) return result('user_pause', false, 'the pack declares no watcher templates');
  const rig = await provision(fixture, template);
  await sweep(rig, 1);
  await saveMonitoringSettings(UID, true, atIso(2), { storage: rig.storage });
  rig.state.digest = 'digest-2';
  const paused = await sweep(rig, 3);
  const events = await fireEvents(rig);
  const stored = await watcher(rig);
  const ok = paused.fired === 0 && events.length === 0 && stored.runtime.fireCount === 0;
  return result('user_pause', ok,
    ok ? 'paused monitoring fired nothing and recorded nothing'
      : `fired=${paused.fired} events=${events.length} fireCount=${stored.runtime.fireCount}`);
};

/** Entitlement loss denies the gate and destroys nothing. */
const entitlementLoss: Check = async (fixture) => {
  const key = fixture.pack.entitlementKey;
  if (key === null) {
    const decision = decidePackEntitlement(fixture.pack, null, atIso(1));
    const ok = decision.allowed && decision.reason === 'free_feature';
    return result('entitlement_loss', ok, ok ? 'free pack: no entitlement to lose' : `unexpected: ${decision.reason}`);
  }
  const active = projectRevenueCatEntitlements({
    scopeId: UID,
    fetchedAt: atIso(1),
    now: atIso(1),
    entitlements: [{ entitlementId: key, isActive: true, expiresAt: null, willRenew: true, billingIssueDetectedAt: null, verification: 'verified' }],
  });
  const lost = projectRevenueCatEntitlements({
    scopeId: UID,
    fetchedAt: atIso(1),
    now: atIso(1),
    entitlements: [{ entitlementId: key, isActive: false, expiresAt: null, willRenew: false, billingIssueDetectedAt: null, verification: 'verified' }],
  });
  const whileActive = decidePackEntitlement(fixture.pack, active, atIso(2));
  const afterLoss = decidePackEntitlement(fixture.pack, lost, atIso(2));
  const missing = decidePackEntitlement(fixture.pack, null, atIso(2));
  const ok = whileActive.allowed
    && !afterLoss.allowed && afterLoss.reason === 'entitlement_missing_or_inactive'
    && !missing.allowed && missing.reason === 'projection_missing';
  return result('entitlement_loss', ok,
    ok ? 'active grants, loss denies, a missing projection denies'
      : `active=${whileActive.allowed} lost=${afterLoss.allowed}/${afterLoss.reason} missing=${missing.allowed}/${missing.reason}`);
};

/** Deleting the account deletes the pack's watchers and stops the sweep. */
const accountDeletion: Check = async (fixture) => {
  const template = fixture.pack.watcherTemplates[0];
  if (!template) return result('account_deletion', false, 'the pack declares no watcher templates');
  process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = DELETION_PEPPER;
  resetDeletionHooksForTests();
  try {
    const rig = await provision(fixture, template);
    await sweep(rig, 1);
    rig.state.digest = 'digest-2';
    const fired = await sweep(rig, 2);
    if (fired.fired !== 1) return result('account_deletion', false, 'the watcher never fired; the check proves nothing');

    await deleteAccount(UID, { initiatedBy: 'user', storage: rig.storage, auth: fakeAuth() });

    const remaining = (await rig.storage.listGroup(WATCHERS)).filter((row) => row.path.startsWith(`${userDoc(UID)}/`));
    const events = await fireEvents(rig);
    const after = await sweep(rig, 3);
    const ok = remaining.length === 0 && events.length === 0 && after.scanned === 0;
    return result('account_deletion', ok,
      ok ? 'the deleted account keeps no watchers, no history, and is swept no more'
        : `watchers=${remaining.length} events=${events.length} scanned=${after.scanned}`);
  } finally {
    resetDeletionHooksForTests();
    delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
  }
};

/* Canonical collections a firing must never touch. */
const CANONICAL_COLLECTIONS = ['commitments', 'events', 'plans'] as const;

/* Contract-declared field sets; a firing artifact with any other key is carrying something the contract never blessed. */
const ARTIFACT_KEYS: Readonly<Record<string, readonly string[]>> = {
  [PLANNING_STATE_CHANGES]: ['schemaVersion', 'changeId', 'scopeId', 'source', 'entityId', 'occurredAt', 'changedFields', 'beforeDigest', 'afterDigest', 'provenanceRef'],
  [WATCHER_PROPOSALS]: ['schemaVersion', 'proposalId', 'watcherId', 'scopeId', 'state', 'signalKind', 'subjectRef', 'reason', 'proposedAt', 'provenanceRef'],
  [WATCHER_NOTIFICATIONS]: ['schemaVersion', 'notificationId', 'watcherId', 'scopeId', 'state', 'signalKind', 'subjectRef', 'reason', 'queuedAt', 'provenanceRef'],
};

/* The names a provider-payload field would plausibly have. */
const CONTENT_KEY_NAMES = ['payload', 'rawBody', 'providerResponse', 'title', 'body', 'description', 'text'];

/**
 * Every effect the pack declares is fired for real, and everything the
 * firing wrote stays inside the watcher pipeline's own collections — no
 * canonical write without confirmation, and no provider-shaped value in any
 * artifact the planner consumes.
 */
const firingArtifactsStayInThePipeline: Check = async (fixture) => {
  const storage = createMemoryStorage();
  await storage.set(userDoc(UID), { uid: UID });
  const state: SignalState = { digest: 'digest-1' };
  const connectionId = fixture.connectionId ?? 'conn_conformance';
  let connectionSeeded = false;

  const store = createWatcherStore(UID, storage);
  const watchers: string[] = [];
  for (const template of fixture.pack.watcherTemplates) {
    if (template.requiresConnection && !connectionSeeded) {
      await storage.set(userSubDoc(UID, PROVIDER_CONNECTIONS, connectionId), connectionRecord(fixture, connectionId, 'connected'));
      connectionSeeded = true;
    }
    const input = instantiateWatcherTemplate({
      pack: fixture.pack,
      templateId: template.templateId,
      provider: fixture.provider,
      connectionId: template.requiresConnection ? connectionId : null,
      subjectRef: fixture.subjectRef ?? 'subject_1',
    });
    watchers.push((await store.create(input, atIso(0))).definition.watcherId);
  }

  const observers: WatcherSignalObserver[] = fixture.pack.watcherTemplates.map((template) =>
    fixture.observerOverride
      ? fixture.observerOverride({ storage, signalKind: template.signalKind, state })
      : genericObserver(fixture, template.signalKind, state));
  const rig: Rig = { storage, registry: createWatcherSignalRegistry(observers), state, watcherId: watchers[0] ?? '', connectionId: null };

  await sweep(rig, 1); // prime everything
  rig.state.digest = 'digest-2';
  const fired = await sweep(rig, 2);
  if (fired.fired !== watchers.length) {
    return result('no_canonical_write_before_confirmation', false,
      `expected ${watchers.length} firings (one per template), got ${fired.fired}; the artifact assertions would prove nothing`);
  }

  const problems: string[] = [];
  for (const path of storage.pathsForTests()) {
    for (const collection of CANONICAL_COLLECTIONS) {
      if (path.includes(`/${collection}/`)) problems.push(`canonical write: ${path}`);
    }
  }

  for (const [collection, allowedKeys] of Object.entries(ARTIFACT_KEYS)) {
    const rows = await storage.listGroup<Record<string, unknown>>(collection);
    for (const row of rows) {
      for (const key of Object.keys(row.data)) {
        if (!allowedKeys.includes(key)) problems.push(`${collection} artifact carries undeclared field '${key}'`);
        if (CONTENT_KEY_NAMES.some((name) => name.toLowerCase() === key.toLowerCase())) {
          problems.push(`${collection} artifact carries content-shaped field '${key}'`);
        }
      }
    }
  }

  // The planner-facing artifacts exist and are the normalized shape #523
  // consumes: digests are strings, changedFields a string list, and no field
  // carries provider vocabulary.
  const stateChanges = await storage.listGroup<PlanningStateChange>(PLANNING_STATE_CHANGES);
  for (const row of stateChanges) {
    if (typeof row.data.afterDigest !== 'string' || row.data.afterDigest.length === 0) {
      problems.push(`state change ${row.data.changeId} has no afterDigest`);
    }
    if (!Array.isArray(row.data.changedFields)) {
      problems.push(`state change ${row.data.changeId} changedFields is not a list`);
    }
  }

  const artifactCheck = problems.length === 0;
  return result('no_canonical_write_before_confirmation', artifactCheck,
    artifactCheck ? `${fired.fired} firings; every artifact stayed inside the pipeline` : problems.join('; '));
};

/** The planner-consumed contracts saw nothing provider-specific. */
const noProviderValueReachesPlanner: Check = async (fixture) => {
  // The artifacts check above already scans the written documents; this check
  // is the other direction — the change the planner consumes names only
  // normalized sources, so a provider branch downstream has nothing to key on.
  const template = fixture.pack.watcherTemplates.find((entry) => entry.effect === 'replan_if_impacted');
  if (!template) {
    return result('no_provider_specific_value_reaches_planner', true,
      'the pack declares no replan effect, so it can produce no planner input at all');
  }
  const rig = await provision(fixture, template);
  await sweep(rig, 1);
  rig.state.digest = 'digest-2';
  await sweep(rig, 2);

  const rows = await rig.storage.listGroup<PlanningStateChange>(PLANNING_STATE_CHANGES);
  const sources = new Set(rows.map((row) => row.data.source));
  const providerNames = rows.filter((row) =>
    CONTENT_KEY_NAMES.some((name) => JSON.stringify(row.data).toLowerCase().includes(`"${name}"`)));
  const ok = rows.length > 0
    && Array.from(sources).every((source) => !source.includes(fixture.provider))
    && providerNames.length === 0;
  return result('no_provider_specific_value_reaches_planner', ok,
    ok ? `${rows.length} state change(s), all normalized (sources: ${Array.from(sources).join(', ') || 'none'})`
      : 'a planner-consumed artifact carries provider-shaped content');
};

const CHECKS: readonly { name: string; run: Check }[] = [
  { name: 'manifest_valid', run: manifestValid },
  { name: 'capability_availability', run: capabilityAvailability },
  { name: 'provider_disconnected', run: providerDisconnected },
  { name: 'permission_limited', run: permissionLimited },
  { name: 'stale_and_duplicate_signal', run: staleAndDuplicateSignal },
  { name: 'revoke', run: revoke },
  { name: 'user_pause', run: userPause },
  { name: 'entitlement_loss', run: entitlementLoss },
  { name: 'account_deletion', run: accountDeletion },
  { name: 'no_canonical_write_before_confirmation', run: firingArtifactsStayInThePipeline },
  { name: 'no_provider_specific_value_reaches_planner', run: noProviderValueReachesPlanner },
];

/**
 * Runs the whole conformance list against one pack. A check that throws is a
 * failed check, not a crashed suite — the report should list everything wrong
 * with a pack, not the first thing.
 */
export async function runPackConformance(fixture: PackConformanceFixture): Promise<PackConformanceReport> {
  const results: PackConformanceResult[] = [];
  for (const { name, run } of CHECKS) {
    try {
      results.push(await run(fixture));
    } catch (error) {
      results.push(result(name, false, error instanceof Error ? error.message : String(error)));
    }
  }
  return {
    packId: fixture.pack.packId,
    results: Object.freeze(results),
    passed: results.every((entry) => entry.ok),
  };
}
