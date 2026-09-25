/**
 * Real Firestore proof for #584: one stored producer change reaches the
 * continuous runtime, produces an incremental offer, and installs a replayable
 * patched generation after the user accepts it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFirestoreStorage, resetFirestoreForTests } from '../../lib/storage/firestoreAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { acceptPlan, acceptPlanProposal, replayStoredPlan } from '../../lib/services/dailyPlan/planActions.ts';
import { processStateChangesForUser } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import { readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { replaceBusyBlocks } from '../../lib/calendar/busyBlocks.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is unset. Run through `npm run test:emulator`.');
}

const DATE = '2026-09-15';
const TZ = 'Asia/Jerusalem';
const MORNING = new Date('2026-09-15T06:00:00.000Z');

test('firestore: a calendar change installs a replayable incremental generation', async () => {
  const uid = `replan_runtime_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const storage = createFirestoreStorage();
  setStorageForTests(storage);
  try {
    let state = createEmptyDomainState();
    for (const id of ['cmt_a', 'cmt_b', 'cmt_c']) {
      state = applyCommand(state, {
        type: 'CreateDraft',
        now: '2026-09-14T06:00:00.000Z',
        commitment: { id, kind: 'task', title: id, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
        draftStatus: 'pending_confirmation',
      }).newState;
      state = applyCommand(state, {
        type: 'ConfirmCommitment', commitmentId: id, now: '2026-09-14T06:00:00.000Z', reminders: [],
      }).newState;
    }
    await persistParticipantState(uid, state);
    const user = await storage.get<Record<string, unknown>>(userDoc(uid));
    await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'en' });
    await savePlanSettings(uid, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
    const claim = await claimDueDelivery(uid, MORNING, { storage });
    assert.ok(claim);
    await buildAndStoreDailyPlan(claim, { storage, now: () => MORNING });
    await acceptPlan(uid, DATE, { storage, now: () => MORNING });

    const before = (await readStoredPlan(uid, DATE, storage))!;
    const hit = before.plan.scheduled[0]!.reservedInterval;
    await replaceBusyBlocks(uid, 'device:runtime-proof', before.plan.horizon, [{
      blockId: 'busy-runtime-proof',
      sourceId: 'device:runtime-proof',
      sourceKind: 'device',
      startAt: hit.startsAt,
      endAt: hit.endsAt,
      allDay: false,
    }], { storage });

    const report = await processStateChangesForUser(uid, { storage, now: MORNING, date: DATE });
    assert.equal(report.replanMode, 'incremental');
    assert.equal(report.offerOutcome, 'offered');
    const offered = (await readStoredPlan(uid, DATE, storage))!;
    assert.ok(offered.proposal?.solveInputs?.incrementalSolve);

    const installed = await acceptPlanProposal(uid, DATE, { storage, now: () => MORNING });
    assert.ok(installed);
    assert.equal(installed.generation, before.generation + 1);
    assert.ok(installed.incrementalSolve);
    assert.deepEqual(replayStoredPlan(installed), installed.plan);
  } finally {
    resetStorageForTests();
    await createFirestoreStorage().deleteTree(`users/${uid}`);
    resetFirestoreForTests();
  }
});
