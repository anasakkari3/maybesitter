/**
 * v1 does not move a single block.
 *
 * The decision behind this feature is that financial context is *shown* and
 * nothing else: no priority change, no deadline shifted, no protected slot,
 * no replan. The import guard next door proves the planner cannot reach the
 * financial modules. This proves the consequence the user would actually feel
 * — that a fully populated financial context, with a tight buffer and bills
 * landing inside the planned day, leaves the plan byte-for-byte the plan the
 * same account gets with no financial context at all.
 *
 * It is written as a negative on purpose. The day somebody wires a financial
 * signal into planning, this is the test that says so out loud, rather than a
 * behaviour nobody notices changing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyPlanInput } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { schedulePlan } from '../../lib/planning/scheduler/index.ts';
import { normalizeStoredTimeSpec, type Commitment } from '../../src/domain/stateMachine.ts';
import type { UserRoutineProfile } from '../../src/contracts/v1/routineContracts.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { uidFor } from '../support/fakeAuth.ts';
import {
  connectFinancialSandbox,
  readFinancialState,
} from '../../lib/services/financial/financialStateService.ts';
import { StoredManualFinancialStore } from '../../lib/services/financial/manualFinancialStore.ts';

const TZ = 'Asia/Jerusalem';
const DATE = '2026-09-23';
const UID = uidFor('FinancialNeutralityUser');
const BUILT_AT = '2026-09-23T06:00:00.000Z';

const PROFILE: UserRoutineProfile = {
  schemaVersion: 1,
  updatedAt: '2026-09-01T00:00:00.000Z',
  timezone: TZ,
  sleepWindow: { start: '23:00', end: '07:00' },
  focusWindows: [{ start: '09:00', end: '17:00', label: 'work_study' }],
  fixedCommitmentWindows: [],
  preferredReminderIntensity: 'followUp',
  quietHours: null,
  surveySkipped: false,
} as UserRoutineProfile;

function commitment(id: string, dueAt: string): Commitment {
  return {
    id,
    kind: 'task',
    title: id,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    category: null,
    categorySource: 'inferred',
    timeSpec: normalizeStoredTimeSpec({ kind: 'due_by', dueAt, timezone: TZ }),
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    confirmedAt: '2026-09-20T00:00:00.000Z',
    completedAt: null,
    droppedAt: null,
  };
}

/** Things a "smarter" planner would be tempted to reorder around money. */
const COMMITMENTS = [
  commitment('buy-a-laptop', '2026-09-23T15:00:00.000Z'),
  commitment('pick-up-a-wolt-shift', '2026-09-23T16:00:00.000Z'),
  commitment('go-to-the-gym', '2026-09-23T17:00:00.000Z'),
];

function planJson(): string {
  const input = buildDailyPlanInput({
    uid: UID, date: DATE, timezone: TZ, profile: PROFILE,
    busyBlocks: [], commitments: COMMITMENTS, builtAt: BUILT_AT,
  });
  return JSON.stringify(schedulePlan(input.constraints, input.config));
}

test('a tight financial context does not move one block of the plan', async () => {
  setStorageForTests(createMemoryStorage());
  try {
    const withoutMoney = planJson();
    // An empty plan compares equal to an empty plan. Check there is a plan.
    const baseline = JSON.parse(withoutMoney) as { scheduled: unknown[] };
    assert.ok(baseline.scheduled.length > 0, 'nothing was scheduled, so equality proves nothing');

    // Now give the account the fullest, tightest financial picture the feature
    // can produce: a connected source, a bill due today, and a correction.
    await connectFinancialSandbox(UID, BUILT_AT);
    const manual = new StoredManualFinancialStore(UID, getStorage());
    await manual.putObligation({
      obligationId: 'manual-tuition', label: 'Tuition', category: 'tuition',
      dueAt: '2026-09-23T12:00:00.000Z', amountMinorUnits: 200_000, currency: 'ILS',
      recurring: false, observedAt: BUILT_AT,
    });
    await manual.putField({
      field: 'cash_available', kind: 'correction', value: 20_000, observedAt: BUILT_AT,
    });

    // The context really is loaded and really is alarming, or the comparison
    // below would be proving nothing.
    const state = await readFinancialState({ uid: UID, asOf: BUILT_AT });
    assert.equal(state.bufferBand, 'negative');
    assert.ok(state.conflicts.length > 0);
    assert.ok(state.upcomingObligations.length > 0);

    const withMoney = planJson();
    assert.equal(withMoney, withoutMoney, 'the financial context changed the plan; v1 says it must not');
  } finally {
    resetStorageForTests();
  }
});
