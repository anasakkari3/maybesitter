/**
 * "Every automatic replan can answer which monitor caused it" (#527, AC 2).
 *
 * `tests/watchers/backgroundAttribution.test.ts` proves the *join*: given the
 * change ids behind a replan, the monitors come back. What it cannot prove is
 * that anybody still holds those ids once the replan is over — and until this
 * slice nobody did. `StoredDailyPlan` recorded `generation`, `replaces` and
 * `inputDigest`, and a plan read back from storage had no way to name its own
 * cause; the answer lived only in the in-memory pipeline result, which is gone
 * the moment the tick returns.
 *
 * So every test here re-reads the plan **from storage** and asks it. Asserting
 * on the service's return value would prove the pipeline still knows what it
 * always knew, which is not the criterion.
 *
 * Nothing here hand-writes a `WatcherFireEvent` or a `PlanningStateChange`:
 * the watcher is created, the engine sweeps, the engine fires, and the change
 * the replan consumes is the one production writes. The only thing the test
 * supplies is `entityFacts` — the changed entity's post-change time facts,
 * which is the caller's input to the service in production too, and which is
 * what makes the impact `REPLAN_REQUIRED` rather than `PLAN_STALE`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { PLANNING_STATE_CHANGES, userCol, userDoc } from '../../lib/storage/paths.ts';
import { createWatcherStore, type NewWatcherInput } from '../../lib/watchers/watcherStore.ts';
import { runWatcherSweep } from '../../lib/watchers/watcherEngine.ts';
import { createWatcherSignalRegistry, type WatcherSignalObserver } from '../../lib/watchers/signals.ts';
import {
  WATCHER_EFFECT_CAPABILITIES,
  WATCHER_SIGNAL_SCHEMA_VERSION,
  type PlanningStateChange,
} from '../../src/contracts/v1/watcherContracts.ts';
import { processStateChangesForUser } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import {
  createIfAbsent,
  listPlanEvents,
  planPath,
  readStoredPlan,
  type StoredDailyPlan,
} from '../../lib/services/dailyPlan/planStore.ts';
import { causeChangeIdsOf, planCause } from '../../lib/services/dailyPlan/planCause.ts';
import { attributionsForArtifacts } from '../../lib/watchers/backgroundAttribution.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { regeneratePlan } from '../../lib/services/dailyPlan/planActions.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import type { Commitment, DomainState } from '../../src/domain/stateMachine.ts';
import {
  PLANNING_CONTRACT_VERSION,
  PLANNING_SCHEMA_VERSION,
  type Plan,
  type PlannedItem,
  type PlanningConstraints,
} from '../../src/contracts/v1/planningContracts.ts';
import { DAILY_PLAN_CONFIG, dailyPlanScheduleSources } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { reconcileScheduleBlocks } from '../../lib/planning/scheduler/index.ts';

const UID = 'user_plan_cause_1';
const OTHER = 'user_plan_cause_2';
const DATE = '2026-11-09';
const TZ = 'Asia/Jerusalem';
const T0 = new Date('2026-11-09T07:50:00.000Z');
const T1 = new Date('2026-11-09T07:55:00.000Z');
const NOW = new Date('2026-11-09T08:00:00.000Z');
/** After the automatic replan, so the manual rebuild is the later ledger entry. */
const LATER = new Date('2026-11-09T09:00:00.000Z');

/** The slot generation 1 places, and the slot the watcher's change collides with. */
const SLOT = { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T08:00:00.000Z` };

let storage: MemoryStorageAdapter;
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
      provenanceRef: `flights/${source.subjectRef}`,
      measures: [],
    };
  },
};

/**
 * A meeting whose attendee count is watched, and which grows.
 *
 * The point of the second watcher is that it is real and that it genuinely
 * does *not* move the day: the engine writes `changedFields: [metric]` for a
 * threshold condition, `attendees` is in `NON_PLANNING_CHANGE_FIELDS`, and the
 * impact evaluator's rule 2 therefore answers `NO_EFFECT` — "a description
 * edit cannot move an interval". A monitor that fired, was allowed, and wrote
 * a state change, and still caused nothing.
 */
let attendees = 4;

const meetingObserver: WatcherSignalObserver = {
  supports: (source) => source.signalKind === 'meeting',
  async observe(source, context) {
    return {
      schemaVersion: WATCHER_SIGNAL_SCHEMA_VERSION,
      signalId: `meeting:${source.subjectRef}:${attendees}`,
      provider: source.provider,
      signalKind: 'meeting',
      subjectRef: source.subjectRef,
      observedAt: context.now,
      stateDigest: `attendees-${attendees}`,
      provenanceRef: `meetings/${source.subjectRef}`,
      measures: [{ metric: 'attendees', value: attendees }],
    };
  },
};

const meetingWatcherInput: NewWatcherInput = {
  enabled: true,
  source: { provider: 'meeting', connectionId: null, signalKind: 'meeting', subjectRef: 'mtg_quarterly' },
  condition: { kind: 'threshold', metric: 'attendees', operator: 'gte', value: 10 },
  effect: 'replan_if_impacted',
  createdBy: 'user',
};

const watcherInput: NewWatcherInput = {
  enabled: true,
  source: { provider: 'aviation', connectionId: null, signalKind: 'flight', subjectRef: 'flt_ly315' },
  condition: { kind: 'digest_changed' },
  effect: 'replan_if_impacted',
  createdBy: 'user',
};

/**
 * A real watcher, primed and then fired once.
 *
 * Two sweeps: the first absorbs a baseline (an unprimed watcher never fires),
 * the second sees a changed digest and fires. That is the engine's rule, not
 * this file's, which is why the fixture runs it rather than asserting it.
 */
async function fireReplanWatcher(uid = UID): Promise<{ watcherId: string; changeId: string }> {
  const store = createWatcherStore(uid, storage);
  const created = await store.create(watcherInput, T0.toISOString());
  const registry = createWatcherSignalRegistry([observer]);
  await runWatcherSweep({ storage, now: T0, registry });
  digest = 'digest-two';
  await runWatcherSweep({ storage, now: T1, registry });

  const changes = await storage.list<PlanningStateChange>(userCol(uid, PLANNING_STATE_CHANGES));
  assert.equal(changes.length, 1, 'the replan firing wrote no state change');
  assert.equal(changes[0]!.data.source, 'watcher');
  return { watcherId: created.definition.watcherId, changeId: changes[0]!.data.changeId };
}

/**
 * Both watchers, primed and then fired in one sweep.
 *
 * Two monitors, one sweep, two firings, two state changes — and only one of
 * them can move a placement. Returns each one's id so the test can say which
 * of the two the plan is allowed to name.
 */
async function fireBothWatchers(): Promise<{
  flight: { watcherId: string; changeId: string };
  meeting: { watcherId: string; changeId: string };
}> {
  const store = createWatcherStore(UID, storage);
  const flightWatcher = await store.create(watcherInput, T0.toISOString());
  const meetingWatcher = await store.create(meetingWatcherInput, T0.toISOString());
  const registry = createWatcherSignalRegistry([observer, meetingObserver]);

  await runWatcherSweep({ storage, now: T0, registry });
  digest = 'digest-two';
  attendees = 12;
  await runWatcherSweep({ storage, now: T1, registry });

  const changes = (await storage.list<PlanningStateChange>(userCol(UID, PLANNING_STATE_CHANGES))).map((row) => row.data);
  assert.equal(changes.length, 2, 'the sweep did not produce one state change per monitor');
  const byWatcher = new Map(changes.map((change) => [change.entityId, change]));
  const flightChange = byWatcher.get(flightWatcher.definition.watcherId);
  const meetingChange = byWatcher.get(meetingWatcher.definition.watcherId);
  assert.ok(flightChange && meetingChange, 'one of the two monitors wrote nothing');
  // The two declare different fields, which is the whole reason their impacts
  // differ. Asserted rather than assumed: if the engine ever stopped
  // declaring the threshold metric, this test would otherwise quietly become
  // a test of two identical changes.
  assert.deepEqual(flightChange.changedFields, ['digest']);
  assert.deepEqual(meetingChange.changedFields, ['attendees']);
  return {
    flight: { watcherId: flightWatcher.definition.watcherId, changeId: flightChange.changeId },
    meeting: { watcherId: meetingWatcher.definition.watcherId, changeId: meetingChange.changeId },
  };
}

/** The automatic replan, with the facts that make the flight change bite. */
async function runAutomaticReplan() {
  return processStateChangesForUser(UID, {
    storage,
    now: NOW,
    date: DATE,
    entityFacts: { interval: { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T07:30:00.000Z` }, blocking: true },
    policyConfig: { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 120 },
  });
}

/** The account a plan and a monitored day need. */
async function seedAccount(): Promise<void> {
  await storage.set(userDoc(UID), { timezone: TZ, locale: 'en' });
  const domain: DomainState = {
    ...createEmptyDomainState(),
    commitments: { 'com-1': sampleCommitment('com-1') },
  };
  await persistParticipantState(UID, domain);
  await seedGeneration1([{ itemId: 'com-1', interval: SLOT, reservedInterval: SLOT }]);
}

function sampleCommitment(id: string): Commitment {
  return {
    id,
    title: 'Review PR',
    kind: 'task',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: `${DATE}T18:00:00.000Z`, endAt: null, remindAt: null, allDay: false, timezone: TZ },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-11-08T10:00:00.000Z',
    updatedAt: '2026-11-08T10:00:00.000Z',
    completedAt: null,
    confirmedAt: '2026-11-08T10:00:00.000Z',
    droppedAt: null,
    category: 'work',
    categorySource: 'inferred',
  };
}

/**
 * Generation 1, exactly as it was written before this slice existed: no
 * `causeChangeIds` key at all. It doubles as the legacy-document fixture.
 */
async function seedGeneration1(scheduled: PlannedItem[]): Promise<StoredDailyPlan> {
  const plan: Plan = {
    version: PLANNING_CONTRACT_VERSION,
    schema: PLANNING_SCHEMA_VERSION,
    scopeId: `${UID}:${DATE}`,
    horizon: { startsAt: `${DATE}T00:00:00.000Z`, endsAt: `${DATE}T23:59:59.999Z` },
    scheduled,
    unscheduled: [],
    constraintReasons: [],
    inputDigest: 'digest-base-gen1',
  };
  const constraints: PlanningConstraints = {
    scopeId: `${UID}:${DATE}`,
    timezone: TZ,
    horizon: plan.horizon,
    workingWindows: [{ windowId: 'w0', weekday: 1, startMinute: 8 * 60, endMinute: 20 * 60, timezone: TZ }],
    fixedEvents: [],
    items: scheduled.map((item) => ({
      itemId: item.itemId,
      title: item.itemId,
      effort: { kind: 'known' as const, minutes: 60 },
      earliestStartAt: null,
      deadlineAt: null,
      priority: 2,
      dependsOn: [],
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    })),
  };
  const document: StoredDailyPlan = {
    date: DATE,
    timezone: TZ,
    locale: 'en',
    status: 'accepted',
    plan,
    blocks: reconcileScheduleBlocks({
      constraints,
      plan,
      generation: 1,
      sources: dailyPlanScheduleSources(constraints),
      previous: null,
    }),
    replaces: null,
    constraints,
    config: DAILY_PLAN_CONFIG,
    explanation: { text: 'Initial plan', locale: 'en', source: 'template', validated: true },
    edits: { moves: [], removals: [] },
    generatedAt: '2026-11-09T07:30:00.000Z',
    generation: 1,
    inputDigest: 'digest-base-gen1',
    acceptedAt: '2026-11-09T07:35:00.000Z',
    updatedAt: '2026-11-09T07:35:00.000Z',
  };
  await createIfAbsent(UID, document, storage);
  return document;
}

function begin(): void {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  digest = 'digest-one';
  attendees = 4;
}

function end(): void {
  resetStorageForTests();
}

/* ── The criterion ────────────────────────────────────────────────── */

test('a stored plan produced by an automatic replan names the monitor that caused it', async () => {
  begin();
  try {
    await seedAccount();
    const { watcherId, changeId } = await fireReplanWatcher();

    // The service reads the pending change from storage itself — the watcher's
    // own record, not one this test handed it.
    const report = await runAutomaticReplan();
    assert.equal(report.pipelineResult.impact.decision, 'REPLAN_REQUIRED');
    assert.equal(report.pipelineResult.policyDecision?.action, 'auto_apply');
    assert.equal(report.planStored, true, 'the automatic replan did not reach storage');

    // From here on, only what storage holds. The pipeline result is discarded.
    const stored = await readStoredPlan(UID, DATE, storage);
    assert.ok(stored);
    assert.equal(stored.generation, 2);
    assert.deepEqual(causeChangeIdsOf(stored), [changeId], 'the stored plan does not record its cause');

    const cause = await planCause(UID, DATE, { storage });
    assert.ok(cause, 'the stored plan could not be asked which monitor caused it');
    assert.equal(cause.generation, 2);
    assert.deepEqual(cause.causeChangeIds, [changeId]);
    assert.equal(cause.attributions.length, 1, 'the replan could not be attributed to a monitor');
    assert.equal(cause.attributions[0]!.watcherId, watcherId);
    assert.equal(cause.attributions[0]!.monitorId, `mon_${watcherId}`);
    assert.equal(cause.attributions[0]!.condition, 'digest_changed');
    assert.equal(cause.attributions[0]!.capability, WATCHER_EFFECT_CAPABILITIES.replan_if_impacted);
    assert.equal(cause.attributions[0]!.effect, 'replan_if_impacted');
    assert.equal(cause.attributions[0]!.artifact.kind, 'state_change');
    assert.equal(cause.attributions[0]!.artifact.ref, changeId);

    // The ledger carries it too, so the causes survive the next regeneration.
    const regenerated = (await listPlanEvents(UID, storage)).filter((event) => event.type === 'plan_regenerated');
    assert.equal(regenerated.length, 1);
    assert.deepEqual(regenerated[0]!.causeChangeIds, [changeId]);
  } finally {
    end();
  }
});

/* ── A monitor that did nothing is not named ──────────────────────── */

test('a monitor that fired in the same sweep but did not impact the plan is not recorded as a cause', async () => {
  begin();
  try {
    await seedAccount();
    const { flight, meeting } = await fireBothWatchers();

    const report = await runAutomaticReplan();
    assert.equal(report.pipelineResult.impact.decision, 'REPLAN_REQUIRED');
    assert.equal(report.planStored, true);

    // The request still subsumes both — that is what a replan request is, and
    // this slice did not change it.
    assert.deepEqual(
      [...(report.pipelineResult.queueEntry?.request.causeChangeIds ?? [])].sort(),
      [flight.changeId, meeting.changeId].sort(),
      'the queue request no longer records the whole batch',
    );

    // What the plan records is narrower, and this is the difference the whole
    // finding is about: the meeting monitor fired, was allowed, wrote a state
    // change, and did not move the day. Naming it here would tell the user a
    // monitor rearranged their afternoon when it did not.
    const cause = await planCause(UID, DATE, { storage });
    assert.ok(cause);
    assert.deepEqual(cause.causeChangeIds, [flight.changeId], 'the plan names a change that caused nothing');
    assert.equal(cause.attributions.length, 1, 'a monitor that caused nothing was attributed');
    assert.equal(cause.attributions[0]!.watcherId, flight.watcherId);
    assert.ok(
      !cause.attributions.some((attribution) => attribution.watcherId === meeting.watcherId),
      'the non-impacting monitor was named as a cause',
    );

    // Both firings are still on the account and still attributable on their
    // own terms: this is about what the *plan* claims, not about hiding work.
    const both = await attributionsForArtifacts(UID, [flight.changeId, meeting.changeId], { storage });
    assert.equal(both.length, 2, 'the background activity history lost a firing');
  } finally {
    end();
  }
});

/* ── Documents written before the field existed ───────────────────── */

test('a plan stored before this field existed is read without crashing and claims no cause', async () => {
  begin();
  try {
    await storage.set(userDoc(UID), { timezone: TZ, locale: 'en' });
    // Written with no `causeChangeIds` key at all — the pre-#527 shape.
    await seedGeneration1([{ itemId: 'com-1', interval: SLOT, reservedInterval: SLOT }]);
    // And a firing exists, so "nothing came back" cannot be an empty account.
    await fireReplanWatcher();

    const cause = await planCause(UID, DATE, { storage });
    assert.ok(cause, 'a legacy plan document could not be read at all');
    assert.equal(cause.generation, 1);
    assert.deepEqual(cause.causeChangeIds, []);
    assert.deepEqual(cause.attributions, []);

    // A document whose field is present but not a list of ids is the same
    // case: unreadable provenance is absent provenance, never a throw on a
    // Trust surface whose job is to render what is known.
    const stored = await readStoredPlan(UID, DATE, storage);
    await storage.set(planPath(UID, DATE), { ...stored, causeChangeIds: 'chg-not-a-list' } as unknown as StoredDailyPlan);
    const damaged = await planCause(UID, DATE, { storage });
    assert.deepEqual(damaged?.causeChangeIds, []);
    assert.deepEqual(damaged?.attributions, []);

    // A list that is only *partly* ids is the same answer, and this is the
    // case worth writing down: keeping the readable members would hand back a
    // shorter cause list with nothing to say that anything was dropped, which
    // reads as "these are the monitors" rather than "some of them".
    await storage.set(
      planPath(UID, DATE),
      { ...stored, causeChangeIds: ['chg-readable', 42] } as unknown as StoredDailyPlan,
    );
    const partial = await planCause(UID, DATE, { storage });
    assert.deepEqual(partial?.causeChangeIds, [], 'a partly damaged cause list was reported as complete');
    assert.deepEqual(partial?.attributions, []);
  } finally {
    end();
  }
});

test('a date with no plan answers null rather than an empty cause', async () => {
  begin();
  try {
    assert.equal(await planCause(UID, DATE, { storage }), null);
  } finally {
    end();
  }
});

/* ── A manual replan has no monitor behind it ─────────────────────── */

/**
 * The arrangement is the test.
 *
 * An earlier version of this built generation 1 and regenerated it, and
 * asserted `[]` — which the fixture satisfied all by itself, because nothing
 * in the account had ever carried a cause. It stayed green under the exact
 * defect it existed to catch: a `regeneratePlan` that wrote
 * `{ ...current, ...rebuilt }` and inherited the previous generation's cause.
 *
 * So the manual rebuild here starts from a generation that *does* carry one:
 * the automatic replan runs first and writes generation 2 with the flight
 * monitor's change id, and only then does the person ask for a rebuild. Now
 * `[]` is a claim the code has to earn.
 */
test('a manual regeneration drops the cause of the generation it replaces', async () => {
  begin();
  try {
    await seedAccount();
    const { changeId } = await fireReplanWatcher();
    assert.equal((await runAutomaticReplan()).planStored, true);

    // Generation 2 is caused, and provably so — the inheritance defect needs
    // something to inherit.
    const caused = await planCause(UID, DATE, { storage });
    assert.deepEqual(caused?.causeChangeIds, [changeId]);
    assert.equal(caused?.generation, 2);

    // A fixed clock, so the ledger order below is the order of events and not
    // whatever the machine's date happens to be relative to the fixture's.
    const outcome = await regeneratePlan(UID, DATE, { storage, now: () => LATER });
    assert.equal(outcome.ok, true, 'the manual rebuild was refused, so this test proves nothing');

    const cause = await planCause(UID, DATE, { storage });
    assert.ok(cause);
    assert.equal(cause.generation, 3);
    assert.deepEqual(cause.causeChangeIds, [], 'a manual rebuild inherited the automatic replan\'s cause');
    assert.deepEqual(cause.attributions, []);

    // And the ledger agrees: two `plan_regenerated` entries, only the first
    // of which names a monitor.
    const regenerated = (await listPlanEvents(UID, storage)).filter((event) => event.type === 'plan_regenerated');
    assert.equal(regenerated.length, 2);
    assert.deepEqual(regenerated[0]!.causeChangeIds, [changeId]);
    assert.equal(regenerated[1]!.causeChangeIds, undefined, 'a manual rebuild wrote a cause into the ledger');
  } finally {
    end();
  }
});

/* ── One account's causes are not another's ───────────────────────── */

test('a cause id belonging to another account attributes to nothing', async () => {
  begin();
  try {
    await seedAccount();
    const { changeId } = await fireReplanWatcher();
    assert.equal((await runAutomaticReplan()).planStored, true);

    // The same id, recorded on a different account's plan. The firing that
    // claims it lives under UID, and the join is scoped before it matches, so
    // the neighbour learns nothing about who is being watched.
    const mine = await readStoredPlan(UID, DATE, storage);
    assert.ok(mine);
    await storage.set(planPath(OTHER, DATE), { ...mine, causeChangeIds: [changeId] });

    const theirs = await planCause(OTHER, DATE, { storage });
    assert.ok(theirs);
    assert.deepEqual(theirs.causeChangeIds, [changeId], 'the fixture did not plant the foreign id');
    assert.deepEqual(theirs.attributions, [], 'one account resolved another account\'s monitor');

    // And the owner still can.
    assert.equal((await planCause(UID, DATE, { storage }))?.attributions.length, 1);
  } finally {
    end();
  }
});
