/**
 * M5b-2b-1 Gate B, R1 Server: across modes (exact provenance on pending
 * suggestions, reuse, identity collisions and their replacement, prior
 * decisions, a mode switch after a run).
 * PLAN-M5b-2b-1 R1: R3-001, R4-002, R10-001, R11-002, R11-003, R12-002,
 * R18-001, R5-003. See support.ts for the harness and the gate rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeFromObservations, reuseRunForVisit } from '../../../lib/intelligence/proposalEngine.ts';
import { deleteMemory } from '../../../lib/services/mobile/memoryService.ts';
import { readParticipantState } from '../../../lib/services/mobile/participantState.ts';
import {
  NOW, addRows, aliasOf, answer, assertUnavailable, begin, citationPath, citationPaths, currentStorage, decide, end,
  epochOf, generate, identityOf, ids, inbox, latestRun, model, revokeMemory, said, scheduleIds, seedSuggestion, setMode,
  show, statement, stored, writeRun, type Mode,
} from './support.ts';

test.afterEach(() => end());

const MORNING = 'I work best in the morning';
const BUS = 'I take the bus to work';

async function fixture() {
  const uid = await begin();
  const rows = await addRows(uid, [{ content: MORNING }, { content: BUS }]);
  const evidence = await statement(uid, 'I want to plan my study week');
  const id = (content: string) => rows.find((row) => row.content === content)!.id;
  return { uid, rows, evidence, id };
}

/** One pending action of every provenance. */
async function everyProvenance(uid: string, evidenceId: string, activeId: string, goneId: string) {
  const epoch = await epochOf(uid);
  return {
    legacy: await seedSuggestion(uid, 'action', [evidenceId], {}, { title: 'Legacy unmarked action' }),
    nobasis: await seedSuggestion(uid, 'action', [evidenceId], { mode: 'on_nobasis' }, { title: 'On nobasis action' }),
    citationless: await seedSuggestion(uid, 'action', [evidenceId], { mode: 'on_basis' }, { title: 'On basis citationless action' }),
    eligible: await seedSuggestion(uid, 'action', [evidenceId], { mode: 'on_basis', memoryIds: [activeId], epoch }, { title: 'On basis eligible action' }),
    ineligible: await seedSuggestion(uid, 'action', [evidenceId], { mode: 'on_basis', memoryIds: [goneId], epoch }, { title: 'On basis ineligible action' }),
  };
}

function recentRun(suggestionIds: string[], mode?: Mode) {
  return {
    digest: 'seeded', contentDigest: 'seeded', claimId: 'seeded-claim', status: 'complete',
    generatedAt: NOW(), reservedUntil: NOW(), suggestionIds, visitDay: NOW().slice(0, 10), visitRuns: 1,
    ...(mode ? { mode } : {}),
  };
}

/* ── exact provenance on pending suggestions (R12-002) ──────────────── */

for (const [mode, expected] of [
  ['on_basis', ['citationless', 'eligible']],
  ['on_nobasis', ['nobasis']],
  ['off', ['legacy']],
] as const) {
  test(`R12-002: ${mode}, the inbox shows exactly the ${expected.join(' and ')} suggestion(s), and schedules only those`, async () => {
    const { uid, evidence, id } = await fixture();
    await revokeMemory(id(BUS));
    const seeded = await everyProvenance(uid, evidence.id, id(MORNING), id(BUS));
    setMode(mode);
    const body = await inbox(uid);
    const want = expected.map((name) => (seeded as any)[name].id).sort();
    assert.deepEqual(ids(body.suggestions).sort(), want, `${mode} showed ${show(body.suggestions.map((row: any) => row.title))}`);
    for (const scheduled of scheduleIds(body)) assert.ok(want.includes(scheduled), `a schedule row names a hidden suggestion: ${scheduled}`);
  });
}

for (const target of ['on_nobasis', 'off'] as const) {
  test(`R12-002: on_basis→${target}, a citationless, memory-fed suggestion is hidden from the inbox, generate and schedules, and refused by every action`, async () => {
    const { uid, evidence } = await fixture();
    model.answer(() => ({ suggestions: [
      said('action', 'Plan two study blocks', [evidence.id]),
      said('question', 'Which evenings are free for study?', [evidence.id]),
    ] }));
    const made = await generate(uid);
    const action = identityOf('action', 'Plan two study blocks', [evidence.id]);
    const question = identityOf('question', 'Which evenings are free for study?', [evidence.id]);
    assert.ok(ids(made.suggestions).includes(action), `fixture: the on_basis run made nothing: ${show(made)}`);
    setMode(target);
    const body = await inbox(uid);
    assert.equal(ids(body.suggestions).includes(action), false, 'the inbox shows a memory-fed on_basis suggestion after the switch');
    assert.equal(ids(body.suggestions).includes(question), false);
    assert.equal(scheduleIds(body).includes(action), false, 'a schedule row names the hidden suggestion');
    const visit = await generate(uid, true);
    assert.equal(ids(visit.suggestions).includes(action), false, 'generate answers a memory-fed on_basis suggestion after the switch');
    assert.equal(scheduleIds(visit).includes(action), false);
    assertUnavailable(await decide(uid, action, 'accept'), 'accept');
    assertUnavailable(await decide(uid, action, 'dismiss'), 'dismiss');
    assertUnavailable(await answer(uid, question), 'answer');
    assert.equal((await readParticipantState(uid)).commitments[`int_${action}`], undefined);
    assert.equal((await stored(uid, action))?.status, 'pending');
  });
}

test('R4-002: memory killed after an on_basis run: no basis suggestion in the inbox, the generate reuse or the claim', async () => {
  const { uid, evidence, id } = await fixture();
  model.answer((call) => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] })] }));
  await generate(uid);
  const key = identityOf('action', 'Plan two study blocks', [evidence.id]);
  setMode('on_nobasis');
  assert.equal(ids((await inbox(uid)).suggestions).includes(key), false, 'the inbox shows a basis suggestion with memory killed');
  assert.equal(ids((await generate(uid, true)).suggestions).includes(key), false, 'the generate reuse answers a basis suggestion with memory killed');
  assertUnavailable(await decide(uid, key, 'accept'), 'accept with memory killed');
  assert.deepEqual((await stored(uid, key))?.memoryBasis?.memoryIds, [id(MORNING)], 'fixture: the run stored no basis');
});

test('R10-001: off→on_basis and off→on_nobasis, legacy unmarked suggestions leave the inbox and every action refuses them', async () => {
  for (const target of ['on_basis', 'on_nobasis'] as const) {
    const { uid, evidence } = await fixture();
    setMode('off');
    model.answer(() => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id])] }));
    const made = await generate(uid);
    const key = identityOf('action', 'Plan two study blocks', [evidence.id]);
    assert.ok(ids(made.suggestions).includes(key), 'fixture: the off run made nothing');
    setMode(target);
    assert.equal(ids((await inbox(uid)).suggestions).includes(key), false, `${target} shows a legacy unmarked suggestion`);
    assert.equal(ids((await generate(uid, true)).suggestions).includes(key), false, `${target} reuses a legacy unmarked suggestion`);
    assertUnavailable(await decide(uid, key, 'accept'), `${target} accept of a legacy suggestion`);
    end();
  }
});

/* ── reuse (R3-001) ─────────────────────────────────────────────────── */

test('R3-001: an on_basis request never reuses an unmarked run, nor an on_nobasis one; an on_nobasis request never reuses an unmarked or on_basis run', async () => {
  const { uid, evidence } = await fixture();
  const legacy = await seedSuggestion(uid, 'action', [evidence.id], {}, { title: 'Legacy unmarked action' });
  for (const [requestMode, runMode] of [['on_basis', undefined], ['on_basis', 'on_nobasis'], ['on_nobasis', undefined], ['on_nobasis', 'on_basis']] as const) {
    await writeRun(uid, recentRun([legacy.id], runMode));
    setMode(requestMode);
    const reused = await reuseRunForVisit(uid, NOW(), currentStorage() as any);
    assert.equal(ids(reused ?? []).includes(legacy.id), false, `${requestMode} reused a run marked ${runMode ?? '(unmarked)'}`);
    const visit = await generate(uid, true);
    assert.equal(ids(visit.suggestions).includes(legacy.id), false, `${requestMode} generate answered from a run marked ${runMode ?? '(unmarked)'}`);
  }
});

test('R3-001 parity: off, a visit still reuses the latest unmarked run exactly as today', async () => {
  const { uid, evidence } = await fixture();
  const legacy = await seedSuggestion(uid, 'action', [evidence.id], {}, { title: 'Legacy unmarked action' });
  await writeRun(uid, recentRun([legacy.id]));
  setMode('off');
  const reused = await reuseRunForVisit(uid, NOW(), currentStorage() as any);
  assert.deepEqual(ids(reused ?? []), [legacy.id]);
  const visit = await generate(uid, true);
  assert.deepEqual(ids(visit.suggestions), [legacy.id]);
});

/* ── identity collisions (R11-003, R18-001) ─────────────────────────── */

test('R11-003: an on_basis run whose suggestion collides with a pending unmarked row replaces it in one transaction: new basis, new mode, new citation rows', async () => {
  const { uid, evidence, id } = await fixture();
  const legacy = await seedSuggestion(uid, 'action', [evidence.id], {}, { title: 'Plan two study blocks' });
  model.answer((call) => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] })] }));
  const made = await generate(uid);
  const row = await stored(uid, legacy.id);
  assert.equal(row?.mode, 'on_basis', `the unmarked row was not replaced: ${show(row)}`);
  assert.deepEqual(row.memoryBasis?.memoryIds, [id(MORNING)]);
  assert.deepEqual(citationPaths(uid), [citationPath(uid, id(MORNING), legacy.id)]);
  assert.deepEqual(ids(made.suggestions), [legacy.id]);
});

test('R11-003: inactive basis A → basis B: the replacement stands when A is deleted, and goes when B is deleted', async () => {
  const { uid, evidence, id } = await fixture();
  const epoch = await epochOf(uid);
  const a = (await addRows(uid, [{ content: 'I used to cycle to work' }])).find((row) => row.content === 'I used to cycle to work');
  const old = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [a!.id], epoch }, { title: 'Plan two study blocks' });
  await revokeMemory(a!.id);
  model.answer((call) => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] })] }));
  await generate(uid);
  const replaced = await stored(uid, old.id);
  assert.deepEqual(replaced?.memoryBasis?.memoryIds, [id(MORNING)], `the ineligible row was not replaced: ${show(replaced)}`);
  assert.equal(await currentStorage().get(citationPath(uid, a!.id, old.id)), null, 'the old basis\'s citation row survived the replacement');
  assert.ok(await currentStorage().get(citationPath(uid, id(MORNING), old.id)), 'no citation row for the new basis');
  await deleteMemory(uid, a!.id, NOW());
  assert.ok(await stored(uid, old.id), 'deleting the old basis A removed the replacement');
  await deleteMemory(uid, id(MORNING), NOW());
  assert.equal(await stored(uid, old.id), null, 'deleting the new basis B left the replacement');
  assert.deepEqual(citationPaths(uid), []);
});

test('R11-003: an eligible on_basis row is never replaced (create-if-absent holds)', async () => {
  const { uid, evidence, id } = await fixture();
  const epoch = await epochOf(uid);
  const kept = await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [id(BUS)], epoch }, { title: 'Plan two study blocks' });
  model.answer((call) => ({ suggestions: [
    said('action', 'Plan two study blocks', [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] }),
    said('action', 'Book a quiet study room', [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] }),
  ] }));
  await generate(uid);
  assert.ok(await stored(uid, identityOf('action', 'Book a quiet study room', [evidence.id])).then((row: any) => row?.memoryBasis), 'fixture: the run stored no basis');
  assert.deepEqual(await stored(uid, kept.id), kept, 'an eligible on_basis row was rewritten');
});

test('R18-001: collisions with accepted or dismissed rows (unmarked, or with an inactive basis) leave them untouched and out of the new pending response', async () => {
  const { uid, evidence, id } = await fixture();
  const epoch = await epochOf(uid);
  const gone = (await addRows(uid, [{ content: 'I used to cycle to work' }])).find((row) => row.content === 'I used to cycle to work');
  const decided = {
    acceptedLegacy: await seedSuggestion(uid, 'action', [evidence.id], {}, { title: 'Accepted legacy action', status: 'accepted', decidedAt: NOW(), linkedEntityId: 'int_accepted_legacy' }),
    dismissedLegacy: await seedSuggestion(uid, 'action', [evidence.id], {}, { title: 'Dismissed legacy action', status: 'dismissed', decidedAt: NOW() }),
    acceptedInactive: await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [gone!.id], epoch }, { title: 'Accepted inactive action', status: 'accepted', decidedAt: NOW(), linkedEntityId: 'int_accepted_inactive' }),
    dismissedInactive: await seedSuggestion(uid, 'action', [evidence.id], { mode: 'on_basis', memoryIds: [gone!.id], epoch }, { title: 'Dismissed inactive action', status: 'dismissed', decidedAt: NOW() }),
  };
  await revokeMemory(gone!.id);
  const citationsBefore = citationPaths(uid);
  model.answer((call) => ({ suggestions: [
    ...Object.values(decided).map((row: any) => said('action', row.title, [evidence.id], { memoryRefs: [aliasOf(call, MORNING)] })),
    said('action', 'Book a quiet study room', [evidence.id]),
  ] }));
  const made = await generate(uid);
  const fresh = identityOf('action', 'Book a quiet study room', [evidence.id]);
  for (const [name, row] of Object.entries(decided)) {
    assert.equal(ids(made.suggestions).includes(row.id), false, `${name} appears in the new pending response`);
    assert.deepEqual(await stored(uid, row.id), row, `${name} was rewritten`);
  }
  assert.deepEqual((await latestRun(uid))?.suggestionIds, [fresh], 'the committed run lists a decided row');
  assert.deepEqual(citationPaths(uid).sort(), citationsBefore.sort(), 'citation rows were written for a decided row');
  assert.ok(ids(made.suggestions).includes(fresh), 'fixture: the run committed nothing new');
  assert.ok(id(MORNING));
});

/* ── prior decisions (R5-003, R11-002) ──────────────────────────────── */

async function decidedOfEveryProvenance(uid: string, evidenceId: string, activeId: string, goneId: string) {
  const epoch = await epochOf(uid);
  const decided = (title: string, status: 'accepted' | 'dismissed') => ({ title, status, decidedAt: NOW() });
  return {
    acceptedLegacy: await seedSuggestion(uid, 'action', [evidenceId], {}, decided('Accepted legacy action', 'accepted')),
    dismissedLegacy: await seedSuggestion(uid, 'action', [evidenceId], {}, decided('Dismissed legacy action', 'dismissed')),
    acceptedNobasis: await seedSuggestion(uid, 'action', [evidenceId], { mode: 'on_nobasis' }, decided('Accepted nobasis action', 'accepted')),
    dismissedNobasis: await seedSuggestion(uid, 'action', [evidenceId], { mode: 'on_nobasis' }, decided('Dismissed nobasis action', 'dismissed')),
    acceptedEligible: await seedSuggestion(uid, 'action', [evidenceId], { mode: 'on_basis', memoryIds: [activeId], epoch }, decided('Accepted eligible basis action', 'accepted')),
    dismissedEligible: await seedSuggestion(uid, 'action', [evidenceId], { mode: 'on_basis', memoryIds: [activeId], epoch }, decided('Dismissed eligible basis action', 'dismissed')),
    acceptedCitationless: await seedSuggestion(uid, 'action', [evidenceId], { mode: 'on_basis' }, decided('Accepted citationless basis action', 'accepted')),
    acceptedIneligible: await seedSuggestion(uid, 'action', [evidenceId], { mode: 'on_basis', memoryIds: [goneId], epoch }, decided('Accepted ineligible basis action', 'accepted')),
    dismissedIneligible: await seedSuggestion(uid, 'action', [evidenceId], { mode: 'on_basis', memoryIds: [goneId], epoch }, decided('Dismissed ineligible basis action', 'dismissed')),
  };
}

for (const [mode, expected] of [
  ['on_basis', ['acceptedEligible', 'dismissedEligible', 'acceptedCitationless']],
  ['on_nobasis', ['acceptedNobasis', 'dismissedNobasis']],
] as const) {
  test(`R5-003/R11-002: ${mode}, the complete model request carries only the mode-matched prior decisions${mode === 'on_basis' ? ' whose basis is still eligible' : ''}`, async () => {
    const { uid, evidence, id } = await fixture();
    await revokeMemory(id(BUS));
    const decided = await decidedOfEveryProvenance(uid, evidence.id, id(MORNING), id(BUS));
    setMode(mode);
    model.answer(() => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id])] }));
    await proposeFromObservations(uid, NOW(), { storage: currentStorage() as any });
    assert.ok(model.calls.length >= 1, 'the model was never called');
    for (const call of model.calls) {
      const titles = (call.context?.priorDecisions ?? []).map((row: any) => row.title).sort();
      assert.deepEqual(titles, expected.map((name) => (decided as any)[name].title).sort(), `${mode} sent prior decisions ${show(titles)}`);
      for (const [name, row] of Object.entries(decided)) {
        if (!(expected as readonly string[]).includes(name)) assert.equal(call.raw.includes((row as any).title), false, `${name} reached the model in ${mode}`);
      }
    }
  });
}

test('R5-003 parity: off, prior decisions are sent exactly as today (every accepted or dismissed legacy row)', async () => {
  const { uid, evidence } = await fixture();
  await seedSuggestion(uid, 'action', [evidence.id], {}, { title: 'Accepted legacy action', status: 'accepted', decidedAt: NOW() });
  await seedSuggestion(uid, 'action', [evidence.id], {}, { title: 'Dismissed legacy action', status: 'dismissed', decidedAt: NOW() });
  await seedSuggestion(uid, 'action', [evidence.id], {}, { title: 'Pending legacy action' });
  setMode('off');
  model.answer(() => ({ suggestions: [said('action', 'Plan two study blocks', [evidence.id])] }));
  await proposeFromObservations(uid, NOW(), { storage: currentStorage() as any });
  const prior = model.calls[0]!.context.priorDecisions;
  assert.deepEqual(prior.map((row: any) => [row.title, row.decision]).sort(), [['Accepted legacy action', 'accepted'], ['Dismissed legacy action', 'dismissed']]);
  for (const row of prior) assert.deepEqual(Object.keys(row), ['kind', 'title', 'decision', 'decidedAt']);
});
