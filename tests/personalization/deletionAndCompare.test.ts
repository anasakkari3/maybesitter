/**
 * Deletion receipts and profile comparison.
 *
 * Two deliverables of #41 that exist to serve the other two tracks: #42 must be
 * able to *verify* a deletion rather than be told about one, and both #42 and
 * #43 need one answer to "what changed between these two profiles".
 *
 * The receipt tests are written from the verifier's side on purpose. Every
 * assertion recomputes the fact from the stores or from an independent digest
 * call, never from the value the deleting function returned — a receipt checked
 * against its own producer proves only that the producer is self-consistent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type FeedbackEvent,
  type FeedbackOutcome,
} from '../../src/contracts/v1/feedbackContracts.ts';
import {
  PERSONALIZATION_CONTRACT_VERSION,
  PERSONALIZATION_SCHEMA_VERSION,
  PREFERENCE_DIMENSIONS,
  checkPersonalizationDeletionReceipt,
  type PersonalizationConsent,
} from '../../src/contracts/v1/personalizationContracts.ts';
import { createInMemoryFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { computeFeedbackInputDigest, resolveFeedbackWindowDays } from '../../lib/feedback/feedbackAggregation.ts';
import { deletePersonalizationScope, emptyStateDigestFor } from '../../lib/personalization/deletion.ts';
import { rebuildPersonalizationProfile } from '../../lib/personalization/rebuild.ts';
import { PROBATIVE_OUTCOMES } from '../../lib/personalization/derive.ts';
import {
  COMPARED_FIELDS,
  comparePersonalizationProfiles,
  profilesAgree,
} from '../../lib/personalization/compare.ts';

const NOW = '2026-08-20T09:00:00.000Z';
const SCOPE = 'alice';
const OTHER = 'bob';
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const ENABLED: PersonalizationConsent = Object.freeze({ state: 'enabled', changedAt: NOW });
const DISABLED: PersonalizationConsent = Object.freeze({ state: 'disabled', changedAt: NOW });

let sequence = 0;

function event(outcome: FeedbackOutcome, ageDays: number, scopeId = SCOPE): FeedbackEvent {
  sequence += 1;
  const occurredAt = new Date(Date.parse(NOW) - ageDays * MS_PER_DAY).toISOString();
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    id: `evt-${sequence}`,
    scopeId,
    outcome,
    subjectId: `subject-${sequence}`,
    actor: 'user',
    source: 'mobile_action',
    occurredAt,
    recordedAt: occurredAt,
    idempotencyKey: `key-${sequence}`,
  };
}

function many(outcome: FeedbackOutcome, count: number, ageDays: number, scopeId = SCOPE): FeedbackEvent[] {
  return Array.from({ length: count }, () => event(outcome, ageDays, scopeId));
}

function memoryInput() {
  return {
    scopeId: SCOPE,
    kind: 'preference' as const,
    content: 'quieter mornings',
    language: 'en' as const,
    source: 'user_stated' as const,
    confidence: 1,
    observedAt: NOW,
  };
}

function profileFor(events: readonly FeedbackEvent[], consent: PersonalizationConsent = ENABLED) {
  return rebuildPersonalizationProfile({ scopeId: SCOPE, now: NOW, consent, events, baseline: null });
}

function storesWith(events: readonly FeedbackEvent[]) {
  const feedbackEvents = createInMemoryFeedbackEventStore();
  for (const entry of events) {
    feedbackEvents.append(
      // No `idempotencyKey`: the store derives its own from
      // (scopeId, subjectId, outcome, occurredAt) and ignores anything the
      // caller supplies. That is why every fixture event above carries a
      // distinct `subjectId` — without it, `many()` would collapse to a single
      // stored row and every remainder assertion below would pass on an
      // implementation that deletes almost nothing.
      {
        scopeId: entry.scopeId,
        outcome: entry.outcome,
        subjectId: entry.subjectId,
        actor: entry.actor,
        source: 'mobile_action',
        occurredAt: entry.occurredAt,
      },
      entry.recordedAt,
    );
  }
  const runtimeMemory = createInMemoryRuntimeMemoryStore();
  return { feedbackEvents, runtimeMemory };
}

/* ── The baseline: the fixture must not already be empty ─────────── */

test('the fixture holds something before deletion, or every remainder below is meaningless', () => {
  // A deletion test whose scope was empty to begin with passes on any
  // implementation, including one that deletes nothing at all.
  const { feedbackEvents, runtimeMemory } = storesWith(many('accept', 4, 1));
  runtimeMemory.put(
    memoryInput(),
    NOW,
  );
  assert.equal(feedbackEvents.list({ scopeId: SCOPE }).length, 4);
  assert.equal(runtimeMemory.listAll(SCOPE).length, 1);
});

/* ── Receipt ─────────────────────────────────────────────────────── */

test('a deletion receipt reports remainders the caller can recount, and they are zero', () => {
  const { feedbackEvents, runtimeMemory } = storesWith([...many('accept', 4, 1), ...many('reject', 3, 30)]);
  runtimeMemory.put(
    memoryInput(),
    NOW,
  );

  const receipt = deletePersonalizationScope({ scopeId: SCOPE, now: NOW, feedbackEvents, runtimeMemory });

  assert.deepEqual(checkPersonalizationDeletionReceipt(receipt), []);
  assert.equal(receipt.version, PERSONALIZATION_CONTRACT_VERSION);
  assert.equal(receipt.schemaVersion, PERSONALIZATION_SCHEMA_VERSION);
  assert.equal(receipt.scopeId, SCOPE);
  assert.equal(receipt.deletedAt, NOW);

  // Recounted from the stores, not read from the receipt.
  assert.equal(feedbackEvents.list({ scopeId: SCOPE }).length, 0);
  assert.equal(runtimeMemory.listAll(SCOPE).length, 0);
  assert.equal(receipt.remainingFeedbackEventCount, 0);
  assert.equal(receipt.remainingRuntimeMemoryRecordCount, 0);
  assert.equal(receipt.remainingPersistedProfileCount, 0);
});

test('deletion is a purge, not a mass revocation: nothing survives listing with revoked included', () => {
  // The distinction the header argues for. `list` includes revoked events by
  // default precisely so history stays inspectable, so a mass-revoke
  // implementation would leave these rows visible right here.
  const { feedbackEvents, runtimeMemory } = storesWith(many('accept', 5, 1));
  deletePersonalizationScope({ scopeId: SCOPE, now: NOW, feedbackEvents, runtimeMemory });
  assert.deepEqual(feedbackEvents.list({ scopeId: SCOPE, includeRevoked: true }), []);
});

test('the empty-state digest is reproducible by a verifier that never calls the deleter', () => {
  // #42's acceptance criterion. The digest is recomputed from the aggregation
  // primitives directly, which is the path a verifier on the other side of the
  // seam has — if these two ever diverge, the receipt stops being checkable.
  const { feedbackEvents, runtimeMemory } = storesWith(many('accept', 4, 1));
  const receipt = deletePersonalizationScope({ scopeId: SCOPE, now: NOW, feedbackEvents, runtimeMemory });

  const independent = computeFeedbackInputDigest({
    events: [],
    baseline: null,
    scopeId: SCOPE,
    now: NOW,
    windowDays: resolveFeedbackWindowDays(undefined),
  });
  assert.equal(receipt.emptyStateDigest, independent);
  assert.equal(emptyStateDigestFor(SCOPE, NOW), independent);
});

test('the empty-state digest is scope-specific and instant-specific', () => {
  // Otherwise one user's receipt would verify another user's deletion, and a
  // receipt from last week would verify today's.
  assert.notEqual(emptyStateDigestFor(SCOPE, NOW), emptyStateDigestFor(OTHER, NOW));
  assert.notEqual(emptyStateDigestFor(SCOPE, NOW), emptyStateDigestFor(SCOPE, '2026-08-21T09:00:00.000Z'));
});

test('deleting one scope leaves another scope entirely alone', () => {
  const { feedbackEvents, runtimeMemory } = storesWith([...many('accept', 3, 1), ...many('reject', 2, 1, OTHER)]);
  deletePersonalizationScope({ scopeId: SCOPE, now: NOW, feedbackEvents, runtimeMemory });
  assert.equal(feedbackEvents.list({ scopeId: SCOPE }).length, 0);
  assert.equal(feedbackEvents.list({ scopeId: OTHER }).length, 2);
});

/* ── Comparison ──────────────────────────────────────────────────── */

test('a profile compared with itself reports no change at all', () => {
  const events = [...many('accept', 6, 1), ...many('reject', 2, 30)];
  const diff = comparePersonalizationProfiles(profileFor(events), profileFor(events));
  assert.deepEqual(diff.changes, []);
  assert.equal(diff.consentChanged, false);
  assert.equal(profilesAgree(profileFor(events), profileFor(events)), true);
});

test('a change is located at a (dimension, field) pair, not at a dimension', () => {
  // The Sprint 08 lesson made local: a dimension-level diff would report one
  // entry here and lose which of the reading's fields actually moved.
  const before = profileFor([...many('accept', 8, 1)]);
  const after = profileFor([...many('reject', 8, 1)]);
  const diff = comparePersonalizationProfiles(before, after);

  const ceiling = diff.changes.filter((change) => change.dimension === 'pressure_ceiling');
  assert.ok(ceiling.length > 1, 'a reversal moved only one field, which means fields are being collapsed');
  const fields = ceiling.map((change) => change.field);
  assert.ok(fields.includes('level'), `the level did not move on a reversal: ${JSON.stringify(diff.changes)}`);
  // Every reported field is one this module declares it compares.
  for (const change of diff.changes) {
    assert.ok(COMPARED_FIELDS.includes(change.field), `undeclared field reported: ${change.field}`);
  }
});

test('evidence moving is reported even when level and confidence hold still', () => {
  // A reading standing on different facts is a changed reading. #43 needs this
  // to tell a stable preference from one re-derived from scratch each window.
  const before = profileFor(many('reject', 8, 1));
  const after = profileFor(many('reject', 8, 100));
  const diff = comparePersonalizationProfiles(before, after);

  const ceiling = diff.changes.filter((change) => change.dimension === 'pressure_ceiling');
  const fields = ceiling.map((change) => change.field);
  assert.ok(fields.includes('evidence'), `evidence did not move across a ladder shift: ${JSON.stringify(ceiling)}`);
  assert.ok(!fields.includes('level'), 'the fixture was supposed to hold the level still');
});

test('a consent flip is reported as consent, not as four preference reversals', () => {
  const events = many('accept', 8, 1);
  const diff = comparePersonalizationProfiles(profileFor(events), profileFor(events, DISABLED));
  assert.equal(diff.consentChanged, true);
  assert.equal(diff.beforeConsent, 'enabled');
  assert.equal(diff.afterConsent, 'disabled');
  assert.deepEqual(diff.changes, [], 'a disabled profile has no readings, so it can contradict none');
  assert.equal(profilesAgree(profileFor(events), profileFor(events, DISABLED)), false);
});

test('every derivable dimension moves, and the one that cannot is the one declared inert', () => {
  // A diff that never looks at a dimension reports agreement about it forever,
  // so this sweeps all four rather than sampling.
  //
  // It does not assert that all four *move*, because one cannot. `pressure_tone`
  // has an empty probative set by decision — no outcome count distinguishes
  // soft from firm, so v1 leaves it `inconclusive` in every profile. The
  // partition below is read from `PROBATIVE_OUTCOMES` rather than hard-coded,
  // which is what makes this a check instead of a restatement: a dimension that
  // gains a rule and stays still fails here, and so does one that loses its rule
  // and keeps moving.
  const before = profileFor([...many('accept', 10, 1), ...many('complete', 6, 1)]);
  const after = profileFor([...many('reject', 10, 1), ...many('ignore', 6, 1)]);
  const moved = new Set(comparePersonalizationProfiles(before, after).changes.map((c) => c.dimension));

  const derivable = PREFERENCE_DIMENSIONS.filter((d) => PROBATIVE_OUTCOMES[d].length > 0);
  const inert = PREFERENCE_DIMENSIONS.filter((d) => PROBATIVE_OUTCOMES[d].length === 0);

  assert.deepEqual(
    inert,
    ['pressure_tone'],
    'the set of never-derived dimensions changed; that is a product decision, not a test detail',
  );
  assert.deepEqual(
    derivable.filter((dimension) => !moved.has(dimension)),
    [],
    'a dimension with a derivation rule never moved across a full behavioural reversal',
  );
  for (const dimension of inert) {
    assert.ok(!moved.has(dimension), `${dimension} has no probative outcomes yet its reading moved`);
  }
});
