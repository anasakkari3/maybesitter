/**
 * The watcher engine, held to the nine things #525 says it must do.
 *
 * ── Why three signal kinds in one file ─────────────────────────────
 *
 * The issue's first acceptance criterion is that the *same* engine serves a
 * flight, a football fixture and a readiness reading. A per-provider test file
 * would satisfy the letter of that and miss its point: what is being asserted
 * is that there is no flight-shaped branch anywhere, so the three run through
 * one sweep, over one storage, in the same tests. Football and readiness use
 * the production observers; flight is synthetic, because no flight provider
 * exists yet — and the synthetic one is deliberately built out of a
 * vendor-shaped payload (`estimated_out`, `dep_delayed`, `raw_vendor_body`),
 * so "provider payload never leaks into watcher contracts" can be asserted
 * against a payload that actually contains something to leak.
 *
 * ── The ones that would go green for the wrong reason ──────────────
 *
 * "A disabled watcher performs zero effects" passes trivially if nothing ever
 * fires, so every negative here is paired with a positive on the same data:
 * the watcher that must not fire is disabled *after* an identical one has been
 * shown firing. The same for the disconnect, the duplicate and the replay —
 * each proves the effect happens first, then that the guard stops it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import {
  fixtureDoc,
  PLANNING_STATE_CHANGES,
  PROVIDER_CONNECTIONS,
  userCol,
  userDoc,
  userSubDoc,
  WATCHER_EVENTS,
  WATCHER_NOTIFICATIONS,
  WATCHER_PROPOSALS,
} from '../../lib/storage/paths.ts';
import {
  WATCHER_SIGNAL_SCHEMA_VERSION,
  type PlanningStateChange,
  type WatcherFireEvent,
  type WatcherNotification,
  type WatcherProposal,
  type WatcherSignal,
  type WatcherSourceRef,
} from '../../src/contracts/v1/watcherContracts.ts';
import { createWatcherStore, type NewWatcherInput, type StoredWatcher } from '../../lib/watchers/watcherStore.ts';
import { runWatcherSweep, type WatcherSweepTotals } from '../../lib/watchers/watcherEngine.ts';
import {
  createWatcherSignalRegistry,
  fixtureObserver,
  readinessObserver,
  type WatcherSignalObserver,
} from '../../lib/watchers/signals.ts';
import {
  FIXTURE_CONTRACT_VERSION,
  FIXTURE_SCHEMA_VERSION,
  fixtureContentHash,
  type Fixture,
  type FixtureCore,
} from '../../src/contracts/v1/fixtureContracts.ts';
import {
  READINESS_CONTRACT_VERSION,
  READINESS_SCHEMA_VERSION,
  type ReadinessSnapshot,
} from '../../src/contracts/v1/readinessContracts.ts';
import { saveNormalizedReadinessSnapshot } from '../../lib/userState/userStateService.ts';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts.ts';

const ALICE = 'AliceWatcherUserxxxxxxxxxxxxx'.slice(0, 28);
const BOB = 'BobWatcherUserxxxxxxxxxxxxxxx'.slice(0, 28);

const T0 = new Date('2026-09-20T09:00:00.000Z');
const T1 = new Date('2026-09-20T09:01:00.000Z');
const T2 = new Date('2026-09-20T09:02:00.000Z');
const T3 = new Date('2026-09-20T09:03:00.000Z');

/* ── The synthetic flight adapter ─────────────────────────────────── */

/**
 * What a flight vendor would hand us: snake-cased, unit-bearing, and with a
 * raw body attached. None of these key names may appear anywhere downstream.
 */
interface VendorFlightPayload {
  readonly estimated_out: string;
  readonly dep_delayed: number;
  readonly raw_vendor_body: string;
}

export const VENDOR_FLIGHT_KEYS = ['estimated_out', 'dep_delayed', 'raw_vendor_body'] as const;

const FLIGHT_SIGNAL_KIND = 'flight';
const FLIGHT_DELAY_METRIC = 'delay_minutes';

const flightVendorState = new Map<string, VendorFlightPayload>();

/**
 * The adapter: vendor payload in, normalized `WatcherSignal` out. The
 * normalization is the whole boundary — the vendor's field names and its raw
 * body stop here, and what continues is a digest, one named measure and a
 * provenance pointer.
 */
const flightObserver: WatcherSignalObserver = {
  supports: (source) => source.signalKind === FLIGHT_SIGNAL_KIND,
  async observe(source, context) {
    const vendor = flightVendorState.get(`${source.subjectRef}`);
    if (!vendor) return null;
    const stateDigest = createHash('sha256')
      .update(JSON.stringify({ departure: vendor.estimated_out, delay: vendor.dep_delayed }))
      .digest('hex');
    const signal: WatcherSignal = {
      schemaVersion: WATCHER_SIGNAL_SCHEMA_VERSION,
      signalId: `${FLIGHT_SIGNAL_KIND}:${source.subjectRef}:${stateDigest}`,
      provider: source.provider,
      signalKind: FLIGHT_SIGNAL_KIND,
      subjectRef: source.subjectRef,
      observedAt: context.now,
      stateDigest,
      provenanceRef: `flights/${source.subjectRef}`,
      measures: [{ metric: FLIGHT_DELAY_METRIC, value: vendor.dep_delayed }],
    };
    return signal;
  },
};

function registry() {
  return createWatcherSignalRegistry([flightObserver, fixtureObserver, readinessObserver]);
}

/* ── Fixtures for the three sources ───────────────────────────────── */

function fixtureCore(kickoffUtc: string, status: FixtureCore['status'] = 'scheduled'): FixtureCore {
  return {
    provider: 'football_data',
    providerMatchId: 'match-4711',
    competition: 'PL',
    homeTeamId: '65',
    awayTeamId: '61',
    homeTeamName: 'Manchester City',
    awayTeamName: 'Chelsea',
    kickoffUtc,
    status,
    venue: null,
  };
}

function fixture(kickoffUtc: string, status: FixtureCore['status'] = 'scheduled'): Fixture {
  const core = fixtureCore(kickoffUtc, status);
  return {
    ...core,
    version: FIXTURE_CONTRACT_VERSION,
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    contentHash: fixtureContentHash(core),
  };
}

function readiness(uid: string, score: number, computedAt: string): ReadinessSnapshot {
  return {
    version: READINESS_CONTRACT_VERSION,
    schemaVersion: READINESS_SCHEMA_VERSION,
    scopeId: uid,
    computedAt,
    windowStart: '2026-09-19T20:00:00.000Z',
    windowEnd: computedAt,
    band: score < 0.3 ? 'low' : 'steady',
    score,
    normalizedSignals: {},
    subjective: null,
    derived: { readinessBand: score < 0.3 ? 'low' : 'steady', confidence: 0.8 },
    signals: [],
    sourceKinds: ['whoop'],
    missingSourceKinds: [],
  };
}

function connection(uid: string, connectionId: string, state: IntegrationConnectionRecord['state']) {
  return {
    version: 'v1',
    schemaVersion: 'integration-connection-v1',
    connectionId,
    scopeId: uid,
    provider: 'whoop',
    providerAccountId: null,
    providerSpaceId: null,
    displayName: null,
    state,
    capabilities: [],
    grantedScopes: [],
    connectedAt: state === 'connected' ? T0.toISOString() : null,
    lastSyncedAt: null,
    expiresAt: null,
    revokedAt: state === 'revoked' ? T0.toISOString() : null,
  } as unknown as IntegrationConnectionRecord;
}

/* ── Harness ──────────────────────────────────────────────────────── */

let storage: MemoryStorageAdapter;

function begin(): void {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  flightVendorState.clear();
}

function end(): void {
  storage.setBeforeCommitHookForTests(null);
  resetStorageForTests();
}

async function sweep(now: Date): Promise<WatcherSweepTotals> {
  return runWatcherSweep({ storage, now, registry: registry() });
}

/**
 * The connection record itself, written where the engine reads it. There is no
 * injectable seam over this read on purpose (see `readConnection` in the
 * engine): the firing transaction re-reads the same document, so a test that
 * stubbed only the sweep-time read would leave the guard that actually holds
 * untested.
 */
async function setConnection(uid: string, connectionId: string, state: IntegrationConnectionRecord['state']): Promise<void> {
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionId), connection(uid, connectionId, state));
}

async function add(uid: string, input: NewWatcherInput, now = T0): Promise<StoredWatcher> {
  return createWatcherStore(uid, storage).create(input, now.toISOString());
}

async function events(uid: string): Promise<WatcherFireEvent[]> {
  return (await storage.list<WatcherFireEvent>(userCol(uid, WATCHER_EVENTS))).map((row) => row.data);
}

async function docsIn(uid: string, collection: string): Promise<unknown[]> {
  return (await storage.list<unknown>(userCol(uid, collection))).map((row) => row.data);
}

const flightSource = {
  provider: 'aviation',
  connectionId: null,
  signalKind: FLIGHT_SIGNAL_KIND,
  subjectRef: 'flt_ly315_20260920',
} as const;

const fixtureSource = {
  provider: 'football_data',
  connectionId: null,
  signalKind: 'fixture',
  subjectRef: 'match-4711',
} as const;

function readinessSource(connectionId: string | null) {
  return { provider: 'whoop', connectionId, signalKind: 'readiness', subjectRef: 'self' } as const;
}

/* ── The acceptance criteria ──────────────────────────────────────── */

test('one engine serves a synthetic flight, a football fixture and a readiness reading', async () => {
  begin();
  try {
    await storage.set(userDoc(ALICE), { uid: ALICE, createdAt: T0.toISOString() });
    await storage.set(fixtureDoc('football_data', 'match-4711'), fixture('2026-09-21T19:00:00.000Z'));
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T14:40:00.000Z',
      dep_delayed: 0,
      raw_vendor_body: '{"flight":{"ident":"LY315"}}',
    });
    await saveNormalizedReadinessSnapshot(ALICE, readiness(ALICE, 0.82, '2026-09-20T08:30:00.000Z'), {
      storage,
      now: T0.toISOString(),
    });

    const flight = await add(ALICE, {
      enabled: true, source: flightSource, condition: { kind: 'digest_changed' }, effect: 'notify', createdBy: 'user',
    });
    const match = await add(ALICE, {
      enabled: true, source: fixtureSource, condition: { kind: 'digest_changed' }, effect: 'replan_if_impacted', createdBy: 'user',
    });
    const recovery = await add(ALICE, {
      enabled: true,
      source: readinessSource(null),
      condition: { kind: 'threshold', metric: 'readiness_score', operator: 'lt', value: 0.3 },
      effect: 'propose_commitment',
      createdBy: 'user',
    });

    // First sweep: three unprimed watchers absorb the current state. Nothing
    // that was already true when they were created may fire.
    const first = await sweep(T0);
    assert.equal(first.scanned, 3);
    assert.equal(first.evaluated, 3);
    assert.equal(first.fired, 0, 'a watcher fired on state that predates it');
    assert.deepEqual(await events(ALICE), []);

    // Now each of the three subjects moves, in its own vocabulary.
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T16:10:00.000Z',
      dep_delayed: 90,
      raw_vendor_body: '{"flight":{"ident":"LY315","status":"Delayed"}}',
    });
    await storage.set(fixtureDoc('football_data', 'match-4711'), fixture('2026-09-21T19:00:00.000Z', 'postponed'));
    await saveNormalizedReadinessSnapshot(ALICE, readiness(ALICE, 0.21, '2026-09-20T08:55:00.000Z'), {
      storage,
      now: T1.toISOString(),
    });

    const second = await sweep(T1);
    assert.equal(second.fired, 3, `one engine did not serve all three: ${JSON.stringify(second)}`);
    assert.equal(second.policyBlocked, 0);

    const fired = await events(ALICE);
    assert.equal(fired.length, 3);
    assert.deepEqual(
      fired.map((event) => event.signalKind).sort(),
      ['fixture', 'flight', 'readiness'],
    );

    // Each effect landed in its own lane, and nowhere else.
    const notifications = await docsIn(ALICE, WATCHER_NOTIFICATIONS) as WatcherNotification[];
    const changes = await docsIn(ALICE, PLANNING_STATE_CHANGES) as PlanningStateChange[];
    const proposals = await docsIn(ALICE, WATCHER_PROPOSALS) as WatcherProposal[];
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.watcherId, flight.definition.watcherId);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.entityId, match.definition.watcherId);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.watcherId, recovery.definition.watcherId);

    // Every execution carries provenance and a reason — the issue's last
    // criterion, asserted over every row rather than over a chosen one.
    for (const event of fired) {
      assert.ok(event.reason.length > 0, `${event.signalKind} fired with no reason`);
      assert.ok(event.provenanceRef.length > 0, `${event.signalKind} fired with no provenance`);
      assert.equal(event.policyDecision, 'allowed');
      assert.equal(event.outcome, 'effected');
      assert.ok(event.effectRef, `${event.signalKind} recorded no effect reference`);
    }
    for (const artifact of [...notifications, ...changes, ...proposals]) {
      assert.ok((artifact as { provenanceRef: string }).provenanceRef.length > 0);
    }
    assert.equal(proposals[0]!.reason, 'threshold_crossed');
    assert.equal(notifications[0]!.reason, 'digest_changed');
  } finally {
    end();
  }
});

test('a provider payload cannot reach a watcher contract, a history row or an effect', async () => {
  begin();
  try {
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T14:40:00.000Z',
      dep_delayed: 0,
      raw_vendor_body: '{"flight":{"ident":"LY315","gate":"C4"}}',
    });
    await add(ALICE, {
      enabled: true, source: flightSource, condition: { kind: 'digest_changed' }, effect: 'notify', createdBy: 'user',
    });
    await sweep(T0);
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T16:10:00.000Z',
      dep_delayed: 90,
      raw_vendor_body: '{"flight":{"ident":"LY315","gate":"C4","status":"Delayed"}}',
    });
    await sweep(T1);

    const fired = await events(ALICE);
    assert.equal(fired.length, 1, 'the positive half of this test did not happen');

    // Everything this watcher wrote, read back as text. A vendor field name, a
    // gate, an aircraft ident: if any of them survived the adapter, it is here.
    const written = JSON.stringify([
      await createWatcherStore(ALICE, storage).get(fired[0]!.watcherId),
      fired,
      await docsIn(ALICE, WATCHER_NOTIFICATIONS),
    ]);
    for (const leaked of [...VENDOR_FLIGHT_KEYS, 'LY315', 'C4', 'Delayed', 'ident', 'gate']) {
      assert.ok(!written.includes(leaked), `the provider payload leaked "${leaked}" into the watcher side`);
    }

    // And the shape itself: a contract with no field for provider content
    // cannot grow one by accident.
    assert.deepEqual(Object.keys(fired[0]!).sort(), [
      'effect', 'effectRef', 'eventId', 'firedAt', 'observedAt', 'outcome', 'policyDecision',
      'provenanceRef', 'provider', 'reason', 'scopeId', 'schemaVersion', 'signalId', 'signalKind',
      'subjectRef', 'version', 'watcherId',
    ].sort());
  } finally {
    end();
  }
});

test('the same source signal delivered twice fires once', async () => {
  begin();
  try {
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T14:40:00.000Z', dep_delayed: 0, raw_vendor_body: '{}',
    });
    const watcher = await add(ALICE, {
      enabled: true, source: flightSource, condition: { kind: 'digest_changed' }, effect: 'notify', createdBy: 'user',
    });
    await sweep(T0);

    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T16:10:00.000Z', dep_delayed: 90, raw_vendor_body: '{}',
    });
    const fires = await sweep(T1);
    assert.equal(fires.fired, 1);
    assert.equal((await events(ALICE)).length, 1);
    assert.equal((await docsIn(ALICE, WATCHER_NOTIFICATIONS)).length, 1);

    // The redelivery a retried or overlapping sweep actually produces: a run
    // that read the watcher *before* the firing committed, and now evaluates
    // the very same observation against the very same stale baseline.
    const store = createWatcherStore(ALICE, storage);
    const afterFiring = (await store.get(watcher.definition.watcherId))!;
    await storage.set(
      `users/${ALICE}/watchers/${watcher.definition.watcherId}`,
      { ...afterFiring, runtime: { ...watcher.runtime, status: 'active', lastDigest: 'a-stale-baseline', lastSignalId: 'stale' } },
    );

    const again = await sweep(T2);
    assert.equal(again.duplicates, 1, `the redelivery was not recognised: ${JSON.stringify(again)}`);
    assert.equal(again.fired, 0);
    assert.equal((await events(ALICE)).length, 1, 'a second history row was written for one observation');
    assert.equal((await docsIn(ALICE, WATCHER_NOTIFICATIONS)).length, 1, 'one observation produced two notifications');
  } finally {
    end();
  }
});

test('a disabled watcher performs zero effects, including when it is disabled mid-sweep', async () => {
  begin();
  try {
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T14:40:00.000Z', dep_delayed: 0, raw_vendor_body: '{}',
    });
    const enabled = await add(ALICE, {
      enabled: true, source: flightSource, condition: { kind: 'digest_changed' }, effect: 'notify', createdBy: 'user',
    });
    const disabled = await add(BOB, {
      enabled: false, source: flightSource, condition: { kind: 'digest_changed' }, effect: 'notify', createdBy: 'user',
    });
    await sweep(T0);

    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T16:10:00.000Z', dep_delayed: 90, raw_vendor_body: '{}',
    });
    const totals = await sweep(T1);

    // The same observation, at the same instant, through the same engine: one
    // watcher fires and the disabled one does not.
    assert.equal(totals.fired, 1);
    assert.equal(totals.paused, 1);
    assert.equal((await events(ALICE)).length, 1);
    assert.deepEqual(await events(BOB), [], 'a disabled watcher wrote history');
    assert.deepEqual(await docsIn(BOB, WATCHER_NOTIFICATIONS), [], 'a disabled watcher produced an effect');
    const parked = (await createWatcherStore(BOB, storage).get(disabled.definition.watcherId))!;
    assert.equal(parked.runtime.status, 'paused');
    assert.equal(parked.runtime.fireCount, 0);

    // And the narrow window: disabled after the sweep read it, before the
    // firing commits. The guard inside the transaction is the one that holds
    // here; the sweep-time check has already been passed.
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T18:10:00.000Z', dep_delayed: 190, raw_vendor_body: '{}',
    });
    const path = `users/${ALICE}/watchers/${enabled.definition.watcherId}`;
    storage.setBeforeCommitHookForTests(async ({ attempt }) => {
      if (attempt !== 1) return;
      const current = (await storage.get<StoredWatcher>(path))!;
      await storage.set(path, { ...current, definition: { ...current.definition, enabled: false } });
    });
    const raced = await sweep(T2);
    storage.setBeforeCommitHookForTests(null);

    assert.equal(raced.fired, 0, 'a pause that landed mid-sweep still cost an effect');
    assert.equal((await events(ALICE)).length, 1, 'a second event was written after the watcher was disabled');
    assert.equal((await docsIn(ALICE, WATCHER_NOTIFICATIONS)).length, 1);
  } finally {
    end();
  }
});

test('disconnecting the provider blocks the watcher, and reconnecting resumes without replaying', async () => {
  begin();
  try {
    await storage.set(userDoc(ALICE), { uid: ALICE, createdAt: T0.toISOString() });
    await saveNormalizedReadinessSnapshot(ALICE, readiness(ALICE, 0.82, '2026-09-20T08:30:00.000Z'), {
      storage, now: T0.toISOString(),
    });
    await setConnection(ALICE, 'conn-1', 'connected');

    const watcher = await add(ALICE, {
      enabled: true,
      source: readinessSource('conn-1'),
      condition: { kind: 'threshold', metric: 'readiness_score', operator: 'lt', value: 0.3 },
      effect: 'propose_commitment',
      createdBy: 'user',
    });
    const store = createWatcherStore(ALICE, storage);

    await sweep(T0);
    await saveNormalizedReadinessSnapshot(ALICE, readiness(ALICE, 0.22, '2026-09-20T08:50:00.000Z'), {
      storage, now: T1.toISOString(),
    });
    assert.equal((await sweep(T1)).fired, 1, 'the connected watcher never fired');
    assert.equal((await docsIn(ALICE, WATCHER_PROPOSALS)).length, 1);

    // The user revokes the grant.
    await setConnection(ALICE, 'conn-1', 'revoked');
    await saveNormalizedReadinessSnapshot(ALICE, readiness(ALICE, 0.80, '2026-09-20T08:52:00.000Z'), {
      storage, now: T1.toISOString(),
    });
    const blocked = await sweep(T2);
    assert.equal(blocked.blocked, 1);
    assert.equal(blocked.fired, 0);
    const parked = (await store.get(watcher.definition.watcherId))!;
    assert.equal(parked.runtime.status, 'blocked');
    assert.equal(parked.runtime.blockedReason, 'provider_disconnected');

    // A reauth-shaped refusal is a different blocked reason, because the user
    // is told a different thing about it.
    await setConnection(ALICE, 'conn-1', 'needs_reauth');
    await sweep(T2);
    assert.equal((await store.get(watcher.definition.watcherId))!.runtime.blockedReason, 'provider_needs_reauth');

    // While it is blocked, readiness crosses the threshold twice. Neither may
    // be delivered later.
    await saveNormalizedReadinessSnapshot(ALICE, readiness(ALICE, 0.15, '2026-09-20T08:54:00.000Z'), {
      storage, now: T2.toISOString(),
    });
    await sweep(T2);
    await saveNormalizedReadinessSnapshot(ALICE, readiness(ALICE, 0.90, '2026-09-20T08:56:00.000Z'), {
      storage, now: T2.toISOString(),
    });
    await sweep(T2);
    assert.equal((await events(ALICE)).length, 1, 'a blocked watcher fired');

    // Reconnect. The resume primes from the current reading and fires nothing.
    await setConnection(ALICE, 'conn-1', 'connected');
    const resumed = await sweep(T3);
    assert.equal(resumed.primed, 1, `the reconnect did not prime: ${JSON.stringify(resumed)}`);
    assert.equal(resumed.fired, 0, 'the reconnect replayed history');
    assert.equal((await events(ALICE)).length, 1);
    assert.equal((await docsIn(ALICE, WATCHER_PROPOSALS)).length, 1);

    // A steady reading after the resume still fires nothing...
    assert.equal((await sweep(T3)).fired, 0);

    // ...and the next real crossing fires exactly once, so "resumes safely"
    // means resumed, not silenced.
    await saveNormalizedReadinessSnapshot(ALICE, readiness(ALICE, 0.12, '2026-09-20T08:58:00.000Z'), {
      storage, now: T3.toISOString(),
    });
    assert.equal((await sweep(T3)).fired, 1);
    assert.equal((await events(ALICE)).length, 2);
  } finally {
    end();
  }
});

test('a commitment effect is a proposal and nothing canonical, and a replan effect only enters the pipeline', async () => {
  begin();
  try {
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T14:40:00.000Z', dep_delayed: 0, raw_vendor_body: '{}',
    });
    await add(ALICE, {
      enabled: true, source: flightSource, condition: { kind: 'digest_changed' }, effect: 'propose_commitment', createdBy: 'user',
    });
    await add(ALICE, {
      enabled: true, source: flightSource, condition: { kind: 'digest_changed' }, effect: 'replan_if_impacted', createdBy: 'user',
    });
    await sweep(T0);
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T16:10:00.000Z', dep_delayed: 90, raw_vendor_body: '{}',
    });
    assert.equal((await sweep(T1)).fired, 2);

    const proposals = await docsIn(ALICE, WATCHER_PROPOSALS) as WatcherProposal[];
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.state, 'proposed');
    // There is no state on this artifact but `proposed`, and no field on it
    // that names a commitment: a proposal cannot become canonical work by
    // being written harder.
    assert.deepEqual(Object.keys(proposals[0]!).sort(), [
      'proposalId', 'proposedAt', 'provenanceRef', 'reason', 'schemaVersion', 'scopeId',
      'signalKind', 'state', 'subjectRef', 'watcherId',
    ].sort());

    // Nothing canonical was written anywhere in this account's tree: no
    // commitment, no plan, no reminder.
    const paths = storage.pathsForTests().filter((path) => path.startsWith(`users/${ALICE}/`));
    for (const path of paths) {
      assert.match(
        path,
        /\/(watchers|watcherEvents|watcherProposals|watcherNotifications|planningStateChanges)\//,
        `a watcher wrote outside its own collections: ${path}`,
      );
    }

    const changes = await docsIn(ALICE, PLANNING_STATE_CHANGES) as PlanningStateChange[];
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.source, 'watcher');
    assert.equal(changes[0]!.changedFields.length, 1);
    assert.ok(changes[0]!.afterDigest.length > 0);
    assert.notEqual(changes[0]!.beforeDigest, changes[0]!.afterDigest);
  } finally {
    end();
  }
});

test('one account cannot see, or be affected by, another account watching the same subject', async () => {
  begin();
  try {
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T14:40:00.000Z', dep_delayed: 0, raw_vendor_body: '{}',
    });
    const hers = await add(ALICE, {
      enabled: true, source: flightSource, condition: { kind: 'digest_changed' }, effect: 'notify', createdBy: 'user',
    });
    const his = await add(BOB, {
      enabled: true, source: flightSource, condition: { kind: 'digest_changed' }, effect: 'notify', createdBy: 'user',
    });
    await sweep(T0);
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T16:10:00.000Z', dep_delayed: 90, raw_vendor_body: '{}',
    });
    await sweep(T1);

    // Both watch the same flight, so both fire — and each one's history is
    // wholly its own, down to the event ids, which are derived from the
    // watcher id and so cannot collide across accounts.
    const hersEvents = await events(ALICE);
    const hisEvents = await events(BOB);
    assert.equal(hersEvents.length, 1);
    assert.equal(hisEvents.length, 1);
    assert.equal(hersEvents[0]!.scopeId, ALICE);
    assert.equal(hisEvents[0]!.scopeId, BOB);
    assert.notEqual(hersEvents[0]!.eventId, hisEvents[0]!.eventId);

    const aliceStore = createWatcherStore(ALICE, storage);
    assert.equal((await aliceStore.list()).length, 1);
    assert.equal(await aliceStore.get(his.definition.watcherId), null, "Alice could read Bob's watcher");
    assert.deepEqual(await aliceStore.listEvents(his.definition.watcherId, 50), [], "Alice could read Bob's history");
    assert.equal((await aliceStore.listEvents(hers.definition.watcherId, 50)).length, 1);
  } finally {
    end();
  }
});

test('re-running an identical sweep changes nothing', async () => {
  begin();
  try {
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T14:40:00.000Z', dep_delayed: 0, raw_vendor_body: '{}',
    });
    await add(ALICE, {
      enabled: true, source: flightSource, condition: { kind: 'digest_changed' }, effect: 'notify', createdBy: 'user',
    });
    await sweep(T0);
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T16:10:00.000Z', dep_delayed: 90, raw_vendor_body: '{}',
    });
    await sweep(T1);
    const after = JSON.stringify(await Promise.all([
      events(ALICE), docsIn(ALICE, WATCHER_NOTIFICATIONS),
    ]));

    for (const at of [T1, T1, T2]) {
      const repeat = await sweep(at);
      assert.equal(repeat.fired, 0, `an unchanged observation fired again at ${at.toISOString()}`);
    }
    assert.equal(
      JSON.stringify(await Promise.all([events(ALICE), docsIn(ALICE, WATCHER_NOTIFICATIONS)])),
      after,
      'repeating the sweep changed what the account holds',
    );
  } finally {
    end();
  }
});

test('an unregistered signal kind blocks its watcher rather than failing the sweep', async () => {
  begin();
  try {
    flightVendorState.set(flightSource.subjectRef, {
      estimated_out: '2026-09-20T14:40:00.000Z', dep_delayed: 0, raw_vendor_body: '{}',
    });
    const healthy = await add(ALICE, {
      enabled: true, source: flightSource, condition: { kind: 'digest_changed' }, effect: 'notify', createdBy: 'user',
    });
    const orphan = await add(ALICE, {
      enabled: true,
      source: { provider: 'notion', connectionId: null, signalKind: 'package_delivery', subjectRef: 'pkg-1' },
      condition: { kind: 'digest_changed' },
      effect: 'notify',
      createdBy: 'user',
    });

    const totals = await sweep(T0);
    assert.equal(totals.blocked, 1);
    assert.deepEqual(totals.failures, []);
    const store = createWatcherStore(ALICE, storage);
    assert.equal((await store.get(orphan.definition.watcherId))!.runtime.blockedReason, 'signal_unavailable');
    assert.equal((await store.get(healthy.definition.watcherId))!.runtime.status, 'active');
  } finally {
    end();
  }
});

/** The observer seam is a named export so #527's surface can register its own. */
test('the observer seam is a contract, not a closed list', () => {
  const custom: WatcherSignalObserver = {
    supports: (source) => source.signalKind === 'nothing_at_all',
    async observe() { return null; },
  };
  const built = createWatcherSignalRegistry([custom, flightObserver]);
  assert.equal(built.observerFor({ ...flightSource }), flightObserver);
  assert.equal(built.observerFor({ ...flightSource, signalKind: 'nope' }), null);
  const source: WatcherSourceRef = flightSource;
  assert.equal(source.signalKind, 'flight');
});
