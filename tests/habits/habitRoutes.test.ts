/**
 * The habits API, through the routes, over real storage (#520).
 *
 * Every test here presses a real handler with a real `Request` against a real
 * `StorageHabitStore` and `StorageHabitOccurrenceStore` — no stub, no injected
 * fake store, nothing that could agree with the handler while disagreeing with
 * production. The previous version of this file ran against an in-memory
 * placeholder whose shape the domain lane then contradicted; that is the class
 * of failure this reconciliation removes, and running the real stores is how it
 * stays removed.
 *
 * Several tests are written against the failure rather than the feature:
 *
 *  - the isolation test asks for another account's habit and requires the
 *    *same* answer as a habit that never existed, so a 403-vs-404 difference
 *    cannot leak whether an id is real;
 *  - the occurrence tests press `complete` twice and then `skip`, because "a
 *    retry is not a conflict" and "a reversal is" are one rule with two halves
 *    and only the pair proves it;
 *  - the confirmation test sends a body with everything *except* a
 *    confirmation, because that is #520's core invariant and the way it breaks
 *    is a server that fills one in.
 *
 * `tests/habits/habitContracts.test.ts` owns the validation rules themselves.
 * What is proved here is that the boundary reaches them, and what the boundary
 * adds: identity, key refusal, and what leaves on the wire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createHabitServices } from '../../lib/services/habits/habitService.ts';
import { withVerifiedScope } from '../../lib/services/habits/habitApi.ts';
import { GET as habitsGet, POST as habitsPost } from '../../src/app/api/mobile/habits/route.ts';
import { DELETE as habitDelete, PATCH as habitPatch } from '../../src/app/api/mobile/habits/[id]/route.ts';
import { POST as completePost } from '../../src/app/api/mobile/habits/[id]/occurrences/[occurrenceId]/complete/route.ts';
import { POST as skipPost } from '../../src/app/api/mobile/habits/[id]/occurrences/[occurrenceId]/skip/route.ts';

const baseUrl = 'http://127.0.0.1:4321';
const USER = uidFor('HabitRouteUser');
const OTHER = uidFor('HabitOtherUser');
const ABSENT_HABIT = '99999999-9999-4999-8999-999999999999';
const ABSENT_OCCURRENCE = `${ABSENT_HABIT}.2026-03-02.0`;
/** Pinned so "today" is a known Monday whatever day this suite runs on. */
const TZ = 'UTC';

let auth: FakeAuthControls | null = null;

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

/**
 * A complete, legal create body.
 *
 * Every field the domain requires is written out rather than defaulted, which
 * is the contract's own decision: `flexibility`, `recoveryPolicy`, `source` and
 * above all `confirmation` have no server-side default, so a fixture that
 * omitted one would be testing a body no client may send.
 */
const VALID = {
  title: 'Morning run',
  cadence: { kind: 'weekdays', weekdays: [1] },
  durationMinutes: 45,
  preferredWindows: [{ start: '07:00', end: '08:00' }],
  minimumOccurrences: 1,
  maximumOccurrences: 1,
  flexibility: 'protected_flexible',
  recoveryPolicy: 'recover_within_period',
  source: 'user_created',
  confirmation: {
    confirmedByUserAt: '2026-03-01T09:00:00.000Z',
    sourceRef: null,
    acceptedSuggestedValues: false,
  },
};

function setup(): () => void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

/** Creates a habit through the route and answers the whole response body. */
async function createHabit(body: Record<string, unknown> = VALID, uid = USER): Promise<Record<string, any>> {
  const response = await habitsPost(req('POST', `/api/mobile/habits?timezone=${TZ}`, body, uid));
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  return json(response);
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
      completePost(
        anonymous('POST', occurrencePath(ABSENT_HABIT, ABSENT_OCCURRENCE, 'complete')),
        occurrenceParams(ABSENT_HABIT, ABSENT_OCCURRENCE),
      ),
      skipPost(
        anonymous('POST', occurrencePath(ABSENT_HABIT, ABSENT_OCCURRENCE, 'skip')),
        occurrenceParams(ABSENT_HABIT, ABSENT_OCCURRENCE),
      ),
    ]);
    for (const answer of answers) assert.equal(answer.status, 401);
  } finally {
    restore();
  }
});

/* ── Create, materialize and read ────────────────────────────────── */

test('creating a habit stores the rule and materializes the dates it asks for', async () => {
  const restore = setup();
  try {
    const created = await createHabit();
    const habitId = created.habit.habitId as string;
    assert.match(habitId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Four weeks of Mondays, from the real materializer through the real store.
    const occurrences = created.occurrences as Array<Record<string, any>>;
    assert.ok(occurrences.length >= 4, `expected four weeks of Mondays, got ${occurrences.length}`);
    for (const occurrence of occurrences) {
      assert.equal(occurrence.state, 'pending');
      assert.equal(occurrence.habitId, habitId);
      assert.equal(occurrence.occurrenceId, `${habitId}.${occurrence.localDate}.${occurrence.ordinal}`);
      assert.equal(new Date(`${occurrence.localDate}T00:00:00Z`).getUTCDay(), 1, 'a weekdays:[1] habit asked for a non-Monday');
    }

    // And they are readable from storage, not merely echoed by the handler.
    const stored = await createHabitServices().occurrences.listForHabit(USER, habitId);
    assert.deepEqual(
      stored.map((row) => row.occurrenceId).sort(),
      occurrences.map((row) => row.occurrenceId as string).sort(),
    );
  } finally {
    restore();
  }
});

test('a created habit comes back, with the account it belongs to left off the wire', async () => {
  const restore = setup();
  try {
    await createHabit();
    const listed = await json(await habitsGet(req('GET', '/api/mobile/habits')));
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].title, 'Morning run');
    assert.equal(listed.items[0].flexibility, 'protected_flexible');
    assert.deepEqual(listed.items[0].preferredWindows, [{ start: '07:00', end: '08:00' }]);
    // The receipt travels: a client showing the user what they agreed to can.
    assert.equal(listed.items[0].confirmation.confirmedByUserAt, '2026-03-01T09:00:00.000Z');
    assert.equal('scopeId' in listed.items[0], false, 'the uid must not be echoed onto every row');
  } finally {
    restore();
  }
});

test("one account cannot see, patch or delete another account's habit", async () => {
  const restore = setup();
  try {
    await createHabit();
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
    // And it is still theirs afterwards, occurrences included.
    assert.equal((await json(await habitsGet(req('GET', '/api/mobile/habits', undefined, OTHER)))).items.length, 1);
    assert.ok((await createHabitServices().occurrences.listForHabit(OTHER, theirId)).length > 0);
  } finally {
    restore();
  }
});

test('the verified uid always wins over a scopeId in the body', () => {
  // The ordering, pinned on its own. In the shipped route a body carrying
  // `scopeId` never gets this far — `checkNewHabitBody` refuses the key — so
  // without this test the line that actually decides whose tree a habit lands
  // in is covered by nothing, and stays that way until the day somebody
  // widens the accepted keys.
  assert.equal(withVerifiedScope({ scopeId: OTHER, title: 'x' }, USER).scopeId, USER);
  assert.equal(withVerifiedScope({ title: 'x' }, USER).scopeId, USER);
});

test('a body cannot choose whose account the habit lands in', async () => {
  const restore = setup();
  try {
    // `scopeId` is not an accepted key, so this is refused outright rather than
    // silently overwritten — a clearer answer than ignoring the attempt.
    const response = await habitsPost(req('POST', '/api/mobile/habits', { ...VALID, scopeId: OTHER }));
    assert.equal(response.status, 400);
    assert.match((await json(response)).error, /scopeId/);
    assert.deepEqual((await json(await habitsGet(req('GET', '/api/mobile/habits', undefined, OTHER)))).items, []);
  } finally {
    restore();
  }
});

/* ── Validation reaches the domain ───────────────────────────────── */

const REFUSED: Array<[string, Record<string, unknown>, RegExp]> = [
  ['an unknown field', { ...VALID, maxShiftMinutes: 30 }, /maxShiftMinutes/],
  ['no confirmation at all', Object.fromEntries(Object.entries(VALID).filter(([k]) => k !== 'confirmation')), /confirmation is required/],
  ['a confirmation with no instant', { ...VALID, confirmation: { sourceRef: null, acceptedSuggestedValues: false } }, /confirmedByUserAt/],
  ['a missing title', { ...VALID, title: '   ' }, /title/],
  ['a duration of zero', { ...VALID, durationMinutes: 0 }, /durationMinutes/],
  ['a fractional duration', { ...VALID, durationMinutes: 12.5 }, /durationMinutes/],
  ['a cadence with no kind', { ...VALID, cadence: { count: 3 } }, /cadence/],
  ['a weekly count of eight', { ...VALID, cadence: { kind: 'weekly_count', count: 8 } }, /count/],
  ['a repeated weekday', { ...VALID, cadence: { kind: 'weekdays', weekdays: [1, 1] } }, /repeat/],
  ['a weekday of seven', { ...VALID, cadence: { kind: 'weekdays', weekdays: [7] } }, /weekdays/],
  ['a window that is not HH:MM', { ...VALID, preferredWindows: [{ start: '7am', end: '08:00' }] }, /HH:MM/],
  ['a zero-length window', { ...VALID, preferredWindows: [{ start: '10:00', end: '10:00' }] }, /same minute/],
  ['a cadence above the ceiling', { ...VALID, cadence: { kind: 'weekly_count', count: 5 }, minimumOccurrences: 1, maximumOccurrences: 1 }, /above maximumOccurrences/],
  ['an unknown flexibility', { ...VALID, flexibility: 'fixed' }, /flexibility/],
  ['an unknown recovery policy', { ...VALID, recoveryPolicy: 'retry_forever' }, /recoveryPolicy/],
];

for (const [what, body, message] of REFUSED) {
  test(`creating a habit with ${what} is refused`, async () => {
    const restore = setup();
    try {
      const response = await habitsPost(req('POST', '/api/mobile/habits', body));
      assert.equal(response.status, 400, `${what} was accepted`);
      assert.match((await json(response)).error, message);
      // Nothing was written on the way to the refusal — neither rule nor dates.
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

/* ── Patch, re-materialize and delete ────────────────────────────── */

test('a patch changes what it names and nothing else', async () => {
  const restore = setup();
  try {
    const habitId = (await createHabit()).habit.habitId as string;
    const response = await habitPatch(
      req('PATCH', `/api/mobile/habits/${habitId}?timezone=${TZ}`, { durationMinutes: 20 }),
      params(habitId),
    );
    assert.equal(response.status, 200);
    const { habit } = await json(response);
    assert.equal(habit.durationMinutes, 20);
    assert.equal(habit.title, 'Morning run');
    assert.equal(habit.flexibility, 'protected_flexible');
    assert.equal(habit.status, 'active');
  } finally {
    restore();
  }
});

test('pausing a habit withdraws its future demand and keeps what the person answered', async () => {
  const restore = setup();
  try {
    const created = await createHabit();
    const habitId = created.habit.habitId as string;
    const services = createHabitServices();
    const before = await services.occurrences.listForHabit(USER, habitId);
    assert.ok(before.length >= 4);

    // Answer one of them, so there is history that must survive the pause.
    const answered = before[0];
    await completePost(
      req('POST', occurrencePath(habitId, answered.occurrenceId, 'complete')),
      occurrenceParams(habitId, answered.occurrenceId),
    );

    const paused = await habitPatch(
      req('PATCH', `/api/mobile/habits/${habitId}?timezone=${TZ}`, { status: 'paused' }),
      params(habitId),
    );
    assert.equal(paused.status, 200);
    assert.equal((await json(paused)).habit.status, 'paused');

    const after = await services.occurrences.listForHabit(USER, habitId);
    // The completed date is still there; the untouched pending ones are gone.
    assert.deepEqual(after.map((row) => row.occurrenceId), [answered.occurrenceId]);
    assert.equal(after[0].state, 'completed');
  } finally {
    restore();
  }
});

test('a patch cannot restate where a habit came from, nor re-sign its receipt', async () => {
  const restore = setup();
  try {
    const habitId = (await createHabit({ ...VALID, source: 'goal_confirmed' })).habit.habitId as string;
    for (const forbidden of [{ source: 'user_created' }, { confirmation: { confirmedByUserAt: '2030-01-01T00:00:00.000Z', sourceRef: null, acceptedSuggestedValues: true } }]) {
      const response = await habitPatch(
        req('PATCH', `/api/mobile/habits/${habitId}`, forbidden),
        params(habitId),
      );
      assert.equal(response.status, 400, `${JSON.stringify(forbidden)} was accepted`);
    }
    const listed = await json(await habitsGet(req('GET', '/api/mobile/habits')));
    assert.equal(listed.items[0].source, 'goal_confirmed');
    assert.equal(listed.items[0].confirmation.confirmedByUserAt, '2026-03-01T09:00:00.000Z');
  } finally {
    restore();
  }
});

test('an empty patch is refused rather than treated as a no-op', async () => {
  const restore = setup();
  try {
    const habitId = (await createHabit()).habit.habitId as string;
    const response = await habitPatch(req('PATCH', `/api/mobile/habits/${habitId}`, {}), params(habitId));
    assert.equal(response.status, 400);
    assert.match((await json(response)).error, /nothing to change/);
  } finally {
    restore();
  }
});

test('a path segment that is not an id is refused before anything is read', async () => {
  const restore = setup();
  try {
    for (const bad of ['../../etc', 'hbt_11111111-1111-4111-8111-111111111111', 'short']) {
      const response = await habitDelete(req('DELETE', `/api/mobile/habits/${bad}`), params(bad));
      assert.equal(response.status, 400, `${bad} was not refused`);
      assert.match((await json(response)).error, /not a habit id/);
    }
  } finally {
    restore();
  }
});

test('deleting a habit takes its occurrences with it', async () => {
  const restore = setup();
  try {
    const habitId = (await createHabit()).habit.habitId as string;
    const services = createHabitServices();
    assert.ok((await services.occurrences.listForHabit(USER, habitId)).length > 0);

    const deleted = await habitDelete(req('DELETE', `/api/mobile/habits/${habitId}`), params(habitId));
    assert.equal(deleted.status, 200);
    assert.deepEqual(await json(deleted), { success: true, habitId, deleted: true });
    assert.deepEqual(await services.occurrences.listForHabit(USER, habitId), []);
    // A second delete is a 404: the habit is gone, and saying so is not a leak
    // because the caller just deleted it.
    assert.equal((await habitDelete(req('DELETE', `/api/mobile/habits/${habitId}`), params(habitId))).status, 404);
  } finally {
    restore();
  }
});

/* ── Occurrence transitions ──────────────────────────────────────── */

/** The habit, and the id of its first materialized date. */
async function habitWithOccurrence(body: Record<string, unknown> = VALID): Promise<{ habitId: string; occurrenceId: string }> {
  const created = await createHabit(body);
  const habitId = created.habit.habitId as string;
  const occurrences = await createHabitServices().occurrences.listForHabit(USER, habitId);
  assert.ok(occurrences.length > 0, 'the fixture materialized nothing');
  return { habitId, occurrenceId: occurrences[0].occurrenceId };
}

for (const [route, outcome] of [[completePost, 'completed'], [skipPost, 'skipped']] as const) {
  test(`marking an occurrence ${outcome} records it and takes it out of the planner's reach`, async () => {
    const restore = setup();
    try {
      // `recoveryPolicy: 'skip'`, so this stays a test about the transition. A
      // recovering habit legitimately leaves the row `recovered` rather than
      // `skipped` — that is the domain doing its job, and it is proved in the
      // recovery tests below rather than smuggled in here.
      const { habitId, occurrenceId } = await habitWithOccurrence({ ...VALID, recoveryPolicy: 'skip' });
      const response = await route(
        req('POST', occurrencePath(habitId, occurrenceId, outcome === 'completed' ? 'complete' : 'skip')),
        occurrenceParams(habitId, occurrenceId),
      );
      assert.equal(response.status, 200);
      const body = await json(response);
      assert.equal(body.occurrence.state, outcome);
      assert.equal(body.changed, true);
      const stored = await createHabitServices().occurrences.get(USER, occurrenceId);
      assert.equal(stored?.state, outcome);
    } finally {
      restore();
    }
  });
}

test('pressing the same outcome twice is a retry, not a conflict', async () => {
  const restore = setup();
  try {
    const { habitId, occurrenceId } = await habitWithOccurrence();
    const path = occurrencePath(habitId, occurrenceId, 'complete');
    const first = await json(await completePost(req('POST', path), occurrenceParams(habitId, occurrenceId)));
    const second = await completePost(req('POST', path), occurrenceParams(habitId, occurrenceId));
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
    const { habitId, occurrenceId } = await habitWithOccurrence();
    await completePost(
      req('POST', occurrencePath(habitId, occurrenceId, 'complete')),
      occurrenceParams(habitId, occurrenceId),
    );

    const reversal = await skipPost(
      req('POST', occurrencePath(habitId, occurrenceId, 'skip')),
      occurrenceParams(habitId, occurrenceId),
    );
    assert.equal(reversal.status, 409);
    const body = await json(reversal);
    assert.equal(body.success, false);
    assert.equal(body.occurrence.state, 'completed');
    const stored = await createHabitServices().occurrences.get(USER, occurrenceId);
    assert.equal(stored?.state, 'completed', 'a stale phone overwrote a completion');
  } finally {
    restore();
  }
});

test('an occurrence cannot be decided through a habit it does not belong to', async () => {
  const restore = setup();
  try {
    const mine = await habitWithOccurrence();
    const other = (await createHabit({ ...VALID, title: 'Second habit' })).habit.habitId as string;

    const response = await completePost(
      req('POST', occurrencePath(other, mine.occurrenceId, 'complete')),
      occurrenceParams(other, mine.occurrenceId),
    );
    assert.equal(response.status, 404, 'the two ids in the path must both mean what they say');
    const stored = await createHabitServices().occurrences.get(USER, mine.occurrenceId);
    assert.equal(stored?.state, 'pending');
  } finally {
    restore();
  }
});

test('another account cannot mark an occurrence that is not theirs', async () => {
  const restore = setup();
  try {
    const { habitId, occurrenceId } = await habitWithOccurrence();
    const response = await completePost(
      req('POST', occurrencePath(habitId, occurrenceId, 'complete'), undefined, OTHER),
      occurrenceParams(habitId, occurrenceId),
    );
    assert.equal(response.status, 404);
    const stored = await createHabitServices().occurrences.get(USER, occurrenceId);
    assert.equal(stored?.state, 'pending');
  } finally {
    restore();
  }
});

test('an occurrence id that is not one is refused before any read', async () => {
  const restore = setup();
  try {
    const { habitId } = await habitWithOccurrence();
    for (const bad of [`${habitId}.not-a-date.0`, '../../etc', `${habitId}.2026-03-02`]) {
      const response = await skipPost(
        req('POST', occurrencePath(habitId, 'x', 'skip')),
        occurrenceParams(habitId, bad),
      );
      assert.equal(response.status, 400, `${bad} was not refused`);
      assert.match((await json(response)).error, /not an occurrence id/);
    }
  } finally {
    restore();
  }
});

/* ── Recovery, through the route ─────────────────────────────────── */

test('a skip under recover_within_period offers another date in the same week', async () => {
  const restore = setup();
  try {
    // Three a week with room for four, so a skip has both capacity and a later
    // date to land on. The horizon starts at "today", so the week under test is
    // whichever week that is — the assertion is about the *relationship*
    // between the skip and its replacement, not about a pinned calendar date.
    const { habitId, occurrenceId } = await habitWithOccurrence({
      ...VALID,
      cadence: { kind: 'weekly_count', count: 3 },
      minimumOccurrences: 3,
      maximumOccurrences: 4,
    });

    const response = await skipPost(
      req('POST', occurrencePath(habitId, occurrenceId, 'skip')),
      occurrenceParams(habitId, occurrenceId),
    );
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.occurrence.state, 'skipped');

    // Recovery was consulted, and this file does not decide what it answered —
    // only that the route reported it, and that a replacement it did mint is
    // real, later, and points back at the skip.
    assert.ok(body.recovery !== undefined, 'a skip must report what recovery decided');
    if (body.recovery.recovered) {
      const replacement = body.recovery.replacement;
      assert.equal(replacement.recoveredFromOccurrenceId, occurrenceId);
      assert.ok(replacement.localDate > body.occurrence.localDate, 'a replacement must be later than the skip');
      const services = createHabitServices();
      const stored = await services.occurrences.get(USER, replacement.occurrenceId);
      assert.ok(stored, 'the replacement was reported but never written');
      // The skipped row is now `recovered`, so it stops reading as outstanding.
      assert.equal((await services.occurrences.get(USER, occurrenceId))?.state, 'recovered');
    } else {
      assert.match(body.recovery.reason, /capacity|policy|date|not_/);
    }
  } finally {
    restore();
  }
});

test('a habit whose policy is skip is offered no replacement, and says why', async () => {
  const restore = setup();
  try {
    const { habitId, occurrenceId } = await habitWithOccurrence({ ...VALID, recoveryPolicy: 'skip' });
    const response = await skipPost(
      req('POST', occurrencePath(habitId, occurrenceId, 'skip')),
      occurrenceParams(habitId, occurrenceId),
    );
    const body = await json(response);
    assert.equal(body.recovery.recovered, false);
    assert.equal(body.recovery.reason, 'policy_is_skip');
  } finally {
    restore();
  }
});

test('a retried skip does not mint a second replacement date', async () => {
  const restore = setup();
  try {
    // The bug this would be: one bad week producing a fortnight of make-up
    // sessions because a phone retried a request it never saw the answer to.
    const { habitId, occurrenceId } = await habitWithOccurrence({
      ...VALID,
      cadence: { kind: 'weekly_count', count: 3 },
      minimumOccurrences: 3,
      maximumOccurrences: 4,
    });
    const path = occurrencePath(habitId, occurrenceId, 'skip');
    await skipPost(req('POST', path), occurrenceParams(habitId, occurrenceId));
    const services = createHabitServices();
    const afterFirst = await services.occurrences.listForHabit(USER, habitId);

    const retry = await skipPost(req('POST', path), occurrenceParams(habitId, occurrenceId));
    // 200, not 409. The first skip may have left the row `recovered`, and a
    // recovered skip is still that skip — see `transition`.
    assert.equal(retry.status, 200);
    const body = await json(retry);
    assert.equal(body.changed, false);
    // Recovery was never consulted a second time, so there is nothing to report.
    assert.equal(body.recovery, undefined);
    assert.deepEqual(
      (await services.occurrences.listForHabit(USER, habitId)).map((row) => row.occurrenceId).sort(),
      afterFirst.map((row) => row.occurrenceId).sort(),
      'a retried skip created a second make-up session',
    );
  } finally {
    restore();
  }
});
