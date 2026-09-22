/**
 * The four things #525 says a watcher must never be able to do.
 *
 *  1. Send a provider write action. There is no Action Gateway flow in this
 *     repository, so the requirement here is not "ask for confirmation" — it
 *     is that the capability is unreachable at all.
 *  2. Call the planner. A `replan_if_impacted` watcher appends a normalized
 *     change and stops; something else decides whether to replan.
 *  3. Create canonical work. `propose_commitment` produces a proposal.
 *  4. Execute anything without a provenance pointer and a reason.
 *
 * ── Why some of these are asserted against the source text ─────────
 *
 * "This module cannot reach the planner" is a statement about the import
 * graph, and an assertion about behaviour can only ever sample it: an engine
 * that called the planner on one branch nobody thought to exercise would pass
 * every behavioural test in this directory. So the reachability claims are
 * checked where they are actually true or false — in what the watcher modules
 * import — and the behavioural tests next to them prove the resulting
 * behaviour is the one that import graph implies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTION_CAPABILITY_POLICIES,
  evaluateActionPolicy,
  type CapabilityId,
} from '../../src/contracts/v1/actionPolicyContracts.ts';
import {
  WATCHER_EFFECT_CAPABILITIES,
  WATCHER_EFFECTS,
  WATCHER_POLICY,
  evaluateWatchCondition,
  watchConditionReason,
} from '../../src/contracts/v1/watcherContracts.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userCol, userSubDoc, WATCHER_EVENTS, WATCHERS } from '../../lib/storage/paths.ts';
import { createWatcherStore, type StoredWatcher } from '../../lib/watchers/watcherStore.ts';
import { runWatcherSweep } from '../../lib/watchers/watcherEngine.ts';
import { createWatcherSignalRegistry, type WatcherSignalObserver } from '../../lib/watchers/signals.ts';
import {
  WATCHER_SIGNAL_SCHEMA_VERSION,
  type WatcherFireEvent,
} from '../../src/contracts/v1/watcherContracts.ts';

const WATCHER_LIB = join(process.cwd(), 'lib', 'watchers');
const UID = 'WatcherSafetyUserxxxxxxxxxxx'.slice(0, 28);

function watcherSources(): Array<{ file: string; text: string }> {
  return readdirSync(WATCHER_LIB)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => ({ file: entry, text: readFileSync(join(WATCHER_LIB, entry), 'utf8') }));
}

/* ── 1. No provider write is reachable ────────────────────────────── */

test('every watcher effect maps to a local capability, and no external write is in reach', () => {
  const policyFor = (capability: CapabilityId) =>
    ACTION_CAPABILITY_POLICIES.find((entry) => entry.capability === capability);

  // The table covers exactly the four effects: no effect without a policy row
  // (which would be denied at runtime) and no policy row for an effect that
  // does not exist (which would be a capability nobody can see).
  assert.deepEqual(Object.keys(WATCHER_EFFECT_CAPABILITIES).sort(), [...WATCHER_EFFECTS].sort());

  for (const effect of WATCHER_EFFECTS) {
    const capability = WATCHER_EFFECT_CAPABILITIES[effect];
    const policy = policyFor(capability);
    assert.ok(policy, `${effect} maps to ${capability}, which the Action Policy does not know`);
    assert.equal(policy.tier, 'low_risk_local_write', `${effect} is not a local write`);
    assert.equal(policy.modelMaySelectRawProviderTool, false);
    assert.equal(policy.auditRequired, true);

    // And the decision the engine actually asks for — system actor, nothing
    // confirmed, automatic external writes not allowed — comes back allowed.
    const decision = evaluateActionPolicy({
      capability,
      provider: null,
      actor: 'system',
      userConfirmed: false,
      strongConfirmation: false,
      settingsAllowAutomaticExternalWrites: false,
    });
    assert.equal(decision.decision, 'allowed', `${effect} cannot run as an unattended system action`);
  }

  // Nothing a watcher can name is an external write, stated over the whole
  // policy table rather than over the four rows above: if a future edit
  // retiered one of these capabilities, this is what would notice.
  const external = new Set(
    ACTION_CAPABILITY_POLICIES.filter((entry) => entry.tier === 'external_write').map((entry) => entry.capability),
  );
  assert.ok(external.size > 0, 'the policy table has no external writes, so this assertion proves nothing');
  for (const capability of Object.values(WATCHER_EFFECT_CAPABILITIES)) {
    assert.ok(!external.has(capability), `a watcher can reach the external write ${capability}`);
  }
});

test('no watcher module names a provider-write capability or a confirmation override', () => {
  const external = ACTION_CAPABILITY_POLICIES
    .filter((entry) => entry.tier === 'external_write' || entry.tier === 'unsupported')
    .map((entry) => entry.capability);

  for (const { file, text } of watcherSources()) {
    for (const capability of external) {
      assert.ok(!text.includes(capability), `lib/watchers/${file} names the non-local capability ${capability}`);
    }
    // The three flags that would turn a refusal into an allowance. A watcher
    // fires with nobody present, so none of them may ever be true here.
    for (const flag of ['userConfirmed: true', 'strongConfirmation: true', 'settingsAllowAutomaticExternalWrites: true']) {
      assert.ok(!text.includes(flag), `lib/watchers/${file} sets ${flag}`);
    }
  }
});

test('a stored watcher whose effect the policy does not know is recorded, not executed', async () => {
  const storage: MemoryStorageAdapter = createMemoryStorage();
  setStorageForTests(storage);
  try {
    // The shape a corrupted document, a rolled-back deploy or a contract
    // widened without a policy row would leave behind. It must not throw, must
    // not execute, and must leave a row saying why.
    const watcherId = 'wtc_00000000-0000-4000-8000-000000000001';
    const forged = {
      definition: {
        version: 'v1',
        schemaVersion: 'watcher-v1',
        watcherId,
        scopeId: UID,
        enabled: true,
        source: { provider: 'aviation', connectionId: null, signalKind: 'flight', subjectRef: 'flt_x' },
        condition: { kind: 'digest_changed' },
        effect: 'create_calendar_event',
        createdBy: 'user',
        createdAt: '2026-09-20T09:00:00.000Z',
        updatedAt: '2026-09-20T09:00:00.000Z',
      },
      runtime: {
        watcherId,
        scopeId: UID,
        status: 'active',
        blockedReason: null,
        lastSignalId: 'flight:flt_x:old',
        lastDigest: 'old',
        lastMeasures: [],
        lastObservedAt: '2026-09-20T09:00:00.000Z',
        lastFiredAt: null,
        fireCount: 0,
        updatedAt: '2026-09-20T09:00:00.000Z',
      },
    } as unknown as StoredWatcher;
    await storage.set(userSubDoc(UID, WATCHERS, watcherId), forged);

    const observer: WatcherSignalObserver = {
      supports: () => true,
      async observe(source, context) {
        return {
          schemaVersion: WATCHER_SIGNAL_SCHEMA_VERSION,
          signalId: 'flight:flt_x:new',
          provider: source.provider,
          signalKind: source.signalKind,
          subjectRef: source.subjectRef,
          observedAt: context.now,
          stateDigest: 'new',
          provenanceRef: 'flights/flt_x',
          measures: [],
        };
      },
    };

    const totals = await runWatcherSweep({
      storage,
      now: new Date('2026-09-20T09:01:00.000Z'),
      registry: createWatcherSignalRegistry([observer]),
    });

    assert.equal(totals.policyBlocked, 1, JSON.stringify(totals));
    assert.equal(totals.fired, 0);
    assert.deepEqual(totals.failures, [], 'an unknown effect became a sweep failure instead of a refusal');

    const events = (await storage.list<WatcherFireEvent>(userCol(UID, WATCHER_EVENTS))).map((row) => row.data);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.outcome, 'policy_blocked');
    assert.equal(events[0]!.policyDecision, 'denied');
    assert.equal(events[0]!.reason, 'unknown_watcher_effect');
    assert.equal(events[0]!.effectRef, null);

    // A refusal is not a firing: it must not advance the fire counters the
    // surface shows the user.
    const after = (await createWatcherStore(UID, storage).get(watcherId))!;
    assert.equal(after.runtime.fireCount, 0);
    assert.equal(after.runtime.lastFiredAt, null);

    // And nothing outside the watcher's own collections was written.
    for (const path of storage.pathsForTests()) {
      assert.match(path, /\/(watchers|watcherEvents)\//, `a denied effect still wrote ${path}`);
    }
  } finally {
    resetStorageForTests();
  }
});

/* ── 2 & 3. The planner and canonical work are out of reach ───────── */

test('no watcher module can reach the planner, the domain state machine or a commitment writer', () => {
  /**
   * Imports the watcher modules are allowed to have. The list is short on
   * purpose: an engine that may import anything is an engine whose "it cannot
   * call the planner" is a promise rather than a fact.
   */
  const ALLOWED = [
    'node:crypto',
    '../../src/contracts/v1/watcherContracts',
    '../../src/contracts/v1/actionPolicyContracts',
    '../../src/contracts/v1/integrationConnectionContracts',
    // #527's read projection. A contracts module like the four around it:
    // closed vocabularies, interfaces and two type guards, importing nothing
    // but `moduleContracts`. It is on this list because the list is the fact
    // rather than the promise — a projection that later reached for a planner
    // type would have to come back here to do it.
    '../../src/contracts/v1/backgroundMonitorContracts',
    '../../src/contracts/v1/fixtureContracts',
    '../storage',
    '../storage/paths',
    '../userState/userStateService',
    './watcherStore',
    './signals',
  ];

  for (const { file, text } of watcherSources()) {
    for (const match of Array.from(text.matchAll(/from '([^']+)'/g))) {
      assert.ok(
        ALLOWED.includes(match[1]!),
        `lib/watchers/${file} imports ${match[1]}, which is not on the watcher module's allowed list`,
      );
    }
  }
});

test('the watcher policy states, as data, what the engine is not allowed to do', () => {
  assert.deepEqual({ ...WATCHER_POLICY }, {
    effectsRouteThroughActionPolicy: true,
    providerWriteCapabilitiesAllowed: false,
    directPlannerCallsAllowed: false,
    proposalsCreateCanonicalWork: false,
    telemetryCarriesContent: false,
    providerPayloadInContracts: false,
  });
  // Frozen, so the module being judged cannot widen the rule it is judged by.
  assert.throws(() => {
    (WATCHER_POLICY as unknown as Record<string, boolean>).providerWriteCapabilitiesAllowed = true;
  });
});

/* ── 4. Provenance and reason ─────────────────────────────────────── */

test('a firing has no shape without a reason and a provenance pointer', () => {
  // Both reason codes exist and are distinct, so "reason" is never a constant
  // standing in for one.
  assert.equal(watchConditionReason({ kind: 'digest_changed' }), 'digest_changed');
  assert.equal(
    watchConditionReason({ kind: 'threshold', metric: 'readiness_score', operator: 'lt', value: 0.3 }),
    'threshold_crossed',
  );

  const contract = readFileSync(join(process.cwd(), 'src', 'contracts', 'v1', 'watcherContracts.ts'), 'utf8');
  for (const required of ['readonly provenanceRef: string', 'readonly reason: string']) {
    assert.ok(contract.includes(required), `the fire event contract lost "${required}"`);
  }
  // A contract with no field for provider content cannot leak one. These are
  // the names such a field would plausibly have — checked against the
  // declarations only, since the prose above them discusses payloads at
  // length and a scan that read the comments would be measuring the comments.
  const declarations = contract
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['payload', 'rawBody', 'providerResponse', 'title', 'body']) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\b`, 'i').test(declarations),
      `the watcher contracts grew a "${forbidden}" field`,
    );
  }
});

/* ── The condition evaluator's own edges ──────────────────────────── */

test('no condition fires without a baseline, and a threshold fires only on the crossing', () => {
  const unprimed = { lastDigest: null, lastMeasures: [] as const };
  assert.equal(
    evaluateWatchCondition({ kind: 'digest_changed' }, { stateDigest: 'b', measures: [] }, unprimed),
    false,
    'an unprimed digest watcher fired, which is how a resume would replay history',
  );
  assert.equal(
    evaluateWatchCondition({ kind: 'digest_changed' }, { stateDigest: 'b', measures: [] }, { lastDigest: 'a', lastMeasures: [] }),
    true,
  );
  assert.equal(
    evaluateWatchCondition({ kind: 'digest_changed' }, { stateDigest: 'a', measures: [] }, { lastDigest: 'a', lastMeasures: [] }),
    false,
  );

  const below = { kind: 'threshold', metric: 'readiness_score', operator: 'lt', value: 0.3 } as const;
  const measure = (value: number) => ({ stateDigest: `d${value}`, measures: [{ metric: 'readiness_score', value }] });
  const baseline = (value: number) => ({ lastDigest: `d${value}`, lastMeasures: [{ metric: 'readiness_score', value }] });

  assert.equal(evaluateWatchCondition(below, measure(0.2), baseline(0.8)), true, 'the crossing did not fire');
  assert.equal(evaluateWatchCondition(below, measure(0.1), baseline(0.2)), false, 'staying below fired again');
  assert.equal(evaluateWatchCondition(below, measure(0.8), baseline(0.2)), false, 'recovering fired');
  assert.equal(evaluateWatchCondition(below, measure(0.2), unprimed), false, 'an unprimed threshold fired');
  // A measure the adapter does not produce is never a crossing, in either
  // direction: an absent number is not a low one.
  assert.equal(
    evaluateWatchCondition(below, { stateDigest: 'x', measures: [] }, baseline(0.8)),
    false,
    'a missing measure was read as satisfying the threshold',
  );
});
