/**
 * The three Sprint 03 tracks, joined and run against each other.
 *
 * #13 (store), #14 (aggregation) and #15 (history API) were built in parallel
 * against contracts written first, so each was only ever verified against its
 * own reading of them. Sprint 02 showed that is not enough: 91 tests passed
 * there while three modules disagreed, because one track's expectations were
 * data that nothing executed.
 *
 * #15's acceptance criterion — "revocation affects future aggregates" — is a
 * statement about #14's output caused by #13's state through #15's API. No
 * single track can test it. This file does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { migrateLegacyBaseline } from '../../lib/feedback/baselineMigration.ts';
import { aggregateFeedback } from '../../lib/feedback/feedbackAggregation.ts';
import { createFeedbackHistoryPort } from '../../lib/feedbackHistory/feedbackHistoryPort.ts';
import { MemoryBehaviorFeedbackStore } from '../../lib/services/behaviorFeedbackService.ts';
import type { FeedbackEventStore } from '../../src/contracts/v1/feedbackContracts.ts';

const SCOPE = 'cross-track-scope';
const NOW = '2026-08-18T12:00:00.000Z';

function seed(store: FeedbackEventStore, occurredAt: string, subjectId: string, outcome: 'complete' | 'defer' | 'ignore') {
  return store.append(
    { scopeId: SCOPE, outcome, subjectId, actor: 'user', source: 'mobile_action', occurredAt },
    occurredAt,
  );
}

/** Aggregates the store's current state, exactly as a consumer would. */
function aggregateFrom(store: FeedbackEventStore) {
  return aggregateFeedback({
    events: store.list({ scopeId: SCOPE, includeRevoked: true }),
    baseline: store.readBaseline(SCOPE),
    scopeId: SCOPE,
    now: NOW,
  });
}

test('revoking through the real history port removes the event from the real aggregate', () => {
  const store = createInMemoryFeedbackEventStore();
  const port = createFeedbackHistoryPort(store);

  seed(store, '2026-08-17T09:00:00.000Z', 'c1', 'complete');
  const toRevoke = seed(store, '2026-08-17T10:00:00.000Z', 'c2', 'complete');

  const before = aggregateFrom(store);
  assert.equal(before.windowed.complete, 2, 'both completions should count before the correction');
  assert.equal(before.revokedCount, 0);

  // The user says "you misread me" through the same path the app uses.
  const result = port.revokeForScope({ scopeId: SCOPE, eventId: toRevoke.id, at: NOW });
  assert.equal(result.outcome, 'revoked');

  const after = aggregateFrom(store);
  assert.equal(after.windowed.complete, 1, 'the revoked event must leave the window');
  assert.equal(after.lifetime.complete, 1, 'and must leave lifetime totals too');
  assert.equal(after.revokedCount, 1, 'the correction is reported, not silently hidden');
});

test('a revoked event stays visible in history, so the user can see the correction took effect', () => {
  const store = createInMemoryFeedbackEventStore();
  const port = createFeedbackHistoryPort(store);
  const event = seed(store, '2026-08-17T09:00:00.000Z', 'c1', 'defer');

  port.revokeForScope({ scopeId: SCOPE, eventId: event.id, at: NOW });

  const listed = port.listForScope(SCOPE);
  assert.equal(listed.length, 1, 'revocation is a correction, not a deletion');
  assert.equal(listed[0].revokedAt, NOW);
  // Disappearing would leave the user unable to tell a correction from a bug.
  assert.equal(aggregateFrom(store).windowed.defer, undefined);
});

test('one participant cannot revoke another participant, even holding a derived id', () => {
  // Event ids are sha256 of (scopeId, subjectId, outcome, occurredAt), so an id
  // is computable by anyone who knows the inputs. Unguessability is therefore
  // not the authorization boundary — the scope check is.
  const store = createInMemoryFeedbackEventStore();
  const port = createFeedbackHistoryPort(store);
  const victim = seed(store, '2026-08-17T09:00:00.000Z', 'c1', 'complete');

  const attacker = port.revokeForScope({ scopeId: 'someone-else', eventId: victim.id, at: NOW });
  assert.notEqual(attacker.outcome, 'revoked');

  assert.equal(store.get(victim.id)?.revokedAt, undefined, "the victim's event must be untouched");
  assert.equal(aggregateFrom(store).windowed.complete, 1, 'and must still count');
});

test('the migration baseline reaches lifetime totals but never a window', () => {
  const store = createInMemoryFeedbackEventStore();
  const legacy = new MemoryBehaviorFeedbackStore();
  legacy.record(SCOPE, 'action_completed', '2026-01-01T00:00:00.000Z');
  legacy.record(SCOPE, 'action_completed', '2026-01-02T00:00:00.000Z');
  legacy.record(SCOPE, 'suggestion_ignored', '2026-01-03T00:00:00.000Z');

  migrateLegacyBaseline({ scopeId: SCOPE, reader: legacy, store, migratedAt: NOW });
  seed(store, '2026-08-17T09:00:00.000Z', 'c1', 'complete');

  const aggregates = aggregateFrom(store);
  assert.equal(aggregates.includesMigrationBaseline, true);
  // The counters carry no per-event times, so they can be totalled but never placed.
  assert.equal(aggregates.lifetime.complete, 3, '2 migrated + 1 real');
  assert.equal(aggregates.lifetime.ignore, 1);
  assert.equal(aggregates.windowed.complete, 1, 'only the timestamped event may enter a window');
  assert.equal(aggregates.windowed.ignore, undefined);
});

test('a retried action does not inflate the aggregate', () => {
  const store = createInMemoryFeedbackEventStore();
  seed(store, '2026-08-17T09:00:00.000Z', 'c1', 'complete');
  seed(store, '2026-08-17T09:00:00.000Z', 'c1', 'complete'); // same behaviour, retried

  assert.equal(aggregateFrom(store).windowed.complete, 1);
});

test('revoking twice does not double-report the correction or move its timestamp', () => {
  const store = createInMemoryFeedbackEventStore();
  const port = createFeedbackHistoryPort(store);
  const event = seed(store, '2026-08-17T09:00:00.000Z', 'c1', 'complete');

  port.revokeForScope({ scopeId: SCOPE, eventId: event.id, at: NOW });
  port.revokeForScope({ scopeId: SCOPE, eventId: event.id, at: '2026-08-18T18:00:00.000Z' });

  assert.equal(store.get(event.id)?.revokedAt, NOW, 'the correction happened once, at one time');
  assert.equal(aggregateFrom(store).revokedCount, 1);
});
