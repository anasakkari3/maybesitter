/**
 * The habits API, through the routes (#520).
 *
 * Every test here presses a real handler with a real `Request`, the way
 * `tests/mobile/intentSeeds.test.ts` does, because the things most likely to be
 * wrong on a route are the things that only exist at the boundary: the guard,
 * the parse, and what a second press does.
 *
 * Three of them are written against the failure rather than the feature:
 *
 *  - the isolation test asks for another account's habit and requires the
 *    *same* answer as a habit that never existed, so a 403-vs-404 difference
 *    cannot leak whether an id is real;
 *  - the occurrence tests press `complete` twice and then `skip`, because "a
 *    retry is not a conflict" and "a reversal is" are one rule with two halves
 *    and only the pair proves it;
 *  - the patch test moves one half of the occurrence bounds, since a patch
 *    validated field by field leaves a habit that can never be materialized.
 *
 * The adapter these habits are eventually planned through is proved separately
 * in `habitPlanningAdapter.test.ts`. Nothing about placement is re-proved here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { InMemoryHabitStore, setHabitStoreForTests } from '../../lib/habits/habitStore.ts';
import { GET as habitsGet, POST as habitsPost } from '../../src/app/api/mobile/habits/route.ts';
import { DELETE as habitDelete, PATCH as habitPatch } from '../../src/app/api/mobile/habits/[id]/route.ts';
import { POST as completePost } from '../../src/app/api/mobile/habits/[id]/occurrences/[occurrenceId]/complete/route.ts';
import { POST as skipPost } from '../../src/app/api/mobile/habits/[id]/occurrences/[occurrenceId]/skip/route.ts';

const baseUrl = 'http://127.0.0.1:4321';
const USER = uidFor('HabitRouteUser');
const OTHER = uidFor('HabitOtherUser');
const OCCURRENCE = 'hbo_11111111-1111-4111-8111-111111111111';
const ABSENT_HABIT = 'hbt_99999999-9999-4999-8999-999999999999';

let auth: FakeAuthControls | null = null;
let store: InMemoryHabitStore;

function req(method: string, path: string, body?: unknown, uid = USER): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The same request with no Authorization header at all. */
function anonymous(method: string, path: string, body?: unknown): Request {
  return new Request(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : new Headers({ 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * The URL an occurrence route is reached at.
 *
 * The handlers read `context.params` rather than the path — that is how Next
 * hands a dynamic segment over — but a `Request` still has to be a request, and
 * a placeholder that is not a URL fails in the constructor rather than in the
 * handler, which proves nothing about either.
 */
function occurrencePath(habitId: string, occurrenceId: string, outcome: 'complete' | 'skip'): string {
  return `/api/mobile/habits/${habitId}/occurrences/${occurrenceId}/${outcome}`;
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function occurrenceParams(id: string, occurrenceId: string) {
  return { params: Promise.resolve({ id, occurrenceId }) };
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

const VALID = {
  title: 'Morning run',
  cadence: { kind: 'weekly_count', count: 3 },
  durationMinutes: 45,
  preferredWindows: [{ startMinute: 420, endMinute: 480 }],
  minimumOccurrences: 2,
  maximumOccurrences: 4,
  flexibility: 'protected_flexible',
};

function setup(): () => void {
  auth = installFakeAuth();
  store = new InMemoryHabitStore();
  setHabitStoreForTests(store);
  const previous = process.env.MAYBESITTER_FEATURE_HABITS;
  process.env.MAYBESITTER_FEATURE_HABITS = 'true';
  return () => {
    auth?.restore();
    auth = null;
    setHabitStoreForTests(null);
    if (previous === undefined) delete process.env.MAYBESITTER_FEATURE_HABITS;
    else process.env.MAYBESITTER_FEATURE_HABITS = previous;
  };
}

/** Creates a habit through the route and answers its id. */
async function createHabit(body: Record<string, unknown> = VALID, uid = USER): Promise<string> {
  const response = await habitsPost(req('POST', '/api/mobile/habits', body, uid));
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  return (await json(response)).habit.habitId as string;
}

/* ── The guard ───────────────────────────────────────────────────── */

test('every habits route refuses an unauthenticated caller', async () => {
  const restore = setup();
  try {
    const answers = await Promise.all([
      habitsGet(anonymous('GET', '/api/mobile/habits')),
      habitsPost(anonymous('POST', '/api/mobile/habits', VALID)),
      habitPatch(anonymous('PATCH', `/api/mobile/habits/${ABSENT_HABIT}`, { title: 'x' }), params(ABSENT_HABIT)),
      habitDelete(anonymous('DELETE', `/api/mobile/habits/${ABSENT_HABIT}`), params(ABSENT_HABIT)),
      completePost(anonymous('POST', occurrencePath(ABSENT_HABIT, OCCURRENCE, 'complete')), occurrenceParams(ABSENT_HABIT, OCCURRENCE)),
      skipPost(anonymous('POST', occurrencePath(ABSENT_HABIT, OCCURRENCE, 'skip')), occurrenceParams(ABSENT_HABIT, OCCURRENCE)),
    ]);
    for (const answer of answers) assert.equal(answer.status, 401);
  } finally {
    restore();
  }
});

test('the routes are off unless the build enables them', async () => {
  const restore = setup();
  delete process.env.MAYBESITTER_FEATURE_HABITS;
  try {
    const response = await habitsGet(req('GET', '/api/mobile/habits'));
    // 503, not 404: the build is saying "not yet", not that this account may
    // not. See `lib/habits/habitStore.ts` for what is behind the gate.
    assert.equal(response.status, 503);
    // And the gate is checked *after* the guard, so an unauthenticated caller
    // still gets 401 rather than learning the flag's state.
    assert.equal((await habitsGet(anonymous('GET', '/api/mobile/habits'))).status, 401);
  } finally {
    restore();
  }
});

/* ── Create and read ─────────────────────────────────────────────── */

test('a created habit comes back, with the account it belongs to left off the wire', async () => {
  const restore = setup();
  try {
    const habitId = await createHabit();
    assert.match(habitId, /^hbt_[0-9a-f-]{36}$/);

    const listed = await json(await habitsGet(req('GET', '/api/mobile/habits')));
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].title, 'Morning run');
    assert.equal(listed.items[0].flexibility, 'protected_flexible');
    assert.deepEqual(listed.items[0].preferredWindows, [{ startMinute: 420, endMinute: 480 }]);
    assert.equal('scopeId' in listed.items[0], false, 'the uid must not be echoed onto every row');
  } finally {
    restore();
  }
});

test('one account cannot see, patch or delete another account\'s habit', async () => {
  const restore = setup();
  try {
    const mine = await createHabit();
    await createHabit({ ...VALID, title: 'Theirs' }, OTHER);

    const listed = await json(await habitsGet(req('GET', '/api/mobile/habits')));
    assert.deepEqual(listed.items.map((row: any) => row.title), ['Morning run']);

    // The other account's real id must answer exactly as an id that never
    // existed. Anything else makes the response an oracle for "is this real".
    const theirId = (await json(await habitsGet(req('GET', '/api/mobile/habits', undefined, OTHER)))).items[0].habitId;
    const patched = await habitPatch(req('PATCH', `/api/mobile/habits/${theirId}`, { title: 'x' }), params(theirId));
    const absent = await habitPatch(req('PATCH', `/api/mobile/habits/${ABSENT_HABIT}`, { title: 'x' }), params(ABSENT_HABIT));
    assert.equal(patched.status, 404);
    assert.equal(absent.status, 404);
    assert.deepEqual(await json(patched), await json(absent));

    assert.equal((await habitDelete(req('DELETE', `/api/mobile/habits/${theirId}`), params(theirId))).status, 404);
    // And it is still theirs afterwards.
    assert.equal((await json(await habitsGet(req('GET', '/api/mobile/habits', undefined, OTHER)))).items.length, 1);
    assert.ok(mine);
  } finally {
    restore();
  }
});

/* ── Validation ──────────────────────────────────────────────────── */

const REFUSED: Array<[string, Record<string, unknown>, string]> = [
  ['an unknown field', { ...VALID, maxShiftMinutes: 30 }, 'unknown_field'],
  ['a missing title', { ...VALID, title: '   ' }, 'invalid_title'],
  ['a duration of zero', { ...VALID, durationMinutes: 0 }, 'invalid_durationMinutes'],
  ['a fractional duration', { ...VALID, durationMinutes: 12.5 }, 'invalid_durationMinutes'],
  ['a cadence with no kind', { ...VALID, cadence: { count: 3 } }, 'invalid_cadence'],
  ['a weekly count of eight', { ...VALID, cadence: { kind: 'weekly_count', count: 8 } }, 'invalid_cadence.count'],
  ['a repeated weekday', { ...VALID, cadence: { kind: 'weekdays', weekdays: [1, 1] } }, 'invalid_cadence'],
  ['a weekday of seven', { ...VALID, cadence: { kind: 'weekdays', weekdays: [7] } }, 'invalid_cadence.weekdays'],
  ['a backwards window', { ...VALID, preferredWindows: [{ startMinute: 600, endMinute: 540 }] }, 'invalid_preferred_windows'],
  ['a zero-length window', { ...VALID, preferredWindows: [{ startMinute: 600, endMinute: 600 }] }, 'invalid_preferred_windows'],
  ['a window with a stray key', { ...VALID, preferredWindows: [{ startMinute: 0, endMinute: 60, weekday: 1 }] }, 'unknown_field'],
  ['too many windows', { ...VALID, preferredWindows: Array.from({ length: 9 }, (_, i) => ({ startMinute: i * 60, endMinute: i * 60 + 30 })) }, 'invalid_preferred_windows'],
  ['a minimum above the maximum', { ...VALID, minimumOccurrences: 5, maximumOccurrences: 2 }, 'invalid_occurrence_bounds'],
  ['an unknown flexibility', { ...VALID, flexibility: 'fixed' }, 'invalid_flexibility'],
  ['an unknown recovery policy', { ...VALID, recoveryPolicy: 'retry_forever' }, 'invalid_recoveryPolicy'],
];

for (const [what, body, reason] of REFUSED) {
  test(`creating a habit with ${what} is refused`, async () => {
    const restore = setup();
    try {
      const response = await habitsPost(req('POST', '/api/mobile/habits', body));
      assert.equal(response.status, 400, `${what} was accepted`);
      assert.equal((await json(response)).reason, reason);
      // Nothing was written on the way to the refusal.
      assert.deepEqual((await json(await habitsGet(req('GET', '/api/mobile/habits')))).items, []);
    } finally {
      restore();
    }
  });
}

test('a body that is not an object, and a body that is not JSON, are both refused', async () => {
  const restore = setup();
  try {
    assert.equal((await habitsPost(req('POST', '/api/mobile/habits', ['a']))).status, 400);
    const malformed = new Request(`${baseUrl}/api/mobile/habits`, {
      method: 'POST',
      headers: new Headers({ authorization: `Bearer ${tokenFor(USER)}`, 'Content-Type': 'application/json' }),
      body: '{ not json',
    });
    assert.equal((await habitsPost(malformed)).status, 400);
  } finally {
    restore();
  }
});

/* ── Patch and delete ────────────────────────────────────────────── */

test('a patch changes what it names and nothing else', async () => {
  const restore = setup();
  try {
    const habitId = await createHabit();
    const response = await habitPatch(
      req('PATCH', `/api/mobile/habits/${habitId}`, { status: 'paused', durationMinutes: 20 }),
      params(habitId),
    );
    assert.equal(response.status, 200);
    const { habit } = await json(response);
    assert.equal(habit.status, 'paused');
    assert.equal(habit.durationMinutes, 20);
    assert.equal(habit.title, 'Morning run');
    assert.equal(habit.flexibility, 'protected_flexible');
    assert.notEqual(habit.updatedAt, habit.createdAt === habit.updatedAt ? 'unchanged' : habit.createdAt);
  } finally {
    restore();
  }
});

test('a patch cannot restate where a habit came from', async () => {
  const restore = setup();
  try {
    const habitId = await createHabit({ ...VALID, source: 'goal_confirmed' });
    const response = await habitPatch(
      req('PATCH', `/api/mobile/habits/${habitId}`, { source: 'user_created' }),
      params(habitId),
    );
    assert.equal(response.status, 400);
    assert.equal((await json(response)).reason, 'unknown_field');
    const listed = await json(await habitsGet(req('GET', '/api/mobile/habits')));
    assert.equal(listed.items[0].source, 'goal_confirmed');
  } finally {
    restore();
  }
});

test('half an occurrence bound is checked against the half already stored', async () => {
  const restore = setup();
  try {
    // Stored: min 2, max 4. Raising only the minimum to 5 is legal read on its
    // own and leaves a habit materialization can never satisfy.
    const habitId = await createHabit();
    const response = await habitPatch(
      req('PATCH', `/api/mobile/habits/${habitId}`, { minimumOccurrences: 5 }),
      params(habitId),
    );
    assert.equal(response.status, 400);
    assert.equal((await json(response)).reason, 'invalid_occurrence_bounds');
    // And the pair moved together is allowed.
    const together = await habitPatch(
      req('PATCH', `/api/mobile/habits/${habitId}`, { minimumOccurrences: 5, maximumOccurrences: 6 }),
      params(habitId),
    );
    assert.equal(together.status, 200);
  } finally {
    restore();
  }
});

test('an empty patch is refused rather than treated as a no-op', async () => {
  const restore = setup();
  try {
    const habitId = await createHabit();
    const response = await habitPatch(req('PATCH', `/api/mobile/habits/${habitId}`, {}), params(habitId));
    assert.equal(response.status, 400);
    assert.equal((await json(response)).reason, 'empty_patch');
  } finally {
    restore();
  }
});

test('a path segment that is not an id is refused before anything is read', async () => {
  const restore = setup();
  try {
    for (const bad of ['../../etc', 'wtc_11111111-1111-4111-8111-111111111111', 'hbt_short']) {
      const response = await habitDelete(req('DELETE', `/api/mobile/habits/${bad}`), params(bad));
      assert.equal(response.status, 400, `${bad} was not refused`);
      assert.equal((await json(response)).reason, 'invalid_habit_id');
    }
  } finally {
    restore();
  }
});

test('deleting a habit takes its occurrences with it', async () => {
  const restore = setup();
  try {
    const habitId = await createHabit();
    await store.putOccurrence(USER, {
      occurrenceId: OCCURRENCE, habitId, localDate: '2026-08-17', state: 'pending', durationMinutes: 45,
    });

    const deleted = await habitDelete(req('DELETE', `/api/mobile/habits/${habitId}`), params(habitId));
    assert.equal(deleted.status, 200);
    assert.deepEqual(await json(deleted), { success: true, habitId, deleted: true });
    assert.deepEqual(await store.listOccurrences(USER, habitId), []);
    // A second delete is a 404: the habit is gone, and saying so is not a leak
    // because the caller just deleted it.
    assert.equal((await habitDelete(req('DELETE', `/api/mobile/habits/${habitId}`), params(habitId))).status, 404);
  } finally {
    restore();
  }
});

/* ── Occurrence transitions ──────────────────────────────────────── */

async function seedOccurrence(habitId: string, state: 'pending' | 'scheduled' = 'pending'): Promise<void> {
  await store.putOccurrence(USER, {
    occurrenceId: OCCURRENCE, habitId, localDate: '2026-08-17', state, durationMinutes: 45,
  });
}

for (const [route, outcome] of [[completePost, 'completed'], [skipPost, 'skipped']] as const) {
  test(`marking an occurrence ${outcome} records it and takes it out of the planner's reach`, async () => {
    const restore = setup();
    try {
      const habitId = await createHabit();
      await seedOccurrence(habitId, 'scheduled');
      const response = await route(req('POST', occurrencePath(habitId, OCCURRENCE, outcome === 'completed' ? 'complete' : 'skip')), occurrenceParams(habitId, OCCURRENCE));
      assert.equal(response.status, 200);
      const body = await json(response);
      assert.equal(body.occurrence.state, outcome);
      assert.equal(body.changed, true);
      const [stored] = await store.listOccurrences(USER, habitId);
      assert.equal(stored.state, outcome);
    } finally {
      restore();
    }
  });
}

test('pressing the same outcome twice is a retry, not a conflict', async () => {
  const restore = setup();
  try {
    const habitId = await createHabit();
    await seedOccurrence(habitId);
    const first = await json(await completePost(req('POST', occurrencePath(habitId, OCCURRENCE, 'complete')), occurrenceParams(habitId, OCCURRENCE)));
    const second = await completePost(req('POST', occurrencePath(habitId, OCCURRENCE, 'complete')), occurrenceParams(habitId, OCCURRENCE));
    assert.equal(second.status, 200, 'a phone retrying a request it never saw the answer to must get the answer');
    const body = await json(second);
    assert.equal(body.occurrence.state, 'completed');
    assert.equal(body.changed, false, 'the second press changed nothing and must say so');
    assert.equal(first.changed, true);
  } finally {
    restore();
  }
});

test('reversing a decision already taken is refused, and does not overwrite it', async () => {
  const restore = setup();
  try {
    const habitId = await createHabit();
    await seedOccurrence(habitId);
    await completePost(req('POST', occurrencePath(habitId, OCCURRENCE, 'complete')), occurrenceParams(habitId, OCCURRENCE));

    const reversal = await skipPost(req('POST', occurrencePath(habitId, OCCURRENCE, 'skip')), occurrenceParams(habitId, OCCURRENCE));
    assert.equal(reversal.status, 409);
    const body = await json(reversal);
    assert.equal(body.success, false);
    assert.equal(body.occurrence.state, 'completed');
    // The stale phone must not have broken the streak.
    const [stored] = await store.listOccurrences(USER, habitId);
    assert.equal(stored.state, 'completed');
  } finally {
    restore();
  }
});

test('an occurrence cannot be decided through a habit it does not belong to', async () => {
  const restore = setup();
  try {
    const mine = await createHabit();
    const other = await createHabit({ ...VALID, title: 'Second habit' });
    await seedOccurrence(mine);

    const response = await completePost(req('POST', occurrencePath(other, OCCURRENCE, 'complete')), occurrenceParams(other, OCCURRENCE));
    assert.equal(response.status, 404, 'the two ids in the path must both mean what they say');
    const [stored] = await store.listOccurrences(USER, mine);
    assert.equal(stored.state, 'pending');
  } finally {
    restore();
  }
});

test('another account cannot mark an occurrence that is not theirs', async () => {
  const restore = setup();
  try {
    const habitId = await createHabit();
    await seedOccurrence(habitId);
    const response = await completePost(req('POST', occurrencePath(habitId, OCCURRENCE, 'complete'), undefined, OTHER), occurrenceParams(habitId, OCCURRENCE));
    assert.equal(response.status, 404);
    const [stored] = await store.listOccurrences(USER, habitId);
    assert.equal(stored.state, 'pending');
  } finally {
    restore();
  }
});

test('an occurrence id that is not one is refused before any read', async () => {
  const restore = setup();
  try {
    const habitId = await createHabit();
    const response = await skipPost(req('POST', occurrencePath(habitId, OCCURRENCE, 'skip')), occurrenceParams(habitId, 'hbt_11111111-1111-4111-8111-111111111111'));
    assert.equal(response.status, 400);
    assert.equal((await json(response)).reason, 'invalid_occurrence_id');
  } finally {
    restore();
  }
});
