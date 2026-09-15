/**
 * Where a commitment lives when it is not on a future day (#383, #384).
 *
 * ── One rule, two functions ──────────────────────────────────────
 *
 * `listTodayRanked` and `listUpcomingRanked` are two answers to one question,
 * and they used to answer it with two independent filters — `=== today` and
 * `> today`. Two filters over one set leave a gap, and everything that fell in
 * the gap existed on the server and appeared on no screen:
 *
 *   #383 — an active commitment dated *yesterday* matched neither. A device run
 *          watched seven of them vanish at midnight.
 *   #384 — an *undated* commitment matched Upcoming never, correctly, and Today
 *          only when the `priority` module runtime happened to be enabled.
 *          Staging's is not, so "Buy milk" never reached a phone at all — the
 *          exact defect #169 closed, alive again under a config flag.
 *
 * The rule both functions now implement is one sentence, stated in
 * `commitmentService.ts` and asserted here: **live work that is not on a later
 * day belongs to Today.** One function decides, and each list is that function
 * read once, so "at most one list" holds because a function returns one value.
 * `every live commitment is on exactly one list` below is the other half,
 * asserted at every offset from the clock.
 *
 * Two limits on that claim, both stated rather than implied. It is about *live*
 * work — `active`, `deferred`, `missed`: something settled is on the day it
 * happened and on no other, because rolling every visible status forward would
 * make Today accumulate the user's whole finished history. And it holds within
 * one request: Today and Upcoming are two GETs that each resolve their own
 * `now`, so a pair straddling local midnight can still miss or double-count a
 * commitment. See `placeInList`.
 *
 * ── It is the planner's rule too ─────────────────────────────────
 *
 * `buildDailyPlan` decided the day comparison first (#194, merged):
 * `rollsIntoDay` calls an instant behind the day being planned "yesterday's
 * work" and rolls it forward. `the list rule and the planner rule are the same
 * rule` proves the two formulations — a day-key comparison here, an epoch
 * comparison there — agree instant for instant in five zones, and drives the
 * shipped lists across each zone's own midnight.
 *
 * They are the same rule on that axis and not on every axis, so
 * `where the list rule and the planner rule differ, they differ in named ways`
 * pins the two places they part: the planner's plannable statuses are a strict
 * subset of the ones that roll forward, and the planner takes an undated
 * commitment only when the user marked it.
 *
 * ── Nothing here reads the wall clock ────────────────────────────
 *
 * `NOW` is the clock this test controls and hands to the service; every seeded
 * instant is arithmetic on it and every expected day key is computed with
 * `localDayKey`, never typed out. A date literal in a fixture is what rotted
 * CI in #382 once the day passed it. The one literal date below is a DST
 * transition, which is a property of a timezone and not of today.
 *
 * The zones are deliberately ones no developer machine and no CI host is set
 * to. A timezone test elsewhere in this repo passed against a conversion that
 * was plainly broken, because the zone it mocked happened to match the host's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import type { Commitment } from '../../src/domain/stateMachine.ts';
import { listTodayRanked, listUpcomingRanked } from '../../lib/services/mobile/commitmentService.ts';
import { localDayKey } from '../../lib/services/mobile/time.ts';
import { belongsToDay, dayHorizon, isPlannable, rollsIntoDay } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { uidFor } from '../support/fakeAuth.ts';

const UID = uidFor('ListBoundaryUser');

/** UTC+14. Nothing is set to it, and it is a day ahead of every CI host. */
const TZ = 'Pacific/Kiritimati';

/**
 * The test's own clock. It is handed to the service as `now`; nothing compares
 * it to the real one, so no passing day can turn this file red.
 */
const NOW = new Date('2026-09-13T09:00:00.000Z');
const HOUR_MS = 60 * 60 * 1_000;

const TODAY_KEY = localDayKey(NOW, TZ);

function at(hoursFromNow: number): string {
  return new Date(NOW.getTime() + hoursFromNow * HOUR_MS).toISOString();
}

function commitment(
  id: string,
  resolvedTime: string | null,
  status: Commitment['status'] = 'active',
  completedAt: string | null = null,
): Commitment {
  return {
    id,
    kind: 'task',
    title: id,
    description: null,
    person: null,
    status,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: {
      kind: resolvedTime === null ? 'unscheduled' : 'due_by',
      dueAt: resolvedTime,
      remindAt: resolvedTime,
      timezone: TZ,
    },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: at(-1_000),
    updatedAt: at(-1_000),
    confirmedAt: at(-1_000),
    completedAt,
    droppedAt: null,
  } as Commitment;
}

async function seed(commitments: Commitment[]): Promise<void> {
  setStorageForTests(createMemoryStorage());
  const state = createEmptyDomainState();
  for (const item of commitments) state.commitments[item.id] = item;
  await persistParticipantState(UID, state);
}

/**
 * Which list one commitment lands on, asked of the service rather than of a
 * copy of its rule. Seeding is per-call because these are single-item questions.
 */
async function placementFor(subject: Commitment): Promise<'today' | 'upcoming' | null> {
  await seed([subject]);
  const today = (await listTodayRanked({ participantId: UID, timezone: TZ, now: NOW })).items;
  const upcoming = (await listUpcomingRanked({ participantId: UID, timezone: TZ, now: NOW })).items;
  assert.ok(today.length + upcoming.length <= 1, `${subject.id} reached both lists`);
  if (today.length === 1) return 'today';
  if (upcoming.length === 1) return 'upcoming';
  return null;
}

async function ids(list: 'today' | 'upcoming'): Promise<string[]> {
  const ranked = list === 'today'
    ? await listTodayRanked({ participantId: UID, timezone: TZ, now: NOW })
    : await listUpcomingRanked({ participantId: UID, timezone: TZ, now: NOW });
  return ranked.items.map((item) => item.id);
}

/**
 * Both runtimes, every time.
 *
 * `MAYBESITTER_FEATURE_PRIORITY` decides the *order* of a list, and #384 is the
 * defect of having let it decide the *membership* as well. Every membership
 * assertion below therefore runs under both settings, which is the only way to
 * state that the flag no longer reaches this question. `false` is also the
 * default and is what staging runs.
 */
async function underBothRuntimes(body: () => Promise<void>): Promise<void> {
  const previous = process.env.MAYBESITTER_FEATURE_PRIORITY;
  try {
    for (const flag of ['false', 'true']) {
      process.env.MAYBESITTER_FEATURE_PRIORITY = flag;
      await body();
    }
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_FEATURE_PRIORITY;
    else process.env.MAYBESITTER_FEATURE_PRIORITY = previous;
    resetStorageForTests();
  }
}

test('#383: an active commitment dated yesterday is on Today', async () => {
  await underBothRuntimes(async () => {
    // 30 hours back is a previous local day in this zone, and the assertion
    // says so rather than trusting the arithmetic.
    const yesterday = at(-30);
    assert.ok(localDayKey(yesterday, TZ) < TODAY_KEY, 'the fixture is not actually behind today');
    await seed([commitment('yesterday', yesterday), commitment('today', at(-1))]);
    assert.deepEqual((await ids('today')).sort(), ['today', 'yesterday']);
  });
});

test('#383: a past-dated commitment is never on Upcoming', async () => {
  await underBothRuntimes(async () => {
    await seed([commitment('yesterday', at(-30)), commitment('later', at(48))]);
    assert.deepEqual(await ids('upcoming'), ['later']);
  });
});

test('#384: an undated commitment is on Today whatever the priority runtime says', async () => {
  await underBothRuntimes(async () => {
    await seed([commitment('milk', null)]);
    assert.deepEqual(await ids('today'), ['milk'], '"Buy milk" never reached a phone (#169)');
  });
});

test('#384: an undated commitment is never on Upcoming', async () => {
  await underBothRuntimes(async () => {
    await seed([commitment('milk', null), commitment('later', at(48))]);
    // Upcoming means a later day. An undated item has no later day to be on.
    assert.deepEqual(await ids('upcoming'), ['later']);
  });
});

test('every live commitment is on exactly one list, at every offset from the clock', async () => {
  // Hours around the clock, chosen to straddle both the local midnight behind
  // `NOW` and the one ahead of it. In this zone `NOW` sits late in the local
  // day, so +2 hours is already tomorrow — which is the case a UTC-shaped test
  // would never produce.
  const OFFSETS = [-8_760, -49, -30, -25, -14, -2, -0.5, 0.5, 2, 12, 25, 49, 8_760];

  await underBothRuntimes(async () => {
    const dated = OFFSETS.map((offset, index) => commitment(`h${index}`, at(offset)));
    await seed([...dated, commitment('undated', null)]);

    const today = new Set(await ids('today'));
    const upcoming = new Set(await ids('upcoming'));

    for (let index = 0; index < OFFSETS.length; index += 1) {
      const offset = OFFSETS[index]!;
      const id = `h${index}`;
      const later = localDayKey(at(offset), TZ) > TODAY_KEY;
      assert.equal(today.has(id), !later, `${id} (${offset}h) is on Today when it should not be, or is not when it should`);
      assert.equal(upcoming.has(id), later, `${id} (${offset}h) is on Upcoming when it should not be, or is not when it should`);
    }
    assert.ok(today.has('undated'), 'an undated commitment fell out of both lists');
    assert.ok(!upcoming.has('undated'), 'an undated commitment reached Upcoming');
    assert.equal(today.size + upcoming.size, OFFSETS.length + 1, 'the two lists overlap or leak');
  });
});

test('the roll-forward is live work only, so Today does not accumulate a lifetime', async () => {
  // The rule applied to everything visible would turn #383's vanishing bug into
  // an accumulating one on the same screen: `completed` is terminal — no
  // command in the state machine reaches `archived` — and the list route has no
  // cap, so Today would gain a row for every commitment the user ever finished.
  // `model.ts` draws `missed` and every status it has no mapping for as a live
  // card, so a year-old abandoned draft would sit in Must for ever.
  await underBothRuntimes(async () => {
    const lastYear = at(-24 * 365);
    await seed([
      commitment('active-today', at(-1)),
      commitment('active-last-year', lastYear),
      commitment('deferred-last-year', lastYear, 'deferred'),
      commitment('missed-last-year', lastYear, 'missed'),
      commitment('completed-last-year', lastYear, 'completed', lastYear),
      commitment('draft-last-year', lastYear, 'draft'),
      commitment('clarify-last-year', lastYear, 'needs_clarification'),
      commitment('pending-last-year', lastYear, 'pending_confirmation'),
    ]);
    assert.deepEqual((await ids('today')).sort(), [
      'active-last-year', 'active-today', 'deferred-last-year', 'missed-last-year',
    ]);
    assert.deepEqual(await ids('upcoming'), []);
  });
});

test('something finished today is on today, and leaves when the day does', async () => {
  // Which is what the Finished group on Today is for — "the day happened". The
  // day it happened on is `completedAt`, not the day it was once due: a
  // commitment due yesterday and ticked off this morning is this morning's.
  await underBothRuntimes(async () => {
    await seed([
      commitment('done-today', at(-30), 'completed', at(-1)),
      commitment('done-yesterday', at(-1), 'completed', at(-30)),
    ]);
    assert.deepEqual(await ids('today'), ['done-today']);
    assert.deepEqual(await ids('upcoming'), []);
  });
});

test('an unconfirmed capture keeps exactly the days it had before this change', async () => {
  // Nothing was committed to, so it does not roll forward. Stated day only —
  // which is the behaviour `=== today` and `> today` already gave it, preserved
  // deliberately rather than by accident. Whether a week-old capture should
  // resurface is a product question nobody has been asked.
  await underBothRuntimes(async () => {
    await seed([
      commitment('capture-today', at(-1), 'pending_confirmation'),
      commitment('capture-later', at(48), 'pending_confirmation'),
      commitment('capture-stale', at(-30), 'pending_confirmation'),
    ]);
    assert.deepEqual(await ids('today'), ['capture-today']);
    assert.deepEqual(await ids('upcoming'), ['capture-later']);
  });
});

test('the only commitments on neither list are the ones the user closed on purpose', async () => {
  await underBothRuntimes(async () => {
    // The partition above is over *visible* commitments. This is what that word
    // excludes, and it is a deliberate exclusion rather than a gap: dropping
    // something on purpose is a first-class outcome in this product, and an
    // archived item is gone. Everything else live is on a list.
    //
    // `dropped-next-tuesday` is the case that matters and the one an earlier
    // version of this test missed: it seeded only a past `dropped` and an
    // undated `archived`, neither of which is on a *later* day, so deleting the
    // visibility guard from the Upcoming half left the whole suite green. A
    // commitment the user dropped on purpose must not come back on Upcoming.
    await seed([
      commitment('dropped-yesterday', at(-30), 'dropped'),
      commitment('dropped-next-tuesday', at(24 * 6), 'dropped'),
      commitment('archived-undated', null, 'archived'),
      commitment('archived-next-tuesday', at(24 * 6), 'archived'),
    ]);
    assert.deepEqual(await ids('today'), []);
    assert.deepEqual(await ids('upcoming'), []);
  });
});

test('the list rule and the planner rule are the same rule', async () => {
  // `buildDailyPlan.rollsIntoDay` is #383's other half, already merged (#194).
  // It compares epochs against the start of the day being planned; the lists
  // compare local day keys. Two spellings of one rule is how two behaviours
  // start, so the two are asked the same question here, including at the
  // millisecond the day turns.
  const CASES: Array<{ timezone: string; date: string; why: string }> = [
    { timezone: TZ, date: TODAY_KEY, why: 'UTC+14' },
    { timezone: 'Pacific/Niue', date: TODAY_KEY, why: 'UTC-11' },
    { timezone: 'Asia/Kathmandu', date: TODAY_KEY, why: 'a 45-minute offset' },
    { timezone: 'Australia/Lord_Howe', date: TODAY_KEY, why: 'a half-hour DST shift' },
    // The one date literal in this file, and it is not a clock: Chile moves its
    // clock at midnight, so local 00:00 on this date does not exist and the day
    // starts at 01:00. Both sides derive it from the same tzdata, so the
    // equality holds however the rules are amended.
    { timezone: 'America/Santiago', date: '2026-09-06', why: 'a day with no local midnight' },
  ];

  // Around the turn of the day, not around `NOW`: the boundary is the only
  // place the two formulations could disagree.
  const DELTAS_MS = [-30 * 24 * HOUR_MS, -HOUR_MS, -1, 0, 1, HOUR_MS, 30 * 24 * HOUR_MS];

  for (const { timezone, date, why } of CASES) {
    const { startsAt } = dayHorizon(date, timezone);
    for (const delta of DELTAS_MS) {
      const instant = new Date(Date.parse(startsAt) + delta).toISOString();
      const listSaysItRollsIn = localDayKey(instant, timezone) < date;
      const plannerSaysItRollsIn = rollsIntoDay(instant, startsAt);
      assert.equal(
        listSaysItRollsIn,
        plannerSaysItRollsIn,
        `${timezone} (${why}) at ${delta}ms from the start of ${date}: the lists say ${listSaysItRollsIn}, the planner says ${plannerSaysItRollsIn}`,
      );
    }
  }

  // And the lists are asked it too, in every one of those zones, at the
  // millisecond the day turns — so this is a statement about the shipped rule
  // and not about two helpers that happen to agree. `before` is one millisecond
  // behind local midnight, which `rollsIntoDay` calls yesterday's work; `after`
  // is one millisecond past it. Both must be on Today, and neither on Upcoming.
  //
  // `America/Santiago` is asked on its own DST date, so the service is driven
  // on a day whose local midnight does not exist. `now` is midnight plus twelve
  // hours there, which is that day in that zone whatever the date literal above
  // turns into.
  for (const { timezone, date, why } of CASES) {
    const midnightMs = Date.parse(dayHorizon(date, timezone).startsAt);
    const before = new Date(midnightMs - 1).toISOString();
    const after = new Date(midnightMs + 1).toISOString();
    const noon = new Date(midnightMs + 12 * HOUR_MS);

    await underBothRuntimes(async () => {
      await seed([commitment('before-midnight', before), commitment('after-midnight', after)]);
      const today = (await listTodayRanked({ participantId: UID, timezone, now: noon })).items.map((i) => i.id);
      const upcoming = (await listUpcomingRanked({ participantId: UID, timezone, now: noon })).items.map((i) => i.id);
      assert.deepEqual([...today].sort(), ['after-midnight', 'before-midnight'], `${timezone} (${why}) lost an item across its own midnight`);
      assert.deepEqual(upcoming, [], `${timezone} (${why}) put today's work on Upcoming`);
    });
  }
});

test('where the list rule and the planner rule differ, they differ in named ways', async () => {
  // The claim above is about the day comparison, and only about it. These are
  // the two axes on which the two rules are *not* the same, asserted so that a
  // third one cannot appear quietly.

  // Membership. `isPlannable` is a strict subset of the statuses that roll
  // forward, which is the direction #383 cared about: nothing can be in the
  // plan and missing from Today. The single difference is `missed`, which no
  // command in `stateMachine.ts` assigns.
  const ALL: Commitment['status'][] = [
    'draft', 'needs_clarification', 'pending_confirmation',
    'active', 'deferred', 'completed', 'dropped', 'missed', 'archived',
  ];
  const plannable = ALL.filter((status) => isPlannable(commitment('x', null, status)));
  const rollsForward: Commitment['status'][] = [];
  for (const status of ALL) {
    // Dated a year back: only a status that rolls forward is on Today then.
    if (await placementFor(commitment('x', at(-24 * 365), status)) === 'today') rollsForward.push(status);
  }
  assert.deepEqual(plannable, ['active', 'deferred']);
  assert.deepEqual(rollsForward, ['active', 'deferred', 'missed']);
  for (const status of plannable) {
    assert.ok(rollsForward.includes(status), `${status} is plannable but does not reach Today`);
  }
  assert.deepEqual(rollsForward.filter((s) => !plannable.includes(s)), ['missed']);

  // Undated items. Every undated live commitment is on Today; the planner takes
  // one only when the user has said it matters, because a plan is what fits in
  // a day and a list is not a plan. So a low-importance undated commitment is
  // on Today and not in the plan, deliberately.
  const undatedLow = { ...commitment('low', null), priority: { level: 'low', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } } as Commitment;
  const dayEndsAt = dayHorizon(TODAY_KEY, TZ).endsAt;
  assert.equal(await placementFor(undatedLow), 'today');
  assert.equal(belongsToDay(undatedLow, dayEndsAt), false);
  // And an undated commitment the user did mark is on both.
  const undatedMust = { ...commitment('must', null), priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } } as Commitment;
  assert.equal(await placementFor(undatedMust), 'today');
  assert.equal(belongsToDay(undatedMust, dayEndsAt), true);
  resetStorageForTests();
});

/**
 * The order two tied commitments come back in.
 *
 * `sortByResolvedTime` used to promise a tie-break of its own. It cannot keep
 * one: `participantState` lists a commitment per document and returns them by
 * id, so the array this sorts is already id-ordered and a comparator tie-break
 * is unreachable code. The promise was removed rather than asserted, and what
 * is left is the half a user can actually observe — the same two commitments
 * come back in the same order however they were written.
 */
test('two undated commitments come back in the same order on every read', async () => {
  const previous = process.env.MAYBESITTER_FEATURE_PRIORITY;
  process.env.MAYBESITTER_FEATURE_PRIORITY = 'false';
  try {
    await seed([commitment('b-milk', null), commitment('a-bread', null)]);
    const first = await ids('today');
    await seed([commitment('a-bread', null), commitment('b-milk', null)]);
    assert.deepEqual(await ids('today'), first, 'the list reordered itself between two reads of the same data');
    assert.deepEqual(first, ['a-bread', 'b-milk']);
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_FEATURE_PRIORITY;
    else process.env.MAYBESITTER_FEATURE_PRIORITY = previous;
    resetStorageForTests();
  }
});

test('two commitments at the same instant come back in the same order on every read', async () => {
  const previous = process.env.MAYBESITTER_FEATURE_PRIORITY;
  process.env.MAYBESITTER_FEATURE_PRIORITY = 'false';
  try {
    // An hour back: `NOW` sits at 23:00 in this zone, so anything ahead of it
    // is tomorrow and would be answered by Upcoming instead.
    const same = at(-1);
    await seed([commitment('zulu', same), commitment('alpha', same)]);
    const first = await ids('today');
    await seed([commitment('alpha', same), commitment('zulu', same)]);
    assert.deepEqual(await ids('today'), first);
    assert.deepEqual(first, ['alpha', 'zulu']);
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_FEATURE_PRIORITY;
    else process.env.MAYBESITTER_FEATURE_PRIORITY = previous;
    resetStorageForTests();
  }
});
