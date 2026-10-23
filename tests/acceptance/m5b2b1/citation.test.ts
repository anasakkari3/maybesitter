/**
 * M5b-2b-1 Gate B, R1 Server: citation (aliases, schema, validation, the
 * stored marker, the union of at most 3, identity, the mode marker).
 * PLAN-M5b-2b-1 R1 + REV-003, REV-004, R2-003, R2-004, R3-001. See support.ts
 * for the harness and the gate rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { proposeFromObservations } from '../../../lib/intelligence/proposalEngine.ts';
import { syncCanonicalObservations } from '../../../lib/intelligence/canonicalObservations.ts';
import { putObservations } from '../../../lib/intelligence/observationStore.ts';
import {
  NOW, addFloating, addRows, aliasFor, aliasOf, allStoredSuggestions, begin, currentStorage, end, identityOf,
  isMemoryPath, latestRun, memoryEntries, memoryObservations, model, observationIdsSent, said, setFence, setMode, show,
  spyStorage, statement, stored, suggestionSchemaProperties, withStorage,
} from './support.ts';

test.afterEach(() => end());

const MORNING = 'I work best in the morning';
const MEETINGS = 'I prefer short meetings';
const BUS = 'I take the bus to work';
const WALK = 'I walk the dog at seven';
const SWIM = 'Learn to swim this summer';
const SPANISH = 'Learn Spanish this year';
const PIANO = 'Practice the piano weekly';
const RUN = 'Run a 10k race';

async function fixture(extra: Array<{ content: string; kind?: 'fact' | 'preference' | 'goal' }> = []) {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: MORNING }, { content: MEETINGS, kind: 'preference' }, { content: BUS }, ...extra]);
  const evidence = await statement(uid, 'I want to plan my study week');
  const id = (content: string) => rows.find((row) => row.content === content)!.id;
  return { uid, rows, evidence, id };
}

function run(uid: string) {
  return proposeFromObservations(uid, NOW(), { storage: currentStorage() as any });
}

/* ── aliases and schema (on_basis only) ─────────────────────────────── */

test('R1 aliases: on_basis, each memory row sent to the model carries its positional alias m1…mN and no record id', async () => {
  const { uid, rows, evidence } = await fixture();
  model.answer(() => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id])] }));
  await run(uid);
  assert.ok(model.calls.length >= 1, 'the model was never called');
  const sent = memoryEntries(model.calls[0]!);
  assert.equal(sent.length, rows.length, show(sent));
  sent.forEach((entry, index) => {
    assert.ok(Object.values(entry).includes(`m${index + 1}`), `memory row ${index + 1} carries no alias m${index + 1}: ${show(entry)}`);
  });
  for (const row of rows) assert.equal(model.calls[0]!.raw.includes(row.id), false, `memory id ${row.id} reached the model`);
});

test('R1 aliases: on_basis, at most 30 memory rows are sent, aliased m1…m30', async () => {
  const uid = await begin();
  const rows = await addRows(uid, Array.from({ length: 31 }, (_, index) => ({ content: `Remembered fact number ${index + 1}` })));
  const evidence = await statement(uid, 'I want to plan my study week');
  model.answer(() => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id])] }));
  await run(uid);
  const sent = memoryEntries(model.calls[0]!);
  assert.equal(sent.length, 30, `expected 30 memory rows, got ${sent.length}`);
  const aliases = sent.map((entry) => Object.values(entry).find((value) => typeof value === 'string' && /^m\d+$/.test(value)));
  assert.deepEqual(aliases, Array.from({ length: 30 }, (_, index) => `m${index + 1}`));
  for (const row of rows) assert.equal(model.calls[0]!.raw.includes(row.id), false, 'a memory record id reached the model');
});

test('R1 schema: on_basis, the response schema offers an optional memoryRefs string array per suggestion', async () => {
  const { uid, evidence } = await fixture();
  model.answer(() => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id])] }));
  await run(uid);
  const properties = suggestionSchemaProperties(model.calls[0]!);
  assert.ok(properties.memoryRefs, `no memoryRefs in the schema: ${show(Object.keys(properties))}`);
  assert.match(String(properties.memoryRefs.type), /array/i);
  assert.match(String(properties.memoryRefs.items?.type), /string/i);
  const required = model.calls[0]!.responseSchema.properties.suggestions.items.required ?? [];
  assert.equal(required.includes('memoryRefs'), false, 'memoryRefs must be optional');
});

/* ── off: byte parity (M5b-1 / M5b-2a rule) ─────────────────────────── */

/**
 * The digest of today's off-mode model requests and stored result for one
 * fixed account, computed on the base (f2c883af), suggestions sorted by kind and title. Any change to the prompt,
 * the schema, the context or the stored suggestion in `off` changes it.
 */
const OFF_PARITY_DIGEST = '63c310c3ceba935765e686e7ea36db2b840c09b5709ad2728902e85a923c2f67';

test('R1 parity: off, the model request bytes, the schema and the stored suggestion are unchanged (digest)', async () => {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: MORNING }, { content: SWIM, kind: 'goal' }]);
  // Fixed ids and refs, so nothing in the material depends on test order.
  await addFloating(uid, 'Call the bank', '0c0ffee6-0000-4000-8000-00000000b0b0');
  const [evidence] = await putObservations(uid, 'manual', 'gate-b-parity-statement', NOW(), [{ kind: 'intention', evidence: 'I want to plan my study week', confidence: 0.8 } as any], currentStorage() as any);
  setMode('off');
  model.answer(() => ({ suggestions: [
    said('action', 'Plan two study blocks', [evidence!.id], { memoryRefs: ['m1'] }),
    said('question', 'Which evenings are free for study?', [evidence!.id]),
  ] }));
  await run(uid);
  // Sorted by what the model said, never by id: one id is hashed from a random
  // memory-observation uuid, so an id order would differ from run to run.
  const suggestions = (await allStoredSuggestions(uid)).sort((a, b) => `${a.kind}\u0000${a.title}`.localeCompare(`${b.kind}\u0000${b.title}`));
  const runDoc = await latestRun(uid);
  // The claim is a random uuid; the two digests hash the context, whose bytes the calls already carry.
  const { claimId: _claim, digest: _digest, contentDigest: _contentDigest, ...runWithoutClaim } = runDoc ?? ({} as any);
  let material = JSON.stringify({ calls: model.calls.map((call) => call.raw), suggestions, run: runWithoutClaim });
  // Memory record ids are random uuids (and so is the id of a goal memory's
  // observation copy, a hash of it): replaced by placeholders, nothing else.
  const copies = await memoryObservations(uid);
  // A suggestion citing that copy has an identity hashed from it.
  for (const suggestion of suggestions) {
    if (copies.some((copy) => suggestion.observationIds.includes(copy.id))) material = material.replaceAll(suggestion.id, 'SUGGESTION_CITING_MEMORY_OBSERVATION');
  }
  for (const copy of copies) material = material.replaceAll(copy.id, 'MEMORY_OBSERVATION_ID');
  for (const row of rows) material = material.replaceAll(row.id, 'MEMORY_ID');
  material = material.replaceAll(uid, 'UID');
  const digest = createHash('sha256').update(material).digest('hex');
  if (process.env.GATE_B_PRINT_DIGEST) console.log('OFF_PARITY_DIGEST', digest);
  assert.equal(digest, OFF_PARITY_DIGEST, 'off-mode bytes changed');
  for (const suggestion of suggestions) {
    assert.equal('memoryBasis' in suggestion, false, show(suggestion));
    assert.equal('mode' in suggestion, false, show(suggestion));
  }
  assert.equal('mode' in (runDoc ?? {}), false, show(runDoc));
});

/* ── on_nobasis: the memory module is killed (REV-003, R2-003) ──────── */

test('REV-003: on_nobasis, the model gets no memory array, no source:memory observation and no memoryRefs in the schema', async () => {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: MORNING }, { content: SWIM, kind: 'goal' }]);
  const swim = rows.find((row) => row.content === SWIM)!;
  const evidence = await statement(uid, 'I want to plan my study week');
  setMode('on_nobasis');
  model.answer(() => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id])] }));
  await run(uid);
  assert.ok(model.calls.length >= 1, 'the model was never called');
  for (const call of model.calls) {
    assert.deepEqual(memoryEntries(call), [], `memory reached the model in on_nobasis: ${show(call.context?.memory)}`);
    assert.equal(call.raw.includes(MORNING), false, 'a memory row\'s content reached the model');
    assert.equal(call.raw.includes(SWIM), false, 'a goal memory (array or observation) reached the model');
    assert.equal(call.raw.includes(swim.id), false);
    const properties = suggestionSchemaProperties(call);
    assert.equal('memoryRefs' in properties, false, 'the on_nobasis schema offers memoryRefs');
  }
});

test('R2-003: on_nobasis, the run (and its canonical sync) reads no memory store and writes no source:memory observation', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: MORNING }, { content: SWIM, kind: 'goal' }]);
  await addFloating(uid, 'Call the bank');
  const evidence = await statement(uid, 'I want to plan my study week');
  setMode('on_nobasis');
  const memoryReads: string[] = [];
  const memoryWrites: string[] = [];
  const spy = spyStorage(currentStorage(), {
    onRead: (method, path) => {
      if (isMemoryPath(path) || (method.endsWith('listGroup') && path === 'memory')
        || (Array.isArray(path) && path.some(isMemoryPath))) memoryReads.push(`${method} ${String(path)}`);
    },
    onWrite: (method, path, value) => {
      if (/\/intelligenceObservations\//.test(path) && (value as any)?.source === 'memory') memoryWrites.push(`${method} ${path}`);
    },
  });
  model.answer(() => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id])] }));
  await withStorage(spy, async () => {
    await syncCanonicalObservations(uid, NOW(), spy);
    await proposeFromObservations(uid, NOW(), { storage: spy });
  });
  assert.deepEqual(memoryReads, [], 'on_nobasis read the memory store');
  assert.deepEqual(memoryWrites, [], 'on_nobasis wrote a memory observation');
  assert.deepEqual(await memoryObservations(uid), []);
  const commitments = (await currentStorage().list<any>(`users/${uid}/intelligenceObservations`)).filter((row) => row.data.source === 'commitment');
  assert.equal(commitments.length, 1, 'commitments are still synchronized');
});

/* ── validateSuggestions ────────────────────────────────────────────── */

test('R1 validateSuggestions: an unknown alias drops that citation, not the suggestion; a suggestion with only unknown aliases is stored unmarked', async () => {
  const { uid, evidence, id } = await fixture();
  model.answer((call) => ({ suggestions: [
    said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: [aliasOf(call, MORNING), 'm9'] }),
    said('action', 'Book a quiet study room', [evidence.id], { memoryRefs: ['m7'] }),
  ] }));
  await run(uid);
  const cited = await stored(uid, identityOf('action', 'Plan two study blocks', [evidence.id]));
  const uncited = await stored(uid, identityOf('action', 'Book a quiet study room', [evidence.id]));
  assert.ok(cited, 'the suggestion with one unknown alias was dropped');
  assert.ok(uncited, 'the suggestion with only an unknown alias was dropped');
  assert.deepEqual(cited.memoryBasis?.memoryIds, [id(MORNING)], show(cited));
  assert.equal('memoryBasis' in uncited, false, show(uncited));
});

test('R1 validateSuggestions: duplicate aliases are removed and at most 3 citations are kept', async () => {
  const { uid, evidence, id } = await fixture([{ content: WALK }]);
  model.answer((call) => ({ suggestions: [
    said('action', 'Plan two study blocks', [evidence.id], {
      memoryRefs: [aliasOf(call, MORNING), aliasOf(call, MORNING), aliasOf(call, MEETINGS), aliasOf(call, BUS)],
    }),
    said('action', 'Book a quiet study room', [evidence.id], {
      memoryRefs: [aliasOf(call, MORNING), aliasOf(call, MEETINGS), aliasOf(call, BUS), aliasOf(call, WALK)],
    }),
  ] }));
  await run(uid);
  const deduped = await stored(uid, identityOf('action', 'Plan two study blocks', [evidence.id]));
  assert.ok(deduped, 'fixture: the first suggestion was not stored');
  assert.deepEqual([...(deduped.memoryBasis?.memoryIds ?? [])].sort(), [id(MORNING), id(MEETINGS), id(BUS)].sort(), show(deduped));
  const capped = await stored(uid, identityOf('action', 'Book a quiet study room', [evidence.id]));
  assert.ok(capped, 'four direct citations dropped the suggestion instead of keeping three');
  const kept: string[] = capped.memoryBasis?.memoryIds ?? [];
  assert.equal(kept.length, 3, show(capped));
  assert.equal(new Set(kept).size, 3);
  for (const memoryId of kept) assert.ok([id(MORNING), id(MEETINGS), id(BUS), id(WALK)].includes(memoryId));
});

test('R1 identity: a cited suggestion keeps the identity hash it has without the citation (memory is not part of identity)', async () => {
  const { uid, evidence, id } = await fixture();
  model.answer((call) => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] })] }));
  const answered = await run(uid);
  const expected = identityOf('action', 'Plan two study blocks', [evidence.id]);
  const row = await stored(uid, expected);
  assert.ok(row, `no suggestion stored under the citation-free identity ${expected}: ${show(answered.map((item) => item.id))}`);
  assert.deepEqual(row.memoryBasis?.memoryIds, [id(MORNING)], 'the suggestion was not stored as cited');
  assert.deepEqual(answered.map((item) => item.id), [expected]);
});

/* ── the stored marker ──────────────────────────────────────────────── */

test('R1 marker: a cited suggestion stores memoryBasis { memoryIds, epoch } with ids only and the fence epoch captured before memory was read', async () => {
  const { uid, evidence, id } = await fixture();
  await setFence(uid, { state: 'active', epoch: 4 });
  model.answer((call) => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: [aliasOf(call, MORNING), aliasOf(call, BUS)] })] }));
  await run(uid);
  const row = await stored(uid, identityOf('action', 'Plan two study blocks', [evidence.id]));
  assert.ok(row?.memoryBasis, `no memoryBasis stored: ${show(row)}`);
  assert.deepEqual(Object.keys(row.memoryBasis).sort(), ['epoch', 'memoryIds']);
  assert.deepEqual([...row.memoryBasis.memoryIds].sort(), [id(MORNING), id(BUS)].sort());
  assert.equal(row.memoryBasis.epoch, 4);
  assert.equal(JSON.stringify(row.memoryBasis).includes(MORNING), false, 'memory content was stored in the marker');
});

test('R1 marker: first create only: a later run never rewrites the basis of an existing eligible suggestion', async () => {
  const { uid, evidence, id } = await fixture();
  model.answer((call) => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] })] }));
  await run(uid);
  const key = identityOf('action', 'Plan two study blocks', [evidence.id]);
  const first = await stored(uid, key);
  assert.deepEqual(first?.memoryBasis?.memoryIds, [id(MORNING)], `the first run stored no basis: ${show(first)}`);
  // A second, explicit run over a changed context cites another memory for the same suggestion.
  await statement(uid, 'Exams start in two weeks');
  model.reset();
  model.answer((call) => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: [aliasOf(call, BUS)] })] }));
  await run(uid);
  assert.ok(model.calls.length >= 1, 'fixture: the second run never reached the model');
  assert.deepEqual((await stored(uid, key))?.memoryBasis, first.memoryBasis, 'a later run rewrote an eligible basis');
});

/* ── the mode marker (R3-001) ───────────────────────────────────────── */

test('R3-001: an on_basis run and every suggestion it creates record mode on_basis (cited or not)', async () => {
  const { uid, evidence } = await fixture();
  model.answer((call) => ({ suggestions: [
    said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] }),
    said('question', 'Which evenings are free for study?', [evidence.id]),
  ] }));
  await run(uid);
  assert.equal((await latestRun(uid))?.mode, 'on_basis', show(await latestRun(uid)));
  const rows = await allStoredSuggestions(uid);
  assert.equal(rows.length, 2, show(rows));
  for (const row of rows) assert.equal(row.mode, 'on_basis', show(row));
});

test('R3-001: an on_nobasis run and every suggestion it creates record mode on_nobasis and carry no memoryBasis', async () => {
  const { uid, evidence } = await fixture();
  setMode('on_nobasis');
  model.answer(() => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: ['m1'] })] }));
  await run(uid);
  assert.equal((await latestRun(uid))?.mode, 'on_nobasis', show(await latestRun(uid)));
  const rows = await allStoredSuggestions(uid);
  assert.equal(rows.length, 1, show(rows));
  assert.equal(rows[0].mode, 'on_nobasis');
  assert.equal('memoryBasis' in rows[0], false);
});

/* ── memory that arrives as an observation (REV-004) ────────────────── */

test('REV-004: on_basis, a source:memory observation whose memory is not in the fenced active snapshot never reaches the model', async () => {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: SWIM, kind: 'goal' }, { content: SPANISH, kind: 'goal' }]);
  const swim = rows.find((row) => row.content === SWIM)!;
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  const copy = (await memoryObservations(uid)).find((row) => row.sourceRef === swim.id);
  assert.ok(copy, 'fixture: no observation copy of the goal');
  // The memory goes inactive; its observation copy stays behind.
  const { createStorageRuntimeMemoryStore } = await import('../../../lib/runtimeMemory/runtimeMemoryStore.ts');
  await createStorageRuntimeMemoryStore(undefined, currentStorage() as any).revoke(swim.id, NOW());
  const evidence = await statement(uid, 'I want to plan my study week');
  model.answer(() => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id])] }));
  await run(uid);
  assert.ok(model.calls.length >= 1, 'the model was never called');
  for (const call of model.calls) {
    assert.equal(observationIdsSent(call).includes(copy.id), false, 'an observation of an inactive memory reached the model');
    assert.equal(call.raw.includes(SWIM), false, 'the inactive memory\'s words reached the model');
  }
});

test('REV-004: a suggestion that cites a memory\'s observation (and no alias) is attributed to that memory', async () => {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: SWIM, kind: 'goal' }, { content: MORNING }]);
  const swim = rows.find((row) => row.content === SWIM)!;
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  const copy = (await memoryObservations(uid)).find((row) => row.sourceRef === swim.id)!;
  assert.ok(copy, 'fixture: no observation copy of the goal');
  model.answer(() => ({ suggestions: [said('action', 'Book a beginner swim lesson', [copy.id])] }));
  await run(uid);
  const row = await stored(uid, identityOf('action', 'Book a beginner swim lesson', [copy.id]));
  assert.ok(row, 'fixture: the suggestion was not stored');
  assert.deepEqual(row.memoryBasis?.memoryIds, [swim.id], show(row));
});

/* ── the union of at most 3 (R2-004) ────────────────────────────────── */

test('R2-004: a suggestion citing four memory observations is rejected, never partially attributed', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: SWIM, kind: 'goal' }, { content: SPANISH, kind: 'goal' }, { content: PIANO, kind: 'goal' }, { content: RUN, kind: 'goal' }]);
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  const copies = await memoryObservations(uid);
  assert.equal(copies.length, 4, 'fixture: four goal observations');
  const evidence = await statement(uid, 'I want to plan my study week');
  model.answer(() => ({ suggestions: [
    said('action', 'Make a weekly plan for all goals', copies.map((row) => row.id)),
    said('action', 'Book a beginner swim lesson', [copies[0]!.id]),
    said('action', 'Plan two study blocks', [evidence.id]),
  ] }));
  const answered = await run(uid);
  const rejected = identityOf('action', 'Make a weekly plan for all goals', copies.map((row) => row.id));
  assert.equal(await stored(uid, rejected), null, 'a suggestion shaped by four memories was stored');
  assert.equal(answered.some((item) => item.id === rejected), false, 'a suggestion shaped by four memories was answered');
  assert.ok(await stored(uid, identityOf('action', 'Plan two study blocks', [evidence.id])), 'fixture: the run stored nothing');
});

test('R2-004: three direct references plus a distinct memory observation are rejected; an overlapping union is kept', async () => {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: MORNING }, { content: MEETINGS }, { content: BUS }, { content: SWIM, kind: 'goal' }]);
  const id = (content: string) => rows.find((row) => row.content === content)!.id;
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  const copy = (await memoryObservations(uid)).find((row) => row.sourceRef === id(SWIM))!;
  assert.ok(copy, 'fixture: no observation copy of the goal');
  model.answer((call) => ({ suggestions: [
    said('action', 'Book a beginner swim lesson', [copy.id], { memoryRefs: [aliasOf(call, MORNING), aliasOf(call, MEETINGS), aliasOf(call, BUS)] }),
    said('action', 'Swim before work twice a week', [copy.id], { memoryRefs: [aliasOf(call, SWIM), aliasOf(call, MORNING)] }),
  ] }));
  await run(uid);
  const overlapping = await stored(uid, identityOf('action', 'Swim before work twice a week', [copy.id]));
  assert.ok(overlapping, 'a union of two memories was rejected');
  assert.deepEqual([...(overlapping.memoryBasis?.memoryIds ?? [])].sort(), [id(SWIM), id(MORNING)].sort(), show(overlapping));
  assert.equal(await stored(uid, identityOf('action', 'Book a beginner swim lesson', [copy.id])), null, 'a union of four memories was stored');
});

test('R1 aliases: the alias map is per run and in memory only: no alias or record id is stored on the suggestion or the run', async () => {
  const { uid, evidence, id } = await fixture();
  model.answer((call) => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] })] }));
  await run(uid);
  aliasFor(model.calls[0]!, MORNING);
  const row = await stored(uid, identityOf('action', 'Plan two study blocks', [evidence.id]));
  assert.deepEqual(row?.memoryBasis?.memoryIds, [id(MORNING)], show(row));
  assert.equal(JSON.stringify(row).includes('memoryRefs'), false, 'the model\'s memoryRefs were stored');
  assert.equal(/"m\d{1,2}"/.test(JSON.stringify(row)), false, 'an alias was stored on the suggestion');
  assert.equal(/"m\d{1,2}"/.test(JSON.stringify(await latestRun(uid))), false, 'an alias was stored on the run');
});
