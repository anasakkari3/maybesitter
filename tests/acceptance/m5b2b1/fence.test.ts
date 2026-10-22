/**
 * M5b-2b-1 Gate B, R1 Server: the fence (before every memory read, at the
 * write, the commit revalidation, interactive retry versus scheduled
 * no-retry, retry ownership, the eligibility rule at commit and at claim,
 * in-flight claims, and the account-deletion fence on the writers this slice
 * adds or changes).
 * PLAN-M5b-2b-1 R1: REV-002, R2-001, R3-002, R5-001, R6-001, R6-003, R8-002,
 * R14-001, R15-001, R16-001. See support.ts for the harness and the gate rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeFromObservations } from '../../../lib/intelligence/proposalEngine.ts';
import { syncCanonicalObservations } from '../../../lib/intelligence/canonicalObservations.ts';
import { putObservations } from '../../../lib/intelligence/observationStore.ts';
import { deleteMemory, patchMemory } from '../../../lib/services/mobile/memoryService.ts';
import { readParticipantState } from '../../../lib/services/mobile/participantState.ts';
import {
  NOW, addFloating, addRows, aliasOf, allStoredSuggestions, assertUnavailable, begin, citationPaths, currentStorage,
  decide, answer, end, epochOf, identityOf, isMemoryPath, latestRun, markDeletedNow, memoryEntries, memoryObservations,
  model, observationIdsSent, plusMinutes, putMemory, removeMemoryRecord, said, seedSuggestion, setClock, setFence, show,
  spyStorage, statement, stored, sweepAccountNow, userPaths, withStorage, writeRun,
} from './support.ts';

test.afterEach(() => end());

const MORNING = 'I work best in the morning';
const BUS = 'I take the bus to work';
const SWIM = 'Learn to swim this summer';
const FIRST = 'Plan two study blocks';
const RETRY = 'Write a short study list';

async function fixture() {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: MORNING }, { content: BUS }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  const id = (content: string) => rows.find((row) => row.content === content)!.id;
  return { uid, rows, evidence, id };
}

const COMPLETION = (uid: string) => `users/${uid}/intelligenceMonitors/gate-b-completion`;

/** A scheduled caller, as the Gmail jobs call it: completion written in the proposal transaction. */
function scheduled(uid: string) {
  return proposeFromObservations(uid, NOW(), {
    storage: currentStorage() as any,
    throwOnGenerateFailure: true,
    transactionComplete: async (tx: any) => { tx.set(COMPLETION(uid), { done: true }); },
  });
}

function interactive(uid: string) {
  return proposeFromObservations(uid, NOW(), { storage: currentStorage() as any });
}

function citesFirst(evidenceId: string) {
  return (call: any) => ({ suggestions: [said('action', FIRST, [evidenceId], { memoryRefs: [aliasOf(call, MORNING)] })] });
}

function memoryFreeReply(evidenceId: string) {
  return () => ({ suggestions: [said('action', RETRY, [evidenceId])] });
}

/** The retry call carried no memory: no memory array and no memory observation. */
async function assertMemoryFree(uid: string, call: any): Promise<void> {
  assert.deepEqual(memoryEntries(call), [], `the retry still carried memory: ${show(call.context?.memory)}`);
  const copies = (await memoryObservations(uid)).map((row) => row.id);
  for (const id of observationIdsSent(call)) assert.equal(copies.includes(id), false, 'the retry still carried a memory observation');
  assert.equal(call.raw.includes(MORNING), false, 'the retry still carried a memory\'s words');
}

/* ── the fence at the write (R2-001, R3-002) ────────────────────────── */

test('R2-001: scheduled, a fence that moves during the model call commits neither the suggestions nor the completion, throws, and makes no retry call', async () => {
  const { uid, evidence } = await fixture();
  model.answer(citesFirst(evidence.id));
  model.during = async () => { await setFence(uid, { state: 'active', epoch: (await epochOf(uid)) + 1 }); };
  await assert.rejects(scheduled(uid), 'a scheduled run committed under a moved fence');
  assert.equal(model.calls.length, 1, 'a scheduled caller retried');
  assert.deepEqual(await allStoredSuggestions(uid), []);
  assert.notEqual((await latestRun(uid))?.status, 'complete', 'the run was completed under a moved fence');
  assert.equal(await currentStorage().get(COMPLETION(uid)), null, 'the scheduled completion was written');
  assert.deepEqual(citationPaths(uid), []);
});

test('R2-001/R3-002: interactive, a fence moved at commit answers nothing memory-shaped and retries once, memory-free, under its own claim', async () => {
  const { uid, evidence } = await fixture();
  model.answer(citesFirst(evidence.id), memoryFreeReply(evidence.id));
  let claimId: string | undefined;
  model.during = async (call) => {
    if (call.index !== 0) return;
    claimId = (await latestRun(uid))?.claimId;
    await setFence(uid, { state: 'active', epoch: (await epochOf(uid)) + 1 });
  };
  const answered = await interactive(uid);
  assert.equal(model.calls.length, 2, `expected exactly one memory-free retry, saw ${model.calls.length} model call(s)`);
  await assertMemoryFree(uid, model.calls[1]!);
  const rows = await allStoredSuggestions(uid);
  assert.equal(rows.some((row) => row.title === FIRST), false, 'the memory-shaped suggestion was committed');
  assert.equal(rows.some((row) => 'memoryBasis' in row), false, show(rows));
  assert.equal(answered.some((row) => row.title === FIRST), false, 'the memory-shaped suggestion was answered');
  const retried = await stored(uid, identityOf('action', RETRY, [evidence.id]));
  assert.ok(retried, 'the retry committed nothing');
  const run = await latestRun(uid);
  assert.equal(run?.claimId, claimId, 'the retry replaced the claim it owned');
  assert.equal(run?.status, 'complete');
  assert.deepEqual(run?.suggestionIds, [retried.id]);
});

test('R3-002: the memory-free retry never erases or replaces a newer claimant\'s reservation', async () => {
  const { uid, evidence } = await fixture();
  model.answer(citesFirst(evidence.id), memoryFreeReply(evidence.id));
  const newer = { digest: 'newer', contentDigest: 'newer', claimId: 'newer-claimant', status: 'running', generatedAt: NOW(), reservedUntil: plusMinutes(NOW(), 1), suggestionIds: [] };
  model.during = async (call) => {
    if (call.index === 0) await setFence(uid, { state: 'active', epoch: (await epochOf(uid)) + 1 });
    // Another request claims the run while the retry is with the model.
    if (call.index === 1) await writeRun(uid, newer);
  };
  await interactive(uid).catch(() => undefined);
  assert.equal(model.calls.length, 2, 'no memory-free retry was made');
  assert.deepEqual(await latestRun(uid), newer, 'the newer claimant\'s reservation was erased or replaced');
  assert.deepEqual(await allStoredSuggestions(uid), [], 'a run that lost its claim committed suggestions');
});

/* ── memory gone during the model call (R5-001, R6-003) ─────────────── */

for (const [what, change] of [
  ['deleted', (uid: string, memoryId: string) => deleteMemory(uid, memoryId, NOW())],
  ['corrected (superseded)', (uid: string, memoryId: string) => patchMemory(uid, memoryId, 'I work best in the late morning', NOW())],
] as const) {
  test(`R5-001/R6-003: interactive, a supplied memory ${what} during the model call commits nothing from that call and retries memory-free`, async () => {
    const { uid, evidence, id } = await fixture();
    model.answer(citesFirst(evidence.id), memoryFreeReply(evidence.id));
    model.during = async (call) => { if (call.index === 0) await change(uid, id(MORNING)); };
    await interactive(uid);
    const rows = await allStoredSuggestions(uid);
    assert.equal(rows.some((row) => row.title === FIRST), false, `a suggestion shaped by a memory ${what} mid-call was committed`);
    assert.equal(model.calls.length, 2, 'no memory-free retry was made');
    await assertMemoryFree(uid, model.calls[1]!);
    assert.ok(await stored(uid, identityOf('action', RETRY, [evidence.id])), 'the retry committed nothing');
  });

  test(`R5-001/R6-003: scheduled, a supplied memory ${what} during the model call commits neither suggestions nor completion, throws, and stays due`, async () => {
    const { uid, evidence, id } = await fixture();
    model.answer(citesFirst(evidence.id));
    model.during = async () => { await change(uid, id(MORNING)); };
    await assert.rejects(scheduled(uid), `a scheduled run committed after a memory was ${what}`);
    assert.equal(model.calls.length, 1, 'a scheduled caller retried');
    assert.deepEqual(await allStoredSuggestions(uid), []);
    assert.equal(await currentStorage().get(COMPLETION(uid)), null, 'the scheduled completion was written');
    assert.notEqual((await latestRun(uid))?.status, 'complete');
  });
}

test('R5-001: a memory that arrives as an observation and is deleted during the model call is reread at commit, so nothing it shaped is committed', async () => {
  const uid = await begin();
  const [goal] = await addRows(uid, [{ content: SWIM, kind: 'goal' }]);
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  const copy = (await memoryObservations(uid)).find((row) => row.sourceRef === goal!.id)!;
  assert.ok(copy, 'fixture: no observation copy of the goal');
  const evidence = await statement(uid, 'I want to plan my study week');
  model.answer(() => ({ suggestions: [said('action', 'Book a beginner swim lesson', [copy.id]), said('action', FIRST, [evidence.id])] }));
  model.during = async (call) => { if (call.index === 0) await removeMemoryRecord(uid, goal!.id); };
  await interactive(uid);
  assert.equal(await stored(uid, identityOf('action', 'Book a beginner swim lesson', [copy.id])), null,
    'a suggestion shaped by a memory deleted mid-call (through its observation) was committed');
  assert.equal(model.calls.length >= 2, true, 'no memory-free retry was made');
});

/* ── one eligibility rule (R8-002) ──────────────────────────────────── */

test('R8-002: a supplied memory that expires (staleAfter passes) during the model call makes the commit store nothing from that call', async () => {
  const uid = await begin();
  const shortLived = await putMemory(uid, MORNING, { ttlMs: 60_000 });
  const evidence = await statement(uid, 'I want to plan my study week');
  model.answer(citesFirst(evidence.id), memoryFreeReply(evidence.id));
  model.during = (call) => { if (call.index === 0) setClock(plusMinutes(NOW(), 2)); };
  await interactive(uid);
  const rows = await allStoredSuggestions(uid);
  assert.equal(rows.some((row) => row.title === FIRST), false, 'a suggestion shaped by a memory that expired mid-call was committed');
  assert.equal(rows.some((row) => (row.memoryBasis?.memoryIds ?? []).includes(shortLived)), false);
  assert.equal(model.calls.length, 2, 'no memory-free retry was made');
});

test('R8-002: a cited memory that expires right before accept refuses the accept (404 suggestion_unavailable) and creates nothing', async () => {
  const uid = await begin();
  const shortLived = await putMemory(uid, MORNING, { ttlMs: 60_000 });
  const evidence = await statement(uid, 'I want to plan my study week');
  const suggestion = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [shortLived], epoch: await epochOf(uid) });
  setClock(plusMinutes(NOW(), 2));
  assertUnavailable(await decide(uid, suggestion.id, 'accept'), 'accept after the basis expired');
  assert.equal((await readParticipantState(uid)).commitments[`int_${suggestion.id}`], undefined, 'a commitment was created');
});

test('R8-002: a cited memory that expires right before answer refuses the answer (404 suggestion_unavailable) and records no answer', async () => {
  const uid = await begin();
  const shortLived = await putMemory(uid, MORNING, { ttlMs: 60_000 });
  const evidence = await statement(uid, 'I want to plan my study week');
  const question = await seedSuggestion(uid, 'question', [evidence.id], { mode: 'on_basis', memoryIds: [shortLived], epoch: await epochOf(uid) });
  setClock(plusMinutes(NOW(), 2));
  assertUnavailable(await answer(uid, question.id), 'answer after the basis expired');
  const answers = (await currentStorage().list<any>(`users/${uid}/intelligenceObservations`)).filter((row) => row.data.sourceRef === `answer:${question.id}`);
  assert.deepEqual(answers, [], 'an answer observation was recorded');
  assert.equal((await stored(uid, question.id))?.status, 'pending');
});

/* ── in-flight actions (R6-001) ─────────────────────────────────────── */

test('R6-001: a memory deleted during the accept claim transaction refuses the action, and nothing is created', async () => {
  const uid = await begin();
  const [row] = await addRows(uid, [{ content: MORNING }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  const suggestion = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [row!.id], epoch: await epochOf(uid) });
  let fired = false;
  const spy = spyStorage(currentStorage(), {
    onRead: async (method, path) => {
      if (!fired && method === 'tx.get' && typeof path === 'string' && path.endsWith(`/intelligenceProposals/${suggestion.id}`)) {
        fired = true;
        await removeMemoryRecord(uid, row!.id);
      }
    },
  });
  const result = await withStorage(spy, () => decide(uid, suggestion.id, 'accept'));
  assert.equal((await readParticipantState(uid)).commitments[`int_${suggestion.id}`], undefined, 'a commitment was created after its basis was deleted mid-claim');
  assertUnavailable(result, 'accept whose basis was deleted during the claim');
  assert.notEqual((await stored(uid, suggestion.id))?.status, 'accepted');
  assert.ok(fired, 'fixture: the accept never read the suggestion in a transaction');
});

/* ── the fence before every memory read (REV-002) ───────────────────── */

for (const [what, fence] of [
  ['a purge', (epoch: number) => ({ state: 'purging', epoch: epoch + 1 })],
  ['a withdrawal', (epoch: number) => ({ state: 'withdrawing', epoch: epoch + 1 })],
] as const) {
  test(`REV-002: ${what} that begins between the epoch capture and the canonical sync leaves no memory-derived write and no basis`, async () => {
    const uid = await begin();
    await addRows(uid, [{ content: SWIM, kind: 'goal' }, { content: MORNING }]);
    const evidence = await statement(uid, 'I want to plan my study week');
    assert.deepEqual(await memoryObservations(uid), [], 'fixture: a memory observation already exists');
    let fired = false;
    const spy = spyStorage(currentStorage(), {
      // The first read of the memory store is the canonical sync's: the fence moves right before it.
      onRead: async (method, path) => {
        if (fired || !(isMemoryPath(path) || (method.endsWith('listGroup') && path === 'memory'))) return;
        fired = true;
        await setFence(uid, fence(await epochOf(uid)));
      },
    });
    model.answer((call) => ({ suggestions: [said('action', FIRST, [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] })] }));
    await withStorage(spy, () => proposeFromObservations(uid, NOW(), { storage: spy })).catch(() => undefined);
    assert.deepEqual(await memoryObservations(uid), [], `a memory observation was written after ${what} began`);
    for (const call of model.calls) assert.deepEqual(memoryEntries(call), [], 'memory reached the model under a moved fence');
    const rows = await allStoredSuggestions(uid);
    assert.equal(rows.some((row) => 'memoryBasis' in row), false, show(rows));
    assert.deepEqual(citationPaths(uid), []);
    assert.ok(fired, 'fixture: the run never read the memory store');
  });
}

test('R3-004: on_basis, a memory snapshot that cannot be read lets the run continue without memory (no memory array, no memory observation)', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: SWIM, kind: 'goal' }, { content: MORNING }]);
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  const copies = (await memoryObservations(uid)).map((row) => row.id);
  const evidence = await statement(uid, 'I want to plan my study week');
  const { memoryUnreadable } = await import('./support.ts');
  const failing = memoryUnreadable(currentStorage());
  model.answer(() => ({ suggestions: [said('action', FIRST, [evidence.id])] }));
  await withStorage(failing, () => proposeFromObservations(uid, NOW(), { storage: failing }));
  assert.ok(model.calls.length >= 1, 'the run did not reach the model');
  for (const call of model.calls) {
    assert.deepEqual(memoryEntries(call), []);
    for (const id of observationIdsSent(call)) assert.equal(copies.includes(id), false, 'a memory observation reached the model without a snapshot');
  }
});

/* ── the account-deletion fence (R14-001, R15-001, R16-001) ─────────── */

test('R14-001: markDeleted committing during the model call leaves no suggestion, completed run or citation row', async () => {
  const { uid, evidence } = await fixture();
  model.answer(citesFirst(evidence.id), memoryFreeReply(evidence.id));
  model.during = async () => { await markDeletedNow(uid); };
  await interactive(uid).catch(() => undefined);
  assert.deepEqual(await allStoredSuggestions(uid), [], 'a suggestion was written for a deleted account');
  assert.notEqual((await latestRun(uid))?.status, 'complete', 'a run was completed for a deleted account');
  assert.deepEqual(citationPaths(uid), []);
});

for (const source of ['memory', 'commitment'] as const) {
  test(`R15-001: putObservations after markDeleted writes no ${source} observation`, async () => {
    const uid = await begin();
    await markDeletedNow(uid);
    await putObservations(uid, source, `gate-b-${source}-ref`, NOW(), [{ kind: source === 'memory' ? 'goal' : 'commitment', evidence: 'Learn to swim this summer', confidence: 1 } as any], currentStorage() as any)
      .catch(() => undefined);
    const rows = await currentStorage().list(`users/${uid}/intelligenceObservations`);
    assert.deepEqual(rows, [], `a ${source} observation was written for a deleted account`);
  });

  test(`R15-001: putObservations after the user-tree sweep recreates no ${source} observation (nothing under the account)`, async () => {
    const uid = await begin();
    await sweepAccountNow(uid);
    await putObservations(uid, source, `gate-b-${source}-ref`, NOW(), [{ kind: source === 'memory' ? 'goal' : 'commitment', evidence: 'Learn to swim this summer', confidence: 1 } as any], currentStorage() as any)
      .catch(() => undefined);
    assert.deepEqual(userPaths(uid), [], 'a user-scoped row was recreated after the sweep');
  });
}

test('R15-001: the canonical sync after markDeleted writes no memory or commitment observation', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: SWIM, kind: 'goal' }]);
  await addFloating(uid, 'Call the bank');
  await markDeletedNow(uid);
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any).catch(() => undefined);
  assert.deepEqual(await currentStorage().list(`users/${uid}/intelligenceObservations`), [], 'the canonical sync wrote for a deleted account');
});

test('R15-001: a sweep that completes between the canonical sync\'s read and its observation write recreates nothing under the account', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: SWIM, kind: 'goal' }]);
  await addFloating(uid, 'Call the bank');
  let fired = false;
  const spy = spyStorage(currentStorage(), {
    onRead: async (method, path) => {
      if (fired || typeof path !== 'string' || !/\/intelligenceObservations\/[a-f0-9]{64}$/.test(path)) return;
      fired = true;
      await sweepAccountNow(uid);
    },
  });
  await withStorage(spy, () => syncCanonicalObservations(uid, NOW(), spy)).catch(() => undefined);
  assert.deepEqual(userPaths(uid), [], 'an observation was recreated behind the account sweep');
  assert.ok(fired, 'fixture: the sync never addressed an observation');
});
