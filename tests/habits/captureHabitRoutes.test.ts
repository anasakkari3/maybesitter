/**
 * A habit saved from the chat can be answered, paused and removed (QA v3,
 * V3-F23-01).
 *
 * The chat mints its habit id as `docIdForKey(...)` — a 64-character sha256
 * hex digest — so a retried confirm writes the same document rather than a
 * second habit. The habit routes accepted only `randomUUID()` ids, so every
 * habit the chat ever saved answered 400 "not a habit id" on «تمّت», «مش اليوم»,
 * «إيقاف مؤقت» and «امسح»: stuck, with no way to get rid of it.
 *
 * These go through the real chat and the real confirm, so the id under test is
 * the one production writes — not a hand-made digest that could drift from it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { tokenFor } from '../support/fakeAuth.ts';
import { createHabitServices } from '../../lib/services/habits/habitService.ts';
import { GET as habitsGet } from '../../src/app/api/mobile/habits/route.ts';
import { DELETE as habitDelete, PATCH as habitPatch } from '../../src/app/api/mobile/habits/[id]/route.ts';
import { POST as completePost } from '../../src/app/api/mobile/habits/[id]/occurrences/[occurrenceId]/complete/route.ts';
import { POST as skipPost } from '../../src/app/api/mobile/habits/[id]/occurrences/[occurrenceId]/skip/route.ts';
import { TZ, beginRules, confirm, end, habitsOf, say, show } from '../acceptance/m3b/support.ts';

const BASE = 'http://localhost:3000';
const WALK = 'بدي أمشي نص ساعة كل يوم الصبح';

function req(uid: string, method: string, path: string, body?: unknown): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** Says the habit, confirms it, and returns its stored id and today's row. */
async function chatHabit(uid: string): Promise<{ habitId: string; occurrenceId: string }> {
  const answer = await say(uid, WALK, { locale: 'ar' });
  const habit = habitsOf(answer)[0]!;
  const confirmed = await confirm(uid, answer.proposal!, { habits: [habit.habitItemId] });
  assert.equal(confirmed.status, 200, show(confirmed.body));
  const habitId = confirmed.body.habitsPersisted?.[0]?.habitId as string;
  assert.match(habitId, /^[0-9a-f]{64}$/, 'the chat no longer mints a digest id; this test no longer reproduces V3-F23-01');
  const listed = await (await habitsGet(req(uid, 'GET', `/api/mobile/habits?timezone=${encodeURIComponent(TZ)}`))).json() as Record<string, any>;
  const today = (listed.today?.occurrences ?? []).find((row: { habitId: string }) => row.habitId === habitId);
  assert.ok(today, `a daily chat habit has no row today: ${show(listed.today)}`);
  return { habitId, occurrenceId: today.occurrenceId as string };
}

function occurrence(habitId: string, occurrenceId: string, verb: string): string {
  return `/api/mobile/habits/${habitId}/occurrences/${occurrenceId}/${verb}?timezone=${encodeURIComponent(TZ)}`;
}

test('V3-F23-01 «تمّت» on a habit saved from the chat is recorded, not refused as "not a habit id"', async () => {
  const uid = beginRules();
  try {
    const { habitId, occurrenceId } = await chatHabit(uid);
    const response = await completePost(req(uid, 'POST', occurrence(habitId, occurrenceId, 'complete')), { params: Promise.resolve({ id: habitId, occurrenceId }) });
    const body = await response.json() as Record<string, any>;
    assert.equal(response.status, 200, show(body));
    assert.equal(body.occurrence.state, 'completed');
    assert.equal((await createHabitServices().occurrences.get(uid, occurrenceId))?.state, 'completed');
  } finally { end(); }
});

test('V3-F23-01 «مش اليوم», «إيقاف مؤقت» and «امسح» work on a habit saved from the chat', async () => {
  const uid = beginRules();
  try {
    const { habitId, occurrenceId } = await chatHabit(uid);
    const skipped = await skipPost(req(uid, 'POST', occurrence(habitId, occurrenceId, 'skip')), { params: Promise.resolve({ id: habitId, occurrenceId }) });
    assert.equal(skipped.status, 200, show(await skipped.clone().json()));

    const paused = await habitPatch(req(uid, 'PATCH', `/api/mobile/habits/${habitId}?timezone=${encodeURIComponent(TZ)}`, { status: 'paused' }), { params: Promise.resolve({ id: habitId }) });
    const pausedBody = await paused.json() as Record<string, any>;
    assert.equal(paused.status, 200, show(pausedBody));
    assert.equal(pausedBody.habit.status, 'paused');

    const removed = await habitDelete(req(uid, 'DELETE', `/api/mobile/habits/${habitId}`), { params: Promise.resolve({ id: habitId }) });
    assert.equal(removed.status, 200, show(await removed.clone().json()));
    assert.equal(await createHabitServices().habits.get(uid, habitId), null, 'the chat habit is still stored after «امسح»');
  } finally { end(); }
});

test('V3-F23-01 widening the id shape lets nothing that is not a minted id through', async () => {
  const uid = beginRules();
  try {
    for (const bad of ['../../etc', `${'a'.repeat(63)}`, `${'a'.repeat(65)}`, `${'g'.repeat(64)}`, `${'a'.repeat(62)}/.`]) {
      const response = await habitDelete(req(uid, 'DELETE', `/api/mobile/habits/x`), { params: Promise.resolve({ id: bad }) });
      assert.equal(response.status, 400, `${bad} was not refused`);
    }
  } finally { end(); }
});
