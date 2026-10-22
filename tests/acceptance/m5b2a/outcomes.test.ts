/**
 * M5b-2a Gate B, R1: what you did, and «مش صحيح» (condition 41).
 * PLAN-M5b-2a R1 + Wire. See support.ts for the harness and the gate rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { listSuggestions, proposeFromObservations, reuseRunForVisit } from '../../../lib/intelligence/proposalEngine.ts';
import { learnFromCommitmentEvents } from '../../../lib/intelligence/outcomeLearning.ts';
import { listObservations } from '../../../lib/intelligence/observationStore.ts';
import { applyParticipantCommands, readParticipantState } from '../../../lib/services/mobile/participantState.ts';
import {
  NOW, addFloating, begin, call, currentStorage, end, grantPersonalization, grantRecommendations, observation,
  outcomeObservation, show, storeSuggestion, storedSuggestion,
} from './support.ts';

const EVENT = (n: number) => `0e0e0e0e-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function dismiss(uid: string, id: string) {
  return call(uid, 'intelligence/observations/[id]', 'POST', { params: { id }, body: { review: 'dismissed' } });
}

async function inbox(uid: string) {
  const result = await call(uid, 'intelligence', 'GET');
  assert.equal(result.status, 200, show(result.body));
  return result.body as { observations: any[]; suggestions: any[] };
}

/* ── dismissal ─────────────────────────────────────────────────────── */

test('R1: on, a confirmed behaviour outcome can be dismissed, and a second dismissal is unchanged', async () => {
  const uid = await begin();
  try {
    const outcome = await outcomeObservation(uid, 'Completed: Call the dentist', EVENT(1));
    assert.equal(outcome.review, 'confirmed');
    const first = await dismiss(uid, outcome.id);
    assert.equal(first.status, 200, show(first.body));
    assert.equal(first.body.observation.review, 'dismissed');
    const stored = (await listObservations(uid, currentStorage() as any)).find((row) => row.id === outcome.id)!;
    assert.equal(stored.review, 'dismissed');
    const second = await dismiss(uid, outcome.id);
    assert.equal(second.status, 200, show(second.body));
    assert.equal(second.body.observation.review, 'dismissed');
    assert.equal(second.body.observation.reviewedAt, first.body.observation.reviewedAt);
  } finally { end(); }
});

test('R1 parity: on, other confirmed observations still cannot be dismissed (unchanged 200)', async () => {
  const uid = await begin();
  try {
    const saved = await observation(uid, 'commitment', 'obligation', 'Saved: pay rent', 'commitment-ref-1');
    assert.equal(saved.review, 'confirmed');
    const result = await dismiss(uid, saved.id);
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.observation.review, 'confirmed');
  } finally { end(); }
});

for (const [name, switches] of [['off', { on: false }], ['killed', { killed: true }]] as const) {
  test(`R1 parity: ${name}, dismissing a confirmed behaviour outcome answers exactly as today (200, still confirmed)`, async () => {
    const uid = await begin(switches);
    try {
      const outcome = await outcomeObservation(uid, 'Completed: Call the dentist', EVENT(2));
      const result = await dismiss(uid, outcome.id);
      assert.equal(result.status, 200, show(result.body));
      assert.deepEqual(result.body, { success: true, observation: outcome });
    } finally { end(); }
  });
}

/* ── the outcome field ─────────────────────────────────────────────── */

test('R1: on, the inbox gives each behaviour outcome its signal and title; an unknown prefix gives none', async () => {
  const uid = await begin();
  try {
    const done = await outcomeObservation(uid, 'Completed: Call the dentist', EVENT(3));
    const later = await outcomeObservation(uid, 'Postponed: Renew the passport', EVENT(4));
    const dropped = await outcomeObservation(uid, 'Dropped: Clean the garage', EVENT(5));
    const odd = await outcomeObservation(uid, 'Something else: x', EVENT(6));
    const pending = await observation(uid, 'manual', 'obligation', 'Call mum on Friday', 'manual-ref-1');
    const body = await inbox(uid);
    const byId = new Map(body.observations.map((row) => [row.id, row]));
    assert.deepEqual(byId.get(done.id).outcome, { signal: 'completed', title: 'Call the dentist' });
    assert.deepEqual(byId.get(later.id).outcome, { signal: 'postponed', title: 'Renew the passport' });
    assert.deepEqual(byId.get(dropped.id).outcome, { signal: 'dropped', title: 'Clean the garage' });
    assert.equal('outcome' in byId.get(odd.id), false);
    assert.equal('outcome' in byId.get(pending.id), false);
  } finally { end(); }
});

for (const [name, switches] of [['off', { on: false }], ['killed', { killed: true }]] as const) {
  test(`R1 parity: ${name}, no observation carries an outcome field`, async () => {
    const uid = await begin(switches);
    try {
      await outcomeObservation(uid, 'Completed: Call the dentist', EVENT(7));
      const body = await inbox(uid);
      for (const row of body.observations) assert.equal('outcome' in row, false, show(row));
    } finally { end(); }
  });
}

/* ── never re-learned ──────────────────────────────────────────────── */

test('R1: a dismissed outcome is not learned again from its event', async () => {
  const uid = await begin();
  try {
    await grantPersonalization(uid);
    const id = await addFloating(uid, 'Water the plants');
    await applyParticipantCommands(uid, [{ type: 'Complete', commitmentId: id, now: NOW() } as any]);
    const learned = await learnFromCommitmentEvents(uid, currentStorage() as any);
    assert.equal(learned.length, 1, show(learned));
    assert.equal((await dismiss(uid, learned[0]!.id)).status, 200);
    const again = await learnFromCommitmentEvents(uid, currentStorage() as any);
    assert.equal(again.length, 0, show(again));
    const behaviour = (await listObservations(uid, currentStorage() as any)).filter((row) => row.source === 'behavior');
    assert.equal(behaviour.length, 1);
    assert.equal(behaviour[0]!.review, 'dismissed');
    assert.ok((await readParticipantState(uid)).commitments[id]);
  } finally { end(); }
});

/* ── suggestions citing a dismissed outcome ────────────────────────── */

test('R1: a pending suggestion citing a dismissed outcome is hidden from the inbox and from run reuse', async () => {
  const uid = await begin();
  try {
    await grantRecommendations(uid);
    const outcome = await outcomeObservation(uid, 'Completed: Call the dentist', EVENT(8));
    const other = await observation(uid, 'manual', 'obligation', 'Book a check-up', 'manual-ref-2');
    const citing = await storeSuggestion(uid, 'action', [outcome.id]);
    const clean = await storeSuggestion(uid, 'action', [other.id]);
    assert.equal((await dismiss(uid, outcome.id)).status, 200);
    const ids = (await inbox(uid)).suggestions.map((row) => row.id);
    assert.ok(ids.includes(clean.id), show(ids));
    assert.equal(ids.includes(citing.id), false, show(ids));
    const reused = await reuseRunForVisit(uid, NOW(), currentStorage() as any);
    if (reused) assert.equal(reused.some((row) => row.id === citing.id), false);
  } finally { end(); }
});

for (const kind of ['action', 'goal', 'warning'] as const) {
  test(`R1: accepting a ${kind} suggestion that cites a dismissed outcome creates nothing and leaves it dismissed`, async () => {
    const uid = await begin();
    try {
      await grantRecommendations(uid);
      const outcome = await outcomeObservation(uid, 'Completed: Call the dentist', EVENT(10));
      const citing = await storeSuggestion(uid, kind, [outcome.id]);
      assert.equal((await dismiss(uid, outcome.id)).status, 200);
      const before = Object.keys((await readParticipantState(uid)).commitments).length;
      const result = await call(uid, 'intelligence/suggestions/[id]', 'POST', { params: { id: citing.id }, body: { decision: 'accept' } });
      assert.ok(result.status < 500, show(result.body));
      const stored = await storedSuggestion(uid, citing.id);
      assert.equal(stored?.status, 'dismissed', show(stored));
      assert.equal(stored?.linkedEntityId ?? null, null);
      assert.equal(Object.keys((await readParticipantState(uid)).commitments).length, before);
    } finally { end(); }
  });
}

test('R1: answering a question that cites a dismissed outcome records no answer and leaves it dismissed', async () => {
  const uid = await begin();
  try {
    await grantRecommendations(uid);
    const outcome = await outcomeObservation(uid, 'Completed: Call the dentist', EVENT(11));
    const question = await storeSuggestion(uid, 'question', [outcome.id]);
    assert.equal((await dismiss(uid, outcome.id)).status, 200);
    const before = (await listObservations(uid, currentStorage() as any)).length;
    const result = await call(uid, 'intelligence/suggestions/[id]/answer', 'POST', { params: { id: question.id }, body: { answer: 'Yes, mornings are hard' } });
    assert.ok(result.status < 500, show(result.body));
    const stored = await storedSuggestion(uid, question.id);
    assert.equal(stored?.status, 'dismissed', show(stored));
    assert.equal((await listObservations(uid, currentStorage() as any)).length, before, 'no answer evidence was recorded');
  } finally { end(); }
});

test('R1 parity: an accept claimed before the dismissal finishes, and stays the person\'s', async () => {
  const uid = await begin();
  try {
    await grantRecommendations(uid);
    const outcome = await outcomeObservation(uid, 'Completed: Call the dentist', EVENT(12));
    const citing = await storeSuggestion(uid, 'action', [outcome.id]);
    const accepted = await call(uid, 'intelligence/suggestions/[id]', 'POST', { params: { id: citing.id }, body: { decision: 'accept' } });
    assert.equal(accepted.status, 200, show(accepted.body));
    assert.equal((await dismiss(uid, outcome.id)).status, 200);
    const stored = await storedSuggestion(uid, citing.id);
    assert.equal(stored?.status, 'accepted');
    assert.ok(stored?.linkedEntityId);
  } finally { end(); }
});

test('R1: many citing suggestions do not stop the dismissal, and every one is hidden and refused', async () => {
  const uid = await begin();
  try {
    await grantRecommendations(uid);
    const outcome = await outcomeObservation(uid, 'Completed: Call the dentist', EVENT(13));
    const citing = [];
    for (let i = 0; i < 520; i += 1) citing.push(await storeSuggestion(uid, 'warning', [outcome.id]));
    const result = await dismiss(uid, outcome.id);
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.observation.review, 'dismissed');
    const ids = new Set((await inbox(uid)).suggestions.map((row) => row.id));
    for (const suggestion of citing) assert.equal(ids.has(suggestion.id), false);
    const last = citing.at(-1)!;
    await call(uid, 'intelligence/suggestions/[id]', 'POST', { params: { id: last.id }, body: { decision: 'accept' } });
    assert.equal((await storedSuggestion(uid, last.id))?.status, 'dismissed');
  } finally { end(); }
});

for (const [name, switches] of [['off', { on: false }], ['killed', { killed: true }]] as const) {
  test(`R1: after the switch goes ${name}, a suggestion citing an outcome dismissed while on is still hidden and refused`, async () => {
    const uid = await begin();
    try {
      await grantRecommendations(uid);
      const outcome = await outcomeObservation(uid, 'Completed: Call the dentist', EVENT(14));
      const citing = await storeSuggestion(uid, 'action', [outcome.id]);
      assert.equal((await dismiss(uid, outcome.id)).status, 200);
      const { setM5bSwitches } = await import('./support.ts');
      setM5bSwitches(switches);
      assert.equal((await inbox(uid)).suggestions.some((row) => row.id === citing.id), false);
      await call(uid, 'intelligence/suggestions/[id]', 'POST', { params: { id: citing.id }, body: { decision: 'accept' } });
      assert.equal((await storedSuggestion(uid, citing.id))?.status, 'dismissed');
      assert.equal((await listSuggestions(uid, currentStorage() as any)).find((row) => row.id === citing.id)?.linkedEntityId ?? null, null);
    } finally { end(); }
  });
}

test('R1: a generation in flight across the dismissal publishes no suggestion citing the dismissed outcome', async () => {
  const uid = await begin();
  try {
    await grantRecommendations(uid);
    const outcome = await outcomeObservation(uid, 'Completed: Call the dentist', EVENT(15));
    const other = await observation(uid, 'manual', 'obligation', 'Book a check-up', 'manual-ref-3');
    const returned = await proposeFromObservations(uid, NOW(), {
      storage: currentStorage() as any,
      generate: async () => {
        // The person says «مش صحيح» while the model is answering.
        assert.equal((await dismiss(uid, outcome.id)).status, 200);
        return { text: JSON.stringify({ suggestions: [
          { kind: 'warning', title: 'Keep the dentist routine going', reason: 'You did it once already', observationIds: [outcome.id], confidence: 0.6, durationMinutes: 0 },
          { kind: 'warning', title: 'A check-up is still open', reason: 'You mentioned booking one', observationIds: [other.id], confidence: 0.6, durationMinutes: 0 },
        ] }) } as any;
      },
    } as any);
    assert.equal(returned.some((row) => row.observationIds.includes(outcome.id)), false, show(returned));
    const stored = await listSuggestions(uid, currentStorage() as any);
    assert.equal(stored.some((row) => row.observationIds.includes(outcome.id) && row.status === 'pending'), false, show(stored));
    assert.ok(stored.some((row) => row.observationIds.includes(other.id)), 'the clean suggestion is published');
  } finally { end(); }
});
