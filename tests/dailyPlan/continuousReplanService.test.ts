/**
 * Integration tests for ContinuousReplanService (#523, slice 2).
 *
 * Verifies storage interactions, idempotency, stale-generation concurrency guards,
 * UserState projection integration, and background tick processing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index';
import { userCol, userDoc, userSubDoc, PLANNING_STATE_CHANGES } from '../../lib/storage/paths';
import type { StorageAdapter } from '../../lib/storage/storageAdapter';
import {
  processStateChangesForUser,
  runContinuousReplanTick,
} from '../../lib/services/dailyPlan/continuousReplanService';
import {
  createIfAbsent,
  readStoredPlan,
  listPlanEvents,
  type StoredDailyPlan,
} from '../../lib/services/dailyPlan/planStore';
import { replaceBusyBlocksAsFixture } from '../support/busyFixtures.ts';
import { persistParticipantState, readParticipantState } from '../../lib/services/mobile/participantState';
import { createEmptyDomainState } from '../../src/domain/stateMachine';
import type { Commitment, DomainState } from '../../src/domain/stateMachine';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts';
import {
  PLANNING_CONTRACT_VERSION,
  PLANNING_SCHEMA_VERSION,
  type Plan,
  type PlannedItem,
  type PlanningConstraints,
} from '../../src/contracts/v1/planningContracts';
import { DAILY_PLAN_CONFIG, dailyPlanScheduleSources } from '../../lib/services/dailyPlan/buildDailyPlan';
import { reconcileScheduleBlocks } from '../../lib/planning/scheduler';

const UID = 'user_replan_test_1';
const DATE = '2026-11-09';
const TZ = 'Asia/Jerusalem';
const NOW = new Date('2026-11-09T08:00:00.000Z');

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

function samplePlan(scheduled: PlannedItem[]): Plan {
  return {
    version: PLANNING_CONTRACT_VERSION,
    schema: PLANNING_SCHEMA_VERSION,
    scopeId: `${UID}:${DATE}`,
    horizon: {
      startsAt: `${DATE}T00:00:00.000Z`,
      endsAt: `${DATE}T23:59:59.999Z`,
    },
    scheduled,
    unscheduled: [],
    constraintReasons: [],
    inputDigest: 'digest-base-gen1',
  };
}

async function seedInitialPlan(storage: StorageAdapter, scheduled: PlannedItem[]): Promise<StoredDailyPlan> {
  const plan = samplePlan(scheduled);
  const constraints: PlanningConstraints = {
    scopeId: `${UID}:${DATE}`,
    timezone: TZ,
    horizon: plan.horizon,
    workingWindows: [
      {
        windowId: 'w0',
        weekday: 1,
        startMinute: 8 * 60,
        endMinute: 20 * 60,
        timezone: TZ,
      },
    ],
    fixedEvents: [],
    items: scheduled.map((s) => ({
      itemId: s.itemId,
      title: s.itemId,
      effort: { kind: 'known' as const, minutes: 60 },
      earliestStartAt: null,
      deadlineAt: null,
      priority: 2,
      dependsOn: [],
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    })),
  };

  const sources = dailyPlanScheduleSources(constraints);
  const blocks = reconcileScheduleBlocks({
    constraints,
    plan,
    generation: 1,
    sources,
    previous: null,
  });

  const storedDoc: StoredDailyPlan = {
    date: DATE,
    timezone: TZ,
    locale: 'en',
    status: 'accepted',
    plan,
    blocks,
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

  await createIfAbsent(UID, storedDoc, storage);
  return storedDoc;
}

test('processStateChangesForUser: REPLAN_REQUIRED auto-applies minor shift, increments generation, and cleans queue', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);

  try {
    // 1. Seed user document
    await storage.set(userDoc(UID), { timezone: TZ, locale: 'en' });

    // 2. Seed domain state with commitment
    const domainState: DomainState = {
      ...createEmptyDomainState(),
      commitments: {
        'com-1': sampleCommitment('com-1'),
      },
    };
    await persistParticipantState(UID, domainState);

    // 3. Seed generation 1 plan: com-1 at 09:00-10:00
    const scheduledItem: PlannedItem = {
      itemId: 'com-1',
      interval: { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T08:00:00.000Z` },
      reservedInterval: { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T08:00:00.000Z` },
    };
    await seedInitialPlan(storage, [scheduledItem]);

    // 4. Add a calendar busy block that collides with com-1's slot (e.g. 07:00-07:30)
    await replaceBusyBlocksAsFixture(
      UID,
      'device:calendar-1',
      { startsAt: `${DATE}T00:00:00.000Z`, endsAt: `${DATE}T23:59:59.999Z` },
      [
        {
          blockId: 'busy-1',
          sourceId: 'device:calendar-1',
          sourceKind: 'device',
          startAt: `${DATE}T07:00:00.000Z`,
          endAt: `${DATE}T07:30:00.000Z`,
          allDay: false,
        },
      ],
      { storage },
    );

    // 5. Add a pending PlanningStateChange describing the collision
    const stateChange: PlanningStateChange = {
      schemaVersion: 'planning-state-change-v1',
      changeId: 'chg-busy-1',
      scopeId: UID,
      source: 'calendar',
      entityId: 'busy-1',
      occurredAt: NOW.toISOString(),
      changedFields: ['interval', 'blocking'],
      beforeDigest: null,
      afterDigest: 'digest-busy-new',
      provenanceRef: 'calendar:refresh-1',
    };
    await storage.set(userSubDoc(UID, PLANNING_STATE_CHANGES, 'chg-busy-1'), stateChange);

    // 6. Process state changes
    const report = await processStateChangesForUser(UID, {
      storage,
      now: NOW,
      date: DATE,
      entityFactsByChangeId: new Map([['chg-busy-1', {
        interval: { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T07:30:00.000Z` },
        blocking: true,
      }]]),
      policyConfig: { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 120 },
    });

    assert.equal(report.changesProcessed, 1);
    assert.equal(report.pipelineResult.impact.decision, 'REPLAN_REQUIRED');
    assert.equal(report.pipelineResult.policyDecision?.action, 'auto_apply');
    assert.equal(report.planStored, true);

    // 7. Verify stored plan was updated to generation 2
    const updatedPlan = await readStoredPlan(UID, DATE, storage);
    assert.ok(updatedPlan);
    assert.equal(updatedPlan.generation, 2);
    assert.equal(updatedPlan.replaces?.generation, 1);
    assert.equal(updatedPlan.replaces?.inputDigest, 'digest-base-gen1');
    assert.equal(updatedPlan.status, 'accepted');

    // 8. Verify ledger event was appended
    const events = await listPlanEvents(UID, storage);
    assert.ok(events.some((e) => e.type === 'plan_regenerated' && e.generation === 2));

    // 9. Verify state change document was deleted after processing
    const remainingChanges = await storage.list(userCol(UID, PLANNING_STATE_CHANGES));
    assert.equal(remainingChanges.length, 0, 'processed state change should be cleaned up');

    // 10. Verify UserStateProjection reflects accepted plan
    assert.ok(report.userState);
    assert.equal(report.userState.projection.plan.status, 'accepted');

    // 11. Invariant: Commitments were NOT mutated
    const currentDomain = await readParticipantState(UID);
    assert.deepEqual(currentDomain.commitments, domainState.commitments);
  } finally {
    resetStorageForTests();
  }
});

test('processStateChangesForUser: PLAN_STALE marks user state projection without rewriting stored plan', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);

  try {
    await storage.set(userDoc(UID), { timezone: TZ, locale: 'en' });
    const domainState: DomainState = {
      ...createEmptyDomainState(),
      commitments: { 'com-1': sampleCommitment('com-1') },
    };
    await persistParticipantState(UID, domainState);

    const scheduledItem: PlannedItem = {
      itemId: 'com-1',
      interval: { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T08:00:00.000Z` },
      reservedInterval: { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T08:00:00.000Z` },
    };
    await seedInitialPlan(storage, [scheduledItem]);

    // Non-overlapping input change (e.g. deadline changed elsewhere)
    const stateChange: PlanningStateChange = {
      schemaVersion: 'planning-state-change-v1',
      changeId: 'chg-stale-1',
      scopeId: UID,
      source: 'commitment',
      entityId: 'com-2',
      occurredAt: NOW.toISOString(),
      changedFields: ['deadlineAt'],
      beforeDigest: 'digest-old',
      afterDigest: 'digest-new',
      provenanceRef: 'edit:deadline',
    };

    const report = await processStateChangesForUser(UID, {
      storage,
      now: NOW,
      date: DATE,
      changes: [stateChange],
      entityFactsByChangeId: new Map(),
    });

    assert.equal(report.pipelineResult.impact.decision, 'PLAN_STALE');
    assert.equal(report.planStored, false, 'PLAN_STALE must not rewrite stored plan by default');

    // Stored plan remains at generation 1
    const stored = await readStoredPlan(UID, DATE, storage);
    assert.equal(stored?.generation, 1);

    // But UserState projection reports plan as stale
    assert.ok(report.userState);
    assert.equal(report.userState.projection.plan.status, 'stale');
  } finally {
    resetStorageForTests();
  }
});

test('runContinuousReplanTick: processes accounts with pending changes', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);

  try {
    await storage.set(userDoc(UID), { timezone: TZ, locale: 'en' });
    await storage.set(userDoc('user_other'), { timezone: TZ, locale: 'en' });

    // Seed initial plan for UID
    await seedInitialPlan(storage, []);

    // Only UID has a pending state change
    const stateChange: PlanningStateChange = {
      schemaVersion: 'planning-state-change-v1',
      changeId: 'chg-tick-1',
      scopeId: UID,
      source: 'watcher',
      entityId: 'watcher-1',
      occurredAt: NOW.toISOString(),
      changedFields: ['digest'],
      beforeDigest: 'digest-a',
      afterDigest: 'digest-b',
      provenanceRef: 'watcher:fire',
    };
    await storage.set(userSubDoc(UID, PLANNING_STATE_CHANGES, 'chg-tick-1'), stateChange);

    const totals = await runContinuousReplanTick({ storage, now: NOW });
    assert.equal(totals.examined, 1);
    assert.equal(totals.failed, 0);
  } finally {
    resetStorageForTests();
  }
});
