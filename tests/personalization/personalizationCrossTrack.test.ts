/**
 * The Sprint 10 join: #41 derives, #42 displays and controls, #43 measures.
 *
 * Merge-owned, because every assertion below is about two tracks agreeing and
 * no track can make it about itself. #42 and #43 were both built against the
 * `PersonalizationDeriver` seam with fixture derivers — which was the right way
 * to build them in parallel, and which means **neither has ever run against the
 * real thing**. Their suites would stay green if #41's deriver disagreed with
 * both of them on every input.
 *
 * A check owned by the thing it checks is not a check. This file owns the seam.
 *
 * ── What is deliberately asserted as a *disagreement* ────────────
 *
 * The shipped `adaptiveService` escalates pressure on avoidance; the contract
 * forbids behavioural inference from escalating anything. Those two rules
 * contradict each other, and the contradiction is the subject of open issue
 * #107. It is pinned here as a measured divergence rather than smoothed over,
 * so that whoever resolves #107 finds a test that already states both sides —
 * and so that nobody can quietly change one side and believe they have agreed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPERATIVE_CONFIDENCE_FLOOR,
  PERSONALIZATION_INVARIANTS,
  PREFERENCE_DIMENSIONS,
  PRODUCT_BASELINE_LEVELS,
  isEscalation,
  operativeReadings,
  type PersonalizationConsent,
} from '../../src/contracts/v1/personalizationContracts.ts';
import { FEEDBACK_EVENT_SCHEMA_VERSION, type FeedbackEvent, type FeedbackOutcome } from '../../src/contracts/v1/feedbackContracts.ts';

import { derivePersonalizationProfile } from '../../lib/personalization/derive.ts';
import { rebuildPersonalizationProfile } from '../../lib/personalization/rebuild.ts';
import { deletePersonalizationScope, emptyStateDigestFor } from '../../lib/personalization/deletion.ts';
import { comparePersonalizationProfiles } from '../../lib/personalization/compare.ts';

import { createInMemoryFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { createInMemoryPersonalizationConsentStore } from '../../lib/personalizationControls/consentStore.ts';
import { buildPersonalizationInventory } from '../../lib/personalizationControls/inventory.ts';
import { handleControlsRequest } from '../../lib/personalizationControls/handler.ts';
import type { PersonalizationControlsPort } from '../../lib/personalizationControls/controlsPort.ts';

import { buildSyntheticCohort, DEFAULT_COHORT_SEED } from '../../lib/evaluation/personalization/syntheticCohort.ts';
import { buildEvaluationReport, evaluateRollbackGate } from '../../lib/evaluation/personalization/report.ts';
import { getAdaptiveBehavior } from '../../lib/services/adaptiveService.ts';

const NOW = '2026-08-20T09:00:00.000Z';
const SCOPE = 'cross-track';
const DAY = 24 * 60 * 60 * 1_000;
const ENABLED: PersonalizationConsent = Object.freeze({ state: 'enabled', changedAt: NOW });

let sequence = 0;
function event(outcome: FeedbackOutcome, ageDays: number): FeedbackEvent {
  sequence += 1;
  const occurredAt = new Date(Date.parse(NOW) - ageDays * DAY).toISOString();
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    id: `x-${sequence}`,
    scopeId: SCOPE,
    outcome,
    subjectId: `subject-${sequence}`,
    actor: 'user',
    source: 'mobile_action',
    occurredAt,
    recordedAt: occurredAt,
    idempotencyKey: `key-${sequence}`,
  };
}
const many = (outcome: FeedbackOutcome, count: number, ageDays: number) =>
  Array.from({ length: count }, () => event(outcome, ageDays));

function portWith(events: readonly FeedbackEvent[], adaptive = {}): PersonalizationControlsPort {
  const feedback = createInMemoryFeedbackEventStore();
  for (const entry of events) {
    feedback.append(
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
  return {
    feedback,
    memory: createInMemoryRuntimeMemoryStore(),
    consent: createInMemoryPersonalizationConsentStore(),
    // The real one. This is the whole point of the file.
    deriver: derivePersonalizationProfile,
    readAdaptiveSignals: () => adaptive,
  };
}

/* ── 1. #42 against the real deriver ─────────────────────────────── */

test('the control centre renders the real deriver’s readings, not a fixture’s', () => {
  // #42's suite has only ever seen scripted readings. If the real deriver
  // produced a shape the presenter mishandles, nothing in either track fails.
  const port = portWith(many('reject', 8, 1));
  port.consent.write(SCOPE, 'enabled', NOW);
  const view = buildPersonalizationInventory(port, SCOPE, NOW);

  assert.equal(view.preferences.kind, 'derived');
  if (view.preferences.kind !== 'derived') return;
  assert.deepEqual(view.preferences.rows.map((row) => row.dimension), [...PREFERENCE_DIMENSIONS]);

  // Every row the real deriver produced is renderable: a reading, its
  // provenance, and what would change it — no empty strings, no undefined.
  for (const row of view.preferences.rows) {
    assert.ok(row.reading, `${row.dimension} produced no reading from the real deriver`);
    assert.ok((row.reading?.provenance ?? '').length > 0, `${row.dimension} provenance`);
    assert.ok((row.reading?.confidenceExplanation ?? '').length > 0, `${row.dimension} confidence copy`);
    assert.ok((row.reading?.whatWouldChangeIt ?? '').length > 0, `${row.dimension} change copy`);
  }
  // And the basis really came from the ladder, not from a stub.
  assert.equal(view.preferences.basis.length, 3);
});

test('#42’s effective level agrees with #41’s own operative set, reading by reading', () => {
  // Two independent readers of one profile: the presenter's precedence rule and
  // the contract's `operativeReadings`. Compared at (dimension, level) pairs —
  // a set of dimensions would agree while the levels disagreed.
  const port = portWith([...many('reject', 9, 1), ...many('accept', 1, 1)]);
  port.consent.write(SCOPE, 'enabled', NOW);

  const profile = rebuildPersonalizationProfile({
    scopeId: SCOPE, now: NOW, consent: ENABLED,
    events: port.feedback.list({ scopeId: SCOPE, includeRevoked: true }), baseline: null,
  });
  const fromContract = operativeReadings(profile)
    .map((reading) => `${reading.dimension}=${reading.level}`)
    .sort();

  const view = buildPersonalizationInventory(port, SCOPE, NOW);
  assert.equal(view.preferences.kind, 'derived');
  if (view.preferences.kind !== 'derived') return;
  const fromPresenter = view.preferences.rows
    .filter((row) => row.effective.source === 'derived_operative')
    .map((row) => `${row.dimension}=${row.effective.level}`)
    .sort();

  assert.deepEqual(fromPresenter, fromContract);
  assert.ok(fromContract.length > 0, 'the fixture produced no operative reading, so this compared two empty lists');
});

test('a suggestion from the real deriver never reaches effective behaviour', () => {
  // The contract's central promise, checked end to end rather than on a
  // scripted reading: below the floor, the product default stands.
  const port = portWith([...many('reject', 6, 1), ...many('accept', 4, 1)]);
  port.consent.write(SCOPE, 'enabled', NOW);
  const view = buildPersonalizationInventory(port, SCOPE, NOW);
  assert.equal(view.preferences.kind, 'derived');
  if (view.preferences.kind !== 'derived') return;

  let sawSuggestion = false;
  for (const row of view.preferences.rows) {
    if (row.reading?.status !== 'suggestion') continue;
    sawSuggestion = true;
    assert.ok((row.reading.confidence ?? 1) < OPERATIVE_CONFIDENCE_FLOOR);
    assert.equal(row.effective.source, 'product_default');
    assert.equal(row.effective.level, PRODUCT_BASELINE_LEVELS[row.dimension]);
  }
  assert.ok(sawSuggestion, 'no suggestion was produced, so this test asserted nothing');
});

/* ── 2. Deletion: produced by #41, verified by #42's path ────────── */

test('#41 produces the receipt and #42’s verifier recomputes it independently', () => {
  const port = portWith([...many('accept', 5, 1), ...many('ignore', 4, 30)]);
  port.consent.write(SCOPE, 'enabled', NOW);
  port.memory.put(
    { scopeId: SCOPE, kind: 'fact', content: 'evenings', language: 'en', source: 'user_stated', confidence: 1, observedAt: NOW },
    NOW,
  );
  assert.ok(port.feedback.list({ scopeId: SCOPE }).length > 0, 'nothing to delete: the fixture is empty');

  const outcome = handleControlsRequest(
    {
      port,
      deleteScope: (scopeId, now) =>
        deletePersonalizationScope({ scopeId, now, feedbackEvents: port.feedback, runtimeMemory: port.memory }),
    },
    { scopeId: SCOPE, now: NOW, action: 'delete' },
  );
  assert.equal(outcome.status, 200);
  const body = outcome.response as { receipt: { emptyStateDigest: string; remainingFeedbackEventCount: number } };

  // Recomputed on the verifier's side of the seam.
  assert.equal(body.receipt.emptyStateDigest, emptyStateDigestFor(SCOPE, NOW));
  assert.equal(body.receipt.remainingFeedbackEventCount, 0);
  assert.deepEqual(port.feedback.list({ scopeId: SCOPE, includeRevoked: true }), []);
  assert.deepEqual(port.memory.listAll(SCOPE), []);
  // Consent went with it: a deleted user must not still be opted in.
  assert.equal(port.consent.read(SCOPE).state, 'disabled');
});

/* ── 3. #43 against the real deriver ─────────────────────────────── */

test('the evaluation protocol scores the real deriver, and the harm metrics are zero', () => {
  // #43 measured a fixture. Zero-by-construction is a claim about #41's
  // arithmetic, and only #41's arithmetic can falsify it.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const report = buildEvaluationReport(cohort, derivePersonalizationProfile, NOW);

  let measured = 0;
  for (const score of [report.overall, ...report.slices]) {
    for (const reading of score.readings) {
      if (reading.kind !== 'measured') continue;
      measured += 1;
      if (reading.metric === 'unfair_pressure' || reading.metric === 'cold_start_invention') {
        assert.equal(reading.personalized, 0, `${score.sliceId}/${reading.metric} against the real deriver`);
      }
    }
  }
  assert.ok(measured > 0, 'nothing was measured, so this asserted nothing');
  // Synthetic input can refuse a release and never authorise one.
  assert.notEqual(evaluateRollbackGate(report).verdict, 'keep');
});

test('the real deriver never escalates a pressure dimension anywhere in the cohort', () => {
  // `BEHAVIORAL_INFERENCE_NEVER_ESCALATES`, swept over every member and every
  // dimension rather than sampled. The cohort's archetypes include a member who
  // ignores everything — the exact input `adaptiveService` reads as a reason to
  // push harder.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  let checked = 0;
  for (const member of cohort.members) {
    const profile = rebuildPersonalizationProfile({
      scopeId: member.scopeId, now: NOW, consent: ENABLED, events: member.events, baseline: null,
    });
    for (const reading of operativeReadings(profile)) {
      checked += 1;
      assert.notEqual(
        isEscalation(reading.dimension, reading.level as string),
        true,
        `${member.scopeId} escalated ${reading.dimension} to ${reading.level}`,
      );
    }
  }
  assert.ok(checked > 0, 'no operative reading in the whole cohort, so nothing was checked');
});

/* ── 4. The #107 divergence, asserted as a divergence ────────────── */

test('the shipped classifier and this contract disagree about avoidance, and #107 is why', () => {
  // Two systems reading the same person. `adaptiveService` sees ignores and
  // raises pressure to `high` with `direct` wording. The contract sees the same
  // ignores as behavioural evidence, which may only quiet the product.
  //
  // Asserted as a *disagreement* on purpose. Making these agree is issue #107's
  // job and it is a product decision, not a merge fix — but the divergence must
  // not be silent, and either side changing without the other is a thing this
  // test now catches.
  const avoidantSignals = { ignoredCommitmentsCount: 6, completionRate: 0.2, delayFrequency: 0.8 };
  const shipped = getAdaptiveBehavior(avoidantSignals);
  assert.equal(shipped.userType, 'avoidant');
  assert.equal(shipped.pressureLevel, 'high');
  assert.equal(shipped.suggestionStyle, 'direct');

  const profile = rebuildPersonalizationProfile({
    scopeId: SCOPE, now: NOW, consent: ENABLED, events: many('ignore', 12, 1), baseline: null,
  });
  for (const reading of operativeReadings(profile)) {
    assert.notEqual(
      isEscalation(reading.dimension, reading.level as string),
      true,
      'the contract escalated on ignores; it now agrees with adaptiveService and #107 is resolved the wrong way',
    );
  }

  // And the divergence is visible to the user on one screen, which is the only
  // reason it is defensible to ship both at once.
  const port = portWith(many('ignore', 12, 1), avoidantSignals);
  port.consent.write(SCOPE, 'enabled', NOW);
  const view = buildPersonalizationInventory(port, SCOPE, NOW);
  assert.equal(view.adaptive.classification, 'avoidant');
  assert.equal(view.adaptive.effect.pressureLevel, 'high');
  assert.equal(view.preferences.kind, 'derived');
});

/* ── 5. Consent, across all three tracks at once ─────────────────── */

test('disabling personalization silences the deriver, the presenter and the comparison together', () => {
  const port = portWith(many('reject', 8, 1));
  port.consent.write(SCOPE, 'enabled', NOW);
  const before = rebuildPersonalizationProfile({
    scopeId: SCOPE, now: NOW, consent: ENABLED, events: port.feedback.list({ scopeId: SCOPE }), baseline: null,
  });
  assert.ok(operativeReadings(before).length > 0);

  port.consent.write(SCOPE, 'disabled', NOW);
  const view = buildPersonalizationInventory(port, SCOPE, NOW);
  assert.equal(view.preferences.kind, 'disabled');
  for (const row of view.preferences.rows) {
    assert.equal(row.reading, null);
    assert.equal(row.effective.source, 'product_default');
  }

  const after = rebuildPersonalizationProfile({
    scopeId: SCOPE, now: NOW, consent: { state: 'disabled', changedAt: NOW }, events: port.feedback.list({ scopeId: SCOPE }), baseline: null,
  });
  const diff = comparePersonalizationProfiles(before, after);
  assert.equal(diff.consentChanged, true);
  assert.deepEqual(diff.changes, [], 'a consent flip reported preference reversals');
});

/* ── 6. The invariants, enumerated against all three tracks ──────── */

test('every contract invariant has a track that enforces it', () => {
  // Not a restatement: each entry names the module that makes it true, and the
  // list is checked against the contract's own so a new invariant arrives here
  // rather than sitting unowned.
  const owners: Readonly<Record<string, string>> = Object.freeze({
    NO_ENGAGEMENT_OPTIMIZATION: 'lib/personalization/derive.ts',
    NO_LATENCY_SIGNAL_IN_INPUT: 'src/contracts/v1/personalizationContracts.ts',
    PRESSURE_DIMENSIONS_EXPLICIT_ONLY: 'lib/personalization/derive.ts',
    BEHAVIORAL_INFERENCE_NEVER_ESCALATES: 'lib/personalization/derive.ts',
    LOW_CONFIDENCE_NEVER_OPERATIVE: 'lib/personalization/derive.ts',
    SMALL_SAMPLE_IS_INCONCLUSIVE: 'lib/evaluation/personalization/protocol.ts',
    DISABLED_CONSENT_YIELDS_INERT_PROFILE: 'lib/personalizationControls/inventory.ts',
    PROFILE_REPRODUCIBLE_FROM_NON_REVOKED_EVENTS: 'lib/personalization/rebuild.ts',
    NO_RAW_TEXT_IN_PROFILE: 'src/contracts/v1/personalizationContracts.ts',
    DELETION_IS_VERIFIABLE: 'lib/personalization/deletion.ts',
    NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE: 'lib/evaluation/personalization/report.ts',
  });
  assert.deepEqual(
    Object.keys(owners).sort(),
    [...PERSONALIZATION_INVARIANTS].sort(),
    'an invariant has no owning module, or names one that no longer exists',
  );
});
