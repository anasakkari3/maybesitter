/**
 * M5b-2b-1 Gate B, R1 Server: memory deletion and correction (hide always,
 * the reverse citation index, conditional cleanup with run pruning, batches
 * of more than 30 chain ids, pages of 100, interruption and resume,
 * correction residue, lazy removal, observation copies).
 * PLAN-M5b-2b-1 R1: R2-002, R3-003, R4-001, R5-002, R6-004, R6-005, R8-004,
 * R9-003, R12-003, R19-001. See support.ts for the harness and the gate rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCanonicalObservations } from '../../../lib/intelligence/canonicalObservations.ts';
import { deleteMemory, patchMemory, MemoryNotFoundError } from '../../../lib/services/mobile/memoryService.ts';
import { createStorageRuntimeMemoryStore } from '../../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { intelligenceRunPath } from '../../../lib/intelligence/proposalEngine.ts';
import {
  NOW, addRows, aliasOf, assertUnavailable, begin, citationPath, citationPaths, currentStorage, decide, deleteMemoryRoute,
  end, epochOf, exportAccount, generate, identityOf, ids, inbox, isMemoryPath, latestRun, memoryObservations, model,
  revokeMemory, said, seedSuggestion, settle, show, spyStorage, statement, stored, withStorage, writeCitation, writeRun,
} from './support.ts';

test.afterEach(() => end());

const MORNING = 'I work best in the morning';
const SWIM = 'Learn to swim this summer';

function visitRun(suggestionIds: string[]) {
  return {
    digest: 'seeded', contentDigest: 'seeded', claimId: 'seeded-claim', status: 'complete', mode: 'on_basis',
    generatedAt: NOW(), reservedUntil: NOW(), suggestionIds, visitDay: NOW().slice(0, 10), visitRuns: 1,
  };
}

async function retryDelete(uid: string, id: string): Promise<void> {
  try { await deleteMemory(uid, id, NOW()); } catch (error) { if (!(error instanceof MemoryNotFoundError)) throw error; }
}

const isCitationList = (method: string, path: unknown) =>
  (method.endsWith('list') && typeof path === 'string' && /\/memoryCitations$/.test(path))
  || (method.endsWith('listGroup') && path === 'memoryCitations');

/* ── observation copies (R2-002) ────────────────────────────────────── */

test('R2-002: deleting a goal memory deletes its source:memory observation copies; none remains in storage, the inbox or the export', async () => {
  const uid = await begin();
  const [goal] = await addRows(uid, [{ content: SWIM, kind: 'goal' }]);
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  assert.ok((await memoryObservations(uid)).some((row) => row.sourceRef === goal!.id), 'fixture: no observation copy of the goal');
  const deleted = await deleteMemoryRoute(uid, goal!.id);
  assert.ok(deleted.status < 300, show(deleted.body));
  assert.deepEqual((await memoryObservations(uid)).filter((row) => row.sourceRef === goal!.id), [], 'the goal\'s observation copy survived its deletion');
  assert.equal((await inbox(uid)).observations.some((row: any) => row.sourceRef === goal!.id), false);
  const exported = await exportAccount(uid);
  assert.equal(exported.status, 200, show(exported.body));
  assert.equal(exported.body.collections.intelligenceObservations.some((row: any) => row.data.sourceRef === goal!.id), false);
});

test('R2-002: a canonical sync racing a delete recreates no observation copy (the write verifies its memory is still active)', async () => {
  const uid = await begin();
  const [goal] = await addRows(uid, [{ content: SWIM, kind: 'goal' }]);
  let fired = false;
  const spy = spyStorage(currentStorage(), {
    // The memory was read; the delete lands before the observation is written.
    onRead: async (method, path) => {
      if (fired || typeof path !== 'string' || !/\/intelligenceObservations\/[a-f0-9]{64}$/.test(path)) return;
      fired = true;
      await currentStorage().delete(`users/${uid}/memory/${goal!.id}`);
    },
  });
  await withStorage(spy, () => syncCanonicalObservations(uid, NOW(), spy)).catch(() => undefined);
  assert.deepEqual((await memoryObservations(uid)).filter((row) => row.sourceRef === goal!.id), [], 'the sync recreated a copy of a deleted memory');
  assert.ok(fired, 'fixture: the sync never addressed an observation');
});

test('R2-002/R6-005: the inbox never shows a memory observation whose memory is inactive (defence in depth), and the read removes it', async () => {
  const uid = await begin();
  const [goal] = await addRows(uid, [{ content: SWIM, kind: 'goal' }]);
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  await revokeMemory(goal!.id);
  const body = await inbox(uid);
  assert.equal(body.observations.some((row: any) => row.sourceRef === goal!.id), false, 'the inbox shows a copy of an inactive memory');
  await settle();
  assert.deepEqual((await memoryObservations(uid)).filter((row) => row.sourceRef === goal!.id), [], 'the read did not remove the hidden residue');
});

/* ── the reverse citation index (R8-004) ────────────────────────────── */

test('R8-004: a basis-bearing suggestion is created with one content-free memoryCitations row per cited memory', async () => {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: MORNING }, { content: 'I take the bus to work' }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  model.answer((call) => ({ suggestions: [
    said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: rows.map((row) => aliasOf(call, row.content)) }),
    said('action', 'Book a quiet study room', [evidence.id]),
  ] }));
  await generate(uid);
  const cited = identityOf('action', 'Plan two study blocks', [evidence.id]);
  assert.deepEqual(citationPaths(uid).sort(), rows.map((row) => citationPath(uid, row.id, cited)).sort());
  for (const row of rows) assert.deepEqual(await currentStorage().get(citationPath(uid, row.id, cited)), { memoryId: row.id, suggestionId: cited });
});

/* ── hide always (R3-003) ───────────────────────────────────────────── */

test('R3-003: a suggestion with any inactive basis id is hidden entirely: inbox, generate, actions and export, whatever cleanup did', async () => {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: MORNING }, { content: 'I take the bus to work' }]);
  const a = rows.find((row) => row.content === MORNING);
  const b = rows.find((row) => row.content === 'I take the bus to work');
  const evidence = await statement(uid, 'I want to plan my study week');
  const suggestion = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id, b!.id], epoch: await epochOf(uid) });
  await writeRun(uid, visitRun([suggestion.id]));
  await revokeMemory(b!.id);
  assert.equal(ids((await inbox(uid)).suggestions).includes(suggestion.id), false, 'the inbox shows a partly inactive basis');
  assert.equal(ids((await generate(uid, true)).suggestions).includes(suggestion.id), false, 'generate answers a partly inactive basis');
  assertUnavailable(await decide(uid, suggestion.id, 'accept'), 'accept with a partly inactive basis');
  const exported = await exportAccount(uid);
  assert.equal(exported.status, 200, show(exported.body));
  assert.equal(exported.body.collections.intelligenceProposals.some((row: any) => row.id === suggestion.id), false, 'the export carries a hidden suggestion');
});

/* ── cleanup in deleteMemory (R3-003, R12-003, R19-001) ─────────────── */

test('R12-003/R19-001: deleting a memory removes the suggestions citing it, their citation rows and their run reference', async () => {
  const uid = await begin();
  const [a] = await addRows(uid, [{ content: MORNING }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  const citing = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id], epoch: await epochOf(uid) });
  const other = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis' });
  await writeRun(uid, visitRun([citing.id, other.id]));
  const deleted = await deleteMemoryRoute(uid, a!.id);
  assert.ok(deleted.status < 300, show(deleted.body));
  assert.equal(await stored(uid, citing.id), null, 'the citing suggestion survived the deletion of its memory');
  assert.deepEqual(citationPaths(uid), []);
  assert.deepEqual((await latestRun(uid))?.suggestionIds, [other.id], 'the run still names the removed suggestion');
  assert.ok(await stored(uid, other.id), 'an unrelated suggestion was removed');
});

test('R9-003: a chain of more than 30 ids is cleaned in batches of at most 30 (memoryId in […]) and every citing suggestion goes', async () => {
  const uid = await begin();
  const [first] = await addRows(uid, [{ content: 'Version 0 of the fact' }]);
  const chain = [first!.id];
  for (let index = 1; index <= 34; index += 1) chain.push((await patchMemory(uid, chain[chain.length - 1]!, `Version ${index} of the fact`, NOW())).id);
  assert.equal(chain.length, 35);
  const evidence = await statement(uid, 'I want to plan my study week');
  const epoch = await epochOf(uid);
  const citing = [
    await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [chain[0]!], epoch }),
    await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [chain[31]!], epoch }),
    await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [chain[34]!], epoch }),
  ];
  const inQueries: number[] = [];
  const limits: Array<number | undefined> = [];
  const spy = spyStorage(currentStorage(), {
    onRead: (method, path, options) => {
      if (!isCitationList(method, path)) return;
      limits.push(options?.limit);
      for (const [, op, value] of (options?.where ?? []) as Array<[string, string, unknown]>) if (op === 'in') inQueries.push((value as unknown[]).length);
    },
  });
  await withStorage(spy, () => deleteMemory(uid, chain[34]!, NOW()));
  for (const row of citing) assert.equal(await stored(uid, row.id), null, 'a suggestion citing a chain id survived');
  assert.deepEqual(citationPaths(uid), []);
  assert.ok(inQueries.length >= 2, `expected at least two 'in' batches over 35 ids, saw ${inQueries.length}`);
  for (const size of inQueries) assert.ok(size <= 30, `an 'in' batch carried ${size} ids`);
  for (const limit of limits) assert.ok(typeof limit === 'number' && limit <= 100, `a citation page was read with limit ${limit}`);
});

test('R5-002: two pages of citing suggestions (more than 100) are all removed, read in pages of at most 100', async () => {
  const uid = await begin();
  const [a] = await addRows(uid, [{ content: MORNING }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  const epoch = await epochOf(uid);
  const citing: string[] = [];
  for (let index = 0; index < 205; index += 1) {
    citing.push((await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id], epoch })).id);
  }
  const limits: Array<number | undefined> = [];
  const spy = spyStorage(currentStorage(), { onRead: (method, path, options) => { if (isCitationList(method, path)) limits.push(options?.limit); } });
  await withStorage(spy, () => deleteMemory(uid, a!.id, NOW()));
  const left = [];
  for (const id of citing) if (await stored(uid, id)) left.push(id);
  assert.equal(left.length, 0, `${left.length} of 205 citing suggestions survived`);
  assert.deepEqual(citationPaths(uid), []);
  assert.ok(limits.length >= 3, `expected at least three citation pages, saw ${limits.length}`);
  for (const limit of limits) assert.ok(typeof limit === 'number' && limit <= 100, `a citation page was read with limit ${limit}`);
});

test('R12-003: cleanup that found A__S resumes after an A→B replacement: S (now citing B) and B__S remain, A__S is gone', async () => {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: MORNING }, { content: 'I take the bus to work' }]);
  const a = rows.find((row) => row.content === MORNING);
  const b = rows.find((row) => row.content === 'I take the bus to work');
  const evidence = await statement(uid, 'I want to plan my study week');
  const epoch = await epochOf(uid);
  const suggestion = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id], epoch });
  let replaced = false;
  const spy = spyStorage(currentStorage(), {
    afterRead: async (method, path, result) => {
      if (replaced || !isCitationList(method, path) || !(result as any[]).some((row) => row.id === `${a!.id}__${suggestion.id}`)) return;
      replaced = true;
      // An A→B replacement commits between the cleanup's query and its delete.
      await currentStorage().set(`users/${uid}/intelligenceProposals/${suggestion.id}`, { ...suggestion, memoryBasis: { memoryIds: [b!.id], epoch } });
      await currentStorage().delete(citationPath(uid, a!.id, suggestion.id));
      await writeCitation(uid, b!.id, suggestion.id);
    },
  });
  await withStorage(spy, () => deleteMemory(uid, a!.id, NOW()));
  const survivor = await stored(uid, suggestion.id);
  assert.deepEqual(survivor?.memoryBasis?.memoryIds, [b!.id], `the replacement (citing B) did not survive the cleanup of A: ${show(survivor)}`);
  assert.ok(await currentStorage().get(citationPath(uid, b!.id, suggestion.id)), 'B__S was removed');
  assert.equal(await currentStorage().get(citationPath(uid, a!.id, suggestion.id)), null, 'A__S survived');
  assert.ok(replaced, 'fixture: the cleanup never read the citation index');
});

test('R19-001: a fault at the run-pruning boundary leaves a citation row to rediscover; a retry by id leaves no suggestion, citation row or run reference', async () => {
  const uid = await begin();
  const [a] = await addRows(uid, [{ content: MORNING }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  const citing = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id], epoch: await epochOf(uid) });
  const other = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis' });
  await writeRun(uid, visitRun([citing.id, other.id]));
  let faulted = false;
  const spy = spyStorage(currentStorage(), {
    onWrite: (method, path) => {
      if (faulted || path !== intelligenceRunPath(uid) || method === 'tx.delete' || method === 'delete') return;
      faulted = true;
      throw new Error('fault injected at the run-pruning boundary');
    },
  });
  await withStorage(spy, () => deleteMemory(uid, a!.id, NOW())).catch(() => undefined);
  await retryDelete(uid, a!.id);
  assert.equal(await stored(uid, citing.id), null, 'the citing suggestion survived the retry');
  assert.deepEqual(citationPaths(uid), []);
  assert.deepEqual((await latestRun(uid))?.suggestionIds, [other.id], 'a dangling run reference remains');
  assert.ok(faulted, 'fixture: the cleanup never pruned the run');
});

test('R6-004: a fault inside deleteMemory before deleteChain: a retry by id leaves no observation copy, suggestion or citation row', async () => {
  const uid = await begin();
  const [goal] = await addRows(uid, [{ content: SWIM, kind: 'goal' }]);
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  const evidence = await statement(uid, 'I want to plan my study week');
  const citing = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [goal!.id], epoch: await epochOf(uid) });
  let faulted = false;
  const spy = spyStorage(currentStorage(), {
    // deleteChain's first record removal fails: the records have not gone yet.
    onWrite: (method, path) => {
      if (faulted || !isMemoryPath(path) || !(method === 'delete' || method === 'tx.delete')) return;
      faulted = true;
      throw new Error('fault injected before the chain was deleted');
    },
  });
  await assert.rejects(withStorage(spy, () => deleteMemory(uid, goal!.id, NOW())));
  assert.ok(faulted, 'fixture: the fault never fired');
  await deleteMemory(uid, goal!.id, NOW());
  assert.deepEqual((await memoryObservations(uid)).filter((row) => row.sourceRef === goal!.id), [], 'an observation copy survived the retry');
  assert.equal(await stored(uid, citing.id), null, 'a citing suggestion survived the retry');
  assert.deepEqual(citationPaths(uid), []);
});

/* ── correction residue and lazy removal (R4-001, R6-005) ───────────── */

test('R4-001/R6-005: after a supersede whose cleanup never ran, nothing shows in the inbox, the reuse, the claim or the export, and the next read removes the rows', async () => {
  const uid = await begin();
  const [goal] = await addRows(uid, [{ content: SWIM, kind: 'goal' }]);
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  const copy = (await memoryObservations(uid)).find((row) => row.sourceRef === goal!.id)!;
  assert.ok(copy, 'fixture: no observation copy of the goal');
  const evidence = await statement(uid, 'I want to plan my study week');
  const citing = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [goal!.id], epoch: await epochOf(uid) });
  await writeRun(uid, visitRun([citing.id]));
  // The supersede commits; the cleanup that should follow it never runs (a fault in between).
  await createStorageRuntimeMemoryStore(undefined, currentStorage() as any).supersede(goal!.id, {
    scopeId: uid, kind: 'goal', content: 'Learn to swim before August', language: 'en', source: 'user_stated',
    confidence: 1, observedAt: NOW(), evidenceIds: [], provenance: { origin: 'manual' },
  } as any, NOW());
  const body = await inbox(uid);
  assert.equal(ids(body.suggestions).includes(citing.id), false, 'the inbox shows a suggestion citing a superseded memory');
  assert.equal(body.observations.some((row: any) => row.id === copy.id), false, 'the inbox shows the superseded memory\'s observation');
  await settle();
  assert.equal(await stored(uid, citing.id), null, 'the read did not remove the hidden suggestion');
  assert.equal((await memoryObservations(uid)).some((row) => row.id === copy.id), false, 'the read did not remove the hidden observation');
  assert.equal(ids((await generate(uid, true)).suggestions).includes(citing.id), false, 'the reuse answers it');
  assertUnavailable(await decide(uid, citing.id, 'accept'), 'accept of a suggestion citing a superseded memory');
  const exported = await exportAccount(uid);
  assert.equal(exported.status, 200, show(exported.body));
  assert.equal(exported.body.collections.intelligenceProposals.some((row: any) => row.id === citing.id), false);
  assert.equal(exported.body.collections.intelligenceObservations.some((row: any) => row.id === copy.id), false);
});

test('R4-001: correcting a memory through the route runs the same cleanup for the superseded id', async () => {
  const uid = await begin();
  const [a] = await addRows(uid, [{ content: MORNING }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  const citing = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id], epoch: await epochOf(uid) });
  await writeRun(uid, visitRun([citing.id]));
  const { patchMemoryRoute } = await import('./support.ts');
  const patched = await patchMemoryRoute(uid, a!.id, 'I work best in the late morning');
  assert.ok(patched.status < 300, show(patched.body));
  assert.equal(await stored(uid, citing.id), null, 'the suggestion citing the corrected memory survived');
  assert.deepEqual(citationPaths(uid), []);
  assert.deepEqual((await latestRun(uid))?.suggestionIds, []);
});
