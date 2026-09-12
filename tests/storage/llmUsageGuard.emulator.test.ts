/**
 * The cost cap under contention, against real Firestore (UC-2.0, #160).
 *
 * A counter is only a cap if two instances cannot both read the same number
 * and both decide they are under it. The memory adapter serialises everything
 * inside one process, so passing there says nothing about two Cloud Run
 * instances — and a cap that is really "the cap times however many instances
 * are up" is not a cap anybody chose.
 *
 * So the reservation is a Firestore transaction, and this is where that claim
 * is tested: concurrent reservations against one cap, through independent
 * adapter handles.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage, resetFirestoreForTests } from '../../lib/storage/firestoreAdapter.ts';
import { LLM_USAGE, userDoc } from '../../lib/storage/paths.ts';
import { callsToday, reserveCall, utcDay } from '../../lib/llm/usageGuard.ts';

/** A fresh uid and day per run, so a rerun never reads the last one's counters. */
function uniqueUid(): string {
  return `usage_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A day this test owns outright, far from any real traffic. */
function isolatedDay(): Date {
  const offset = Math.floor(Math.random() * 3000);
  return new Date(Date.UTC(2030, 0, 1) + offset * 24 * 60 * 60 * 1000);
}

async function cleanUp(uid: string, now: Date): Promise<void> {
  const storage = createFirestoreStorage();
  await storage.deleteTree(userDoc(uid)).catch(() => {});
  await storage.delete(`${LLM_USAGE}/${utcDay(now)}`).catch(() => {});
}

test('firestore: ten concurrent reservations never exceed a cap of four', async () => {
  const uid = uniqueUid();
  const now = isolatedDay();
  const storage = createFirestoreStorage();
  try {
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => reserveCall(uid, 'capture_extraction', { storage, now, userCap: 4 })),
    );

    const allowed = outcomes.filter((outcome) => outcome === 'ok').length;
    // The invariant is the ceiling, not the exact number. Ten transactions on
    // two documents is heavy contention, and Firestore may abort some of them
    // outright — those come back `unavailable`, which is a refusal. What must
    // never happen is more than the cap getting through.
    assert.ok(allowed <= 4, `a cap of four allowed ${allowed} concurrent calls`);
    assert.ok(allowed > 0, 'every concurrent reservation was refused, so nothing was proven');
    assert.equal(
      outcomes.filter((outcome) => outcome === 'ok' || outcome === 'user_cap' || outcome === 'unavailable').length,
      10,
      `an unexpected outcome appeared: ${JSON.stringify(outcomes)}`,
    );

    // And the stored counter agrees with what was handed out. A counter that
    // said 10 while allowing 4 would be the same defect seen from the other end.
    const counted = await callsToday(uid, { storage: createFirestoreStorage(), now });
    assert.equal(counted.user, allowed, 'the counter and the decisions disagree');
  } finally {
    await cleanUp(uid, now);
    resetFirestoreForTests();
  }
});

test('firestore: the global counter is shared across accounts under contention', async () => {
  const a = uniqueUid();
  const b = uniqueUid();
  const now = isolatedDay();
  const storage = createFirestoreStorage();
  try {
    const outcomes = await Promise.all([
      ...Array.from({ length: 4 }, () => reserveCall(a, 'capture_extraction', { storage, now, globalCap: 3 })),
      ...Array.from({ length: 4 }, () => reserveCall(b, 'capture_extraction', { storage, now, globalCap: 3 })),
    ]);

    const allowed = outcomes.filter((outcome) => outcome === 'ok').length;
    assert.ok(allowed <= 3, `the global cap of three allowed ${allowed}`);
    assert.ok(allowed > 0, 'every reservation was refused, so nothing was proven');

    const counted = await callsToday(a, { storage: createFirestoreStorage(), now });
    assert.equal(counted.global, allowed, 'the global counter and the decisions disagree');
  } finally {
    await cleanUp(a, now);
    await cleanUp(b, now);
    resetFirestoreForTests();
  }
});

test('firestore: a second instance sees the first instance\'s reservations', async () => {
  // Independent adapter handles, which is what "another Cloud Run instance"
  // means from this side of the seam.
  const uid = uniqueUid();
  const now = isolatedDay();
  try {
    const instanceA = createFirestoreStorage();
    const instanceB = createFirestoreStorage();

    assert.equal(await reserveCall(uid, 'capture_extraction', { storage: instanceA, now, userCap: 2 }), 'ok');
    assert.equal(await reserveCall(uid, 'capture_extraction', { storage: instanceB, now, userCap: 2 }), 'ok');
    assert.equal(
      await reserveCall(uid, 'capture_extraction', { storage: instanceB, now, userCap: 2 }),
      'user_cap',
      'the second instance had its own counter',
    );
  } finally {
    await cleanUp(uid, now);
    resetFirestoreForTests();
  }
});
