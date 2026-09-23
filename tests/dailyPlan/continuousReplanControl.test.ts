/**
 * The user's control over continuous replanning (#523, AC 9), and the patch
 * the default mode proposes.
 *
 * Three claims are made here, and each is written so that it can fail:
 *
 *  - **The switch is independent of provider sync.** The interesting assertion
 *    is not "nothing replanned" — a test that disconnected the calendar would
 *    pass that while describing a completely different product. It is that a
 *    *connected* provider is still connected, still syncing and still writing
 *    `PlanningStateChange` rows, in a sweep that still runs and still examines
 *    this account, while the plan is not touched. The second user in the same
 *    sweep, who has not switched anything off, is replanned in the same call,
 *    which is what makes the gate per-account rather than a feature flag.
 *  - **The default is on, and that default is load-bearing.** A user document
 *    written before the field existed must read as enabled. If
 *    `DEFAULT_CONTINUOUS_REPLAN_ENABLED` flips, the legacy account stops
 *    replanning and this file goes red.
 *  - **The default mode leaves something to review.** `propose_for_review`
 *    used to write a ledger line carrying the *old* generation and digest and
 *    drop the solved plan and the diff on the floor. The assertion is on the
 *    stored patch, not on the event.
 *
 * The monitoring pause (#567) is exercised in both directions because the two
 * switches are easy to conflate and mean different things: the pause silences
 * every watcher effect and is read only inside the watcher engine; this one
 * silences replanning and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import {
  PLANNING_STATE_CHANGES,
  PROVIDER_CONNECTIONS,
  userCol,
  userDoc,
  userSubDoc,
} from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor } from '../support/fakeAuth.ts';
import {
  CONTINUOUS_REPLAN_SWEEP_INTERVAL_MINUTES,
  processStateChangesForUser,
  runContinuousReplanTick,
} from '../../lib/services/dailyPlan/continuousReplanService.ts';
import {
  createIfAbsent,
  listPlanEvents,
  readStoredPlan,
  storePlanProposal,
  type StoredDailyPlan,
} from '../../lib/services/dailyPlan/planStore.ts';
import {
  DEFAULT_CONTINUOUS_REPLAN_ENABLED,
  planSettingsOf,
} from '../../lib/services/dailyPlan/planSettings.ts';
import { readPlanSettings, savePlanSettings } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { GET as settingsGet, PUT as settingsPut } from '../../src/app/api/mobile/settings/plan/route.ts';
import { replaceBusyBlocks } from '../../lib/calendar/busyBlocks.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import type { Commitment, DomainState } from '../../src/domain/stateMachine.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';
import {
  PLANNING_CONTRACT_VERSION,
  PLANNING_SCHEMA_VERSION,
  type Plan,
  type PlannedItem,
  type PlanningConstraints,
} from '../../src/contracts/v1/planningContracts.ts';
import { DAILY_PLAN_CONFIG, dailyPlanScheduleSources } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { reconcileScheduleBlocks } from '../../lib/planning/scheduler/index.ts';

const BASE = 'http://127.0.0.1:4321';
const DATE = '2026-11-09';
const TZ = 'Asia/Jerusalem';
const NOW = new Date('2026-11-09T08:00:00.000Z');

/** A connected calendar, exactly as the connection layer keeps one. */
const CONNECTION = Object.freeze({
  connectionId: 'conn_google_1',
  provider: 'google_calendar',
  state: 'connected',
  connectedAt: '2026-11-01T09:00:00.000Z',
  scopes: ['calendar.readonly'],
});

function commitmentFor(id: string): Commitment {
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

function planFor(uid: string, scheduled: PlannedItem[]): Plan {
  return {
    version: PLANNING_CONTRACT_VERSION,
    schema: PLANNING_SCHEMA_VERSION,
    scopeId: `${uid}:${DATE}`,
    horizon: { startsAt: `${DATE}T00:00:00.000Z`, endsAt: `${DATE}T23:59:59.999Z` },
    scheduled,
    unscheduled: [],
    constraintReasons: [],
    inputDigest: 'digest-base-gen1',
  };
}

const SLOT: PlannedItem = {
  itemId: 'com-1',
  interval: { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T08:00:00.000Z` },
  reservedInterval: { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T08:00:00.000Z` },
};

async function seedPlan(uid: string, storage: StorageAdapter): Promise<StoredDailyPlan> {
  const plan = planFor(uid, [SLOT]);
  const constraints: PlanningConstraints = {
    scopeId: `${uid}:${DATE}`,
    timezone: TZ,
    horizon: plan.horizon,
    workingWindows: [{ windowId: 'w0', weekday: 1, startMinute: 8 * 60, endMinute: 20 * 60, timezone: TZ }],
    fixedEvents: [],
    items: [{
      itemId: 'com-1',
      title: 'com-1',
      effort: { kind: 'known' as const, minutes: 60 },
      earliestStartAt: null,
      deadlineAt: null,
      priority: 2,
      dependsOn: [],
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    }],
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
  await createIfAbsent(uid, document, storage);
  return document;
}

/**
 * Everything a *connected provider's sync* leaves behind for one account: the
 * connection record it syncs under, the busy block it just wrote, and the
 * normalized change row that announces it.
 */
async function seedSyncedAccount(
  uid: string,
  storage: StorageAdapter,
  userDocument: Record<string, unknown>,
): Promise<void> {
  await storage.set(userDoc(uid), { timezone: TZ, locale: 'en', ...userDocument });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, CONNECTION.connectionId), { ...CONNECTION });

  const state: DomainState = { ...createEmptyDomainState(), commitments: { 'com-1': commitmentFor('com-1') } };
  await persistParticipantState(uid, state);
  await seedPlan(uid, storage);

  await replaceBusyBlocks(
    uid,
    'device:calendar-1',
    { startsAt: `${DATE}T00:00:00.000Z`, endsAt: `${DATE}T23:59:59.999Z` },
    [{
      blockId: 'busy-1',
      sourceId: 'device:calendar-1',
      sourceKind: 'device',
      startAt: `${DATE}T07:00:00.000Z`,
      endAt: `${DATE}T07:30:00.000Z`,
      allDay: false,
    }],
    { storage },
  );

  await storage.set(userSubDoc(uid, PLANNING_STATE_CHANGES, 'chg-busy-1'), changeFor(uid));
}

function changeFor(uid: string): PlanningStateChange {
  return {
    schemaVersion: 'planning-state-change-v1',
    changeId: 'chg-busy-1',
    scopeId: uid,
    source: 'calendar',
    entityId: 'busy-1',
    occurredAt: NOW.toISOString(),
    changedFields: ['interval', 'blocking'],
    beforeDigest: null,
    afterDigest: 'digest-busy-new',
    provenanceRef: 'calendar:refresh-1',
  };
}

const FACTS = {
  interval: { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T07:30:00.000Z` },
  blocking: true,
} as const;

/** `FACTS` as the one change these cases store (`chg-busy-1`) describes it (#605). */
const FACTS_BY_CHANGE = new Map([['chg-busy-1', FACTS]]);

/* ── The default ─────────────────────────────────────────────────── */

test('a user document written before the switch existed keeps continuous replanning on', async () => {
  // Both halves matter. The first pins the default at the one place it is
  // applied; the second proves the default is what the pipeline actually
  // reads, so flipping the constant is not merely a documentation change.
  assert.equal(
    planSettingsOf({ timezone: TZ }, TZ).continuousReplanEnabled,
    true,
    'an account that never chose must read as enabled',
  );
  assert.equal(DEFAULT_CONTINUOUS_REPLAN_ENABLED, true);

  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const uid = 'user_replan_legacy';
  try {
    // Deliberately a *legacy* document: planSettings exists and predates the
    // field entirely, which is the shape every account already in production
    // has.
    await seedSyncedAccount(uid, storage, {
      planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ },
    });

    const report = await processStateChangesForUser(uid, {
      storage,
      now: NOW,
      date: DATE,
      entityFactsByChangeId: FACTS_BY_CHANGE,
      policyConfig: { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 120 },
    });

    assert.equal(report.skipped, null, 'a legacy account must not be treated as having opted out');
    assert.equal(report.planStored, true);
    assert.equal((await readStoredPlan(uid, DATE, storage))?.generation, 2);
  } finally {
    resetStorageForTests();
  }
});

test('an explicit opt-out survives a sibling field the record can no longer read', async () => {
  // `planSettingsOf` collapses the whole record to the hard defaults when any
  // of `enabled`, `deliveryLocalTime` or `timezone` fails to validate — a
  // tzdata update that withdraws a zone is enough, and so is a hand-edit. The
  // header's rule for that collapse is that the defaults are the *safe*
  // direction, because they leave delivery off. This field is the one whose
  // default points the other way, so it is the one field the collapse may not
  // take with it: re-enabling replanning for someone who switched it off is
  // exactly the outcome the switch exists to prevent.
  const settings = planSettingsOf(
    {
      timezone: TZ,
      planSettings: {
        enabled: true,
        deliveryLocalTime: '07:30',
        timezone: 'Not/AZone',
        continuousReplanEnabled: false,
      },
    },
    TZ,
  );
  assert.equal(settings.continuousReplanEnabled, false, 'the user said off; a broken neighbour may not say on');
  // The collapse itself still happens, and must: the rest of the record is
  // unreadable, so delivery falls back to off at the default hour.
  assert.equal(settings.enabled, false);
  assert.equal(settings.deliveryLocalTime, '07:30');
  assert.equal(settings.timezone, TZ);

  // And the gate downstream sees the choice, not the default.
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const uid = 'user_replan_malformed';
  try {
    await seedSyncedAccount(uid, storage, {
      planSettings: {
        enabled: true,
        deliveryLocalTime: '07:30',
        timezone: 'Not/AZone',
        continuousReplanEnabled: false,
      },
    });
    const report = await processStateChangesForUser(uid, {
      storage,
      now: NOW,
      date: DATE,
      entityFactsByChangeId: FACTS_BY_CHANGE,
      policyConfig: { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 120 },
    });
    assert.equal(report.skipped, 'continuous_replan_disabled');
    assert.equal((await readStoredPlan(uid, DATE, storage))?.generation, 1);
  } finally {
    resetStorageForTests();
  }
});

test('the wire narrows the switch the same way the gate does', async () => {
  /**
   * The two halves answer different questions, and only the second can fail
   * for the defect this exists to catch.
   *
   * Behaviourally the DTO and the gate agree today no matter which operator
   * the DTO uses, because `planSettingsOf` fills the field on every path, so
   * neither side ever meets `undefined` — which is precisely why `=== true`
   * survived as long as it did. The operator is a *guard*, and what a guard
   * is worth is what it does on the input that is supposed to be impossible.
   *
   * So the behaviour is asserted, and then the narrowing itself is read out
   * of both sources and required to be the same test written the same way
   * round. `=== true` on the wire opposite `=== false` at the gate is a
   * default of false facing a default of enabled: a toggle drawn OFF over a
   * backend that is still replanning, which is the worst reading a control
   * switch can produce.
   */
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const routeSource = readFileSync(join(repoRoot, 'src/app/api/mobile/settings/plan/route.ts'), 'utf8');
  const dtoLine = routeSource
    .split('\n')
    .find((row) => row.includes('continuousReplanEnabled: settings.'));
  assert.ok(dtoLine, 'the plan settings DTO no longer carries the switch');
  assert.match(
    dtoLine,
    /settings\.continuousReplanEnabled !== false/,
    'the DTO must treat an unset switch as enabled, exactly as the gate does; `=== true` is a default of false',
  );

  const gateSource = readFileSync(
    join(repoRoot, 'lib/services/dailyPlan/continuousReplanService.ts'),
    'utf8',
  );
  assert.match(
    gateSource,
    /if \(settings\.continuousReplanEnabled === false\)/,
    'the gate stopped testing for a literal false; the DTO above is now narrowing against nothing',
  );

  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  const uid = uidFor('ReplanWireUser');
  try {
    // A record the collapse rejects, with no switch stored at all: the gate
    // reads this as enabled, so the wire says enabled too.
    await storage.set(userDoc(uid), {
      timezone: TZ,
      planSettings: { enabled: true, deliveryLocalTime: 'not-a-time', timezone: TZ },
    });
    const body = await (await settingsGet(new Request(`${BASE}/api/mobile/settings/plan`, {
      headers: new Headers({ authorization: `Bearer ${tokenFor(uid)}` }),
    }))).json();

    const gateSeesEnabled = (await readPlanSettings(uid, { storage })).continuousReplanEnabled !== false;
    assert.equal(
      body.planSettings.continuousReplanEnabled,
      gateSeesEnabled,
      'the toggle the client draws must agree with the gate the server applies',
    );
    assert.equal(body.planSettings.continuousReplanEnabled, true);
  } finally {
    auth.restore();
    resetStorageForTests();
  }
});

/* ── Independence from provider sync ─────────────────────────────── */

test('switching continuous replanning off stops the replan and leaves provider sync alone', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const off = 'user_replan_off';
  const on = 'user_replan_on';
  try {
    await seedSyncedAccount(off, storage, {
      planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ, continuousReplanEnabled: false },
    });
    // The same sweep, an account that has not switched anything off. Without
    // this the test could pass against a global kill switch.
    await seedSyncedAccount(on, storage, {
      planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ, continuousReplanEnabled: true },
    });

    // The sync already happened: the change row is there before the sweep, and
    // it is there because a connected provider wrote it.
    assert.equal((await storage.list(userCol(off, PLANNING_STATE_CHANGES))).length, 1);

    const totals = await runContinuousReplanTick({ storage, now: NOW });

    // The sweep still runs and still examines the account. "Off" is not
    // "invisible".
    assert.equal(totals.examined, 2, 'the sweep must still examine an account that has replanning off');
    assert.equal(totals.skipped, 1);
    assert.equal(totals.failed, 0);
    // Exactly one of the two accounts reached the impact evaluator, and the
    // sweep now carries it all the way (#605). The tick resolves the change's
    // facts from the stored busy block, which sits on the enabled account's
    // scheduled item, so that account is replanned in this very sweep. The
    // point is still which account was judged at all: a per-account gate, not
    // a kill switch.
    assert.equal(totals.replanRequired, 1, 'the enabled account must reach the pipeline in the same sweep');
    assert.equal(totals.stale, 0);
    assert.equal(totals.autoApplied + totals.proposed, 1, 'and the pipeline acted on it');

    // Nothing was planned for the account that switched it off …
    const untouched = await readStoredPlan(off, DATE, storage);
    assert.equal(untouched?.generation, 1, 'a disabled account must not be replanned');
    assert.equal(untouched?.proposal ?? null, null, 'a disabled account must not be offered a patch either');
    assert.deepEqual(await listPlanEvents(off, storage), [], 'a disabled account must leave no plan ledger entry');

    // … while the other account in the very same sweep was replanned by it:
    // a new generation, or a stored patch, depending on the churn policy.
    const replanned = await readStoredPlan(on, DATE, storage);
    assert.ok(
      replanned?.generation === 2 || replanned?.proposal,
      'the gate must be per account: the enabled account was replanned by the sweep',
    );

    // And the disabled account, given the identical change and facts, is
    // still not replanned — the difference is the setting and nothing else.
    await storage.set(userSubDoc(off, PLANNING_STATE_CHANGES, 'chg-busy-1'), changeFor(off));
    const disabled = await processStateChangesForUser(off, {
      storage,
      now: NOW,
      date: DATE,
      entityFactsByChangeId: FACTS_BY_CHANGE,
      policyConfig: { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 120 },
    });
    assert.equal(disabled.skipped, 'continuous_replan_disabled');
    assert.equal((await readStoredPlan(off, DATE, storage))?.generation, 1);

    // The connection is byte-identical: this switch never went near it. It is
    // the connection record, not this field, that decides whether a provider
    // syncs at all.
    assert.deepEqual(
      await storage.get(userSubDoc(off, PROVIDER_CONNECTIONS, CONNECTION.connectionId)),
      { ...CONNECTION },
      'the provider connection must be untouched by the replan switch',
    );

    // And the sync's other output — the busy blocks it wrote — is still there
    // to be read by the morning build, the calendar screen and anything else.
    const busy = await storage.list(userCol(off, 'busyBlocks'));
    assert.ok(busy.length > 0, 'provider sync output must survive a disabled replan sweep');
  } finally {
    resetStorageForTests();
  }
});

test('a disabled account drains its pending changes rather than hoarding them', async () => {
  // `planningStateChanges` is a work queue. Leaving rows behind for a disabled
  // account grows the collection for as long as the switch is off, and turns
  // switching back on into a replan over every stale change since. It costs
  // the Trust surface nothing: a plan's `causeChangeIds` resolve against
  // `watcherEvents.effectRef`, not against these rows.
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const uid = 'user_replan_drain';
  try {
    await seedSyncedAccount(uid, storage, {
      planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ, continuousReplanEnabled: false },
    });

    const report = await processStateChangesForUser(uid, { storage, now: NOW, date: DATE, entityFactsByChangeId: FACTS_BY_CHANGE });
    assert.equal(report.skipped, 'continuous_replan_disabled');
    assert.equal(report.changesProcessed, 1, 'the change was read, and reading it is having handled it');
    assert.equal(report.pipelineResult.impact.reason, 'continuous_replan_disabled');
    assert.equal(
      (await storage.list(userCol(uid, PLANNING_STATE_CHANGES))).length,
      0,
      'pending changes must be acknowledged even when nothing is replanned',
    );
  } finally {
    resetStorageForTests();
  }
});

test('the monitoring pause and the continuous-replan switch are orthogonal', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const paused = 'user_replan_paused';
  try {
    // #567's pause is set, the replan switch is not. The pause silences
    // watcher *effects* inside the watcher engine; it is never consulted here,
    // so a plan whose inputs moved is still replanned.
    await seedSyncedAccount(paused, storage, {
      monitoringSettings: { paused: true },
      planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ },
    });

    const report = await processStateChangesForUser(paused, {
      storage,
      now: NOW,
      date: DATE,
      entityFactsByChangeId: FACTS_BY_CHANGE,
      policyConfig: { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 120 },
    });
    assert.equal(report.skipped, null, 'the monitoring pause must not be read as a replan opt-out');
    assert.equal(report.planStored, true);

    // And the pause is not disturbed by the replan switch either: saving plan
    // settings leaves it exactly where the monitoring route put it.
    await savePlanSettings(paused, { enabled: true, continuousReplanEnabled: false }, NOW, { storage });
    const after = await storage.get<{ monitoringSettings?: { paused?: boolean } }>(userDoc(paused));
    assert.equal(after?.monitoringSettings?.paused, true, 'the replan switch must not write the monitoring pause');
  } finally {
    resetStorageForTests();
  }
});

/* ── Persistence and the wire ────────────────────────────────────── */

test('the switch round-trips through savePlanSettings and GET/PUT /api/mobile/settings/plan', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  const uid = uidFor('ReplanSettingsUser');
  const request = (body?: unknown): Request => new Request(`${BASE}/api/mobile/settings/plan`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: new Headers({ authorization: `Bearer ${tokenFor(uid)}`, 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const before = await (await settingsGet(request())).json();
    assert.equal(before.planSettings.continuousReplanEnabled, true, 'the wire must carry the default, not omit it');

    const saved = await settingsPut(request({ enabled: true, continuousReplanEnabled: false }));
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).planSettings.continuousReplanEnabled, false);

    // Persisted, not merely echoed.
    assert.equal((await readPlanSettings(uid, { storage })).continuousReplanEnabled, false);
    assert.equal((await (await settingsGet(request())).json()).planSettings.continuousReplanEnabled, false);

    // Omitting it leaves the account's choice alone, the way omitting
    // deliveryLocalTime does.
    await settingsPut(request({ enabled: true, deliveryLocalTime: '08:15' }));
    const kept = await readPlanSettings(uid, { storage });
    assert.equal(kept.continuousReplanEnabled, false, 'an omitted switch must not silently re-enable replanning');
    assert.equal(kept.deliveryLocalTime, '08:15');

    const bad = await settingsPut(request({ enabled: true, continuousReplanEnabled: 'no' }));
    assert.equal(bad.status, 400);
  } finally {
    auth.restore();
    resetStorageForTests();
  }
});

/* ── The proposed patch ──────────────────────────────────────────── */

test('a proposal the user must confirm is stored as a patch of the generation it patches', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const uid = 'user_replan_proposal';
  try {
    await seedSyncedAccount(uid, storage, {
      planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ },
    });

    const report = await processStateChangesForUser(uid, {
      storage,
      now: NOW,
      date: DATE,
      entityFactsByChangeId: FACTS_BY_CHANGE,
      policyConfig: { userControlMode: 'always_require_confirmation' },
    });
    assert.equal(report.pipelineResult.policyDecision?.action, 'propose_for_review');

    const stored = await readStoredPlan(uid, DATE, storage);
    assert.ok(stored, 'the plan must still be there');
    // The plan in force is unchanged: a proposal is an offer beside it.
    assert.equal(stored.generation, 1);
    assert.equal(stored.status, 'accepted');

    const proposal = stored.proposal;
    assert.ok(proposal, 'the proposed patch must be durable; a ledger line is not a patch');
    assert.equal(proposal.baseGeneration, 1);
    assert.equal(proposal.baseInputDigest, 'digest-base-gen1');
    assert.equal(proposal.userControlMode, 'always_require_confirmation');
    assert.equal(proposal.reason, 'user_requires_confirmation');
    assert.ok(proposal.diff.changes.some((change) => change.kind !== 'unchanged'), 'the diff must be the real one');
    assert.deepEqual(
      proposal.plan.scheduled,
      report.pipelineResult.newPlan?.scheduled,
      'the stored patch must be the plan the planner actually solved',
    );
    // A proposal carries its causes for the reason a generation does.
    assert.deepEqual([...proposal.causeChangeIds], ['chg-busy-1']);

    const proposed = (await listPlanEvents(uid, storage)).find((event) => event.type === 'plan_proposed');
    assert.ok(proposed);
    assert.deepEqual([...(proposed.causeChangeIds ?? [])], ['chg-busy-1']);
  } finally {
    resetStorageForTests();
  }
});

test('a patch of a generation that has moved on is refused, and an auto-apply clears the one it supersedes', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const uid = 'user_replan_supersede';
  try {
    await seedSyncedAccount(uid, storage, {
      planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ },
    });

    // A patch solved against a generation that no longer exists is wrong, not
    // merely stale, so it is refused rather than merged.
    const staleBase = await storePlanProposal(uid, DATE, {
      proposalId: 'prp_stale',
      proposedAt: NOW.toISOString(),
      baseGeneration: 7,
      baseInputDigest: 'digest-of-a-plan-that-never-existed',
      plan: planFor(uid, []),
      diff: { changes: [], sameInputDigest: false },
      reason: 'contains_removals',
      userControlMode: 'automatic_time_only',
      causeChangeIds: [],
    }, storage);
    assert.equal(staleBase, null, 'a patch whose base generation has moved must be refused');
    assert.equal((await readStoredPlan(uid, DATE, storage))?.proposal ?? null, null);

    // A live patch, then an auto-applied replan on top of it.
    const live = await storePlanProposal(uid, DATE, {
      proposalId: 'prp_live',
      proposedAt: NOW.toISOString(),
      baseGeneration: 1,
      baseInputDigest: 'digest-base-gen1',
      plan: planFor(uid, []),
      diff: { changes: [], sameInputDigest: false },
      reason: 'contains_removals',
      userControlMode: 'automatic_time_only',
      causeChangeIds: ['chg-old'],
    }, storage);
    assert.ok(live?.proposal, 'a patch of the current generation must be stored');

    const report = await processStateChangesForUser(uid, {
      storage,
      now: NOW,
      date: DATE,
      entityFactsByChangeId: FACTS_BY_CHANGE,
      policyConfig: { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 120 },
    });
    assert.equal(report.planStored, true);

    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after?.generation, 2);
    assert.equal(
      after?.proposal ?? null,
      null,
      'generation 2 must not inherit a patch that describes generation 1',
    );
  } finally {
    resetStorageForTests();
  }
});

/* ── The cadence is one number, in two places that must agree ────── */

test('the continuous replan sweep the infrastructure schedules matches the constant beside it', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const scheduler = readFileSync(join(repoRoot, 'infra/scheduler.sh'), 'utf8');
  const line = scheduler.split('\n').find((row) => row.includes('upsert_job "replan-tick-'));
  assert.ok(
    line,
    'infra/scheduler.sh does not register the replan job; /api/internal/jobs/replan is never called in production',
  );
  assert.match(line, /"\/api\/internal\/jobs\/replan"/, 'the replan job points at the wrong route');
  const crontab = /"(\S*\*[^"]*)"/.exec(line)?.[1];
  assert.equal(
    crontab,
    '*/5 * * * *',
    `the replan cadence changed to "${crontab}"; CONTINUOUS_REPLAN_SWEEP_INTERVAL_MINUTES must change with it`,
  );
  assert.equal(CONTINUOUS_REPLAN_SWEEP_INTERVAL_MINUTES, 5);
});
