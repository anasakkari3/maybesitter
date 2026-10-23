import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPORT_MAX_CHARS } from '../../lib/account/accountExport.ts';
import { answerIntelligenceQuestion } from '../../lib/intelligence/answerQuestion.ts';
import { SuggestionUnavailableError } from '../../lib/intelligence/memoryBasis.ts';
import { reviewSuggestion } from '../../lib/intelligence/reviewSuggestion.ts';
import {
  NOW,
  begin,
  currentStorage,
  end,
  exportAccount,
  markDeletedNow,
  outcomeObservation,
  seedSuggestion,
  spyStorage,
  stored,
  userDoc,
  withStorage,
} from '../acceptance/m5b2b1/support.ts';

test.afterEach(() => end());

for (const operation of ['accept', 'dismiss', 'answer'] as const) {
  for (const [boundary, removeAccount] of [
    ['markDeleted', markDeletedNow],
    ['removal of users/{uid}', async (uid: string) => currentStorage().delete(userDoc(uid))],
  ] as const) {
    test(`SRV-ACT-001-R4: ${operation} cannot dismiss a cited outcome after ${boundary}`, async () => {
      const uid = await begin();
      const outcome = await outcomeObservation(uid, 'Completed: Call the dentist', `fix5-${operation}-${boundary}`);
      await currentStorage().set(`users/${uid}/intelligenceObservations/${outcome.id}`, {
        ...outcome,
        review: 'dismissed',
        reviewedAt: NOW(),
      });
      const suggestion = await seedSuggestion(
        uid,
        operation === 'answer' ? 'question' : 'action',
        [outcome.id],
        { mode: 'on_basis' },
      );
      await removeAccount(uid);
      const writes: string[] = [];
      const guardedStorage = spyStorage(currentStorage(), {
        onWrite: (method, path) => { writes.push(`${method}:${path}`); },
      });

      await assert.rejects(
        operation === 'answer'
          ? answerIntelligenceQuestion(uid, suggestion.id, 'Mornings work best for me', NOW(), guardedStorage)
          : reviewSuggestion(uid, suggestion.id, operation, NOW(), guardedStorage),
        (error: unknown) => error instanceof SuggestionUnavailableError,
      );

      assert.deepEqual(writes, [], 'the failed live-account check was followed by a user-scoped write');
      assert.equal((await stored(uid, suggestion.id))?.status, 'pending');
      assert.equal(await currentStorage().get(`users/${uid}/commitments/int_${suggestion.id}`), null);
      const answers = await currentStorage().list<any>(`users/${uid}/intelligenceObservations`, {
        where: [['sourceRef', '==', `answer:${suggestion.id}`]],
      });
      assert.deepEqual(answers, []);
    });
  }
}

test('SRV-EXPORT-007: an oversized export whose build crosses lease expiry is retryable, not terminal 413', async () => {
  const uid = await begin();
  const chunk = 'x'.repeat(Math.ceil(EXPORT_MAX_CHARS / 8));
  for (let index = 0; index < 9; index += 1) {
    await currentStorage().set(`users/${uid}/commitments/big${index}`, { title: chunk });
  }
  const storage = currentStorage();
  let expiredDuringBuild = false;
  const expiringStorage = spyStorage(storage, {
    afterRead: async (method, path) => {
      if (expiredDuringBuild || method !== 'list' || path !== `users/${uid}/commitments`) return;
      const leasePath = ((storage as any).pathsForTests() as string[])
        .find((candidate) => candidate.startsWith(`users/${uid}/exportLeases/`));
      assert.ok(leasePath, 'fixture: the build reached commitments without holding an export lease');
      const lease = await storage.get<Record<string, unknown>>(leasePath);
      await storage.set(leasePath, { ...lease, leaseExpiresAt: '2000-01-01T00:00:00.000Z' });
      expiredDuringBuild = true;
    },
  });

  const result = await withStorage(expiringStorage, () => exportAccount(uid));

  assert.equal(result.status, 503, `expected retryable settlement failure, got ${result.status}`);
  assert.equal(result.body.reason, 'export_retryable');
  assert.ok(expiredDuringBuild, 'fixture: the lease did not expire during export construction');
  const paths = (storage as any).pathsForTests() as string[];
  assert.equal(paths.some((path) => path.startsWith(`users/${uid}/usage/account_export-`)), false,
    'an uncommitted terminal export consumed a slot');
  assert.equal(paths.some((path) => path.startsWith(`users/${uid}/exportLeases/`)), false,
    'the expired reservation was not released');
});
