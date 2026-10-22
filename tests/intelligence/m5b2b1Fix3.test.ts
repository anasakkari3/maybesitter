import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupMemoryResidues } from '../../lib/intelligence/memoryBasis.ts';
import { syncCanonicalObservations } from '../../lib/intelligence/canonicalObservations.ts';
import { proposeFromObservations } from '../../lib/intelligence/proposalEngine.ts';
import { readParticipantState } from '../../lib/services/mobile/participantState.ts';
import {
  NOW,
  addRows,
  aliasOf,
  answer,
  assertUnavailable,
  begin,
  currentStorage,
  decide,
  end,
  epochOf,
  identityOf,
  latestRun,
  memoryEntries,
  memoryObservations,
  model,
  observationIdsSent,
  putMemory,
  removeMemoryRecord,
  said,
  seedSuggestion,
  setFence,
  show,
  spyStorage,
  statement,
  stored,
  userDoc,
  withStorage,
} from '../acceptance/m5b2b1/support.ts';

test.afterEach(() => end());

const MORNING = 'I work best in the morning';
const SWIM = 'Learn to swim this summer';
const FIRST = 'Plan two study blocks';
const RETRY = 'Write a short study list';

async function fixture() {
  const uid = await begin();
  await addRows(uid, [{ content: MORNING }, { content: 'I take the bus to work' }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  return { uid, evidence };
}

function firstReply(evidenceId: string) {
  return (call: any) => ({ suggestions: [said('action', FIRST, [evidenceId], {
    memoryRefs: [aliasOf(call, MORNING)],
  })] });
}

function retryReply(evidenceId: string) {
  return () => ({ suggestions: [said('action', RETRY, [evidenceId])] });
}

async function assertMemoryFree(uid: string, call: any): Promise<void> {
  assert.deepEqual(memoryEntries(call), [], `the retry still carried memory: ${show(call.context?.memory)}`);
  const copies = (await memoryObservations(uid)).map((row) => row.id);
  for (const id of observationIdsSent(call)) assert.equal(copies.includes(id), false);
  assert.equal(call.raw.includes(MORNING), false);
}

test('SRV-RETRY-002: a visit bypasses reuse for its memory-free retry and completes the run', async () => {
  const { uid, evidence } = await fixture();
  model.answer(firstReply(evidence.id), retryReply(evidence.id));
  model.during = async (call) => {
    if (call.index === 0) await setFence(uid, { state: 'active', epoch: (await epochOf(uid)) + 1 });
  };
  const answered = await proposeFromObservations(uid, NOW(), { storage: currentStorage() as any, visit: true });
  assert.equal(model.calls.length, 2, 'the visit reused its own running reservation instead of retrying');
  await assertMemoryFree(uid, model.calls[1]!);
  const retried = await stored(uid, identityOf('action', RETRY, [evidence.id]));
  assert.ok(retried, 'the visit retry committed nothing');
  assert.deepEqual(answered.map((row) => row.id), [retried.id]);
  assert.equal((await latestRun(uid))?.status, 'complete');
});

test('SRV-RETRY-002: a memory-only retry completes its owned run empty', async () => {
  const uid = await begin();
  const [goal] = await addRows(uid, [{ content: SWIM, kind: 'goal' }]);
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  const copy = (await memoryObservations(uid)).find((row) => row.sourceRef === goal!.id)!;
  assert.ok(copy, 'fixture: no memory observation was created');
  model.answer(() => ({ suggestions: [said('action', 'Book a beginner swim lesson', [copy.id])] }));
  model.during = async (call) => { if (call.index === 0) await removeMemoryRecord(uid, goal!.id); };
  const answered = await proposeFromObservations(uid, NOW(), { storage: currentStorage() as any, visit: true });
  assert.deepEqual(answered, []);
  assert.equal(model.calls.length, 1, 'the empty memory-free retry called the model');
  assert.deepEqual((await latestRun(uid))?.suggestionIds, []);
  assert.equal((await latestRun(uid))?.status, 'complete', 'the retry left its reservation running');
});

for (const operation of ['accept', 'dismiss', 'answer'] as const) {
  test(`SRV-ACT-001: ${operation} revalidates a deleted memory inside its claim transaction`, async () => {
    const uid = await begin();
    const [row] = await addRows(uid, [{ content: MORNING }]);
    const evidence = await statement(uid, 'I want to plan my study week');
    const suggestion = await seedSuggestion(uid, operation === 'answer' ? 'question' : 'action', [evidence.id], {
      mode: 'on_basis', memoryIds: [row!.id], epoch: await epochOf(uid),
    });
    let transactionReads = 0;
    let fired = false;
    const spy = spyStorage(currentStorage(), {
      onRead: async (method, path) => {
        if (method !== 'tx.get' || typeof path !== 'string' || !path.endsWith(`/intelligenceProposals/${suggestion.id}`)) return;
        transactionReads += 1;
        if (!fired && transactionReads === (operation === 'accept' ? 2 : 1)) {
          fired = true;
          await removeMemoryRecord(uid, row!.id);
        }
      },
    });
    const result = await withStorage(spy, () => operation === 'answer'
      ? answer(uid, suggestion.id)
      : decide(uid, suggestion.id, operation));
    assertUnavailable(result, `${operation} whose basis was deleted during the claim`);
    assert.equal((await stored(uid, suggestion.id))?.status, 'pending');
    assert.equal((await readParticipantState(uid)).commitments[`int_${suggestion.id}`], undefined);
    const answers = (await currentStorage().list<any>(`users/${uid}/intelligenceObservations`))
      .filter((entry) => entry.data.sourceRef === `answer:${suggestion.id}`);
    assert.deepEqual(answers, []);
    assert.ok(fired, `fixture: ${operation} never reached its claim transaction`);
  });
}

test('SRV-CLEANUP-003: valid memory rows created after the snapshot survive cleanup', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: MORNING }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  const base = currentStorage();
  let userReads = 0;
  let fired = false;
  let newMemoryId: string | undefined;
  let newObservationId: string | undefined;
  let newSuggestionId: string | undefined;
  const spy = spyStorage(base, {
    afterRead: async (method, path) => {
      if (method !== 'get' || path !== userDoc(uid)) return;
      userReads += 1;
      if (fired || userReads !== 2) return;
      fired = true;
      newMemoryId = await putMemory(uid, 'Learn to paint this winter', { kind: 'goal' });
      await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
      newObservationId = (await memoryObservations(uid)).find((row) => row.sourceRef === newMemoryId)?.id;
      newSuggestionId = (await seedSuggestion(uid, 'action', [evidence.id], {
        mode: 'on_basis', memoryIds: [newMemoryId], epoch: await epochOf(uid),
      }, { title: 'Buy a small set of paint brushes' })).id;
    },
  });
  const cleaned = await withStorage(spy, () => cleanupMemoryResidues(uid, NOW(), spy));
  assert.equal(cleaned, true);
  assert.ok(fired && newMemoryId && newObservationId && newSuggestionId);
  assert.ok((await memoryObservations(uid)).some((row) => row.id === newObservationId));
  assert.ok(await stored(uid, newSuggestionId));
});
