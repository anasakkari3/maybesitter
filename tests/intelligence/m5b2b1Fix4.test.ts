import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXPORTS_PER_DAY,
  commitAccountExport,
  reserveAccountExport,
} from '../../lib/account/accountExport.ts';
import { cleanupMemoryDependents } from '../../lib/intelligence/memoryBasis.ts';
import { SuggestionUnavailableError } from '../../lib/intelligence/memoryBasis.ts';
import { answerIntelligenceQuestion } from '../../lib/intelligence/answerQuestion.ts';
import { proposeFromObservations } from '../../lib/intelligence/proposalEngine.ts';
import { reviewSuggestion } from '../../lib/intelligence/reviewSuggestion.ts';
import {
  NOW,
  addRows,
  aliasOf,
  begin,
  citationPaths,
  currentStorage,
  end,
  epochOf,
  generate,
  identityOf,
  ids,
  markDeletedNow,
  model,
  said,
  seedSuggestion,
  setMode,
  statement,
  stored,
  userDoc,
  userPaths,
} from '../acceptance/m5b2b1/support.ts';

test.afterEach(() => end());

const MORNING = 'I work best in the morning';

for (const operation of ['accept', 'dismiss', 'answer'] as const) {
  for (const [boundary, removeAccount] of [
    ['markDeleted', markDeletedNow],
    ['a partial user-tree sweep', async (uid: string) => currentStorage().delete(userDoc(uid))],
  ] as const) {
    test(`SRV-ACT-001: ${operation} refuses a citationless suggestion after ${boundary}`, async () => {
      const uid = await begin();
      const evidence = await statement(uid, 'I want to plan my study week');
      const suggestion = await seedSuggestion(
        uid,
        operation === 'answer' ? 'question' : 'action',
        [evidence.id],
        { mode: 'on_basis' },
      );
      await removeAccount(uid);
      const pathsBefore = userPaths(uid);

      await assert.rejects(
        operation === 'answer'
          ? answerIntelligenceQuestion(uid, suggestion.id, 'Mornings work best for me', NOW(), currentStorage() as any)
          : reviewSuggestion(uid, suggestion.id, operation, NOW(), currentStorage() as any),
        (error: unknown) => error instanceof SuggestionUnavailableError,
      );
      assert.deepEqual(userPaths(uid), pathsBefore, 'the refused claim created an account-scoped row');
      assert.equal((await stored(uid, suggestion.id))?.status, 'pending');
      assert.equal(await currentStorage().get(`users/${uid}/commitments/int_${suggestion.id}`), null);
      const answers = await currentStorage().list<any>(`users/${uid}/intelligenceObservations`, {
        where: [['sourceRef', '==', `answer:${suggestion.id}`]],
      });
      assert.deepEqual(answers, []);
    });
  }
}

test('SRV-TX-002: a new suggestion before an eligible collision performs every read before its first write', async () => {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: MORNING }, { content: 'I take the bus to work' }]);
  const morning = rows.find((row) => row.content === MORNING)!;
  const bus = rows.find((row) => row.content === 'I take the bus to work')!;
  const evidence = await statement(uid, 'I want to plan my study week');
  const collision = await seedSuggestion(uid, 'action', [evidence.id], {
    mode: 'on_basis', memoryIds: [bus.id], epoch: await epochOf(uid),
  }, { title: 'Plan two study blocks' });
  const freshTitle = 'Book a quiet study room';
  model.answer((call) => ({ suggestions: [
    said('action', freshTitle, [evidence.id]),
    said('action', collision.title, [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] }),
  ] }));

  const made = await proposeFromObservations(uid, NOW(), { storage: currentStorage() as any });
  const freshId = identityOf('action', freshTitle, [evidence.id]);

  assert.deepEqual(made.map((row) => row.id), [freshId, collision.id]);
  assert.ok(await stored(uid, freshId), 'the suggestion before the collision was not created');
  assert.deepEqual(await stored(uid, collision.id), collision, 'the eligible collision was replaced');
  assert.ok(morning.id, 'fixture: the model was not given the active memory');
});

test('SRV-CLEANUP-003: memory copies after more than one page of colliding non-memory rows are cleaned', async () => {
  const uid = await begin();
  const sourceRef = 'memory-source-with-many-collisions';
  const collection = `users/${uid}/intelligenceObservations`;
  for (let index = 0; index < 105; index += 1) {
    const id = `a-non-memory-${String(index).padStart(3, '0')}`;
    await currentStorage().set(`${collection}/${id}`, { id, source: 'manual', sourceRef });
  }
  const memoryIds = ['z-memory-copy-1', 'z-memory-copy-2'];
  for (const id of memoryIds) {
    await currentStorage().set(`${collection}/${id}`, { id, source: 'memory', sourceRef });
  }

  await cleanupMemoryDependents(uid, [sourceRef], currentStorage() as any);

  for (const id of memoryIds) assert.equal(await currentStorage().get(`${collection}/${id}`), null);
  assert.equal((await currentStorage().list(collection)).length, 105, 'non-memory collisions were removed');
});

test('SRV-EXPORT-004: an expired slot and its concurrent replacement cannot both commit past the daily cap', async () => {
  const uid = await begin();
  const start = Date.parse(NOW());
  const at = (milliseconds: number) => new Date(start + milliseconds).toISOString();
  for (let index = 0; index < MAX_EXPORTS_PER_DAY - 1; index += 1) {
    const reserved = await reserveAccountExport(uid, at(index * 1_000), currentStorage() as any);
    assert.ok(reserved, `fixture: reservation ${index + 1} was refused`);
    await commitAccountExport(uid, reserved, at(index * 1_000), currentStorage() as any);
  }
  const expired = await reserveAccountExport(uid, at(2_000), currentStorage() as any);
  assert.ok(expired, 'fixture: the last slot was not reserved');
  const replacement = await reserveAccountExport(uid, at(6 * 60_000), currentStorage() as any);
  assert.ok(replacement, 'the expired slot was not made available to a replacement');

  const results = await Promise.allSettled([
    commitAccountExport(uid, expired, at(6 * 60_000 + 1_000), currentStorage() as any),
    commitAccountExport(uid, replacement, at(6 * 60_000 + 1_000), currentStorage() as any),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.match(String(rejected?.reason), /export_lease_expired|export_rate_limited/);
  const count = await currentStorage().get<{ calls?: number }>(`users/${uid}/usage/account_export-${at(0).slice(0, 10)}`);
  assert.equal(count?.calls, MAX_EXPORTS_PER_DAY);
});

for (const provenance of ['on_basis', 'on_nobasis'] as const) {
  test(`SRV-MODE-005: ${provenance} pending collision is replaced by the unmarked off-mode suggestion`, async () => {
    const uid = await begin();
    const [memory] = await addRows(uid, [{ content: MORNING }]);
    const evidence = await statement(uid, 'I want to plan my study week');
    const title = 'Plan two study blocks';
    const collision = await seedSuggestion(uid, 'action', [evidence.id], provenance === 'on_basis'
      ? { mode: provenance, memoryIds: [memory!.id], epoch: await epochOf(uid) }
      : { mode: provenance }, { title });
    setMode('off');
    model.answer(() => ({ suggestions: [said('action', title, [evidence.id])] }));

    const made = await generate(uid);
    const replaced = await stored(uid, collision.id);

    assert.deepEqual(ids(made.suggestions), [collision.id]);
    assert.ok(replaced, 'the collision disappeared instead of being replaced');
    assert.equal('mode' in replaced, false, 'the replacement retained the old mode');
    assert.equal('memoryBasis' in replaced, false, 'the replacement retained the old memory basis');
    assert.deepEqual(citationPaths(uid), [], 'the replacement retained the old citation');
  });
}
