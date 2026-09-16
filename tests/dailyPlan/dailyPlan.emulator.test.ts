/**
 * The morning sweep against real Firestore (UC-3.10a, #194).
 *
 * Every test of "two ticks, one plan, one push" in `dailyPlanJob.test.ts` runs
 * on the memory adapter, which serialises transactions inside one process. The
 * issue's own implementation note said as much: "there is no emulator test for
 * `plans`, so transaction behaviour … [is] unverified against real Firestore."
 * Three things here are only true if Firestore makes them true:
 *
 *   1. **The sweep query.** `where enabled == true`, `where nextRunAt <= now`,
 *      `orderBy nextRunAt` over a nested map. Firestore omits a document whose
 *      queried field is absent; the memory adapter was changed during review to
 *      agree, and this is where that agreement is checked rather than assumed.
 *   2. **The claim.** Two ticks from two adapter instances race over one
 *      account. The claim transaction is what makes the loser see `nextRunAt`
 *      already advanced — in Firestore's optimistic transactions, not a mutex.
 *   3. **The unreadable record.** A `nextRunAt` that is a string but not an
 *      instant is matched by the range filter (Firestore compares strings), so
 *      the sweep must disarm it, and the next sweep must not return it.
 *
 * The composite index in `firestore.indexes.json` is not proven here: the
 * emulator does not enforce indexes. `tests/storage/firestoreIndexes.test.ts`
 * asserts the index against the query instead.
 *
 * `users` is a shared collection in one emulator run, so every assertion is
 * about this file's own uids, and every account is deleted afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFirestoreStorage, resetFirestoreForTests } from '../../lib/storage/firestoreAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import {
  listDueAccounts,
  runDailyPlanTick,
  savePlanSettings,
  type PlanReadyNotice,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { listPlanEvents, readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand, createEmptyDomainState, type DomainState } from '../../src/domain/stateMachine.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    'FIRESTORE_EMULATOR_HOST is unset. Run this file through `npm run test:emulator`, never against a real project.',
  );
}

const TZ = 'Asia/Jerusalem';
/** 09:00 in Jerusalem, past a 07:30 delivery armed the afternoon before. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');
const ARMED_AT = new Date('2026-09-14T12:00:00.000Z');
/** Wide enough that another test's accounts in this run cannot crowd ours out. */
const WIDE = 500;

function uniqueUid(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function withCommitments(titles: readonly string[]): DomainState {
  let state = createEmptyDomainState();
  titles.forEach((title, index) => {
    const id = `cmt_${index}`;
    state = applyCommand(state, {
      type: 'CreateDraft',
      now: '2026-09-14T06:00:00.000Z',
      commitment: { id, kind: 'task', title, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyCommand(state, {
      type: 'ConfirmCommitment', commitmentId: id, now: '2026-09-14T06:00:00.000Z', reminders: [],
    }).newState;
  });
  return state;
}

async function seed(storage: StorageAdapter, uid: string, enabled = true): Promise<void> {
  await persistParticipantState(uid, withCommitments(['Write the summary', 'Call the bank']));
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'ar' });
  await savePlanSettings(uid, { enabled, deliveryLocalTime: '07:30' }, ARMED_AT, { storage });
}

/**
 * The adapter, with the `users` sweep narrowed to one account.
 *
 * Other emulator files share `users`; a tick must not claim their accounts.
 * `Object.create` rather than a spread, because the adapter is a class and a
 * spread would drop every method but the one overridden.
 */
function sweepingOnly(instance: StorageAdapter, uid: string): StorageAdapter {
  const narrowed = Object.create(instance) as StorageAdapter;
  narrowed.list = (async (path: string, query?: Parameters<StorageAdapter['list']>[1]) => {
    const rows = await instance.list(path, query ? { ...query, limit: WIDE } : query);
    return path === 'users' ? rows.filter((row) => row.id === uid) : rows;
  }) as StorageAdapter['list'];
  return narrowed;
}

async function withFirestore(uids: readonly string[], fn: (storage: StorageAdapter) => Promise<void>): Promise<void> {
  const storage = createFirestoreStorage();
  setStorageForTests(storage);
  try {
    await fn(storage);
  } finally {
    resetStorageForTests();
    const cleaner = createFirestoreStorage();
    for (const uid of uids) await cleaner.deleteTree(`users/${uid}`);
    resetFirestoreForTests();
  }
}

test('firestore: the sweep returns a due account and omits a disabled, a future and a never-configured one', async () => {
  const due = uniqueUid('plan_due');
  const disabled = uniqueUid('plan_off');
  const future = uniqueUid('plan_future');
  const never = uniqueUid('plan_never');
  await withFirestore([due, disabled, future, never], async (storage) => {
    await seed(storage, due);
    await seed(storage, disabled, false);
    await seed(storage, future);
    await persistParticipantState(never, withCommitments(['Something']));

    const found = new Set(await listDueAccounts(MORNING, { storage }, WIDE));
    assert.equal(found.has(due), true, 'a due account was not returned by the real query');
    assert.equal(found.has(disabled), false, 'a disabled account was returned by the real query');
    assert.equal(found.has(never), false, 'an account with no planSettings was returned');

    // The morning before the delivery instant: nobody here is due yet.
    const early = new Set(await listDueAccounts(new Date('2026-09-15T04:00:00.000Z'), { storage }, WIDE));
    assert.equal(early.has(future), false, 'an account was due before its local delivery time');
  });
});

test('firestore: two ticks through two adapter instances build one plan and push once', async () => {
  const uid = uniqueUid('plan_race');
  await withFirestore([uid], async (storage) => {
    await seed(storage, uid);
    const sent: PlanReadyNotice[] = [];
    const push = async (notice: PlanReadyNotice) => {
      if (notice.uid === uid) sent.push(notice);
    };
    // Only this account: other files' accounts are not ours to claim.
    const only = async (instance: StorageAdapter) => runDailyPlanTick({
      storage: sweepingOnly(instance, uid),
      push,
      now: () => MORNING,
    });

    const [left, right] = await Promise.all([only(createFirestoreStorage()), only(createFirestoreStorage())]);

    assert.equal(left.claimed + right.claimed, 1, 'both instances claimed the same morning in Firestore');
    assert.equal(left.built + right.built, 1, 'two plan documents were written for one morning');
    assert.equal(sent.length, 1, 'the user was pushed twice');

    const reader = createFirestoreStorage();
    const stored = await readStoredPlan(uid, '2026-09-15', reader);
    assert.ok(stored, 'the plan is not readable from a third instance');
    assert.equal(stored!.generation, 1);
    assert.deepEqual((await listPlanEvents(uid, reader)).map((event) => event.type), ['plan_proposed']);

    // And the sweep has forgotten the account for this morning.
    const again = new Set(await listDueAccounts(MORNING, { storage: reader }, WIDE));
    assert.equal(again.has(uid), false, 'the claimed account is still due in Firestore');
  });
});

test('firestore: a nextRunAt that is not an instant is matched once, disarmed, and never matched again', async () => {
  const uid = uniqueUid('plan_bad');
  await withFirestore([uid], async (storage) => {
    await seed(storage, uid);
    const user = await storage.get<Record<string, unknown>>(userDoc(uid));
    await storage.set(userDoc(uid), {
      ...(user ?? {}),
      planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ, nextRunAt: '0000-not-an-instant' },
    });

    // Firestore compares the string, and '0' sorts before '2026-…'.
    assert.equal(new Set(await listDueAccounts(MORNING, { storage }, WIDE)).has(uid), true,
      'the premise is wrong: Firestore did not return the malformed record');

    const errors = console.error;
    console.error = () => undefined;
    try {
      await runDailyPlanTick({
        storage: sweepingOnly(storage, uid),
        push: async () => undefined,
        now: () => MORNING,
      });
    } finally {
      console.error = errors;
    }

    assert.equal(new Set(await listDueAccounts(MORNING, { storage }, WIDE)).has(uid), false,
      'the malformed record is still returned by every sweep');
    const after = await storage.get<{ planSettings: Record<string, unknown> }>(userDoc(uid));
    assert.equal(after!.planSettings.deliveryLocalTime, '07:30', 'disarming destroyed the rest of the settings');
    assert.equal(Object.prototype.hasOwnProperty.call(after!.planSettings, 'nextRunAt'), false);
  });
});
