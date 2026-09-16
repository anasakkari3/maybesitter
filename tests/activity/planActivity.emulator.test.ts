/**
 * An accepted plan in the activity history, on real Firestore (UC-3.15 #201).
 *
 * The memory adapter forgives two things Firestore does not: a transaction
 * that writes before it reads, and a range query whose ordering the engine
 * decides. `acceptPlan` now reads the activity counter and writes the ledger
 * entry and the counter in one transaction, and the history pages two
 * collections by one cursor — so both are exercised here against the emulator,
 * through independent handles for the writer and the reader.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage } from '../../lib/storage/firestoreAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { planPath, type StoredDailyPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { acceptPlan } from '../../lib/services/dailyPlan/planActions.ts';
import { activityStatsPath } from '../../lib/services/activity/activityStats.ts';
import { listActivity, weeklySummaryFor } from '../../lib/services/activity/activityService.ts';

function uniqueUid(): string {
  return `planact_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Only the fields `acceptPlan` reads or rewrites; the rest is not this test's. */
function storedPlan(date: string): StoredDailyPlan {
  return {
    date, timezone: 'Asia/Jerusalem', locale: 'ar', status: 'proposed', generation: 1,
    inputDigest: 'd'.repeat(64), acceptedAt: null, generatedAt: `${date}T04:00:00.000Z`, updatedAt: `${date}T04:00:00.000Z`,
  } as unknown as StoredDailyPlan;
}

test('firestore: accepting plans writes the ledger and the counter together, and the history pages them', async () => {
  const uid = uniqueUid();
  const writer = createFirestoreStorage();
  const reader = createFirestoreStorage();
  try {
    await writer.set(userDoc(uid), { timezone: 'Asia/Jerusalem', locale: 'ar' });
    for (const [date, at] of [['2026-09-14', '2026-09-14T05:00:00.000Z'], ['2026-09-15', '2026-09-15T05:00:00.000Z'], ['2026-09-16', '2026-09-16T05:00:00.000Z']] as const) {
      await writer.set(planPath(uid, date), storedPlan(date));
      await acceptPlan(uid, date, { storage: writer, now: () => new Date(at) });
    }

    const stats = await reader.get<{ firstPlanAcceptedAt: string | null }>(activityStatsPath(uid));
    assert.equal(stats?.firstPlanAcceptedAt, '2026-09-14T05:00:00.000Z');

    setStorageForTests(reader);
    const seen: Array<string | undefined> = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await listActivity({ uid, limit: 1, cursor });
      seen.push(...result.items.map((item) => item.detail?.planDate));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    assert.deepEqual(seen, ['2026-09-16', '2026-09-15', '2026-09-14']);

    const week = await weeklySummaryFor({ uid, weekStart: '2026-09-13' });
    assert.equal(week.plannedDaysCount, 3);
    assert.deepEqual(
      week.moments.filter((moment) => moment.id === 'first_plan_accepted'),
      [{ id: 'first_plan_accepted', reachedAt: '2026-09-14T05:00:00.000Z' }],
    );
  } finally {
    resetStorageForTests();
    await createFirestoreStorage().deleteTree(userDoc(uid)).catch(() => {});
  }
});
