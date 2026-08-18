/**
 * Feedback event store semantics (Sprint 03, issue #13).
 *
 * Every test here runs against both backends. The two properties this issue
 * exists for — one record per behaviour however many times it is submitted,
 * and a revocation timestamp that keeps recording when the user corrected us —
 * are semantics rather than persistence, and the sibling alpha stores drifted
 * precisely by re-implementing semantics once per backend.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type AppendFeedbackEventInput,
  type FeedbackBaseline,
  type FeedbackEventStore,
} from '../../src/contracts/v1/feedbackContracts.ts';
import {
  createFileFeedbackEventStore,
  createInMemoryFeedbackEventStore,
} from '../../lib/feedback/feedbackEventStore.ts';

const OCCURRED = '2026-08-18T09:00:00.000Z';
const RECORDED = '2026-08-18T09:00:03.000Z';
const LATER = '2026-08-18T18:30:00.000Z';

/** Free-text-bearing ids: a scope or subject may carry the user's own words. */
const ARABIC = 'التزام: الاتصال بالطبيب قبل الساعة ٩ — لا تؤجل';
const HEBREW = 'התחייבות: להתקשר לרופא לפני 9 — לא לדחות';

interface Harness {
  readonly store: FeedbackEventStore;
  readonly cleanup: () => void;
}

const BACKENDS: readonly (readonly [string, () => Harness])[] = [
  ['memory', () => ({ store: createInMemoryFeedbackEventStore(), cleanup: () => undefined })],
  ['file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'maybesitter-feedback-'));
    return {
      store: createFileFeedbackEventStore({ dataDir }),
      cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
    };
  }],
];

function input(overrides: Partial<AppendFeedbackEventInput> = {}): AppendFeedbackEventInput {
  return {
    scopeId: 'scope-a',
    outcome: 'complete',
    subjectId: 'commitment-1',
    actor: 'user',
    source: 'mobile_action',
    occurredAt: OCCURRED,
    ...overrides,
  };
}

function baseline(overrides: Partial<FeedbackBaseline> = {}): FeedbackBaseline {
  return {
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
    migratedAt: RECORDED,
    ...overrides,
  };
}

for (const entry of BACKENDS) {
  const [backend, make] = entry;

  test(`[${backend}] append records actor, source and both timestamps`, () => {
    const { store, cleanup } = make();
    try {
      const event = store.append(input(), RECORDED);
      assert.equal(event.version, FEEDBACK_EVENT_SCHEMA_VERSION);
      assert.equal(event.scopeId, 'scope-a');
      assert.equal(event.subjectId, 'commitment-1');
      assert.equal(event.outcome, 'complete');
      assert.equal(event.actor, 'user');
      assert.equal(event.source, 'mobile_action');
      assert.equal(event.occurredAt, OCCURRED);
      assert.equal(event.recordedAt, RECORDED);
      assert.ok(event.idempotencyKey.length > 0, 'an idempotency key must be assigned');
      assert.equal(event.revokedAt, undefined);
      assert.deepEqual(store.get(event.id), event);
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] appending the same input twice yields one record and one identical event`, () => {
    const { store, cleanup } = make();
    try {
      const first = store.append(input(), RECORDED);
      // A retry that arrives hours later: nothing about the stored event may move.
      const second = store.append(input(), LATER);
      assert.deepEqual(second, first, 'a repeat append must return the existing event unchanged');
      assert.equal(second.recordedAt, RECORDED, 'recordedAt must record the first storage, not the retry');
      assert.equal(second.id, first.id);
      assert.equal(store.list({ scopeId: 'scope-a' }).length, 1, 'a retry must not create a second record');
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] the idempotency key derives from scope, subject, outcome and occurredAt`, () => {
    const { store, cleanup } = make();
    try {
      const base = store.append(input(), RECORDED);
      const variants: readonly Partial<AppendFeedbackEventInput>[] = [
        { scopeId: 'scope-b' },
        { subjectId: 'commitment-2' },
        { outcome: 'defer' },
        { occurredAt: '2026-08-18T09:00:01.000Z' },
      ];
      for (const variant of variants) {
        const other = store.append(input(variant), RECORDED);
        assert.notEqual(
          other.idempotencyKey,
          base.idempotencyKey,
          `changing ${Object.keys(variant)[0]} must produce a distinct key`,
        );
      }
      assert.equal(store.list({ scopeId: 'scope-a' }).length, 4, 'scope-a keeps the base plus three variants');
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] a repeat differing only in actor or source replays rather than double counting`, () => {
    const { store, cleanup } = make();
    try {
      const first = store.append(input(), RECORDED);
      // Deliberate: the same behaviour re-submitted through another path is one
      // behaviour. Collapsing it is the point; the first write stays authoritative.
      const viaScheduler = store.append(input({ actor: 'system', source: 'scheduler' }), LATER);
      assert.deepEqual(viaScheduler, first);
      assert.equal(store.list({ scopeId: 'scope-a' }).length, 1);
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] idempotency keys are stable across store instances`, () => {
    const first = make();
    const second = make();
    try {
      const a = first.store.append(input(), RECORDED);
      const b = second.store.append(input(), LATER);
      assert.equal(b.idempotencyKey, a.idempotencyKey, 'a restart must not lose idempotency');
      assert.equal(b.id, a.id, 'the same behaviour must resolve to the same record identity');
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test(`[${backend}] append rejects a record missing actor, source or a timestamp`, () => {
    const { store, cleanup } = make();
    try {
      const missing: readonly Partial<Record<keyof AppendFeedbackEventInput, unknown>>[] = [
        { actor: undefined },
        { source: undefined },
        { occurredAt: undefined },
        { scopeId: undefined },
        { subjectId: undefined },
        { outcome: undefined },
        { actor: 'someone-else' },
        { source: 'unknown_source' },
        { outcome: 'shrug' },
        { occurredAt: 'yesterday' },
        { scopeId: '  ' },
        { subjectId: '' },
      ];
      for (const patch of missing) {
        assert.throws(
          () => store.append({ ...input(), ...patch } as AppendFeedbackEventInput, RECORDED),
          /feedback events:/,
          `append must reject ${JSON.stringify(patch)}`,
        );
      }
      assert.throws(() => store.append(input(), 'not-a-timestamp'), /feedback events:/);
      assert.throws(
        () => store.append(input({ source: 'migration_baseline' as never }), RECORDED),
        /feedback events:/,
        'migration_baseline is a baseline marker and must never be appendable as an event',
      );
      assert.equal(store.list({ scopeId: 'scope-a' }).length, 0, 'no rejected input may leave a record');
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] append ignores forged server-assigned fields`, () => {
    const { store, cleanup } = make();
    try {
      const forged = {
        ...input(),
        id: 'fbk_forged',
        version: 'feedback-event-v0',
        recordedAt: '1999-01-01T00:00:00.000Z',
        idempotencyKey: 'forged-key',
        revokedAt: '1999-01-01T00:00:00.000Z',
        smuggled: 'nope',
      } as unknown as AppendFeedbackEventInput;

      const event = store.append(forged, RECORDED);
      assert.notEqual(event.id, 'fbk_forged');
      assert.equal(event.version, FEEDBACK_EVENT_SCHEMA_VERSION);
      assert.equal(event.recordedAt, RECORDED);
      assert.notEqual(event.idempotencyKey, 'forged-key');
      assert.equal(
        Object.prototype.hasOwnProperty.call(event, 'revokedAt'),
        false,
        'a caller must not be able to forge a revocation',
      );
      assert.equal(Object.prototype.hasOwnProperty.call(event, 'smuggled'), false);
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] revoke stamps revokedAt and rewrites nothing else`, () => {
    const { store, cleanup } = make();
    try {
      const event = store.append(input(), RECORDED);
      assert.equal(store.revoke(event.id, LATER), true);

      const revoked = store.get(event.id);
      assert.ok(revoked, 'a revoked event is corrected, never deleted');
      assert.equal(revoked.revokedAt, LATER);
      assert.deepEqual(
        { ...revoked, revokedAt: undefined },
        { ...event, revokedAt: undefined },
        'revoke must touch no field but revokedAt',
      );
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] revoking twice returns false and keeps the first correction time`, () => {
    const { store, cleanup } = make();
    try {
      const event = store.append(input(), RECORDED);
      assert.equal(store.revoke(event.id, RECORDED), true);
      assert.equal(store.revoke(event.id, LATER), false, 'a second revocation is not a new correction');
      assert.equal(
        store.get(event.id)?.revokedAt,
        RECORDED,
        'revokedAt records when the user made the correction and must not move',
      );
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] revoke returns false for an unknown or malformed id`, () => {
    const { store, cleanup } = make();
    try {
      assert.equal(store.revoke('fbk_missing', LATER), false);
      assert.equal(store.revoke('../../etc/passwd', LATER), false);
      assert.throws(() => store.revoke('fbk_missing', 'whenever'), /feedback events:/);
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] appending after a revocation leaves the revoked event untouched`, () => {
    const { store, cleanup } = make();
    try {
      const first = store.append(input(), RECORDED);
      store.revoke(first.id, RECORDED);
      store.append(input({ subjectId: 'commitment-2' }), LATER);
      // A retry of the revoked event must replay it, not resurrect it.
      const replay = store.append(input(), LATER);
      assert.equal(replay.revokedAt, RECORDED, 'a retry must not clear a revocation');
      assert.equal(store.list({ scopeId: 'scope-a' }).length, 2);
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] revoked events stay in history and are excluded only on request`, () => {
    const { store, cleanup } = make();
    try {
      const kept = store.append(input(), RECORDED);
      const corrected = store.append(input({ subjectId: 'commitment-2' }), RECORDED);
      store.revoke(corrected.id, LATER);

      const all = store.list({ scopeId: 'scope-a' });
      assert.equal(all.length, 2, 'history must show corrections by default');
      const live = store.list({ scopeId: 'scope-a', includeRevoked: false });
      assert.deepEqual(live.map((event) => event.id), [kept.id]);
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] list orders by when the behaviour happened, as instants`, () => {
    const { store, cleanup } = make();
    try {
      // Middle entry carries a +03:00 offset: it is 09:00Z, so a textual sort
      // would rank it last and `limit` would then drop the actual newest.
      store.append(input({ subjectId: 'b', occurredAt: '2026-08-18T12:00:00.000+03:00' }), RECORDED);
      store.append(input({ subjectId: 'c', occurredAt: '2026-08-18T18:00:00.000Z' }), RECORDED);
      store.append(input({ subjectId: 'a', occurredAt: '2026-08-18T06:00:00.000Z' }), RECORDED);

      assert.deepEqual(
        store.list({ scopeId: 'scope-a' }).map((event) => event.subjectId),
        ['a', 'b', 'c'],
      );
      assert.deepEqual(
        store.list({ scopeId: 'scope-a', newestFirst: true }).map((event) => event.subjectId),
        ['c', 'b', 'a'],
      );
      assert.deepEqual(
        store.list({ scopeId: 'scope-a', newestFirst: true, limit: 1 }).map((event) => event.subjectId),
        ['c'],
        'limit must keep the newest, not the first written',
      );
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] list never leaks a sibling scope`, () => {
    const { store, cleanup } = make();
    try {
      store.append(input(), RECORDED);
      store.append(input({ scopeId: 'scope-b' }), RECORDED);
      const rows = store.list({ scopeId: 'scope-a' });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].scopeId, 'scope-a');
      assert.throws(() => store.list({ scopeId: '' }), /feedback events:/);
      assert.throws(() => store.list({ scopeId: 'scope-a', limit: 0 }), /feedback events:/);
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] Arabic and Hebrew ids round-trip byte-identically`, () => {
    const { store, cleanup } = make();
    try {
      const arabic = store.append(input({ scopeId: ARABIC, subjectId: HEBREW }), RECORDED);
      assert.equal(arabic.scopeId, ARABIC);
      assert.equal(arabic.subjectId, HEBREW);

      const stored = store.get(arabic.id);
      assert.equal(stored?.scopeId, ARABIC);
      assert.equal(stored?.subjectId, HEBREW);
      assert.equal(
        Buffer.from(stored?.subjectId ?? '', 'utf8').equals(Buffer.from(HEBREW, 'utf8')),
        true,
        'no normalization pass may re-encode the user\'s own words',
      );

      const replay = store.append(input({ scopeId: ARABIC, subjectId: HEBREW }), LATER);
      assert.equal(replay.id, arabic.id, 'idempotency must survive non-ASCII ids');
      assert.equal(store.list({ scopeId: ARABIC }).length, 1);
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] get returns null for an unknown or malformed id`, () => {
    const { store, cleanup } = make();
    try {
      for (const id of ['fbk_missing', '../../etc/passwd', '', 'fbk_a/../../x']) {
        assert.equal(store.get(id), null, `get(${id}) must not resolve`);
      }
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] events are frozen, so the readonly contract holds at runtime`, () => {
    const { store, cleanup } = make();
    try {
      const event = store.append(input(), RECORDED);
      assert.equal(Object.isFrozen(event), true);
      assert.throws(() => {
        (event as { outcome: string }).outcome = 'reject';
      });
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] the baseline round-trips verbatim and is scoped`, () => {
    const { store, cleanup } = make();
    try {
      assert.equal(store.readBaseline('scope-a'), null);
      store.writeBaseline(baseline());
      assert.deepEqual(store.readBaseline('scope-a'), baseline());
      assert.equal(store.readBaseline('scope-b'), null);
      assert.equal(Object.isFrozen(store.readBaseline('scope-a')), true);
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] writeBaseline rejects a baseline that misstates its own limits`, () => {
    const { store, cleanup } = make();
    try {
      const rejected: readonly Partial<Record<keyof FeedbackBaseline, unknown>>[] = [
        { timestampsUnavailable: false },
        { timestampsUnavailable: undefined },
        { version: 'feedback-event-v0' },
        { scopeId: '' },
        { migratedAt: 'sometime' },
        { lastUpdatedAt: 'sometime' },
        { counters: { ignoredSuggestions: -1, completedActions: 0, delayedActions: 0, clarificationSuccesses: 0, clarificationFailures: 0 } },
        { counters: { ignoredSuggestions: 1.5, completedActions: 0, delayedActions: 0, clarificationSuccesses: 0, clarificationFailures: 0 } },
        { counters: { completedActions: 0, delayedActions: 0, clarificationSuccesses: 0, clarificationFailures: 0 } },
      ];
      for (const patch of rejected) {
        assert.throws(
          () => store.writeBaseline({ ...baseline(), ...patch } as FeedbackBaseline),
          /feedback events:/,
          `writeBaseline must reject ${JSON.stringify(patch)}`,
        );
      }
      assert.equal(store.readBaseline('scope-a'), null);
      // lastUpdatedAt is nullable: the legacy store leaves it null until first use.
      store.writeBaseline(baseline({ lastUpdatedAt: null }));
      assert.equal(store.readBaseline('scope-a')?.lastUpdatedAt, null);
    } finally {
      cleanup();
    }
  });

  test(`[${backend}] deleteScope removes the scope's events and baseline, leaving a sibling intact`, () => {
    const { store, cleanup } = make();
    try {
      store.append(input(), RECORDED);
      store.append(input({ subjectId: 'commitment-2' }), RECORDED);
      store.append(input({ scopeId: 'scope-b' }), RECORDED);
      store.writeBaseline(baseline());
      store.writeBaseline(baseline({ scopeId: 'scope-b' }));

      assert.equal(store.deleteScope('scope-a'), 2, 'the count reports events removed');
      assert.equal(store.list({ scopeId: 'scope-a' }).length, 0);
      assert.equal(
        store.readBaseline('scope-a'),
        null,
        'the legacy counters are the user\'s data too and must not survive deletion',
      );
      assert.equal(store.list({ scopeId: 'scope-b' }).length, 1);
      assert.deepEqual(store.readBaseline('scope-b'), baseline({ scopeId: 'scope-b' }));
      assert.equal(store.deleteScope('scope-a'), 0, 'deleting twice is a no-op');
      assert.throws(() => store.deleteScope(''), /feedback events:/);
    } finally {
      cleanup();
    }
  });
}
