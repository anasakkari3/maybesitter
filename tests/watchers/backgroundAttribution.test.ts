/**
 * `GET /api/mobile/trust/background-activity/attribution` (#527's Rule).
 *
 * The issue states the rule this file exists to hold: *every user-affecting
 * background action must be attributable to* `monitor/watcher → condition →
 * policy → resulting action`, and *no orphan autonomous work*.
 *
 * Nothing here hand-builds a firing. Every `WatcherFireEvent` under test is
 * produced by making the real engine actually sweep and actually fire, so the
 * ids, the policy decisions and the artifact refs are the ones production
 * writes. A hand-rolled event would be this file's own opinion about what the
 * engine records, and the first thing to disagree with it — which is precisely
 * the failure an attribution audit must not have.
 *
 * Three tests are written against the failure rather than the feature:
 *
 *  - the replan test goes the whole way round — fire, read the state change,
 *    hand its id back as a patch's `causeChangeIds` would, and require the
 *    monitor to come back — because "the chain is recorded" and "the chain can
 *    be asked" are different claims and only the round trip proves the second;
 *  - the orphan test *plants* an unattributable artifact, because a counter
 *    that has never seen one is a counter that returns zero for any reason;
 *  - the leak test runs over the whole serialized response rather than field
 *    by field, since the field being guarded against is the one nobody
 *    remembered to list.
 *
 * `tests/watchers/backgroundMonitors.test.ts` owns the monitor projection and
 * `tests/watchers/watcherEngine.test.ts` owns the firing itself. Neither is
 * re-proved here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { createWatcherStore, type NewWatcherInput } from '../../lib/watchers/watcherStore.ts';
import { runWatcherSweep } from '../../lib/watchers/watcherEngine.ts';
import { createWatcherSignalRegistry, type WatcherSignalObserver } from '../../lib/watchers/signals.ts';
import {
  WATCHER_CONTRACT_VERSION,
  WATCHER_EFFECT_CAPABILITIES,
  WATCHER_EVENT_SCHEMA_VERSION,
  WATCHER_SIGNAL_SCHEMA_VERSION,
  type PlanningStateChange,
  type WatcherEffect,
  type WatcherFireEvent,
} from '../../src/contracts/v1/watcherContracts.ts';
import {
  PLANNING_STATE_CHANGES,
  WATCHER_NOTIFICATIONS,
  userCol,
  userSubDoc,
} from '../../lib/storage/paths.ts';
import {
  attributionsForArtifacts,
  countOrphanBackgroundActions,
  listBackgroundAttribution,
  projectAttribution,
} from '../../lib/watchers/backgroundAttribution.ts';
import { GET as attributionGet } from '../../src/app/api/mobile/trust/background-activity/attribution/route.ts';

const baseUrl = 'http://127.0.0.1:4321';
const USER = uidFor('AttributionUser');
const OTHER = uidFor('AttributionOther');
const T0 = new Date('2026-09-20T09:00:00.000Z');
const T1 = new Date('2026-09-20T09:01:00.000Z');

/** A marked value in every place a provider secret could plausibly sit. */
const SECRET = 'PROVIDER-SECRET-MUST-NOT-LEAK';

let storage: MemoryStorageAdapter;
let auth: FakeAuthControls | null = null;
/** Flipped between sweeps so the second observation is a change and fires. */
let digest = 'digest-one';

const observer: WatcherSignalObserver = {
  supports: (source) => source.signalKind === 'flight',
  async observe(source, context) {
    return {
      schemaVersion: WATCHER_SIGNAL_SCHEMA_VERSION,
      signalId: `flight:${source.subjectRef}:${digest}`,
      provider: source.provider,
      signalKind: 'flight',
      subjectRef: source.subjectRef,
      observedAt: context.now,
      stateDigest: digest,
      // The pointer into provider data. It must never reach the response.
      provenanceRef: `flights/${SECRET}`,
      measures: [],
    };
  },
};

function watcherInput(effect: WatcherEffect): NewWatcherInput {
  return {
    enabled: true,
    source: { provider: 'aviation', connectionId: null, signalKind: 'flight', subjectRef: 'flt_ly315' },
    condition: { kind: 'digest_changed' },
    effect,
    createdBy: 'user',
  };
}

function req(path: string, uid = USER): Request {
  return new Request(`${baseUrl}${path}`, {
    headers: new Headers({ authorization: `Bearer ${tokenFor(uid)}` }),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

async function sweep(now: Date): Promise<void> {
  await runWatcherSweep({ storage, now, registry: createWatcherSignalRegistry([observer]) });
}

/**
 * A watcher of this effect, primed and then fired once.
 *
 * Two sweeps: the first absorbs a baseline (an unprimed watcher never fires),
 * the second sees a changed digest and fires. That is the engine's own rule,
 * not this file's, which is why the fixture runs it rather than asserting it.
 */
async function fireOnce(effect: WatcherEffect, uid = USER): Promise<string> {
  const store = createWatcherStore(uid, storage);
  const created = await store.create(watcherInput(effect), T0.toISOString());
  await sweep(T0);
  digest = 'digest-two';
  await sweep(T1);
  return created.definition.watcherId;
}

function begin(): void {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  auth = installFakeAuth();
  digest = 'digest-one';
}

function end(): void {
  auth?.restore();
  auth = null;
  resetStorageForTests();
}

/* ── The chain ────────────────────────────────────────────────────── */

test('a firing is projected as monitor, condition, policy and resulting action', async () => {
  begin();
  try {
    const watcherId = await fireOnce('notify');
    const view = await listBackgroundAttribution(USER, {}, { storage });

    assert.equal(view.actions.length, 1, 'the fixture did not fire exactly once');
    const [action] = view.actions;
    // The four links the issue names, in its own order.
    assert.equal(action.monitorId, `mon_${watcherId}`);
    assert.equal(action.watcherId, watcherId);
    assert.equal(action.condition, 'digest_changed');
    assert.equal(action.capability, WATCHER_EFFECT_CAPABILITIES.notify);
    assert.equal(action.policyDecision, 'allowed');
    assert.equal(action.effect, 'notify');
    assert.equal(action.artifact.kind, 'notification');
    assert.ok(action.artifact.ref, 'the action produced no artifact to point at');
    // And the label is the monitor view's code, not a sentence.
    assert.equal(action.label, 'aviation:flight');
    assert.equal(view.orphanCount, 0);
  } finally {
    end();
  }
});

test('the capability comes from the policy table, not from the stored firing', async () => {
  begin();
  try {
    await fireOnce('propose_commitment');
    const [action] = (await listBackgroundAttribution(USER, {}, { storage })).actions;
    // A historical copy of the binding would let the table and the record
    // drift without anybody noticing; this must equal the table as it is now.
    assert.equal(action.capability, WATCHER_EFFECT_CAPABILITIES.propose_commitment);
    assert.equal(action.artifact.kind, 'proposal');
  } finally {
    end();
  }
});

test('update_context is attributable even though it produces no artifact', async () => {
  begin();
  try {
    await fireOnce('update_context');
    const [action] = (await listBackgroundAttribution(USER, {}, { storage })).actions;
    // The absorbed baseline *is* the effect. That is a real case and gets its
    // own kind rather than being reported as `none`, which is reserved for a
    // firing the policy refused.
    assert.equal(action.effect, 'update_context');
    assert.equal(action.artifact.kind, 'context_update');
    assert.equal(action.artifact.ref, null);
    assert.equal(action.policyDecision, 'allowed');
  } finally {
    end();
  }
});

/* ── "Every automatic replan can answer which monitor caused it" ──── */

test('a replan state change leads back to the monitor that caused it', async () => {
  begin();
  try {
    const watcherId = await fireOnce('replan_if_impacted');

    // The artifact the firing wrote, read from where the engine put it.
    const changes = await storage.list<PlanningStateChange>(userCol(USER, PLANNING_STATE_CHANGES));
    assert.equal(changes.length, 1, 'the replan firing wrote no state change');
    const change = changes[0].data;
    assert.equal(change.source, 'watcher');
    assert.equal(change.entityId, watcherId);

    // The round trip. `IncrementalPlanPatch.causeChangeIds` (#524) carries
    // exactly these ids, so this is the call a replan makes to answer which
    // monitor caused it.
    const causeChangeIds = [change.changeId];
    const attributions = await attributionsForArtifacts(USER, causeChangeIds, { storage });

    assert.equal(attributions.length, 1, 'the replan could not be attributed');
    assert.equal(attributions[0].watcherId, watcherId);
    assert.equal(attributions[0].monitorId, `mon_${watcherId}`);
    assert.equal(attributions[0].condition, 'digest_changed');
    assert.equal(attributions[0].capability, WATCHER_EFFECT_CAPABILITIES.replan_if_impacted);
    assert.equal(attributions[0].artifact.kind, 'state_change');
    assert.equal(attributions[0].artifact.ref, change.changeId);
  } finally {
    end();
  }
});

test('a ref nothing claims comes back absent, not as a null row', async () => {
  begin();
  try {
    await fireOnce('replan_if_impacted');
    assert.deepEqual(await attributionsForArtifacts(USER, ['watcher:nothing'], { storage }), []);
    assert.deepEqual(await attributionsForArtifacts(USER, [], { storage }), []);
  } finally {
    end();
  }
});

test("one account's refs never resolve against another's firings", async () => {
  begin();
  try {
    await fireOnce('replan_if_impacted', OTHER);
    const changes = await storage.list<PlanningStateChange>(userCol(OTHER, PLANNING_STATE_CHANGES));
    assert.equal(changes.length, 1, 'the fixture wrote nothing to attribute');

    // The other account's real change id, asked about as USER.
    assert.deepEqual(
      await attributionsForArtifacts(USER, [changes[0].data.changeId], { storage }),
      [],
      "one account resolved another account's artifact",
    );
  } finally {
    end();
  }
});

/* ── "No orphan autonomous work" ──────────────────────────────────── */

test('an artifact no firing claims is counted as an orphan', async () => {
  begin();
  try {
    await fireOnce('notify');
    assert.equal(await countOrphanBackgroundActions(USER, { storage }), 0);

    // Planted, because a counter that has never seen an orphan is a counter
    // that returns zero for any reason at all.
    await storage.set(userSubDoc(USER, WATCHER_NOTIFICATIONS, 'wtn_orphan'), {
      schemaVersion: 'watcher-notification-v1',
      notificationId: 'wtn_orphan',
      watcherId: 'wtc_gone',
      scopeId: USER,
      state: 'queued',
      signalKind: 'flight',
      subjectRef: 'flt_ly315',
      reason: 'digest_changed',
      queuedAt: T1.toISOString(),
      provenanceRef: 'flights/x',
    });
    assert.equal(await countOrphanBackgroundActions(USER, { storage }), 1);
    assert.equal((await listBackgroundAttribution(USER, {}, { storage })).orphanCount, 1);
  } finally {
    end();
  }
});

test("a state change the user's own act produced is not autonomous work", async () => {
  begin();
  try {
    await fireOnce('notify');
    // A commitment edit writes a state change with a non-watcher source. It is
    // attributable to the person by definition and must not be counted as an
    // orphan — otherwise every ordinary edit would read as unexplained
    // background work.
    await storage.set(userSubDoc(USER, PLANNING_STATE_CHANGES, 'manual-edit'), {
      schemaVersion: 'planning-state-change-v1',
      changeId: 'manual-edit',
      scopeId: USER,
      source: 'commitment',
      entityId: 'cmt_1',
      occurredAt: T1.toISOString(),
      changedFields: ['dueAt'],
      beforeDigest: null,
      afterDigest: 'd2',
      provenanceRef: 'commitments/cmt_1',
    });
    assert.equal(await countOrphanBackgroundActions(USER, { storage }), 0);
  } finally {
    end();
  }
});

test('the orphan count is not limited to the page of actions returned', async () => {
  begin();
  try {
    await fireOnce('notify');
    await storage.set(userSubDoc(USER, WATCHER_NOTIFICATIONS, 'wtn_orphan'), {
      schemaVersion: 'watcher-notification-v1',
      notificationId: 'wtn_orphan',
      watcherId: 'wtc_gone',
      scopeId: USER,
      state: 'queued',
      signalKind: 'flight',
      subjectRef: 'x',
      reason: 'digest_changed',
      queuedAt: T1.toISOString(),
      provenanceRef: 'flights/x',
    });
    // A single orphan outside a narrow window must not read as zero: that is
    // the one wrong answer this number can give.
    const view = await listBackgroundAttribution(USER, { limit: 1 }, { storage });
    assert.equal(view.actions.length, 1);
    assert.equal(view.orphanCount, 1);
  } finally {
    end();
  }
});

/* ── The route ────────────────────────────────────────────────────── */

test('the route refuses an unauthenticated caller', async () => {
  begin();
  try {
    const anonymous = new Request(`${baseUrl}/api/mobile/trust/background-activity/attribution`);
    assert.equal((await attributionGet(anonymous)).status, 401);
  } finally {
    end();
  }
});

test('the route answers the feed, and the ref question, from one path', async () => {
  begin();
  try {
    const watcherId = await fireOnce('replan_if_impacted');
    const changes = await storage.list<PlanningStateChange>(userCol(USER, PLANNING_STATE_CHANGES));
    const changeId = changes[0].data.changeId;

    const feed = await json(await attributionGet(req('/api/mobile/trust/background-activity/attribution')));
    assert.equal(feed.success, true);
    assert.equal(feed.actions.length, 1);
    assert.equal(feed.orphanCount, 0);
    assert.equal(feed.schemaVersion, 'background-monitor-v1');

    const asked = await json(await attributionGet(
      req(`/api/mobile/trust/background-activity/attribution?ref=${encodeURIComponent(changeId)}`),
    ));
    assert.equal(asked.actions.length, 1);
    assert.equal(asked.actions[0].watcherId, watcherId);
    // The ref form answers one question and does not pretend to answer the
    // other: an orphan count over a filtered view would be meaningless.
    assert.equal(asked.orphanCount, undefined);
  } finally {
    end();
  }
});

test('the route bounds what it can be asked for', async () => {
  begin();
  try {
    await fireOnce('notify');
    for (const bad of ['0', '-1', '1.5', '201', 'all']) {
      const response = await attributionGet(req(`/api/mobile/trust/background-activity/attribution?limit=${bad}`));
      assert.equal(response.status, 400, `limit=${bad} was accepted`);
    }
    const refs = Array.from({ length: 51 }, (_unused, index) => `ref=r${index}`).join('&');
    const tooMany = await attributionGet(req(`/api/mobile/trust/background-activity/attribution?${refs}`));
    assert.equal(tooMany.status, 400);
  } finally {
    end();
  }
});

test('one account never sees another account\'s background actions', async () => {
  begin();
  try {
    await fireOnce('notify', OTHER);
    const mine = await json(await attributionGet(req('/api/mobile/trust/background-activity/attribution')));
    assert.deepEqual(mine.actions, []);
    const theirs = await json(await attributionGet(
      req('/api/mobile/trust/background-activity/attribution', OTHER),
    ));
    assert.equal(theirs.actions.length, 1);
  } finally {
    end();
  }
});

/* ── "No raw token/provider payload appears" ──────────────────────── */

test('no provenance pointer, subject or provider payload appears anywhere in the response', async () => {
  begin();
  try {
    await fireOnce('notify');
    const response = await attributionGet(req('/api/mobile/trust/background-activity/attribution'));
    const serialized = JSON.stringify(await json(response));

    // Over the whole response, not field by field: the field being guarded
    // against is the one nobody remembered to list.
    assert.equal(serialized.includes(SECRET), false, 'a provider pointer reached the response');
    assert.equal(serialized.includes('provenanceRef'), false, 'the provenance pointer is being projected');
    // `subjectRef` is opaque, but it is also what identifies *which* flight is
    // being watched, and a history of what happened does not need it.
    assert.equal(serialized.includes('flt_ly315'), false, 'the watched subject reached the response');
  } finally {
    end();
  }
});

test('a blocked firing is still attributable, and says the policy stopped it', () => {
  // Built from the contract rather than from a sweep: the engine only produces
  // `policy_blocked` when the Action Policy refuses, which the four local
  // capabilities never do in this harness. What is under test is the
  // projection's reading of the outcome, and that is a pure function.
  const blocked: WatcherFireEvent = {
    version: WATCHER_CONTRACT_VERSION,
    schemaVersion: WATCHER_EVENT_SCHEMA_VERSION,
    eventId: 'evt_1',
    watcherId: 'wtc_1',
    scopeId: USER,
    signalId: 'flight:flt_ly315:d2',
    provider: 'aviation',
    signalKind: 'flight',
    subjectRef: 'flt_ly315',
    observedAt: T0.toISOString(),
    firedAt: T1.toISOString(),
    effect: 'notify',
    outcome: 'policy_blocked',
    reason: 'capability_denied',
    policyDecision: 'denied',
    provenanceRef: `flights/${SECRET}`,
    effectRef: null,
  };
  const action = projectAttribution(blocked);
  assert.equal(action.artifact.kind, 'none');
  assert.equal(action.artifact.ref, null);
  assert.equal(action.policyDecision, 'denied');
  assert.equal(action.condition, 'capability_denied');
});
