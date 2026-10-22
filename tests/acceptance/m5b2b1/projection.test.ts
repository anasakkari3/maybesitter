/**
 * M5b-2b-1 Gate B, R2 Server: projection (the inbox DTO and its live
 * `memoryBasis` subset, one mapper on all four suggestion routes, the
 * snapshot failing closed by row, the `basisMode` envelope omitted in off,
 * schedules from the filtered list).
 * PLAN-M5b-2b-1 R2 + REV-001, R3-004, R7-001, R7-004, R13-001, R14-002. See
 * support.ts for the harness and the gate rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCanonicalObservations } from '../../../lib/intelligence/canonicalObservations.ts';
import {
  NOW, addFloating, addRows, aliasOf, answer, assertUnavailable, begin, currentStorage, decide, end, epochOf, generate,
  identityOf, ids, inbox, memoryObservations, memoryUnreadable, model, said, scheduleIds, seedSuggestion,
  setFence, setMode, show, statement, stored, withStorage, writeRun, call,
} from './support.ts';

test.afterEach(() => end());

const MORNING = 'I work best in the morning';
const BUS = 'I take the bus to work';
const SWIM = 'Learn to swim this summer';

function visitRun(suggestionIds: string[], mode?: string) {
  return {
    digest: 'seeded', contentDigest: 'seeded', claimId: 'seeded-claim', status: 'complete',
    generatedAt: NOW(), reservedUntil: NOW(), suggestionIds, visitDay: NOW().slice(0, 10), visitRuns: 1,
    ...(mode ? { mode } : {}),
  };
}

/** No stored marker on a suggestion DTO: neither the internal basis object nor a per-suggestion mode. */
function assertNoStoredMarker(dto: any, where: string): void {
  assert.equal('mode' in dto, false, `${where}: a per-suggestion mode leaked: ${show(dto)}`);
  if ('memoryBasis' in dto) {
    assert.ok(Array.isArray(dto.memoryBasis), `${where}: the stored memoryBasis object leaked: ${show(dto.memoryBasis)}`);
    for (const entry of dto.memoryBasis) assert.deepEqual(Object.keys(entry), ['memoryId'], `${where}: ${show(entry)}`);
  }
}

/* ── the inbox DTO (R2) ─────────────────────────────────────────────── */

test('R2: on_basis, a pending suggestion in the inbox carries memoryBasis [{ memoryId }] for its active basis, and nothing of the stored marker', async () => {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: MORNING }, { content: BUS }]);
  const a = rows.find((row) => row.content === MORNING);
  const b = rows.find((row) => row.content === BUS);
  const evidence = await statement(uid, 'I want to plan my study week');
  const cited = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id, b!.id], epoch: await epochOf(uid) });
  const plain = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis' });
  const body = await inbox(uid);
  const dto = body.suggestions.find((row: any) => row.id === cited.id);
  assert.ok(dto, 'the cited suggestion is missing from the inbox');
  assert.deepEqual(dto.memoryBasis, [{ memoryId: a!.id }, { memoryId: b!.id }]);
  assertNoStoredMarker(dto, 'inbox');
  const uncited = body.suggestions.find((row: any) => row.id === plain.id);
  assert.ok(uncited, 'the citationless on_basis suggestion is missing');
  assert.equal('memoryBasis' in uncited, false);
  assertNoStoredMarker(uncited, 'inbox');
  assert.equal(JSON.stringify(body).includes(MORNING), false, 'memory content reached the inbox');
});

test('R2: the inbox omits memoryBasis while the fence is not active (a purge running), never leaking the stored marker', async () => {
  const uid = await begin();
  const [a] = await addRows(uid, [{ content: MORNING }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  const cited = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id], epoch: await epochOf(uid) });
  await setFence(uid, { state: 'purging', epoch: (await epochOf(uid)) + 1 });
  const body = await inbox(uid);
  for (const row of body.suggestions) {
    if (row.id === cited.id) assert.equal('memoryBasis' in row, false, `memoryBasis shown under a running purge: ${show(row)}`);
    assertNoStoredMarker(row, 'inbox under a purge');
  }
});

/* ── one mapper, four routes (REV-001) ──────────────────────────────── */

test('REV-001: generate answers a cited pending suggestion through the mapper: memoryBasis [{ memoryId }], no stored marker', async () => {
  const uid = await begin();
  const [a] = await addRows(uid, [{ content: MORNING }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  model.answer((call) => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] })] }));
  const body = await generate(uid);
  const dto = body.suggestions.find((row: any) => row.id === identityOf('action', 'Plan two study blocks', [evidence.id]));
  assert.ok(dto, `generate answered nothing: ${show(body)}`);
  assert.deepEqual(dto.memoryBasis, [{ memoryId: a!.id }]);
  assertNoStoredMarker(dto, 'generate');
});

for (const decision of ['accept', 'dismiss'] as const) {
  test(`REV-001: the decision route (${decision}) answers through the mapper: the decided suggestion carries no memoryBasis and no stored marker`, async () => {
    const uid = await begin();
    const [a] = await addRows(uid, [{ content: MORNING }]);
    const evidence = await statement(uid, 'I want to plan my study week');
    const cited = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id], epoch: await epochOf(uid) });
    const result = await decide(uid, cited.id, decision);
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.suggestion.status, decision === 'accept' ? 'accepted' : 'dismissed');
    assert.equal('memoryBasis' in result.body.suggestion, false, `a decided suggestion carries memoryBasis: ${show(result.body.suggestion)}`);
    assertNoStoredMarker(result.body.suggestion, decision);
  });
}

test('REV-001: the answer route answers through the mapper: the answered question carries no memoryBasis and no stored marker', async () => {
  const uid = await begin();
  const [a] = await addRows(uid, [{ content: MORNING }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  const question = await seedSuggestion(uid, 'question', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id], epoch: await epochOf(uid) });
  const result = await answer(uid, question.id);
  assert.equal(result.status, 200, show(result.body));
  assert.equal('memoryBasis' in result.body.suggestion, false, `an answered question carries memoryBasis: ${show(result.body.suggestion)}`);
  assertNoStoredMarker(result.body.suggestion, 'answer');
});

test('REV-001: suggestionToDto(stored, projection?) drops the stored marker and adds nothing without a projection', async () => {
  // The plan names the mapper but not its module: the engine, or a module of its own.
  let mapper: unknown;
  for (const path of ['lib/intelligence/proposalEngine.ts', 'lib/intelligence/suggestionDto.ts']) {
    try { mapper = (await import(new URL(`../../../${path}`, import.meta.url).href) as Record<string, unknown>).suggestionToDto; } catch { /* not built */ }
    if (typeof mapper === 'function') break;
  }
  assert.equal(typeof mapper, 'function', 'suggestionToDto is not exported (lib/intelligence/proposalEngine.ts or lib/intelligence/suggestionDto.ts)');
  const storedRow = {
    id: 'a'.repeat(64), kind: 'action', title: 'Plan two study blocks', reason: 'Because of what you told me before',
    observationIds: ['b'.repeat(64)], confidence: 0.8, durationMinutes: 30, status: 'pending', position: 0,
    decidedAt: null, linkedEntityId: null, generatedAt: NOW(), mode: 'on_basis', memoryBasis: { memoryIds: ['mem_x'], epoch: 3 },
  };
  const dto = (mapper as (stored: unknown) => any)(storedRow);
  assert.equal('memoryBasis' in dto, false, show(dto));
  assert.equal('mode' in dto, false, show(dto));
  const { mode: _mode, memoryBasis: _basis, ...rest } = storedRow;
  assert.deepEqual(dto, rest);
});

/* ── the snapshot fails closed by row (R7-001, R3-004) ──────────────── */

async function snapshotFixture() {
  const uid = await begin();
  const a = (await addRows(uid, [{ content: MORNING }, { content: SWIM, kind: 'goal' }])).find((row) => row.content === MORNING);
  await addFloating(uid, 'Call the bank');
  await syncCanonicalObservations(uid, NOW(), currentStorage() as any);
  const copies = (await memoryObservations(uid)).map((row) => row.id);
  assert.ok(copies.length >= 1, 'fixture: no memory observation');
  const evidence = await statement(uid, 'I want to plan my study week');
  const epoch = await epochOf(uid);
  const cited = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id], epoch }, { title: 'Cited action for the snapshot test' });
  const plain = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis' }, { title: 'Plain action for the snapshot test' });
  return { uid, copies, evidence, cited, plain };
}

test('R7-001: the inbox with an unreadable snapshot answers 200 without memory observations, basis-bearing suggestions or their schedule rows, and keeps the rest', async () => {
  const { uid, copies, evidence, cited, plain } = await snapshotFixture();
  const result = await withStorage(memoryUnreadable(currentStorage()), () => call(uid, 'intelligence', 'GET'));
  assert.equal(result.status, 200, show(result.body));
  const observationIds = ids(result.body.observations);
  for (const copy of copies) assert.equal(observationIds.includes(copy), false, 'a memory observation was shown without a snapshot');
  assert.ok(observationIds.includes(evidence.id), 'an unrelated observation was hidden');
  assert.equal(ids(result.body.suggestions).includes(cited.id), false, 'a basis-bearing suggestion was shown without a snapshot');
  assert.equal(scheduleIds(result.body).includes(cited.id), false, 'an orphan schedule row names the hidden suggestion');
  assert.ok(ids(result.body.suggestions).includes(plain.id), 'an unrelated suggestion was hidden');
});

test('R7-001: generate with an unreadable snapshot answers 200 without the basis-bearing suggestion or its schedule row', async () => {
  const { uid, cited, plain } = await snapshotFixture();
  await writeRun(uid, visitRun([cited.id, plain.id], 'on_basis'));
  const result = await withStorage(memoryUnreadable(currentStorage()), () =>
    call(uid, 'intelligence/generate', 'POST', { body: { trigger: 'visit' } }));
  assert.equal(result.status, 200, show(result.body));
  assert.equal(ids(result.body.suggestions).includes(cited.id), false, 'generate answered a basis-bearing suggestion without a snapshot');
  assert.equal(scheduleIds(result.body).includes(cited.id), false);
  assert.ok(ids(result.body.suggestions).includes(plain.id), 'an unrelated suggestion was hidden');
});

test('R7-001: actions on a basis-bearing suggestion with an unreadable snapshot are refused (404 suggestion_unavailable)', async () => {
  const { uid, cited } = await snapshotFixture();
  const accepted = await withStorage(memoryUnreadable(currentStorage()), () => decide(uid, cited.id, 'accept'));
  assertUnavailable(accepted, 'accept without a snapshot');
  assert.equal((await stored(uid, cited.id))?.status, 'pending');
});

/* ── schedules from the filtered list (R7-004) ──────────────────────── */

test('R7-004: the inbox schedule is built from the final filtered list: no row names a hidden suggestion', async () => {
  const uid = await begin();
  const evidence = await statement(uid, 'I want to plan my study week');
  const hidden = await seedSuggestion(uid, 'action', [evidence.id], {}, { title: 'Legacy action hidden in on_basis' });
  const shown = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis' }, { title: 'On basis action shown' });
  const body = await inbox(uid);
  assert.equal(scheduleIds(body).includes(hidden.id), false, 'the schedule names a suggestion hidden from the list');
  for (const id of scheduleIds(body)) assert.ok(ids(body.suggestions).includes(id), `schedule row ${id} names no listed suggestion`);
  assert.ok(scheduleIds(body).includes(shown.id), 'fixture: the shown action has no schedule row');
});

test('R7-004: the generate schedule is built from the final filtered list: no row names a hidden suggestion', async () => {
  const uid = await begin();
  const evidence = await statement(uid, 'I want to plan my study week');
  const hidden = await seedSuggestion(uid, 'action', [evidence.id], {}, { title: 'Legacy action hidden in on_basis' });
  const shown = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis' }, { title: 'On basis action shown' });
  await writeRun(uid, visitRun([hidden.id, shown.id], 'on_basis'));
  const body = await generate(uid, true);
  assert.equal(scheduleIds(body).includes(hidden.id), false, 'the generate schedule names a hidden suggestion');
  for (const id of scheduleIds(body)) assert.ok(ids(body.suggestions).includes(id), `schedule row ${id} names no listed suggestion`);
});

/* ── the basisMode envelope (R13-001, R14-002) ──────────────────────── */

for (const mode of ['on_basis', 'on_nobasis'] as const) {
  test(`R13-001: ${mode}, the inbox and generate envelopes carry basisMode '${mode}' and no suggestion carries a mode`, async () => {
    const uid = await begin();
    const evidence = await statement(uid, 'I want to plan my study week');
    await seedSuggestion(uid, 'action', [evidence.id], { mode });
    setMode(mode);
    model.answer(() => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id])] }));
    const read = await inbox(uid);
    assert.equal(read.basisMode, mode, `inbox basisMode: ${show(read.basisMode)}`);
    const made = await generate(uid);
    assert.equal(made.basisMode, mode, `generate basisMode: ${show(made.basisMode)}`);
    for (const row of [...read.suggestions, ...made.suggestions]) assertNoStoredMarker(row, mode);
  });
}

test('R14-002 parity: off, the inbox and generate envelopes carry no basisMode, keep today\'s keys, and a suggestion DTO is the stored row unchanged', async () => {
  const uid = await begin();
  const evidence = await statement(uid, 'I want to plan my study week');
  const legacy = await seedSuggestion(uid, 'action', [evidence.id], {}, { title: 'Legacy unmarked action' });
  setMode('off');
  const read = await inbox(uid);
  assert.deepEqual(Object.keys(read), ['success', 'observations', 'suggestions', 'schedule']);
  assert.deepEqual(read.suggestions.find((row: any) => row.id === legacy.id), legacy);
  model.answer(() => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id])] }));
  const made = await generate(uid);
  assert.deepEqual(Object.keys(made), ['success', 'suggestions', 'schedule']);
  const visit = await generate(uid, true);
  assert.deepEqual(Object.keys(visit), ['success', 'suggestions', 'schedule', 'nextVisitAt']);
  const fresh = made.suggestions.find((row: any) => row.id === identityOf('action', 'Plan two study blocks', [evidence.id]));
  assert.deepEqual(fresh, await stored(uid, fresh.id));
});
