/**
 * M5b-2b-2 Gate B, R2 Server: one live projection (the inbox `readd` field,
 * current titles and renames, a commitment gone, the bound outcome
 * dismissed with no fallback, deterministic binding, the model context with
 * the stored review at 0.6 and the prompt line, unmatched markers left out).
 * PLAN-M5b-2b-2 R2 "One projection", "Inbox DTO", "Model context", R2-003,
 * R3-002, REV-004, owner decision 4. On, with the client header. See
 * support.ts for the harness and the gate rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { intelligenceRunPath } from '../../../lib/intelligence/proposalEngine.ts';
import {
  NOW, READD_MODULE, assertNoReaddedSignal, begin, completeAt, confirmAt, currentStorage, currentTitle, daysAgo, dropAt,
  droppedThenReadded, end, generateH, inboxH, inboxRow, learn, loadModule, markerFor, model, outcomeFor, plusMinutes,
  renameCommitment, reviewH, scan, show, userDoc,
} from './support.ts';
import { listObservations } from '../../../lib/intelligence/observationStore.ts';
import { readParticipantState } from '../../../lib/services/mobile/participantState.ts';

test.afterEach(() => end());

const PROMPT_LINE = 'Re-added means the person added again something they dropped or finished; a hint it still matters, never proof.';

/* ── the inbox field ────────────────────────────────────────────────── */

test('R2 projection: the inbox gives each marker readd { after, title } with C\'s current title, no outcome field, and never a \'readded\' signal', async () => {
  const uid = await begin();
  const dropped = await droppedThenReadded(uid, 'Call the dentist');
  const completed = await droppedThenReadded(uid, 'Water the plants', { verb: 'completed' });
  await scan(uid);
  const body = await inboxH(uid);
  const a = inboxRow(body, (await markerFor(uid, dropped.c)).id);
  const b = inboxRow(body, (await markerFor(uid, completed.c)).id);
  assert.ok(a && b, `the inbox left a marker out: ${show(body.observations)}`);
  assert.deepEqual(a.readd, { after: 'dropped', title: 'Call the dentist' });
  assert.deepEqual(b.readd, { after: 'completed', title: 'Water the plants' });
  for (const row of [a, b]) {
    assert.equal('outcome' in row, false, `a marker carries an outcome field: ${show(row)}`);
    assert.equal(row.review, 'pending');
    assert.equal(row.confidence, 0.6);
  }
  assertNoReaddedSignal(body, 'inbox');
});

test('R2 projection: after a rename the field follows C\'s current title while it still matches, and the marker is left out once it no longer does', async () => {
  const uid = await begin();
  const { c } = await droppedThenReadded(uid, 'Call the dentist');
  await scan(uid);
  const id = (await markerFor(uid, c)).id;
  await renameCommitment(uid, c, 'CALL the  Dentist');
  const renamed = await currentTitle(uid, c);
  assert.deepEqual(inboxRow(await inboxH(uid), id)?.readd, { after: 'dropped', title: renamed }, 'the field did not follow the current title');
  await renameCommitment(uid, c, 'Call the plumber');
  assert.equal(inboxRow(await inboxH(uid), id), undefined, 'a marker whose commitment no longer matches is still in the inbox');
});

test('R2 projection: a marker whose commitment is gone is left out of the inbox', async () => {
  const uid = await begin();
  const kept = await droppedThenReadded(uid, 'Buy a birthday present');
  const gone = await droppedThenReadded(uid, 'Fix the shelf');
  await scan(uid);
  const keptId = (await markerFor(uid, kept.c)).id;
  const goneId = (await markerFor(uid, gone.c)).id;
  await currentStorage().delete(`${userDoc(uid)}/commitments/${gone.c}`);
  assert.equal((await readParticipantState(uid)).commitments[gone.c], undefined, 'fixture: the commitment is still in domain state');
  const body = await inboxH(uid);
  assert.ok(inboxRow(body, keptId)?.readd, 'control: the other marker lost its field');
  assert.equal(inboxRow(body, goneId), undefined, 'a marker whose commitment is gone is still in the inbox');
});

/* ── binding (REV-004, R2-003, owner decision 4) ────────────────────── */

test('REV-004/owner decision 4: dismissing the bound outcome hides the marker at once, with no fallback to an older match; dismissing an unbound match changes nothing', async () => {
  const uid = await begin();
  // X: completed three days ago, dropped yesterday; the marker binds yesterday's drop.
  const x1 = await completeAt(uid, 'Clean the windows', daysAgo(3));
  const x2 = await dropAt(uid, 'Clean the windows', daysAgo(1));
  const y1 = await completeAt(uid, 'Walk the dog', daysAgo(3));
  const y2 = await dropAt(uid, 'Walk the dog', daysAgo(1));
  await learn(uid);
  const ox1 = await outcomeFor(uid, x1, 'commitment_completed');
  const ox2 = await outcomeFor(uid, x2, 'commitment_dropped');
  const oy1 = await outcomeFor(uid, y1, 'commitment_completed');
  const oy2 = await outcomeFor(uid, y2, 'commitment_dropped');
  const cx = await confirmAt(uid, 'Clean the windows', plusMinutes(NOW(), -60));
  const cy = await confirmAt(uid, 'Walk the dog', plusMinutes(NOW(), -60));
  await scan(uid);
  const mx = await markerFor(uid, cx);
  const my = await markerFor(uid, cy);
  assert.equal(mx.matchedOutcomeId, ox2.id, 'the marker is not bound to the newest match');
  assert.equal(my.matchedOutcomeId, oy2.id);
  assert.equal((await reviewH(uid, ox2.id, 'dismissed')).status, 200);
  assert.equal((await reviewH(uid, oy1.id, 'dismissed')).status, 200);
  const body = await inboxH(uid);
  assert.equal(inboxRow(body, mx.id), undefined, 'the marker survived the dismissal of its bound outcome (fell back to an older match)');
  assert.deepEqual(inboxRow(body, my.id)?.readd, { after: 'dropped', title: 'Walk the dog' }, 'dismissing an unbound match changed the marker');
  assert.ok(ox1.review === 'confirmed');
});

test('R2-003: the marker binds the greatest observedAt whatever the storage order, and ties go to the smallest observation id', async () => {
  const uid = await begin();
  // Newest stored first, oldest stored last.
  const newer = await dropAt(uid, 'Order the groceries', daysAgo(1));
  await learn(uid);
  const older = await completeAt(uid, 'Order the groceries', daysAgo(4));
  await learn(uid);
  const oNewer = await outcomeFor(uid, newer, 'commitment_dropped');
  await outcomeFor(uid, older, 'commitment_completed');
  // Two drops at the same instant.
  const tieAt = daysAgo(2);
  const t1 = await dropAt(uid, 'Book the hotel', tieAt);
  const t2 = await dropAt(uid, 'Book the hotel', tieAt);
  await learn(uid);
  const ids = [(await outcomeFor(uid, t1, 'commitment_dropped')).id, (await outcomeFor(uid, t2, 'commitment_dropped')).id].sort();
  const c1 = await confirmAt(uid, 'Order the groceries', plusMinutes(NOW(), -60));
  const c2 = await confirmAt(uid, 'Book the hotel', plusMinutes(NOW(), -60));
  await scan(uid);
  const m1 = await markerFor(uid, c1);
  assert.equal(m1.matchedOutcomeId, oNewer.id, 'reversed storage order changed the binding');
  assert.deepEqual(inboxRow(await inboxH(uid), m1.id)?.readd, { after: 'dropped', title: 'Order the groceries' });
  assert.equal((await markerFor(uid, c2)).matchedOutcomeId, ids[0], 'a tie did not go to the smallest observation id');
});

/* ── the pure projection (its module is the builder's: READD_MODULE) ── */

test('R2 projectReadd: pure: { after, title } from the bound outcome and C\'s current title; null when C is gone, renamed away, or the bound outcome is dismissed or missing', async () => {
  const uid = await begin();
  const { c, outcome } = await droppedThenReadded(uid, 'Pay the parking fine');
  await scan(uid);
  const marker = await markerFor(uid, c);
  const module = await loadModule(READD_MODULE);
  const projectReadd = module.projectReadd as (marker: unknown, commitments: unknown, outcomes: unknown, outcomeCommitment: unknown) => unknown;
  assert.equal(typeof projectReadd, 'function', `projectReadd is not exported from ${READD_MODULE}`);
  const state = await readParticipantState(uid);
  const outcomes = await listObservations(uid, currentStorage() as any);
  const d = Object.values(state.commitments as Record<string, any>).find((item) => item.status === 'dropped')!;
  const map = new Map([[outcome.id, d.id]]);
  assert.deepEqual(projectReadd(marker, state.commitments, outcomes, map), { after: 'dropped', title: 'Pay the parking fine' });
  const { [c]: _gone, ...without } = state.commitments as Record<string, any>;
  assert.equal(projectReadd(marker, without, outcomes, map), null, 'C gone');
  const renamed = { ...state.commitments, [c]: { ...(state.commitments as any)[c], title: 'Pay the rent' } };
  assert.equal(projectReadd(marker, renamed, outcomes, map), null, 'C renamed away');
  const dismissed = outcomes.map((row) => (row.id === outcome.id ? { ...row, review: 'dismissed' } : row));
  assert.equal(projectReadd(marker, state.commitments, dismissed, map), null, 'bound outcome dismissed');
  assert.equal(projectReadd(marker, state.commitments, outcomes.filter((row) => row.id !== outcome.id), map), null, 'bound outcome purged');
});

/* ── the model context (R2, R3-002) ─────────────────────────────────── */

function markerEntry(call: any, id: string): any {
  return (call.context?.observations ?? []).find((row: any) => row.id === id);
}

async function freshRun(uid: string): Promise<void> {
  await currentStorage().delete(intelligenceRunPath(uid));
}

test('R2/R3-002 model context: a marker is sent with its projected evidence, at its stored review and confidence 0.6, with the re-add prompt line; pending, then confirmed', async () => {
  const uid = await begin();
  const dropped = await droppedThenReadded(uid, 'Call the dentist');
  const completed = await droppedThenReadded(uid, 'Water the plants', { verb: 'completed' });
  await scan(uid);
  const md = await markerFor(uid, dropped.c);
  const mc = await markerFor(uid, completed.c);
  await generateH(uid);
  assert.ok(model.calls.length >= 1, 'the model was never called');
  const first = model.calls[0]!;
  assert.deepEqual(
    { evidence: markerEntry(first, md.id)?.evidence, review: markerEntry(first, md.id)?.review, confidence: markerEntry(first, md.id)?.confidence },
    { evidence: 'Re-added after dropped: Call the dentist', review: 'pending', confidence: 0.6 },
    `the dropped re-add was sent as ${show(markerEntry(first, md.id))}`,
  );
  assert.equal(markerEntry(first, mc.id)?.evidence, 'Re-added after completed: Water the plants');
  assert.ok(first.system.includes(PROMPT_LINE), 'the re-add prompt line is missing');
  assert.equal((await reviewH(uid, md.id, 'confirmed')).status, 200);
  await freshRun(uid);
  model.reset();
  await generateH(uid);
  assert.ok(model.calls.length >= 1, 'the model was not called again');
  const second = markerEntry(model.calls[0]!, md.id);
  assert.deepEqual({ evidence: second?.evidence, review: second?.review, confidence: second?.confidence },
    { evidence: 'Re-added after dropped: Call the dentist', review: 'confirmed', confidence: 0.6 },
    'a confirmed re-add changed confidence or lost its review');
});

test('R2 model context: a marker with no projection is left out of the model request', async () => {
  const uid = await begin();
  const { c } = await droppedThenReadded(uid, 'Call the dentist');
  await scan(uid);
  const id = (await markerFor(uid, c)).id;
  await generateH(uid);
  assert.ok(markerEntry(model.calls[0], id), 'control: the projected marker was not sent');
  await renameCommitment(uid, c, 'Call the plumber');
  await freshRun(uid);
  model.reset();
  await generateH(uid);
  assert.ok(model.calls.length >= 1, 'the model was not called again');
  for (const call of model.calls) {
    assert.equal(markerEntry(call, id), undefined, 'an unmatched marker was sent');
    assert.equal(call.raw.includes('Re-added'), false, 'the model request mentions a re-add');
  }
});
