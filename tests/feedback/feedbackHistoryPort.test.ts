/**
 * The adapter that joins the history API (#15) to the event store (#13).
 *
 * This is the piece wired up at merge time, so it is tested against a store
 * that implements the committed `FeedbackEventStore` contract and nothing else.
 * The store used here is deliberately hostile in one place — it can decline a
 * revoke — because the failure mode that matters is an adapter that reports a
 * correction the store never made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFeedbackHistoryPort } from '../../lib/feedbackHistory/feedbackHistoryPort.ts';
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type AppendFeedbackEventInput,
  type FeedbackBaseline,
  type FeedbackEvent,
  type FeedbackEventQuery,
  type FeedbackEventStore,
} from '../../src/contracts/v1/feedbackContracts.ts';

interface StubOptions {
  readonly refuseRevoke?: boolean;
  /** Reports a successful revoke without actually stamping the event. */
  readonly lieAboutRevoke?: boolean;
}

function stubStore(seed: readonly FeedbackEvent[], options: StubOptions = {}): FeedbackEventStore & {
  lastQuery: FeedbackEventQuery | null;
} {
  const events = new Map(seed.map((entry) => [entry.id, { ...entry }]));
  const baselines = new Map<string, FeedbackBaseline>();
  const store = {
    lastQuery: null as FeedbackEventQuery | null,
    append(_input: AppendFeedbackEventInput, _recordedAt: string): FeedbackEvent {
      throw new Error('the history port must never append');
    },
    get(id: string): FeedbackEvent | null {
      return events.get(id) ?? null;
    },
    list(query: FeedbackEventQuery): readonly FeedbackEvent[] {
      store.lastQuery = query;
      return Array.from(events.values()).filter((entry) => entry.scopeId === query.scopeId);
    },
    revoke(id: string, at: string): boolean {
      if (options.refuseRevoke) return false;
      if (options.lieAboutRevoke) return true;
      const found = events.get(id);
      if (!found || found.revokedAt) return false;
      events.set(id, { ...found, revokedAt: at });
      return true;
    },
    deleteScope(scopeId: string): number {
      let deleted = 0;
      for (const [id, entry] of Array.from(events.entries())) {
        if (entry.scopeId === scopeId) {
          events.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    },
    readBaseline(scopeId: string): FeedbackBaseline | null {
      return baselines.get(scopeId) ?? null;
    },
    writeBaseline(baseline: FeedbackBaseline): void {
      baselines.set(baseline.scopeId, baseline);
    },
  };
  return store;
}

function event(id: string, scopeId: string, revokedAt?: string): FeedbackEvent {
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    id,
    scopeId,
    outcome: 'defer',
    subjectId: `subject-${id}`,
    actor: 'user',
    source: 'mobile_action',
    occurredAt: '2026-08-10T09:00:00.000Z',
    recordedAt: '2026-08-10T09:00:01.000Z',
    idempotencyKey: `${scopeId}|defer|${id}`,
    ...(revokedAt ? { revokedAt } : {}),
  };
}

test('history port: reads ask the store for revoked rows too', () => {
  const store = stubStore([event('e1', 'scope-a')]);
  const port = createFeedbackHistoryPort(store);

  port.listForScope('scope-a');

  assert.equal(store.lastQuery?.scopeId, 'scope-a');
  // History showing corrections is a property of the request, not a hope about
  // the store's default.
  assert.equal(store.lastQuery?.includeRevoked, true);
});

test('history port: revoke stamps the event and returns the stamped copy', () => {
  const store = stubStore([event('e1', 'scope-a')]);
  const port = createFeedbackHistoryPort(store);

  const result = port.revokeForScope({ scopeId: 'scope-a', eventId: 'e1', at: '2026-08-14T10:00:00.000Z' });

  assert.equal(result.outcome, 'revoked');
  assert.equal(result.event?.revokedAt, '2026-08-14T10:00:00.000Z');
  assert.equal(store.get('e1')?.revokedAt, '2026-08-14T10:00:00.000Z');
});

test('history port: an event in another scope is never revoked through this scope', () => {
  const store = stubStore([event('theirs', 'scope-b')]);
  const port = createFeedbackHistoryPort(store);

  const result = port.revokeForScope({ scopeId: 'scope-a', eventId: 'theirs', at: '2026-08-14T10:00:00.000Z' });

  assert.equal(result.outcome, 'not_found');
  assert.equal(result.event, null);
  assert.equal(store.get('theirs')?.revokedAt, undefined);
});

test('history port: re-revoking keeps the original correction time', () => {
  const store = stubStore([event('e1', 'scope-a', '2026-08-12T08:00:00.000Z')]);
  const port = createFeedbackHistoryPort(store);

  const result = port.revokeForScope({ scopeId: 'scope-a', eventId: 'e1', at: '2026-08-14T10:00:00.000Z' });

  assert.equal(result.outcome, 'already_revoked');
  assert.equal(result.event?.revokedAt, '2026-08-12T08:00:00.000Z');
});

test('history port: a store that declines the write is reported as failed, not missing', () => {
  const store = stubStore([event('e1', 'scope-a')], { refuseRevoke: true });
  const port = createFeedbackHistoryPort(store);

  const result = port.revokeForScope({ scopeId: 'scope-a', eventId: 'e1', at: '2026-08-14T10:00:00.000Z' });

  // The event exists, so "not found" would be a false statement about the
  // user's own record; the honest answer is that the correction did not land.
  assert.equal(result.outcome, 'failed');
  assert.equal(store.get('e1')?.revokedAt, undefined);
});

test('history port: a store that claims success without stamping is caught', () => {
  const store = stubStore([event('e1', 'scope-a')], { lieAboutRevoke: true });
  const port = createFeedbackHistoryPort(store);

  // The user is told a correction was applied only when the record shows it.
  const result = port.revokeForScope({ scopeId: 'scope-a', eventId: 'e1', at: '2026-08-14T10:00:00.000Z' });

  assert.equal(result.outcome, 'failed');
});

test('history port: baseline reads pass straight through', () => {
  const store = stubStore([]);
  const baseline: FeedbackBaseline = {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId: 'scope-a',
    counters: {
      ignoredSuggestions: 1,
      completedActions: 2,
      delayedActions: 3,
      clarificationSuccesses: 0,
      clarificationFailures: 0,
    },
    lastUpdatedAt: '2026-07-01T00:00:00.000Z',
    timestampsUnavailable: true,
    migratedAt: '2026-08-18T00:00:00.000Z',
  };
  store.writeBaseline(baseline);

  assert.deepEqual(createFeedbackHistoryPort(store).readBaseline('scope-a'), baseline);
  assert.equal(createFeedbackHistoryPort(store).readBaseline('scope-b'), null);
});
