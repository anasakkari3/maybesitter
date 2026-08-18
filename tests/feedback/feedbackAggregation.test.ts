/**
 * Behavioural tests for feedback aggregation (Sprint 03, issue #14).
 *
 * Four properties dominate, and each has a block below:
 *
 *  1. Determinism. Identical inputs must produce byte-identical output, so the
 *     assertions compare serialized JSON and key order as well as structure —
 *     deepEqual alone ignores key order, which is exactly where nondeterminism
 *     hides. Reordering the events array, or the keys inside an event, must
 *     change neither the digest nor the output.
 *
 *  2. Late events land where the behaviour happened. Windows key off
 *     `occurredAt`, never `recordedAt`, and every timestamp comparison is on
 *     instants rather than text: ISO strings carrying UTC offsets sort
 *     differently as text than they do in time, so the offset fixtures below
 *     are deliberately chosen to disagree under the two comparisons.
 *
 *  3. The user's corrections and the migration baseline stay visible.
 *     Revoked events leave every aggregate but are counted; the baseline
 *     reaches lifetime totals only, because it carries no per-event time and
 *     therefore cannot be placed in any window.
 *
 *  4. The global view is counts only. A cross-user aggregate must never become
 *     a way to read one user's history.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEEDBACK_OUTCOME_ORDER,
  aggregateFeedback,
  aggregateGlobalFeedback,
  canonicalizeFeedbackInput,
  computeFeedbackInputDigest,
  resolveFeedbackWindowDays,
} from '../../lib/feedback/feedbackAggregation.ts';
import {
  DEFAULT_FEEDBACK_WINDOW_DAYS,
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type FeedbackAggregationInput,
  type FeedbackBaseline,
  type FeedbackEvent,
} from '../../src/contracts/v1/feedbackContracts.ts';

const NOW = '2026-08-18T12:00:00.000Z';
const SCOPE = 'scope-1';
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
/** windowStart for the default 14-day window at NOW. */
const WINDOW_START = '2026-08-04T12:00:00.000Z';

function shift(fromIso: string, ms: number): string {
  return new Date(Date.parse(fromIso) + ms).toISOString();
}

function daysBefore(days: number): string {
  return shift(NOW, -days * MS_PER_DAY);
}

function hoursBefore(hours: number): string {
  return shift(NOW, -hours * 60 * 60 * 1_000);
}

function event(overrides: Partial<FeedbackEvent> & { id: string }): FeedbackEvent {
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId: SCOPE,
    outcome: 'accept',
    subjectId: `subject-${overrides.id}`,
    actor: 'user',
    source: 'mobile_action',
    occurredAt: hoursBefore(1),
    recordedAt: hoursBefore(1),
    idempotencyKey: `key-${overrides.id}`,
    ...overrides,
  };
}

function baseline(overrides: Partial<FeedbackBaseline> = {}): FeedbackBaseline {
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId: SCOPE,
    counters: {
      ignoredSuggestions: 0,
      completedActions: 0,
      delayedActions: 0,
      clarificationSuccesses: 0,
      clarificationFailures: 0,
    },
    lastUpdatedAt: null,
    timestampsUnavailable: true,
    migratedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function input(overrides: Partial<FeedbackAggregationInput> = {}): FeedbackAggregationInput {
  return { events: [], baseline: null, scopeId: SCOPE, now: NOW, ...overrides };
}

/* ── Determinism ────────────────────────────────────────────────── */

test('the same input aggregated twice is deeply equal, digest included', () => {
  const events = [
    event({ id: 'e1', outcome: 'accept', occurredAt: hoursBefore(2), recordedAt: hoursBefore(2) }),
    event({ id: 'e2', outcome: 'defer', occurredAt: daysBefore(3), recordedAt: daysBefore(3) }),
  ];

  const first = aggregateFeedback(input({ events }));
  const second = aggregateFeedback(input({ events }));

  assert.deepEqual(first, second);
  assert.equal(first.inputDigest, second.inputDigest);
  // Byte equality, not just structural: key order is part of determinism.
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('reordering the events array changes neither the digest nor the serialized output', () => {
  const events = [
    event({ id: 'e1', outcome: 'accept', occurredAt: daysBefore(1) }),
    event({ id: 'e2', outcome: 'complete', occurredAt: daysBefore(2) }),
    event({ id: 'e3', outcome: 'ignore', occurredAt: daysBefore(3) }),
    event({ id: 'e4', outcome: 'accept', occurredAt: daysBefore(4) }),
  ];
  const reversed = [...events].reverse();
  const shuffled = [events[2], events[0], events[3], events[1]];

  const base = aggregateFeedback(input({ events }));

  assert.equal(JSON.stringify(aggregateFeedback(input({ events: reversed }))), JSON.stringify(base));
  assert.equal(JSON.stringify(aggregateFeedback(input({ events: shuffled }))), JSON.stringify(base));
  assert.equal(aggregateFeedback(input({ events: reversed })).inputDigest, base.inputDigest);
  assert.equal(aggregateFeedback(input({ events: shuffled })).inputDigest, base.inputDigest);
});

test('events sharing an occurredAt still order deterministically regardless of arrival order', () => {
  // Sorting on time alone leaves ties, and Array#sort is stable — it preserves
  // arrival order for ties, which is precisely what reorder-invariance must not
  // depend on. The comparator therefore has to be total.
  const sameInstant = daysBefore(2);
  const a = event({ id: 'e-a', outcome: 'accept', occurredAt: sameInstant, recordedAt: sameInstant });
  const b = event({ id: 'e-b', outcome: 'reject', occurredAt: sameInstant, recordedAt: sameInstant });
  const c = event({ id: 'e-c', outcome: 'edit', occurredAt: sameInstant, recordedAt: sameInstant });

  const forward = aggregateFeedback(input({ events: [a, b, c] }));
  const backward = aggregateFeedback(input({ events: [c, b, a] }));

  assert.equal(forward.inputDigest, backward.inputDigest);
  assert.equal(JSON.stringify(forward), JSON.stringify(backward));
});

test('reordering keys inside an event changes neither the digest nor the output', () => {
  const written: FeedbackEvent = {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    id: 'e1',
    scopeId: SCOPE,
    outcome: 'complete',
    subjectId: 'subject-1',
    actor: 'user',
    source: 'mobile_action',
    occurredAt: daysBefore(1),
    recordedAt: daysBefore(1),
    idempotencyKey: 'key-1',
  };
  const shuffledKeys: FeedbackEvent = {
    idempotencyKey: 'key-1',
    recordedAt: daysBefore(1),
    occurredAt: daysBefore(1),
    source: 'mobile_action',
    actor: 'user',
    subjectId: 'subject-1',
    outcome: 'complete',
    scopeId: SCOPE,
    id: 'e1',
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
  };

  const fromWritten = aggregateFeedback(input({ events: [written] }));
  const fromShuffled = aggregateFeedback(input({ events: [shuffledKeys] }));

  assert.equal(fromWritten.inputDigest, fromShuffled.inputDigest);
  assert.equal(JSON.stringify(fromWritten), JSON.stringify(fromShuffled));
});

test('naive JSON.stringify would not have caught the key reordering the digest must survive', () => {
  // Guards the test above from going vacuous: if these two ever serialize
  // identically under JSON.stringify, the reorder fixture stopped exercising
  // anything and the canonicalization test proves nothing.
  const written = { id: 'e1', outcome: 'complete' };
  const shuffled = { outcome: 'complete', id: 'e1' };
  assert.notEqual(JSON.stringify(written), JSON.stringify(shuffled));
});

test('outcome counts are emitted in a frozen order, never encounter order', () => {
  // Encounter order would leak event arrival order into the serialized
  // aggregate, so two logs holding the same outcomes would not compare equal.
  const arrivalA = [
    event({ id: 'e1', outcome: 'undo', occurredAt: daysBefore(1) }),
    event({ id: 'e2', outcome: 'accept', occurredAt: daysBefore(2) }),
    event({ id: 'e3', outcome: 'ignore', occurredAt: daysBefore(3) }),
  ];
  const arrivalB = [arrivalA[1], arrivalA[2], arrivalA[0]];

  const a = aggregateFeedback(input({ events: arrivalA }));
  const b = aggregateFeedback(input({ events: arrivalB }));

  assert.deepEqual(Object.keys(a.windowed), ['accept', 'ignore', 'undo']);
  assert.deepEqual(Object.keys(a.windowed), Object.keys(b.windowed));
  // The frozen order is the contract's outcome order, not alphabetical accident.
  assert.deepEqual(
    [...FEEDBACK_OUTCOME_ORDER],
    ['accept', 'edit', 'reject', 'defer', 'complete', 'ignore', 'undo'],
  );
});

test('top-level aggregate keys are emitted in a fixed order', () => {
  const result = aggregateFeedback(input({ events: [event({ id: 'e1' })] }));
  assert.deepEqual(Object.keys(result), [
    'version',
    'scopeId',
    'computedAt',
    'inputDigest',
    'windowDays',
    'windowStart',
    'windowed',
    'lifetime',
    'includesMigrationBaseline',
    'revokedCount',
    'lateEventCount',
  ]);
});

test('computedAt comes from input.now and the clock is never read', () => {
  const past = '1999-12-31T23:59:59.000Z';
  const result = aggregateFeedback(input({ now: past, events: [] }));

  assert.equal(result.computedAt, past);
  assert.equal(result.windowStart, shift(past, -DEFAULT_FEEDBACK_WINDOW_DAYS * MS_PER_DAY));
  // A system-clock read would land in the present, decades after this `now`.
  assert.ok(Date.parse(result.computedAt) < Date.parse('2000-01-01T00:00:00.000Z'));
});

test('inputDigest is a sha256 hex string that changes when any input value changes', () => {
  const events = [event({ id: 'e1', occurredAt: daysBefore(1) })];
  const base = aggregateFeedback(input({ events }));

  assert.match(base.inputDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(base.inputDigest, aggregateFeedback(input({ events, now: shift(NOW, 1) })).inputDigest);
  assert.notEqual(base.inputDigest, aggregateFeedback(input({ events, windowDays: 7 })).inputDigest);
  assert.notEqual(
    base.inputDigest,
    aggregateFeedback(input({ events: [{ ...events[0], outcome: 'reject' }] })).inputDigest,
  );
  assert.notEqual(
    base.inputDigest,
    aggregateFeedback(input({ events, baseline: baseline() })).inputDigest,
  );
  // Two scopes with identical (empty) histories must not share a digest.
  assert.notEqual(
    aggregateFeedback(input({ events: [], scopeId: 'scope-1' })).inputDigest,
    aggregateFeedback(input({ events: [], scopeId: 'scope-2' })).inputDigest,
  );
});

test('the digest covers the resolved window, so omitting the default matches passing it', () => {
  // Otherwise two calls that must produce identical output would report a false
  // mismatch on replay purely because one spelled the default out.
  const events = [event({ id: 'e1', occurredAt: daysBefore(1) })];
  const omitted = aggregateFeedback(input({ events }));
  const explicit = aggregateFeedback(input({ events, windowDays: DEFAULT_FEEDBACK_WINDOW_DAYS }));

  assert.equal(omitted.inputDigest, explicit.inputDigest);
  assert.equal(JSON.stringify(omitted), JSON.stringify(explicit));
});

test('canonicalization is key-sorted, so the digest is reproducible outside the aggregator', () => {
  const events = [event({ id: 'e1', occurredAt: daysBefore(1) })];
  const resolved = {
    events,
    baseline: null,
    scopeId: SCOPE,
    now: NOW,
    windowDays: DEFAULT_FEEDBACK_WINDOW_DAYS,
  };

  assert.equal(computeFeedbackInputDigest(resolved), aggregateFeedback(input({ events })).inputDigest);
  const canonical = canonicalizeFeedbackInput(resolved);
  assert.ok(canonical.startsWith('{"baseline":null,"events"'), `keys should be sorted, got ${canonical.slice(0, 40)}`);
});

test('aggregation does not mutate the caller\'s event array', () => {
  // Raw history is authoritative; an aggregate that sorts its caller's log in
  // place would quietly rewrite the thing it reads.
  const events = [
    event({ id: 'e2', occurredAt: daysBefore(1) }),
    event({ id: 'e1', occurredAt: daysBefore(5) }),
  ];
  const frozen = Object.freeze([...events]);

  aggregateFeedback(input({ events: frozen }));

  assert.deepEqual(frozen.map((e) => e.id), ['e2', 'e1']);
});

/* ── Windows and late events ────────────────────────────────────── */

test('windows key off occurredAt, never recordedAt', () => {
  const events = [
    // Behaved inside the window, stored after `now`: still belongs to the window.
    event({ id: 'late-arrival', outcome: 'complete', occurredAt: daysBefore(2), recordedAt: NOW }),
    // Behaved long before the window, stored inside it: must not enter the window.
    event({ id: 'old-behaviour', outcome: 'reject', occurredAt: daysBefore(40), recordedAt: hoursBefore(1) }),
  ];

  const result = aggregateFeedback(input({ events }));

  assert.deepEqual(result.windowed, { complete: 1 });
  assert.deepEqual(result.lifetime, { reject: 1, complete: 1 });
});

test('lateEventCount reports events recorded in a later window than they occurred', () => {
  const events = [
    // Occurred 30 days ago (two windows back), recorded now: late.
    event({ id: 'late', outcome: 'ignore', occurredAt: daysBefore(30), recordedAt: NOW }),
    // Occurred and recorded inside the same window: on time.
    event({ id: 'prompt', outcome: 'accept', occurredAt: daysBefore(2), recordedAt: daysBefore(2) }),
    // Occurred 13 days ago, recorded an hour later: still the same window.
    event({ id: 'slow-but-same-window', outcome: 'defer', occurredAt: daysBefore(13), recordedAt: shift(daysBefore(13), 3_600_000) }),
  ];

  const result = aggregateFeedback(input({ events }));

  assert.equal(result.lateEventCount, 1);
  assert.deepEqual(result.windowed, { accept: 1, defer: 1 });
  assert.deepEqual(result.lifetime, { accept: 1, defer: 1, ignore: 1 });
});

test('lateness is measured on instants, so an offset spelling cannot fake or hide it', () => {
  // recordedAt is one hour after occurredAt in real time, but sorts *earlier*
  // as text. A text comparison would either miss the lateness or invent it.
  const events = [
    event({
      id: 'offset',
      outcome: 'accept',
      occurredAt: '2026-08-17T09:00:00.000Z',
      recordedAt: '2026-08-17T05:00:00.000-05:00',
    }),
  ];

  const result = aggregateFeedback(input({ events }));

  assert.equal(result.lateEventCount, 0);
  assert.deepEqual(result.windowed, { accept: 1 });
});

test('window membership is decided on instants, not on timestamp text', () => {
  // With windowStart = 2026-08-04T12:00:00.000Z:
  //  - `text-inside` reads as later than windowStart as text, but its instant
  //    (2026-08-04T08:00Z) is before it, so it is outside the window.
  //  - `text-outside` reads as earlier as text, but its instant
  //    (2026-08-04T16:00Z) is inside the window.
  const events = [
    event({ id: 'text-inside', outcome: 'reject', occurredAt: '2026-08-04T13:00:00.000+05:00', recordedAt: NOW }),
    event({ id: 'text-outside', outcome: 'accept', occurredAt: '2026-08-04T11:00:00.000-05:00', recordedAt: NOW }),
  ];

  const result = aggregateFeedback(input({ events }));

  assert.equal(result.windowStart, WINDOW_START);
  assert.deepEqual(result.windowed, { accept: 1 });
  assert.deepEqual(result.lifetime, { accept: 1, reject: 1 });
});

test('the window is closed at both ends: windowStart and now are both inside', () => {
  // Pinned decision: [windowStart, now] inclusive, matching
  // lib/lifeState/recentOutcomesView.ts. An event exactly on a boundary is a
  // real outcome and belongs to exactly one window; excluding either end would
  // silently drop it from every view.
  const events = [
    event({ id: 'at-start', outcome: 'accept', occurredAt: WINDOW_START, recordedAt: WINDOW_START }),
    event({ id: 'at-now', outcome: 'complete', occurredAt: NOW, recordedAt: NOW }),
    event({ id: 'just-before-start', outcome: 'reject', occurredAt: shift(WINDOW_START, -1), recordedAt: NOW }),
  ];

  const result = aggregateFeedback(input({ events }));

  assert.deepEqual(result.windowed, { accept: 1, complete: 1 });
  assert.deepEqual(result.lifetime, { accept: 1, reject: 1, complete: 1 });
});

test('an event occurring after now does not inflate the window', () => {
  // Clock skew on a device, or a caller replaying with an earlier `now`. The
  // event is real history, so it stays in lifetime; it just cannot be counted
  // in a window that has not reached it yet.
  const events = [
    event({ id: 'skewed', outcome: 'complete', occurredAt: shift(NOW, 60 * 60 * 1_000), recordedAt: NOW }),
    event({ id: 'normal', outcome: 'accept', occurredAt: hoursBefore(1), recordedAt: hoursBefore(1) }),
  ];

  const result = aggregateFeedback(input({ events }));

  assert.deepEqual(result.windowed, { accept: 1 });
  assert.deepEqual(result.lifetime, { accept: 1, complete: 1 });
});

test('windowDays defaults to the contract default and resolves hostile values', () => {
  assert.equal(aggregateFeedback(input()).windowDays, DEFAULT_FEEDBACK_WINDOW_DAYS);
  assert.equal(resolveFeedbackWindowDays(undefined), DEFAULT_FEEDBACK_WINDOW_DAYS);
  assert.equal(resolveFeedbackWindowDays(7), 7);
  assert.equal(resolveFeedbackWindowDays(7.9), 7);
  assert.equal(resolveFeedbackWindowDays(0), DEFAULT_FEEDBACK_WINDOW_DAYS);
  assert.equal(resolveFeedbackWindowDays(-3), DEFAULT_FEEDBACK_WINDOW_DAYS);
  assert.equal(resolveFeedbackWindowDays(Number.NaN), DEFAULT_FEEDBACK_WINDOW_DAYS);
  assert.equal(resolveFeedbackWindowDays(Number.POSITIVE_INFINITY), DEFAULT_FEEDBACK_WINDOW_DAYS);
  // A fractional window still has to mean at least one whole day, never zero.
  assert.equal(resolveFeedbackWindowDays(0.5), 1);
  // Clamped to the widest window that still has a representable start, and the
  // clamped value is what the aggregate reports — a caller must not be told the
  // window was 1e9 days when it was not.
  assert.equal(resolveFeedbackWindowDays(1e9), 100_000_000);
  assert.equal(resolveFeedbackWindowDays(Number.MAX_SAFE_INTEGER), 100_000_000);
  assert.equal(aggregateFeedback(input({ windowDays: 1e9 })).windowDays, 100_000_000);
});

test('an extreme window yields a representable windowStart instead of a bare RangeError', () => {
  // new Date(x).toISOString() throws a RangeError outside the ECMAScript time
  // range, from deep inside the aggregation and past every validation boundary
  // it presents to callers.
  for (const windowDays of [1e9, Number.MAX_SAFE_INTEGER, 100_000_000]) {
    const result = aggregateFeedback(input({ windowDays, events: [event({ id: 'e1' })] }));
    assert.match(result.windowStart, /^[-+0-9]{4,7}-\d{2}-\d{2}T/);
    assert.ok(Number.isFinite(Date.parse(result.windowStart)));
    // The whole log is inside a window that wide.
    assert.deepEqual(result.windowed, { accept: 1 });
  }
});

/* ── Revocation ─────────────────────────────────────────────────── */

test('revoked events leave every aggregate and are counted instead of hidden', () => {
  const events = [
    event({ id: 'kept', outcome: 'accept', occurredAt: daysBefore(1) }),
    event({ id: 'revoked-in-window', outcome: 'reject', occurredAt: daysBefore(2), revokedAt: NOW }),
    event({ id: 'revoked-old', outcome: 'ignore', occurredAt: daysBefore(40), revokedAt: NOW }),
  ];

  const result = aggregateFeedback(input({ events }));

  assert.deepEqual(result.windowed, { accept: 1 });
  assert.deepEqual(result.lifetime, { accept: 1 });
  assert.equal(result.revokedCount, 2);
});

test('revoking the only event empties the counts while the correction stays visible', () => {
  const events = [event({ id: 'only', outcome: 'complete', occurredAt: daysBefore(1), revokedAt: NOW })];

  const result = aggregateFeedback(input({ events }));

  assert.deepEqual(result.windowed, {});
  assert.deepEqual(result.lifetime, {});
  assert.equal(result.revokedCount, 1);
  // Lateness is measured over the events that still count; a withdrawn record
  // is not evidence about our pipeline's timeliness.
  assert.equal(result.lateEventCount, 0);
});

test('an undo event is a behaviour that counts, not a revocation', () => {
  // Conflating the two would erase the user's correction and would learn from
  // a reversal as if the original had never been reported.
  const events = [
    event({ id: 'original', outcome: 'complete', occurredAt: daysBefore(2) }),
    event({ id: 'reversal', outcome: 'undo', occurredAt: daysBefore(1) }),
  ];

  const result = aggregateFeedback(input({ events }));

  assert.deepEqual(result.windowed, { complete: 1, undo: 1 });
  assert.equal(result.revokedCount, 0);
});

/* ── Migration baseline ─────────────────────────────────────────── */

test('the migration baseline reaches lifetime only, never the window', () => {
  const events = [event({ id: 'e1', outcome: 'accept', occurredAt: daysBefore(1) })];
  const withBaseline = baseline({
    counters: {
      ignoredSuggestions: 4,
      completedActions: 7,
      delayedActions: 2,
      clarificationSuccesses: 0,
      clarificationFailures: 0,
    },
  });

  const result = aggregateFeedback(input({ events, baseline: withBaseline }));

  assert.deepEqual(result.windowed, { accept: 1 });
  assert.deepEqual(result.lifetime, { accept: 1, complete: 7, ignore: 4, defer: 2 });
  assert.equal(result.includesMigrationBaseline, true);
});

test('a baseline whose lastUpdatedAt falls inside the window still cannot be windowed', () => {
  // lastUpdatedAt is a scope-level timestamp, not an event time. Using it to
  // place the counters in a window would pile invented history onto one instant
  // — the exact corruption the frozen baseline exists to prevent.
  const withBaseline = baseline({
    counters: {
      ignoredSuggestions: 0,
      completedActions: 5,
      delayedActions: 0,
      clarificationSuccesses: 0,
      clarificationFailures: 0,
    },
    lastUpdatedAt: hoursBefore(2),
  });

  const result = aggregateFeedback(input({ events: [], baseline: withBaseline }));

  assert.deepEqual(result.windowed, {});
  assert.deepEqual(result.lifetime, { complete: 5 });
  assert.equal(result.includesMigrationBaseline, true);
});

test('clarification counters are not forced into the outcome vocabulary', () => {
  // They are capture-quality signals, not commitment outcomes; mapping them to
  // an outcome would invent behaviour the user never performed.
  const withBaseline = baseline({
    counters: {
      ignoredSuggestions: 0,
      completedActions: 0,
      delayedActions: 0,
      clarificationSuccesses: 9,
      clarificationFailures: 3,
    },
  });

  const result = aggregateFeedback(input({ events: [], baseline: withBaseline }));

  assert.deepEqual(result.lifetime, {});
  // The baseline still contributed: a reader must know the totals predate the log.
  assert.equal(result.includesMigrationBaseline, true);
});

test('a negative or fractional legacy counter cannot corrupt a lifetime total', () => {
  // Legacy counters cannot be re-derived, so a nonsensical value is contained
  // rather than allowed to make a claim about the user that is not merely
  // imprecise but impossible.
  const withBaseline = baseline({
    counters: {
      ignoredSuggestions: -5,
      completedActions: 2.7,
      delayedActions: 0,
      clarificationSuccesses: 0,
      clarificationFailures: 0,
    },
  });

  const result = aggregateFeedback(input({ events: [], baseline: withBaseline }));

  assert.deepEqual(result.lifetime, { complete: 2 });
});

test('a non-finite legacy counter throws with the counter named, not from inside the digest', () => {
  // A NaN cannot be canonicalized at all, so the digest would either throw an
  // unattributed TypeError from the fingerprinting helper or hash a value that
  // is not the input. Failing here says which counter is broken.
  const withBaseline = baseline({
    counters: {
      ignoredSuggestions: 0,
      completedActions: 0,
      delayedActions: Number.NaN,
      clarificationSuccesses: 0,
      clarificationFailures: 0,
    },
  });

  assert.throws(() => aggregateFeedback(input({ events: [], baseline: withBaseline })), /delayedActions/);
  assert.throws(
    () => aggregateFeedback(input({
      events: [],
      baseline: baseline({ counters: { ...baseline().counters, completedActions: null as unknown as number } }),
    })),
    /completedActions/,
  );
});

test('an empty log with no baseline is a known zero, not an error', () => {
  const result = aggregateFeedback(input({ events: [], baseline: null }));

  assert.deepEqual(result.windowed, {});
  assert.deepEqual(result.lifetime, {});
  assert.equal(result.includesMigrationBaseline, false);
  assert.equal(result.revokedCount, 0);
  assert.equal(result.lateEventCount, 0);
  assert.equal(result.windowStart, WINDOW_START);
  assert.equal(result.version, FEEDBACK_EVENT_SCHEMA_VERSION);
  assert.equal(result.scopeId, SCOPE);
});

test('an empty log with an all-zero baseline still reports that a baseline exists', () => {
  const result = aggregateFeedback(input({ events: [], baseline: baseline() }));

  assert.deepEqual(result.lifetime, {});
  assert.equal(result.includesMigrationBaseline, true);
});

/* ── Input validation ───────────────────────────────────────────── */

test('an unusable now or scopeId throws rather than producing a plausible aggregate', () => {
  assert.throws(() => aggregateFeedback(input({ now: 'not-a-date' })), /now/);
  assert.throws(() => aggregateFeedback(input({ now: '' })), /now/);
  assert.throws(() => aggregateFeedback(input({ scopeId: '' })), /scopeId/);
  assert.throws(() => aggregateFeedback(input({ scopeId: '   ' })), /scopeId/);
});

test('an event from another scope throws instead of contaminating this scope', () => {
  const events = [event({ id: 'mine' }), event({ id: 'theirs', scopeId: 'scope-2' })];
  assert.throws(() => aggregateFeedback(input({ events })), /scope-2/);
});

test('a baseline from another scope throws', () => {
  assert.throws(
    () => aggregateFeedback(input({ baseline: baseline({ scopeId: 'scope-2' }) })),
    /scope-2/,
  );
});

test('an unparseable event timestamp throws and names the event', () => {
  // Silently skipping it would undercount without saying so, and the aggregate
  // would disagree with the log it claims to summarize.
  assert.throws(() => aggregateFeedback(input({ events: [event({ id: 'bad-occurred', occurredAt: 'whenever' })] })), /bad-occurred/);
  assert.throws(() => aggregateFeedback(input({ events: [event({ id: 'bad-recorded', recordedAt: 'whenever' })] })), /bad-recorded/);
});

test('an outcome outside the vocabulary throws instead of vanishing from the counts', () => {
  // Counts are emitted through a frozen outcome order, so an unrecognised
  // outcome would otherwise be dropped in silence — the aggregate would report
  // fewer events than the log holds and look perfectly healthy doing it.
  const rogue = { ...event({ id: 'rogue' }), outcome: 'snooze' } as unknown as FeedbackEvent;
  assert.throws(() => aggregateFeedback(input({ events: [rogue] })), /rogue/);
});

/* ── Global view ────────────────────────────────────────────────── */

test('the global view carries counts only — no scope, subject, or event identity', () => {
  const events = [
    event({ id: 'evt-secret-1', scopeId: 'scope-secret-alpha', subjectId: 'subject-secret-alpha', outcome: 'accept', occurredAt: daysBefore(1) }),
    event({ id: 'evt-secret-2', scopeId: 'scope-secret-beta', subjectId: 'subject-secret-beta', outcome: 'reject', occurredAt: daysBefore(2) }),
  ];

  const result = aggregateGlobalFeedback({ events, now: NOW });
  const serialized = JSON.stringify(result);

  for (const identifying of ['scope-secret-alpha', 'scope-secret-beta', 'subject-secret-alpha', 'subject-secret-beta', 'evt-secret-1', 'evt-secret-2']) {
    assert.equal(serialized.includes(identifying), false, `global result leaked ${identifying}`);
  }
  assert.deepEqual(Object.keys(result), ['version', 'computedAt', 'windowDays', 'windowStart', 'windowed', 'scopeCount']);
  assert.deepEqual(result.windowed, { accept: 1, reject: 1 });
  assert.equal(result.scopeCount, 2);
});

test('the global view applies the same windowing and revocation rules as the per-user view', () => {
  // One implementation, so the two cannot diverge: over a single scope the
  // global windowed counts must equal the per-user windowed counts exactly.
  const events = [
    event({ id: 'in-window', outcome: 'accept', occurredAt: daysBefore(1) }),
    event({ id: 'at-start', outcome: 'edit', occurredAt: WINDOW_START }),
    event({ id: 'before-window', outcome: 'complete', occurredAt: daysBefore(40) }),
    event({ id: 'future', outcome: 'defer', occurredAt: shift(NOW, 1) }),
    event({ id: 'revoked', outcome: 'ignore', occurredAt: daysBefore(3), revokedAt: NOW }),
  ];

  const perUser = aggregateFeedback(input({ events }));
  const global = aggregateGlobalFeedback({ events, now: NOW });

  assert.deepEqual(global.windowed, perUser.windowed);
  assert.equal(global.windowStart, perUser.windowStart);
  assert.equal(global.windowDays, perUser.windowDays);
  assert.equal(global.scopeCount, 1);
});

test('scopeCount counts the scopes that contributed to the window', () => {
  const events = [
    event({ id: 'a1', scopeId: 'scope-a', outcome: 'accept', occurredAt: daysBefore(1) }),
    event({ id: 'a2', scopeId: 'scope-a', outcome: 'accept', occurredAt: daysBefore(2) }),
    event({ id: 'b1', scopeId: 'scope-b', outcome: 'defer', occurredAt: daysBefore(3) }),
    // Contributes nothing to the window, so it cannot inflate a per-scope rate.
    event({ id: 'c1', scopeId: 'scope-c', outcome: 'reject', occurredAt: daysBefore(40) }),
    event({ id: 'd1', scopeId: 'scope-d', outcome: 'reject', occurredAt: daysBefore(1), revokedAt: NOW }),
  ];

  const result = aggregateGlobalFeedback({ events, now: NOW });

  assert.deepEqual(result.windowed, { accept: 2, defer: 1 });
  assert.equal(result.scopeCount, 2);
});

test('the global view is order-independent and clock-free like the per-user view', () => {
  const events = [
    event({ id: 'a1', scopeId: 'scope-a', outcome: 'accept', occurredAt: daysBefore(1) }),
    event({ id: 'b1', scopeId: 'scope-b', outcome: 'ignore', occurredAt: daysBefore(2) }),
    event({ id: 'c1', scopeId: 'scope-c', outcome: 'undo', occurredAt: daysBefore(3) }),
  ];

  const forward = aggregateGlobalFeedback({ events, now: NOW });
  const backward = aggregateGlobalFeedback({ events: [...events].reverse(), now: NOW });

  assert.equal(JSON.stringify(forward), JSON.stringify(backward));
  assert.equal(forward.computedAt, NOW);
  assert.deepEqual(Object.keys(forward.windowed), ['accept', 'ignore', 'undo']);
});

test('the global view rejects an unusable now, like the per-user view', () => {
  assert.throws(() => aggregateGlobalFeedback({ events: [], now: 'not-a-date' }), /now/);
});
