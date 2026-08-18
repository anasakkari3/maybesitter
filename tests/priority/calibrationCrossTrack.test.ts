/**
 * The three Sprint 05 tracks, joined and run against each other.
 *
 * #21 (queue), #22 (calibration) and #23 (shadow) were built in parallel
 * against contracts written first, so each was verified only against its own
 * reading of them. Sprints 02, 03 and 04 each showed that is not enough — and
 * in Sprint 04 the cross-track run was also what proved the delegation safe.
 *
 * The path this file exercises is the one the sprint exists to build:
 * reviewer decisions become a corpus, the corpus drives a calibration, and the
 * candidate that calibration finds is compared against the frozen policy
 * before anything is shipped. No single track can test that path, and the most
 * important property of it — that none of this moves the production weights —
 * only becomes checkable once all three are present.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createReviewedDecision } from '../../lib/priority/annotation/reviewedDecision.ts';
import { createInMemoryDecisionStore } from '../../lib/priority/annotation/decisionStore.ts';
import { ingestIntoStore } from '../../lib/priority/annotation/decisionIngest.ts';
import { buildAnnotationQueue } from '../../lib/priority/annotation/annotationQueue.ts';
import { buildSeedCorpus } from '../../lib/priority/calibration/seedCorpus.ts';
import { runCalibration } from '../../lib/priority/calibration/calibrate.ts';
import { buildShadowComparisonReport } from '../../lib/priority/shadow/shadowComparison.ts';
import { derivePolicy } from '../../lib/priority/shadow/candidatePolicy.ts';
import { DEFAULT_PRIORITY_POLICY } from '../../lib/priority/priorityPolicy.ts';
import { PRIORITY_SEED_PAIRS } from '../fixtures/prioritySeedSet.ts';
import type { Commitment, Reminder } from '../../src/domain/stateMachine.ts';
import type { PairwiseJudgment } from '../../src/contracts/v1/priorityContracts.ts';

const NOW = '2026-08-19T12:00:00.000Z';
const GENERATED_AT = '2026-08-19T12:00:00.000Z';

/** Pairs from the calibration split; the locked split is reserved for the gate. */
function calibrationPairs() {
  return PRIORITY_SEED_PAIRS.filter((pair) => pair.split === 'calibration');
}

/**
 * Synthetic decisions, constructed here as test inputs.
 *
 * Legitimate precisely because they never leave this file: the shipped corpus
 * stays empty, and the corpus must be told they are synthetic — provenance is
 * declared, never guessed from whether rows happen to exist.
 */
function syntheticDecisions(count: number) {
  return calibrationPairs().slice(0, count).map((pair, index) =>
    createReviewedDecision({
      pairId: pair.pairId,
      reviewerId: `rev-${index % 2 === 0 ? 'a' : 'b'}`,
      verdict: index % 3 === 0 ? 'right' : 'left',
      rationale: 'C1: synthetic pipeline proof, not a human judgment',
      hardConstraintFlag: false,
      decidedAt: '2026-08-18T09:00:00.000Z',
    }),
  );
}

function judgmentsFrom(decisions: readonly ReturnType<typeof createReviewedDecision>[]): PairwiseJudgment[] {
  const byPairId = new Map(PRIORITY_SEED_PAIRS.map((pair) => [pair.pairId, pair]));
  return decisions.map((decision) => {
    const pair = byPairId.get(decision.pairId);
    assert.ok(pair, `seed pair missing for ${decision.pairId}`);
    return {
      pairId: decision.pairId,
      leftCommitmentId: pair.left.commitment.id,
      rightCommitmentId: pair.right.commitment.id,
      verdict: decision.verdict,
      annotatorId: decision.reviewerId,
      rationale: decision.rationale,
      judgedAt: decision.decidedAt,
    };
  });
}

function commitment(id: string, overrides: Partial<Commitment> = {}): Commitment {
  return {
    id,
    kind: 'task',
    title: 'Call the clinic',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: true, pressureLevel: 'gentle' },
    timeSpec: { kind: 'due_by', dueAt: '2026-08-19T11:00:00.000Z', remindAt: null, timezone: 'UTC' },
    currentAckState: 'seen',
    postponedUntil: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    confirmedAt: null,
    completedAt: null,
    droppedAt: null,
    ...overrides,
  };
}

test('decisions flow into a corpus, a calibration runs, and the shipped policy still does not move', () => {
  const store = createInMemoryDecisionStore();
  const decisions = syntheticDecisions(6);
  const queue = buildAnnotationQueue({ enqueuedAt: '2026-08-18T08:00:00.000Z' }).items;
  const ingested = ingestIntoStore(decisions, store, { queue });
  assert.equal(ingested.accepted.length, decisions.length, 'every well-formed decision should be accepted');

  const corpus = buildSeedCorpus({ split: 'calibration', judgments: judgmentsFrom(ingested.accepted), provenance: 'synthetic_pipeline_proof' });
  assert.equal(
    corpus.provenance,
    'synthetic_pipeline_proof',
    'provenance is derived from the rows, so a synthetic run cannot present itself as human evidence',
  );

  const report = runCalibration({
    corpus,
    basePolicy: DEFAULT_PRIORITY_POLICY,
    generatedAt: GENERATED_AT,
    searchSeed: 42,
  });

  // The property the whole sprint turns on, and the only place all three
  // tracks are present at once to check it.
  assert.equal(report.policyUnchanged, true);
  assert.deepEqual(
    { ...DEFAULT_PRIORITY_POLICY.weights },
    { ...report.baseline.policy.weights },
    'a calibration run must not mutate the policy it was handed',
  );
  assert.equal(report.manifest.corpusProvenance, 'synthetic_pipeline_proof');
});

test('a calibration candidate can be shadow-compared against the frozen policy before anyone ships it', () => {
  const corpus = buildSeedCorpus({
    split: 'calibration',
    judgments: judgmentsFrom(syntheticDecisions(6)),
    provenance: 'synthetic_pipeline_proof',
  });
  const report = runCalibration({
    corpus,
    basePolicy: DEFAULT_PRIORITY_POLICY,
    generatedAt: GENERATED_AT,
    searchSeed: 42,
  });

  // Whatever the sweep found — or a deliberate perturbation when it found
  // nothing better — is what a reviewer would want to see the effect of.
  const candidate = report.best?.policy
    ?? derivePolicy(DEFAULT_PRIORITY_POLICY, { version: 'priority-policy-crosstrack-probe', weights: { importanceHigh: 300 } });

  const subjects = [
    { commitment: commitment('c_high', {
      priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'firm' },
    }), reminders: [] as Reminder[], reason: 'overdue' as const },
    { commitment: commitment('c_normal'), reminders: [] as Reminder[], reason: 'overdue' as const },
  ];

  const shadow = buildShadowComparisonReport({
    subjects,
    baselinePolicy: DEFAULT_PRIORITY_POLICY,
    candidatePolicy: candidate,
    sampling: { rate: 1, seed: 7 },
    now: NOW,
    generatedAt: GENERATED_AT,
  });

  assert.equal(shadow.comparedCount, subjects.length);
  const causeTotal = Object.values(shadow.byCause).reduce((sum, count) => sum + count, 0);
  assert.equal(causeTotal, shadow.disagreements.length, 'byCause must account for every disagreement, exactly once');

  // Still frozen after a full pass through all three tracks.
  assert.equal(DEFAULT_PRIORITY_POLICY.weights.importanceHigh, 180);
});

test('a disagreement between reviewers survives the whole path instead of being averaged away', () => {
  const store = createInMemoryDecisionStore();
  const pair = calibrationPairs()[0];
  const conflicting = [
    createReviewedDecision({
      pairId: pair.pairId, reviewerId: 'rev-a', verdict: 'left',
      rationale: 'C1: left is more urgent', hardConstraintFlag: false,
      decidedAt: '2026-08-18T09:00:00.000Z',
    }),
    createReviewedDecision({
      pairId: pair.pairId, reviewerId: 'rev-b', verdict: 'right',
      rationale: 'C1: right is more urgent', hardConstraintFlag: false,
      decidedAt: '2026-08-18T09:05:00.000Z',
    }),
  ];

  const queue = buildAnnotationQueue({ enqueuedAt: '2026-08-18T08:00:00.000Z' }).items;
  const ingested = ingestIntoStore(conflicting, store, { queue });

  assert.equal(ingested.accepted.length, 2, 'both reviewers are recorded; neither overwrites the other');
  assert.equal(ingested.conflicts.length, 1, 'and the disagreement is surfaced rather than resolved');
  assert.deepEqual([...ingested.conflicts[0].verdicts].sort(), ['left', 'right']);

  // Disagreement usually means the rubric is ambiguous at that pair, which is a
  // fact about the rubric. Averaging would destroy it exactly where it is most
  // informative — and would hand calibration a preference nobody held.
  const corpus = buildSeedCorpus({ split: 'calibration', judgments: judgmentsFrom(ingested.accepted), provenance: 'synthetic_pipeline_proof' });
  const report = runCalibration({
    corpus, basePolicy: DEFAULT_PRIORITY_POLICY, generatedAt: GENERATED_AT, searchSeed: 42,
  });
  assert.equal(
    report.baseline.overall.scorablePairs,
    0,
    'a pair its own reviewers disagree on must not be scored as if it had an answer',
  );
});

test('an empty corpus produces no calibration evidence at all', () => {
  const corpus = buildSeedCorpus({ split: 'calibration', judgments: [] });
  const report = runCalibration({
    corpus, basePolicy: DEFAULT_PRIORITY_POLICY, generatedAt: GENERATED_AT, searchSeed: 42,
  });

  // The shipped state. A rate of 0 would read as "the policy agrees with
  // nobody"; null reads as "nothing was measured", which is the truth.
  assert.equal(report.baseline.overall.rate, null);
  assert.equal(report.policyUnchanged, true);
});

test('a non-empty corpus refuses to guess its own provenance', () => {
  // The defect this replaced: provenance was inferred from whether rows
  // existed, so any non-empty set was labelled `human_reviewed`. Synthetic
  // rows are the only kind that exist today, so every pipeline run stamped
  // its manifest as human evidence — the precise confusion the field exists
  // to prevent. "The rows exist" is not the claim "a person made them".
  assert.throws(
    () => buildSeedCorpus({
      split: 'calibration',
      judgments: judgmentsFrom(syntheticDecisions(2)),
      // provenance deliberately omitted
    }),
    /provenance must be declared/,
    'supplying rows without saying where they came from must fail loudly',
  );
});

test('declaring synthetic provenance keeps it out of the manifest as human evidence', () => {
  const corpus = buildSeedCorpus({
    split: 'calibration',
    judgments: judgmentsFrom(syntheticDecisions(4)),
    provenance: 'synthetic_pipeline_proof',
  });
  const report = runCalibration({
    corpus, basePolicy: DEFAULT_PRIORITY_POLICY, generatedAt: GENERATED_AT, searchSeed: 42,
  });

  assert.equal(report.manifest.corpusProvenance, 'synthetic_pipeline_proof');
  assert.notEqual(
    report.manifest.corpusProvenance,
    'human_reviewed',
    'a run over rows nobody made must never be stored as human evidence',
  );
});
