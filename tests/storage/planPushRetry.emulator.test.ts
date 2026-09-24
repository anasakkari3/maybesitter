/**
 * The morning plan's push retry against real Firestore (#431).
 *
 * `tests/dailyPlan/planPushRetry.test.ts` proves the behaviour on the memory
 * adapter. Three things the retry path relies on are only true if Firestore
 * makes them true, and are checked here instead:
 *
 *   1. **The sweep query.** `listGroup('plans')` with a range filter and an
 *      order on a *nested* field, `pushPending.nextAttemptAt`. Firestore omits
 *      a document whose queried field is absent, and a cleared marker is
 *      removed rather than nulled so that it is.
 *   2. **The ledger read inside the claim.** `claimPlanPushRetry` queries
 *      `planEvents` for a `plan_opened` row inside its transaction, reading
 *      everything before it writes — the order Firestore insists on.
 *   3. **The lease compare-and-set.** Two claims from two adapter instances
 *      race over one plan in Firestore's optimistic transactions, not a
 *      process-local mutex, and exactly one send comes out.
 *
 * The collection-group index is not proven here: the emulator does not
 * enforce indexes. `tests/storage/firestoreIndexes.test.ts` asserts the field
 * override against the query instead.
 *
 * ── Keeping out of other files' plans ────────────────────────────
 *
 * `plans` is a collection group shared by every emulator file in the run, and
 * `dailyPlan.emulator.test.ts` stores real plans with real markers. So every
 * instant here is in 2099, which no other file's clock reaches: another
 * file's sweep never sees these markers as due. And this file's sweep sees
 * only its own plans: the adapter's `listGroup` is narrowed *after* the real
 * query, so the query itself is still Firestore's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFirestoreStorage, resetFirestoreForTests } from '../../lib/storage/firestoreAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import type { PlanReadyNotice } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import {
  appendPlanEvent,
  planPath,
  readStoredPlan,
  type StoredDailyPlan,
} from '../../lib/services/dailyPlan/planStore.ts';
import {
  listDuePlanPushes,
  runPlanPushRetries,
  type PlanPushPending,
} from '../../lib/services/dailyPlan/planPushRetry.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    'FIRESTORE_EMULATOR_HOST is unset. Run this file through `npm run test:emulator`, never against a real project.',
  );
}

/** Local midnight-and-a-minute in UTC, on a date no other file's clock reaches. */
const DATE = '2099-01-01';
const NOW = new Date('2099-01-01T00:01:00.000Z');
/** Wide enough that other files' pending pushes cannot crowd ours out of the batch. */
const WIDE = 500;

function uniqueUid(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * A plan document carrying a marker. Only the fields the retry path reads are
 * meaningful; the rest is the shape, so Firestore stores what production does.
 */
async function seedPendingPlan(storage: StorageAdapter, uid: string, nextAttemptAt: string): Promise<void> {
  const pushPending: PlanPushPending = { attempts: 1, failedSends: 1, nextAttemptAt, reason: 'send_failed' };
  await storage.set(planPath(uid, DATE), {
    date: DATE,
    timezone: 'UTC',
    locale: 'en',
    status: 'proposed',
    plan: { scheduled: [], unscheduled: [], inputDigest: 'digest' },
    blocks: [],
    replaces: null,
    constraints: {},
    config: {},
    explanation: { text: 'x', locale: 'en', source: 'template', validated: true },
    edits: { moves: [], removals: [] },
    generatedAt: '2098-12-31T23:00:00.000Z',
    generation: 1,
    inputDigest: 'digest',
    acceptedAt: null,
    updatedAt: '2098-12-31T23:00:00.000Z',
    pushPending,
  } as unknown as StoredDailyPlan);
}

/**
 * The adapter, with the `plans` group read narrowed to these accounts. The
 * query still runs in Firestore with its filter and order; only other files'
 * rows are removed from its answer. `Object.create`, not a spread: the adapter
 * is a class, and a spread would drop every method but the one overridden.
 */
function sweepingOnly(instance: StorageAdapter, uids: readonly string[]): StorageAdapter {
  const narrowed = Object.create(instance) as StorageAdapter;
  narrowed.listGroup = (async (collectionId: string, query?: Parameters<StorageAdapter['listGroup']>[1]) => {
    const rows = await instance.listGroup(collectionId, query ? { ...query, limit: WIDE } : query);
    return rows.filter((row) => uids.some((uid) => row.path.startsWith(`users/${uid}/`)));
  }) as StorageAdapter['listGroup'];
  return narrowed;
}

/** A sender that records which of this file's accounts it was asked to push. */
function recorder(uids: readonly string[]) {
  const sent: PlanReadyNotice[] = [];
  return {
    sent,
    push: async (notice: PlanReadyNotice) => {
      if (uids.includes(notice.uid)) sent.push(notice);
      return { status: 'sent' };
    },
  };
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

test('firestore: the retry query on pushPending.nextAttemptAt finds a due plan and omits one not yet due', async () => {
  const due = uniqueUid('push_due');
  const later = uniqueUid('push_later');
  await withFirestore([due, later], async (storage) => {
    await seedPendingPlan(storage, due, '2099-01-01T00:00:00.000Z');
    await seedPendingPlan(storage, later, '2099-01-01T00:30:00.000Z');

    const found = (await listDuePlanPushes(NOW, storage, WIDE)).map((ref) => `${ref.uid}/${ref.date}`);
    assert.equal(found.includes(`${due}/${DATE}`), true, 'the real query did not return a due pending push');
    assert.equal(found.includes(`${later}/${DATE}`), false, 'the real query returned a push not yet due');

    // And the sweep, through that query, sends exactly the due one.
    const push = recorder([due, later]);
    const totals = await runPlanPushRetries(NOW, push.push, sweepingOnly(storage, [due, later]), WIDE);
    assert.equal(totals.retried, 1);
    assert.deepEqual(push.sent.map((notice) => notice.uid), [due]);
    assert.equal(push.sent[0]!.dedupeKey, `plan:${DATE}:retry1`, 'a retry after a thrown send reused the spent key');
  });
});

test('firestore: two sweeps from two adapter instances racing over one due plan send it once', async () => {
  const uid = uniqueUid('push_race');
  await withFirestore([uid], async (storage) => {
    await seedPendingPlan(storage, uid, '2099-01-01T00:00:00.000Z');
    const push = recorder([uid]);

    const [left, right] = await Promise.all([
      runPlanPushRetries(NOW, push.push, sweepingOnly(createFirestoreStorage(), [uid]), WIDE),
      runPlanPushRetries(NOW, push.push, sweepingOnly(createFirestoreStorage(), [uid]), WIDE),
    ]);

    assert.equal(left.retried + right.retried, 1, 'both instances claimed the same attempt in Firestore');
    assert.equal(push.sent.length, 1, 'the user was pushed twice');
  });
});

test('firestore: a plan_opened row for the date, read inside the claim transaction, drops the push', async () => {
  const uid = uniqueUid('push_opened');
  await withFirestore([uid], async (storage) => {
    await seedPendingPlan(storage, uid, '2099-01-01T00:00:00.000Z');
    await appendPlanEvent(uid, {
      type: 'plan_opened', date: DATE, at: '2098-12-31T23:30:00.000Z', generation: 1, inputDigest: 'digest',
    }, storage);
    const push = recorder([uid]);

    const warn = console.warn;
    console.warn = () => undefined;
    let totals;
    try {
      totals = await runPlanPushRetries(NOW, push.push, sweepingOnly(storage, [uid]), WIDE);
    } finally {
      console.warn = warn;
    }

    assert.deepEqual({ retried: totals.retried, retryDropped: totals.retryDropped }, { retried: 0, retryDropped: 1 });
    assert.equal(push.sent.length, 0, 'a plan already opened was pushed');
    const stored = await readStoredPlan(uid, DATE, createFirestoreStorage());
    assert.ok(stored, 'dropping the push deleted the plan');
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'pushPending'), false, 'the dropped push kept its marker');
  });
});

test('firestore: a confirmed send removes the marker, and the query stops returning the plan', async () => {
  const uid = uniqueUid('push_sent');
  await withFirestore([uid], async (storage) => {
    await seedPendingPlan(storage, uid, '2099-01-01T00:00:00.000Z');
    const push = recorder([uid]);

    const totals = await runPlanPushRetries(NOW, push.push, sweepingOnly(storage, [uid]), WIDE);
    assert.deepEqual({ retried: totals.retried, retryPushed: totals.retryPushed }, { retried: 1, retryPushed: 1 });

    const reader = createFirestoreStorage();
    const stored = await readStoredPlan(uid, DATE, reader);
    assert.ok(stored);
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'pushPending'), false, 'a delivered push left its marker');
    assert.equal(stored!.inputDigest, 'digest', 'recording the send rewrote the plan');

    // Absent, not null: the range query must not return it again, even much later.
    const later = (await listDuePlanPushes(new Date('2099-01-01T11:00:00.000Z'), reader, WIDE))
      .map((ref) => ref.uid);
    assert.equal(later.includes(uid), false, 'a cleared marker is still returned by the sweep query');
    assert.equal(push.sent.length, 1);
  });
});
