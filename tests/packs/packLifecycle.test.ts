/**
 * The pack rollout mechanism, proven behaviourally (#528, slice 2).
 *
 * Every assertion in this file is about what a *sweep* did, not about what
 * `disablePack` returned: "the pack is off" is only true if the real engine,
 * reading the real store, produces no effect from that pack's watchers. A
 * mechanism whose proof is its own return value proves nothing, and the two
 * facts the issue actually cares about — the shared connection survives, and
 * nothing is deleted — are invisible from a return value.
 *
 * Two packs run side by side throughout, over one shared provider connection,
 * because every interesting failure of this mechanism is a failure of
 * *containment*: disabling one pack silencing the other, or corrupting the
 * grant they both read through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import {
  PROVIDER_CONNECTIONS,
  userDoc,
  userSubDoc,
  WATCHER_EVENTS,
  WATCHERS,
} from '../../lib/storage/paths.ts';
import { createWatcherStore, type StoredWatcher } from '../../lib/watchers/watcherStore.ts';
import { runWatcherSweep } from '../../lib/watchers/watcherEngine.ts';
import {
  createWatcherSignalRegistry,
  type WatcherSignalObserver,
  type WatcherSignalRegistry,
} from '../../lib/watchers/signals.ts';
import { projectRevenueCatEntitlements } from '../../lib/integrations/revenuecat/entitlements.ts';
import {
  applyPackEntitlement,
  disablePack,
  enablePack,
  readPackInstallation,
  listPackInstallations,
} from '../../lib/packs/packLifecycle.ts';
import { ATHLETE_PACK, FOOTBALL_PACK, TRAVEL_PACK } from '../../lib/packs/catalog.ts';
import {
  WATCHER_SIGNAL_SCHEMA_VERSION,
  type WatcherFireEvent,
} from '../../src/contracts/v1/watcherContracts.ts';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts.ts';
import type { VerticalPackDefinition } from '../../src/contracts/v1/verticalPackContracts.ts';

const UID = 'pack_lifecycle_user_00001';
const CONNECTION_ID = 'conn_shared';
const T0 = Date.parse('2026-09-22T09:00:00.000Z');
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);
const atIso = (minutes: number): string => at(minutes).toISOString();

/** One mutable digest per signal kind — "what the provider currently shows". */
type SignalState = Map<string, string>;

function observerFor(signalKind: string, state: SignalState): WatcherSignalObserver {
  return {
    supports: (source) => source.signalKind === signalKind,
    async observe(source, context) {
      const digest = state.get(signalKind) ?? 'digest-1';
      return {
        schemaVersion: WATCHER_SIGNAL_SCHEMA_VERSION,
        signalId: `${signalKind}:${source.subjectRef}:${digest}`,
        provider: source.provider,
        signalKind,
        subjectRef: source.subjectRef,
        observedAt: context.now,
        stateDigest: digest,
        provenanceRef: `pack-lifecycle/${signalKind}`,
        measures: [],
      };
    },
  };
}

function connectionRecord(): IntegrationConnectionRecord {
  return {
    version: 'v1',
    schemaVersion: 'integration-connection-v1',
    connectionId: CONNECTION_ID,
    scopeId: UID,
    identity: { provider: 'whoop', providerAccountId: 'pacct_1', providerSpaceId: null, displayName: null },
    state: 'connected',
    capabilities: ['readiness_read', 'mail_read', 'calendar_busy'],
    grantedScopes: [],
    connectedAt: atIso(0),
    lastSyncedAt: null,
    expiresAt: null,
    revokedAt: null,
    updatedAt: atIso(0),
  };
}

interface Rig {
  storage: MemoryStorageAdapter;
  registry: WatcherSignalRegistry;
  state: SignalState;
}

const PROVIDERS: Readonly<Record<string, string>> = {
  football: 'football_data',
  athlete: 'whoop',
  travel: 'aviation',
};

/** Every signal kind any catalog pack names, each with its own observer. */
function buildRig(): Rig {
  const storage = createMemoryStorage();
  const state: SignalState = new Map();
  const kinds = new Set(
    [FOOTBALL_PACK, ATHLETE_PACK, TRAVEL_PACK].flatMap((pack) =>
      pack.watcherTemplates.map((template) => template.signalKind)),
  );
  const registry = createWatcherSignalRegistry(
    Array.from(kinds).map((kind) => observerFor(kind, state)),
  );
  return { storage, registry, state };
}

async function seed(rig: Rig): Promise<void> {
  await rig.storage.set(userDoc(UID), { uid: UID });
  await rig.storage.set(userSubDoc(UID, PROVIDER_CONNECTIONS, CONNECTION_ID), connectionRecord());
}

function subjectsFor(pack: VerticalPackDefinition): Record<string, string> {
  return Object.fromEntries(pack.watcherTemplates.map((template) => [template.templateId, `${pack.packId}_subject`]));
}

async function turnOn(rig: Rig, pack: VerticalPackDefinition, minutes: number, entitlement = activeFor(pack)) {
  return enablePack({
    pack,
    scopeId: UID,
    provider: PROVIDERS[pack.packId]!,
    connectionId: CONNECTION_ID,
    subjects: subjectsFor(pack),
    entitlement,
    now: atIso(minutes),
    storage: rig.storage,
  });
}

function projectionFor(pack: VerticalPackDefinition, isActive: boolean) {
  if (pack.entitlementKey === null) return null;
  return projectRevenueCatEntitlements({
    scopeId: UID,
    fetchedAt: atIso(0),
    now: atIso(0),
    entitlements: [{
      entitlementId: pack.entitlementKey,
      isActive,
      expiresAt: null,
      willRenew: isActive,
      billingIssueDetectedAt: null,
      verification: 'verified',
    }],
  });
}

const activeFor = (pack: VerticalPackDefinition) => projectionFor(pack, true);
const lapsedFor = (pack: VerticalPackDefinition) => projectionFor(pack, false);

async function sweep(rig: Rig, minutes: number) {
  return runWatcherSweep({ storage: rig.storage, now: at(minutes), registry: rig.registry });
}

/** Move every signal kind on, so a sweep sees a real change everywhere. */
function moveSignals(rig: Rig, digest: string): void {
  for (const kind of ['fixture', 'readiness', 'flight', 'itinerary']) rig.state.set(kind, digest);
}

async function eventsFor(rig: Rig, watcherIds: readonly string[]): Promise<readonly WatcherFireEvent[]> {
  const rows = await rig.storage.listGroup<WatcherFireEvent>(WATCHER_EVENTS);
  return rows.map((row) => row.data).filter((event) => watcherIds.includes(event.watcherId));
}

async function watchersOf(rig: Rig, watcherIds: readonly string[]): Promise<readonly StoredWatcher[]> {
  const store = createWatcherStore(UID, rig.storage);
  const found: StoredWatcher[] = [];
  for (const watcherId of watcherIds) {
    const stored = await store.get(watcherId);
    if (stored) found.push(stored);
  }
  return found;
}

/* ── The headline: one pack off, the other still running ─────────── */

test('disabling a pack stops its watchers while another pack keeps firing, and the shared connection is untouched', async () => {
  const rig = buildRig();
  await seed(rig);
  const connectionBefore = JSON.stringify(
    await rig.storage.get(userSubDoc(UID, PROVIDER_CONNECTIONS, CONNECTION_ID)),
  );

  const football = await turnOn(rig, FOOTBALL_PACK, 0);
  const travel = await turnOn(rig, TRAVEL_PACK, 0);
  assert.equal(football.state, 'enabled');
  assert.equal(travel.state, 'enabled');

  moveSignals(rig, 'digest-1');
  await sweep(rig, 1); // prime every watcher
  moveSignals(rig, 'digest-2');
  const both = await sweep(rig, 2);
  assert.equal(
    both.fired,
    football.watcherIds.length + travel.watcherIds.length,
    'the packs did not both fire while enabled, so the disable below would prove nothing',
  );

  const off = await disablePack({ scopeId: UID, packId: FOOTBALL_PACK.packId, now: atIso(3), storage: rig.storage });
  assert.equal(off.state, 'disabled');
  assert.deepEqual([...off.changedWatcherIds].sort(), [...football.watcherIds].sort());

  const footballEventsBefore = (await eventsFor(rig, football.watcherIds)).length;
  moveSignals(rig, 'digest-3');
  const after = await sweep(rig, 4);

  assert.equal(
    (await eventsFor(rig, football.watcherIds)).length,
    footballEventsBefore,
    'a disabled pack produced an effect',
  );
  assert.equal(
    after.fired,
    travel.watcherIds.length,
    `only travel should have fired after football was disabled: ${JSON.stringify(after)}`,
  );
  for (const stored of await watchersOf(rig, football.watcherIds)) {
    assert.equal(stored.definition.enabled, false);
    assert.equal(stored.runtime.status, 'paused');
  }
  for (const stored of await watchersOf(rig, travel.watcherIds)) {
    assert.equal(stored.definition.enabled, true, 'disabling football touched travel');
  }

  assert.equal(
    JSON.stringify(await rig.storage.get(userSubDoc(UID, PROVIDER_CONNECTIONS, CONNECTION_ID))),
    connectionBefore,
    'disabling a pack changed the shared provider connection record',
  );
});

/* ── Disabling deletes nothing ───────────────────────────────────── */

test('disabling a pack deletes no watcher, no history and no unrelated user data', async () => {
  const rig = buildRig();
  await seed(rig);
  await rig.storage.set(userSubDoc(UID, 'commitments', 'cmt_unrelated'), { uid: UID, id: 'cmt_unrelated' });

  const football = await turnOn(rig, FOOTBALL_PACK, 0);
  moveSignals(rig, 'digest-1');
  await sweep(rig, 1);
  moveSignals(rig, 'digest-2');
  await sweep(rig, 2);

  const before = await watchersOf(rig, football.watcherIds);
  assert.equal(before.length, football.watcherIds.length);
  const firedCounts = before.map((stored) => stored.runtime.fireCount);
  assert.ok(firedCounts.every((count) => count === 1), `the pack never fired: ${firedCounts.join(',')}`);
  const historyBefore = (await eventsFor(rig, football.watcherIds)).length;
  assert.ok(historyBefore > 0);

  await disablePack({ scopeId: UID, packId: FOOTBALL_PACK.packId, now: atIso(3), storage: rig.storage });

  const after = await watchersOf(rig, football.watcherIds);
  assert.equal(after.length, football.watcherIds.length, 'a disabled pack lost a watcher document');
  assert.deepEqual(after.map((stored) => stored.runtime.fireCount), firedCounts, 'a disable reset a runtime baseline');
  assert.equal((await eventsFor(rig, football.watcherIds)).length, historyBefore, 'a disable deleted firing history');
  assert.deepEqual(
    await rig.storage.get(userSubDoc(UID, 'commitments', 'cmt_unrelated')),
    { uid: UID, id: 'cmt_unrelated' },
    'a disable reached outside the pack',
  );

  const record = await readPackInstallation(UID, FOOTBALL_PACK.packId, { storage: rig.storage });
  assert.ok(record);
  assert.equal(record.state, 'disabled');
  assert.equal(record.reason, 'user_disabled');
  assert.deepEqual([...record.watcherIds].sort(), [...football.watcherIds].sort(), 'the pack forgot what it owns');
});

test('re-enabling a pack resumes the same watchers rather than installing a second copy', async () => {
  const rig = buildRig();
  await seed(rig);
  const first = await turnOn(rig, FOOTBALL_PACK, 0);
  moveSignals(rig, 'digest-1');
  await sweep(rig, 1);
  await disablePack({ scopeId: UID, packId: FOOTBALL_PACK.packId, now: atIso(2), storage: rig.storage });
  moveSignals(rig, 'digest-2');
  await sweep(rig, 3); // the pack is off; the engine records it as paused

  const again = await turnOn(rig, FOOTBALL_PACK, 3);
  assert.equal(again.state, 'enabled');
  assert.deepEqual(again.watcherIds, first.watcherIds, 're-enabling minted new watchers');

  const all = (await rig.storage.listGroup<StoredWatcher>(WATCHERS))
    .filter((row) => row.path.startsWith(`${userDoc(UID)}/`));
  assert.equal(all.length, first.watcherIds.length, 're-enabling left a duplicate watcher behind');

  moveSignals(rig, 'digest-4');
  await sweep(rig, 4); // entering active primes; history is absorbed, not replayed
  assert.equal((await eventsFor(rig, first.watcherIds)).length, 0, 'resuming replayed what happened while off');
  moveSignals(rig, 'digest-5');
  const resumed = await sweep(rig, 5);
  assert.equal(resumed.fired, first.watcherIds.length, 'a resumed pack did not fire on a real change');
});

/* ── Entitlement loss preserves data and disables premium behaviour ─ */

test('entitlement loss disables the pack and preserves everything it owns; regaining it resumes', async () => {
  const rig = buildRig();
  await seed(rig);

  const athlete = await turnOn(rig, ATHLETE_PACK, 0, activeFor(ATHLETE_PACK));
  assert.equal(athlete.state, 'enabled');
  moveSignals(rig, 'digest-1');
  await sweep(rig, 1);
  moveSignals(rig, 'digest-2');
  const live = await sweep(rig, 2);
  assert.equal(live.fired, athlete.watcherIds.length, 'the premium pack never worked, so losing it proves nothing');
  const historyBefore = (await eventsFor(rig, athlete.watcherIds)).length;
  const runtimeBefore = (await watchersOf(rig, athlete.watcherIds)).map((stored) => stored.runtime.fireCount);

  const lost = await applyPackEntitlement({
    pack: ATHLETE_PACK,
    scopeId: UID,
    entitlement: lapsedFor(ATHLETE_PACK),
    now: atIso(3),
    storage: rig.storage,
  });
  assert.equal(lost.state, 'disabled');
  assert.equal(lost.reason, 'entitlement_lost');
  assert.equal(lost.decision?.allowed, false);
  assert.equal(lost.decision?.reason, 'entitlement_missing_or_inactive');

  // Premium behaviour stopped…
  moveSignals(rig, 'digest-3');
  const afterLoss = await sweep(rig, 4);
  assert.equal(afterLoss.fired, 0, 'a pack whose entitlement lapsed still produced effects');

  // …and nothing was destroyed.
  const surviving = await watchersOf(rig, athlete.watcherIds);
  assert.equal(surviving.length, athlete.watcherIds.length, 'entitlement loss deleted the pack’s watchers');
  assert.deepEqual(surviving.map((stored) => stored.runtime.fireCount), runtimeBefore, 'entitlement loss reset a baseline');
  assert.equal((await eventsFor(rig, athlete.watcherIds)).length, historyBefore, 'entitlement loss deleted firing history');
  const record = await readPackInstallation(UID, ATHLETE_PACK.packId, { storage: rig.storage });
  assert.ok(record, 'entitlement loss deleted the installation record');
  assert.equal(record.reason, 'entitlement_lost');
  assert.equal(
    JSON.stringify(await rig.storage.get(userSubDoc(UID, PROVIDER_CONNECTIONS, CONNECTION_ID))),
    JSON.stringify(connectionRecord()),
    'entitlement loss corrupted the shared provider connection',
  );

  // Paying again resumes the very same watchers.
  const restored = await applyPackEntitlement({
    pack: ATHLETE_PACK,
    scopeId: UID,
    entitlement: activeFor(ATHLETE_PACK),
    now: atIso(5),
    storage: rig.storage,
  });
  assert.equal(restored.state, 'enabled');
  assert.equal(restored.reason, 'entitlement_restored');
  assert.deepEqual([...restored.watcherIds].sort(), [...athlete.watcherIds].sort());
  moveSignals(rig, 'digest-4');
  await sweep(rig, 6); // prime
  moveSignals(rig, 'digest-5');
  const back = await sweep(rig, 7);
  assert.equal(back.fired, athlete.watcherIds.length, 'the restored pack did not resume');
});

test('a lapsed pack switched back on behind the record is stopped again by the next reconciler run', async () => {
  const rig = buildRig();
  await seed(rig);
  const athlete = await turnOn(rig, ATHLETE_PACK, 0, activeFor(ATHLETE_PACK));
  moveSignals(rig, 'digest-1');
  await sweep(rig, 1);

  await applyPackEntitlement({
    pack: ATHLETE_PACK, scopeId: UID, entitlement: lapsedFor(ATHLETE_PACK), now: atIso(2), storage: rig.storage,
  });
  moveSignals(rig, 'digest-2');
  assert.equal((await sweep(rig, 3)).fired, 0, 'the lapse did not take effect, so this test proves nothing');

  // Somebody flips the watchers back on behind the record's back — which is
  // exactly what `POST /api/mobile/watchers/{id}/pause` with `{"paused":
  // false}` used to do, and what a future writer of that flag could still do.
  const store = createWatcherStore(UID, rig.storage);
  for (const watcherId of athlete.watcherIds) {
    await store.update(watcherId, (current) => ({
      ...current,
      definition: { ...current.definition, enabled: true, updatedAt: atIso(4) },
    }));
  }
  await sweep(rig, 5); // re-entering active primes
  moveSignals(rig, 'digest-3');
  assert.equal(
    (await sweep(rig, 6)).fired,
    athlete.watcherIds.length,
    'the hand-flipped watchers never fired, so the reconciler below would prove nothing',
  );

  // The record still says `disabled`, and the entitlement is still lapsed. A
  // reconciler gated on the record would report "unchanged" and leave premium
  // behaviour running for ever.
  const recordBefore = await readPackInstallation(UID, ATHLETE_PACK.packId, { storage: rig.storage });
  assert.equal(recordBefore?.state, 'disabled');

  const rerun = await applyPackEntitlement({
    pack: ATHLETE_PACK, scopeId: UID, entitlement: lapsedFor(ATHLETE_PACK), now: atIso(7), storage: rig.storage,
  });
  assert.equal(rerun.state, 'disabled');
  assert.equal(rerun.reason, 'entitlement_lost', 'the rerun reported nothing happened while it re-stopped two watchers');
  assert.deepEqual([...rerun.changedWatcherIds].sort(), [...athlete.watcherIds].sort());

  moveSignals(rig, 'digest-4');
  assert.equal((await sweep(rig, 8)).fired, 0, 'a lapsed pack kept firing after a reconciler run');
  for (const stored of await watchersOf(rig, athlete.watcherIds)) {
    assert.equal(stored.definition.enabled, false);
  }
  // And nothing was destroyed on the way.
  assert.equal((await watchersOf(rig, athlete.watcherIds)).length, athlete.watcherIds.length);
});

test('a pack that gained a template since it was first enabled installs the new one on re-enable', async () => {
  const rig = buildRig();
  await seed(rig);
  // Enable a one-template version of the pack, then re-enable the real
  // two-template manifest: the second template must arrive, attributed.
  const narrowed: VerticalPackDefinition = {
    ...FOOTBALL_PACK,
    watcherTemplates: [FOOTBALL_PACK.watcherTemplates[0]!],
  };
  const first = await enablePack({
    pack: narrowed,
    scopeId: UID,
    provider: PROVIDERS.football!,
    connectionId: CONNECTION_ID,
    subjects: subjectsFor(FOOTBALL_PACK),
    entitlement: null,
    now: atIso(0),
    storage: rig.storage,
  });
  assert.equal(first.watcherIds.length, 1);

  const grown = await turnOn(rig, FOOTBALL_PACK, 1);
  assert.equal(grown.watcherIds.length, FOOTBALL_PACK.watcherTemplates.length, 'the new template was never installed');
  assert.equal(grown.watcherIds[0], first.watcherIds[0], 'the existing watcher was replaced rather than kept');
  const record = await readPackInstallation(UID, FOOTBALL_PACK.packId, { storage: rig.storage });
  assert.deepEqual(
    record?.templateIds,
    FOOTBALL_PACK.watcherTemplates.map((template) => template.templateId),
    'the record does not say which template produced which watcher',
  );

  // And a second re-enable adds nothing more.
  const idempotent = await turnOn(rig, FOOTBALL_PACK, 2);
  assert.deepEqual(idempotent.watcherIds, grown.watcherIds, 're-enabling installed a duplicate');
});

test('a pack the user switched off themselves is not resurrected by an active entitlement', async () => {
  const rig = buildRig();
  await seed(rig);
  const athlete = await turnOn(rig, ATHLETE_PACK, 0, activeFor(ATHLETE_PACK));
  await disablePack({ scopeId: UID, packId: ATHLETE_PACK.packId, now: atIso(1), storage: rig.storage });

  const reconciled = await applyPackEntitlement({
    pack: ATHLETE_PACK,
    scopeId: UID,
    entitlement: activeFor(ATHLETE_PACK),
    now: atIso(2),
    storage: rig.storage,
  });
  assert.equal(reconciled.state, 'disabled');
  assert.equal(reconciled.reason, 'unchanged');
  for (const stored of await watchersOf(rig, athlete.watcherIds)) {
    assert.equal(stored.definition.enabled, false, 'an entitlement sweep switched a pack back on for the user');
  }
});

test('a pack whose entitlement the projection denies installs nothing at all', async () => {
  const rig = buildRig();
  await seed(rig);
  const refused = await turnOn(rig, TRAVEL_PACK, 0, lapsedFor(TRAVEL_PACK));
  assert.equal(refused.reason, 'entitlement_denied');
  assert.equal(refused.decision?.allowed, false);
  assert.deepEqual(refused.watcherIds, []);
  assert.equal(await readPackInstallation(UID, TRAVEL_PACK.packId, { storage: rig.storage }), null);
  const watchers = (await rig.storage.listGroup<StoredWatcher>(WATCHERS))
    .filter((row) => row.path.startsWith(`${userDoc(UID)}/`));
  assert.deepEqual(watchers, [], 'a refused pack left watchers behind');
});

test('a free pack needs no projection at all', async () => {
  const rig = buildRig();
  await seed(rig);
  const free = await turnOn(rig, FOOTBALL_PACK, 0, null);
  assert.equal(free.state, 'enabled');
  assert.equal(free.decision?.reason, 'free_feature');
});

/* ── Containment ─────────────────────────────────────────────────── */

test('disabling a pack never touches a watcher the user built by hand', async () => {
  const rig = buildRig();
  await seed(rig);
  const football = await turnOn(rig, FOOTBALL_PACK, 0);

  // A hand-built watcher whose id has drifted onto the pack's record — the
  // corruption the `createdBy` guard exists for.
  const mine = await createWatcherStore(UID, rig.storage).create({
    enabled: true,
    source: { provider: 'football_data', connectionId: CONNECTION_ID, signalKind: 'fixture', subjectRef: 'my_own' },
    condition: { kind: 'digest_changed' },
    effect: 'notify',
    createdBy: 'user',
  }, atIso(0));
  const record = await readPackInstallation(UID, FOOTBALL_PACK.packId, { storage: rig.storage });
  assert.ok(record);
  await rig.storage.set(userSubDoc(UID, 'packInstallations', FOOTBALL_PACK.packId), {
    ...record,
    watcherIds: [...record.watcherIds, mine.definition.watcherId],
  });

  const off = await disablePack({ scopeId: UID, packId: FOOTBALL_PACK.packId, now: atIso(1), storage: rig.storage });
  assert.ok(!off.changedWatcherIds.includes(mine.definition.watcherId));
  const stored = await createWatcherStore(UID, rig.storage).get(mine.definition.watcherId);
  assert.equal(stored?.definition.enabled, true, 'a pack switched off a watcher the user made');
  for (const paused of await watchersOf(rig, football.watcherIds)) {
    assert.equal(paused.definition.enabled, false, 'the pack failed to stop its own watchers');
  }
});

test('disabling a pack that was never enabled is a no-op, not an error', async () => {
  const rig = buildRig();
  await seed(rig);
  const off = await disablePack({ scopeId: UID, packId: TRAVEL_PACK.packId, now: atIso(0), storage: rig.storage });
  assert.equal(off.reason, 'not_installed');
  assert.deepEqual(off.watcherIds, []);
  assert.deepEqual(await listPackInstallations(UID, { storage: rig.storage }), []);
});

test('installations list every pack an account has, by id', async () => {
  const rig = buildRig();
  await seed(rig);
  await turnOn(rig, TRAVEL_PACK, 0);
  await turnOn(rig, FOOTBALL_PACK, 0);
  assert.deepEqual(
    (await listPackInstallations(UID, { storage: rig.storage })).map((record) => record.packId),
    ['football', 'travel'],
  );
});
