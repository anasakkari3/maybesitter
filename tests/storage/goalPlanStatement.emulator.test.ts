import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage, resetFirestoreForTests } from '../../lib/storage/firestoreAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { GOAL_STATEMENT_PREVIEWS, userSubDoc, userDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor } from '../support/fakeAuth.ts';
import { POST as previewPost } from '../../src/app/api/mobile/goals/from-statement/preview/route.ts';
import { POST as acceptPost } from '../../src/app/api/mobile/goals/from-statement/accept/route.ts';

const emulatorSkip = process.env.FIRESTORE_EMULATOR_HOST
  ? false
  : 'FIRESTORE_EMULATOR_HOST is not set; run npm run test:emulator';

function request(path: string, uid: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:4321/api/mobile/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(uid)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('firestore goal statement: a timestamp-backed preview can be accepted through the routes', { skip: emulatorSkip }, async () => {
  resetFirestoreForTests();
  const storage = createFirestoreStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  const uid = uidFor(`GoalStatementFirestore${Date.now().toString(36)}`);
  const previousFlag = process.env.MAYBESITTER_FEATURE_GOAL_PLAN;
  process.env.MAYBESITTER_FEATURE_GOAL_PLAN = 'true';
  try {
    const previewResponse = await previewPost(request('goals/from-statement/preview', uid, {
      statement: 'I want to run a 5k', locale: 'en',
    }));
    const preview = await previewResponse.json() as {
      summaryId: string; revision: number; understood: { goalText: string };
    };
    assert.equal(previewResponse.status, 200, JSON.stringify(preview));

    const stored = await storage.get<{ expiresAt: unknown }>(
      userSubDoc(uid, GOAL_STATEMENT_PREVIEWS, preview.summaryId),
    );
    assert.equal(typeof (stored?.expiresAt as { toDate?: unknown } | undefined)?.toDate, 'function',
      'Firestore did not round-trip the TTL Date as a Timestamp');

    const acceptResponse = await acceptPost(request('goals/from-statement/accept', uid, {
      summaryId: preview.summaryId,
      revision: preview.revision,
      understood: preview.understood,
      idempotencyKey: 'firestore-goal-statement-accept',
    }));
    const accepted = await acceptResponse.json() as Record<string, unknown>;
    assert.equal(acceptResponse.status, 200, JSON.stringify(accepted));
    assert.equal(typeof accepted.goalId, 'string');
  } finally {
    if (previousFlag === undefined) delete process.env.MAYBESITTER_FEATURE_GOAL_PLAN;
    else process.env.MAYBESITTER_FEATURE_GOAL_PLAN = previousFlag;
    auth.restore();
    resetStorageForTests();
    await storage.deleteTree(userDoc(uid)).catch(() => {});
    resetFirestoreForTests();
  }
});
