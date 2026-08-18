/**
 * Migration of the legacy counters into a frozen baseline (Sprint 03, #13).
 *
 * The legacy store holds five counters and one scope-level updatedAt, so no
 * individual outcome has a time. Two failures follow from that, and both are
 * pinned here:
 *
 *  1. Expanding the counters into events would invent history that did not
 *     happen and would pile every fabricated event onto one instant, corrupting
 *     exactly the windowed aggregates this sprint produces.
 *
 *  2. Re-running the migration after dual-write has begun would fold outcomes
 *     already in the event log back into the pre-log totals, counting them
 *     twice. The counters keep incrementing after migration, so this is the
 *     live failure mode, not a hypothetical one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type FeedbackBaseline,
} from '../../src/contracts/v1/feedbackContracts.ts';
import { createInMemoryFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import {
  migrateLegacyBaseline,
  type LegacyCounterReader,
  type LegacyCounterSnapshot,
} from '../../lib/feedback/baselineMigration.ts';
import { MemoryBehaviorFeedbackStore } from '../../lib/services/behaviorFeedbackService.ts';

const MIGRATED_AT = '2026-08-18T09:00:00.000Z';
const LATER = '2026-08-19T09:00:00.000Z';

function snapshot(overrides: Partial<LegacyCounterSnapshot> = {}): LegacyCounterSnapshot {
  return {
    ignoredSuggestions: 3,
    completedActions: 7,
    delayedActions: 2,
    clarificationSuccesses: 5,
    clarificationFailures: 1,
    updatedAt: '2026-08-10T20:00:00.000Z',
    ...overrides,
  };
}

function reader(value: LegacyCounterSnapshot): LegacyCounterReader {
  return { get: () => value };
}

test('migration copies the five legacy counters verbatim', () => {
  const store = createInMemoryFeedbackEventStore();
  const baseline = migrateLegacyBaseline({
    scopeId: 'scope-a',
    reader: reader(snapshot()),
    store,
    migratedAt: MIGRATED_AT,
  });

  assert.deepEqual(baseline, {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId: 'scope-a',
    counters: {
      ignoredSuggestions: 3,
      completedActions: 7,
      delayedActions: 2,
      clarificationSuccesses: 5,
      clarificationFailures: 1,
    },
    lastUpdatedAt: '2026-08-10T20:00:00.000Z',
    timestampsUnavailable: true,
    migratedAt: MIGRATED_AT,
  } satisfies FeedbackBaseline);
  assert.deepEqual(store.readBaseline('scope-a'), baseline);
});

test('migration states in the data that the counters carry no per-event times', () => {
  const store = createInMemoryFeedbackEventStore();
  const baseline = migrateLegacyBaseline({
    scopeId: 'scope-a',
    reader: reader(snapshot({ updatedAt: null })),
    store,
    migratedAt: MIGRATED_AT,
  });

  assert.equal(baseline?.timestampsUnavailable, true);
  assert.equal(baseline?.lastUpdatedAt, null, 'the legacy updatedAt is the only time information there is');
});

test('migration never expands counters into events', () => {
  const store = createInMemoryFeedbackEventStore();
  migrateLegacyBaseline({
    scopeId: 'scope-a',
    reader: reader(snapshot()),
    store,
    migratedAt: MIGRATED_AT,
  });

  assert.deepEqual(
    store.list({ scopeId: 'scope-a' }),
    [],
    'eighteen counted outcomes must not become eighteen events at one instant',
  );
});

test('migrating twice is idempotent and does not double the counters', () => {
  const store = createInMemoryFeedbackEventStore();
  const first = migrateLegacyBaseline({
    scopeId: 'scope-a',
    reader: reader(snapshot()),
    store,
    migratedAt: MIGRATED_AT,
  });
  const second = migrateLegacyBaseline({
    scopeId: 'scope-a',
    reader: reader(snapshot()),
    store,
    migratedAt: LATER,
  });

  assert.deepEqual(second, first, 'a second migration must return the frozen baseline unchanged');
  assert.equal(second?.migratedAt, MIGRATED_AT, 'migratedAt records the one migration that happened');
  assert.deepEqual(store.readBaseline('scope-a'), first);
});

test('a second migration ignores counters that grew after the first', () => {
  const store = createInMemoryFeedbackEventStore();
  const first = migrateLegacyBaseline({
    scopeId: 'scope-a',
    reader: reader(snapshot()),
    store,
    migratedAt: MIGRATED_AT,
  });
  // Dual-write keeps incrementing the legacy counters while the same outcomes
  // land in the event log. Re-reading them would count those outcomes twice.
  const second = migrateLegacyBaseline({
    scopeId: 'scope-a',
    reader: reader(snapshot({ completedActions: 40, ignoredSuggestions: 30 })),
    store,
    migratedAt: LATER,
  });

  assert.deepEqual(second, first);
  assert.equal(store.readBaseline('scope-a')?.counters.completedActions, 7);
  assert.equal(store.readBaseline('scope-a')?.counters.ignoredSuggestions, 3);
});

test('a scope with no legacy history gets no baseline', () => {
  const store = createInMemoryFeedbackEventStore();
  const baseline = migrateLegacyBaseline({
    scopeId: 'fresh-scope',
    reader: reader(snapshot({
      ignoredSuggestions: 0,
      completedActions: 0,
      delayedActions: 0,
      clarificationSuccesses: 0,
      clarificationFailures: 0,
      updatedAt: null,
    })),
    store,
    migratedAt: MIGRATED_AT,
  });

  assert.equal(baseline, null, 'a new user has no pre-event-log history to preserve');
  assert.equal(
    store.readBaseline('fresh-scope'),
    null,
    'an empty baseline would make aggregates claim history that does not exist',
  );
});

test('migration reads the real legacy store shape', () => {
  const legacy = new MemoryBehaviorFeedbackStore();
  legacy.record('scope-a', 'action_completed', '2026-08-10T20:00:00.000Z');
  legacy.record('scope-a', 'action_completed', '2026-08-11T20:00:00.000Z');
  legacy.record('scope-a', 'suggestion_ignored', '2026-08-12T20:00:00.000Z');
  legacy.record('scope-b', 'action_delayed', '2026-08-12T20:00:00.000Z');

  const store = createInMemoryFeedbackEventStore();
  const baseline = migrateLegacyBaseline({
    scopeId: 'scope-a',
    reader: legacy,
    store,
    migratedAt: MIGRATED_AT,
  });

  assert.deepEqual(baseline?.counters, {
    ignoredSuggestions: 1,
    completedActions: 2,
    delayedActions: 0,
    clarificationSuccesses: 0,
    clarificationFailures: 0,
  });
  assert.equal(baseline?.lastUpdatedAt, '2026-08-12T20:00:00.000Z');
  assert.equal(baseline?.scopeId, 'scope-a');
});

test('migration rejects a scope, timestamp or counter it cannot trust', () => {
  const store = createInMemoryFeedbackEventStore();
  const base = { reader: reader(snapshot()), store, migratedAt: MIGRATED_AT, scopeId: 'scope-a' };

  assert.throws(() => migrateLegacyBaseline({ ...base, scopeId: '  ' }), /feedback baseline:/);
  assert.throws(() => migrateLegacyBaseline({ ...base, migratedAt: 'sometime' }), /feedback baseline:/);
  assert.throws(
    () => migrateLegacyBaseline({ ...base, reader: reader(snapshot({ completedActions: -1 })) }),
    /feedback baseline:/,
  );
  assert.throws(
    () => migrateLegacyBaseline({ ...base, reader: reader(snapshot({ delayedActions: 1.5 })) }),
    /feedback baseline:/,
  );
  assert.throws(
    () => migrateLegacyBaseline({ ...base, reader: reader(snapshot({ updatedAt: 'yesterday' })) }),
    /feedback baseline:/,
  );
  assert.equal(store.readBaseline('scope-a'), null, 'no rejected migration may leave a baseline');
});

test('migration is scoped: one user\'s counters never land in another\'s baseline', () => {
  const store = createInMemoryFeedbackEventStore();
  const seen: string[] = [];
  const scopedReader: LegacyCounterReader = {
    get: (scopeId) => {
      seen.push(scopeId);
      return scopeId === 'scope-a' ? snapshot() : snapshot({ completedActions: 99 });
    },
  };

  const a = migrateLegacyBaseline({ scopeId: 'scope-a', reader: scopedReader, store, migratedAt: MIGRATED_AT });
  const b = migrateLegacyBaseline({ scopeId: 'scope-b', reader: scopedReader, store, migratedAt: MIGRATED_AT });

  assert.deepEqual(seen, ['scope-a', 'scope-b'], 'the reader is asked for exactly the scope being migrated');
  assert.equal(a?.counters.completedActions, 7);
  assert.equal(b?.counters.completedActions, 99);
  assert.equal(store.readBaseline('scope-a')?.counters.completedActions, 7);
});
