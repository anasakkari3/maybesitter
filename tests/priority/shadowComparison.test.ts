/**
 * Shadow comparison of a candidate policy against the frozen one
 * (Sprint 05, #23).
 *
 * ## Why nothing here compares the frozen policy to itself
 *
 * Issue #23 as written asks to compare "current ordering" against "Priority
 * v1". Sprint 04 made those the same code — `lib/utils/agendaScoring.ts`
 * delegates to `lib/priority/priorityScorer.ts`, and a 260,000-case
 * differential fuzz confirmed the two are numerically identical. A comparison
 * built to that framing would report zero disagreement forever: a dashboard
 * that looks reassuring while measuring nothing.
 *
 * So every substantive test below compares a **deliberately perturbed
 * candidate policy** against the frozen one, and the zero-disagreement case
 * appears exactly once, as the control. That ordering is the point. A suite
 * where both sides are always equal proves only that the code can return zero,
 * which is also what a comparison that never runs returns.
 *
 * ## The cause split
 *
 * `byCause` is the substantive requirement, and the rule it implements is
 * stated once, in `lib/priority/shadow/shadowComparison.ts`. The tests here pin
 * each branch of it against fixtures whose arithmetic is written out in
 * `shadowFixtures.ts`, so a cause assertion below can be checked by hand
 * against the numbers rather than trusted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRIORITY_POLICY } from '../../lib/priority/priorityPolicy.ts';
import { extractPriorityFeatures } from '../../lib/priority/priorityFeatures.ts';
import { scorePriority } from '../../lib/priority/priorityScorer.ts';
import { derivePolicy, policyDelta } from '../../lib/priority/shadow/candidatePolicy.ts';
import {
  buildShadowComparisonReport,
  generateShadowComparisonMarkdown,
  type ShadowComparisonInput,
  type ShadowSubject,
} from '../../lib/priority/shadow/shadowComparison.ts';
import { CALIBRATION_SCHEMA_VERSION } from '../../src/contracts/v1/calibrationContracts.ts';
import type { DisagreementCause, RankDisagreement } from '../../src/contracts/v1/calibrationContracts.ts';
import {
  GENERATED_AT,
  NOW,
  SUBJECT_A,
  SUBJECT_M,
  SUBJECT_P,
  SUBJECT_Q,
  SUBJECT_R,
} from './shadowFixtures.ts';

const FULL_SAMPLE = { rate: 1, seed: 0 } as const;

function compare(
  subjects: readonly ShadowSubject[],
  candidatePolicy = DEFAULT_PRIORITY_POLICY,
  overrides: Partial<ShadowComparisonInput> = {},
) {
  return buildShadowComparisonReport({
    subjects,
    baselinePolicy: DEFAULT_PRIORITY_POLICY,
    candidatePolicy,
    sampling: FULL_SAMPLE,
    now: NOW,
    generatedAt: GENERATED_AT,
    ...overrides,
  });
}

function causeOf(disagreements: readonly RankDisagreement[], commitmentId: string): DisagreementCause {
  const row = disagreements.find((entry) => entry.commitmentId === commitmentId);
  if (row === undefined) {
    throw new assert.AssertionError({ message: `expected a disagreement for ${commitmentId}` });
  }
  return row.cause;
}

function totalFor(subject: ShadowSubject, policy = DEFAULT_PRIORITY_POLICY): number {
  return scorePriority({
    features: extractPriorityFeatures({
      commitment: subject.commitment,
      reminders: subject.reminders,
      now: NOW,
    }),
    reason: subject.reason,
    policy,
  }).total;
}

/* ── The fixtures mean what their comments say ────────────────────── */

test('fixtures: the frozen policy scores the subjects at the totals the fixtures document', () => {
  // Pinned so a fixture edit that quietly changes an ordering fails here, where
  // the arithmetic is visible, rather than in a cause assertion downstream.
  assert.equal(totalFor(SUBJECT_A), 7_326);
  assert.equal(totalFor(SUBJECT_R), 7_332);
  assert.equal(totalFor(SUBJECT_M), 7_300);
  assert.equal(totalFor(SUBJECT_P), 7_186);
  assert.equal(totalFor(SUBJECT_Q), 7_200);
});

/* ── The control ──────────────────────────────────────────────────── */

test('control: two identical policies disagree nowhere and correlate perfectly', () => {
  const report = compare([SUBJECT_A, SUBJECT_R, SUBJECT_M, SUBJECT_P, SUBJECT_Q]);

  assert.equal(report.comparedCount, 5);
  assert.deepEqual(report.disagreements, []);
  assert.deepEqual(report.byCause, { missing_context: 0, scorer_disagreement: 0, mixed: 0 });
  assert.equal(report.rankCorrelation, 1);
});

test('control: a changed weight that no subject is sensitive to still disagrees nowhere', () => {
  // Nothing in this corpus is postponed, so re-weighting postponement moves no
  // total. A zero here is a real measurement about these commitments, which is
  // only meaningful because the tests below show a non-zero is reachable.
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, {
    version: 'priority-policy-candidate-postponed',
    weights: { latenessPostponed: 900 },
  });
  const report = compare([SUBJECT_A, SUBJECT_R, SUBJECT_M], candidate);

  assert.deepEqual(report.disagreements, []);
  assert.equal(report.rankCorrelation, 1);
});

/* ── scorer_disagreement: the tuning did it ───────────────────────── */

test('perturbed weight: a re-weighted known feature flips two subjects, both scorer_disagreement', () => {
  // P 7186 / Q 7200 baseline; importanceHigh 180 -> 400 lifts P to 7406.
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, {
    version: 'priority-policy-candidate-importance',
    weights: { importanceHigh: 400 },
  });
  const report = compare([SUBJECT_P, SUBJECT_Q], candidate);

  assert.equal(report.comparedCount, 2);
  assert.equal(report.disagreements.length, 2);
  assert.equal(causeOf(report.disagreements, 'cmt_p'), 'scorer_disagreement');
  assert.equal(causeOf(report.disagreements, 'cmt_q'), 'scorer_disagreement');
  assert.deepEqual(report.byCause, { missing_context: 0, scorer_disagreement: 2, mixed: 0 });
  assert.equal(report.rankCorrelation, -1);

  const p = report.disagreements.find((entry) => entry.commitmentId === 'cmt_p');
  assert.equal(p?.baselineRank, 2);
  assert.equal(p?.candidateRank, 1);
});

/* ── missing_context: go and collect the input ────────────────────── */

test('missing context: a subject whose own score cannot move, because the re-weighted feature was never measured', () => {
  // A 7326 (userPressure known, recent) / R 7332 (userPressure unknown).
  // userPressureRecent 240 -> 500 lifts A to 7586 and leaves R at 7332.
  // R loses its top rank without its score changing by a single point: the
  // fix is to record when the user ignored it, not to retune anything.
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, {
    version: 'priority-policy-candidate-pressure',
    weights: { userPressureRecent: 500 },
  });
  const report = compare([SUBJECT_A, SUBJECT_R], candidate);

  assert.equal(report.disagreements.length, 2);
  assert.equal(causeOf(report.disagreements, 'cmt_r'), 'missing_context');
  assert.equal(causeOf(report.disagreements, 'cmt_a'), 'scorer_disagreement');
  assert.deepEqual(report.byCause, { missing_context: 1, scorer_disagreement: 1, mixed: 0 });

  const r = report.disagreements.find((entry) => entry.commitmentId === 'cmt_r');
  assert.ok(r?.unknownFeatures.includes('userPressure'), 'the decisive unknown must be named');
});

test('missing context: dependency and effort never make a subject missing_context on their own', () => {
  // They are unknown for every commitment and no policy weights them, so both
  // runs are equally blind to them. A blindness both sides share cannot explain
  // a difference between the two sides — and treating it as a cause would mark
  // every single row missing_context and destroy the split entirely.
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, {
    version: 'priority-policy-candidate-importance',
    weights: { importanceHigh: 400 },
  });
  const report = compare([SUBJECT_P, SUBJECT_Q], candidate);

  for (const disagreement of report.disagreements) {
    assert.ok(disagreement.unknownFeatures.includes('dependency'), 'dependency is reported as unknown');
    assert.ok(disagreement.unknownFeatures.includes('effort'), 'effort is reported as unknown');
    assert.equal(disagreement.cause, 'scorer_disagreement');
  }
});

/* ── mixed, and the sum ───────────────────────────────────────────── */

test('mixed: a subject with a re-weighted known feature and a re-weighted unknown one is both', () => {
  // Baseline R 7332 > A 7326 > M 7300.
  // importanceHigh 180 -> 400 and userPressureRecent 240 -> 500 give
  // A 7586 > M 7520 > R 7332: all three move.
  //   A  score moved, nothing re-weighted is unknown  -> scorer_disagreement
  //   R  score unchanged, userPressure unknown        -> missing_context
  //   M  score moved AND userPressure unknown         -> mixed
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, {
    version: 'priority-policy-candidate-both',
    weights: { importanceHigh: 400, userPressureRecent: 500 },
  });
  const report = compare([SUBJECT_A, SUBJECT_R, SUBJECT_M], candidate);

  assert.equal(report.disagreements.length, 3);
  assert.equal(causeOf(report.disagreements, 'cmt_a'), 'scorer_disagreement');
  assert.equal(causeOf(report.disagreements, 'cmt_r'), 'missing_context');
  assert.equal(causeOf(report.disagreements, 'cmt_m'), 'mixed');
  assert.deepEqual(report.byCause, { missing_context: 1, scorer_disagreement: 1, mixed: 1 });
  assert.equal(report.rankCorrelation, -1 / 3);
});

test('byCause counts sum to the number of disagreements, in every scenario', () => {
  const candidates = [
    DEFAULT_PRIORITY_POLICY,
    derivePolicy(DEFAULT_PRIORITY_POLICY, { version: 'c1', weights: { importanceHigh: 400 } }),
    derivePolicy(DEFAULT_PRIORITY_POLICY, { version: 'c2', weights: { userPressureRecent: 500 } }),
    derivePolicy(DEFAULT_PRIORITY_POLICY, { version: 'c3', weights: { importanceHigh: 400, userPressureRecent: 500 } }),
    derivePolicy(DEFAULT_PRIORITY_POLICY, { version: 'c4', weights: { urgencyOverduePerHour: 1 } }),
    derivePolicy(DEFAULT_PRIORITY_POLICY, { version: 'c5', bandCap: 200 }),
    derivePolicy(DEFAULT_PRIORITY_POLICY, { version: 'c6', reasonBase: { overdue: 4_000 } }),
  ];
  const subjects = [SUBJECT_A, SUBJECT_R, SUBJECT_M, SUBJECT_P, SUBJECT_Q];

  for (const candidate of candidates) {
    const report = compare(subjects, candidate);
    const summed = report.byCause.missing_context + report.byCause.scorer_disagreement + report.byCause.mixed;
    assert.equal(summed, report.disagreements.length, `byCause must account for every row under ${candidate.version}`);
    assert.deepEqual(Object.keys(report.byCause).sort(), ['missing_context', 'mixed', 'scorer_disagreement']);
  }
});

/* ── Sampling, seen through the report ────────────────────────────── */

test('sampling: rate 0 compares nothing and reports it as nothing, not as agreement', () => {
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, { version: 'c', weights: { importanceHigh: 400 } });
  const report = compare([SUBJECT_A, SUBJECT_R, SUBJECT_M, SUBJECT_P, SUBJECT_Q], candidate, {
    sampling: { rate: 0, seed: 42 },
  });

  assert.equal(report.comparedCount, 0);
  assert.deepEqual(report.disagreements, []);
  // Null, not 1. A correlation of 1 over zero commitments would read as perfect
  // agreement, which is the same failure as reporting 0% agreement over an
  // empty judgment corpus.
  assert.equal(report.rankCorrelation, null);
  assert.deepEqual(report.sampling, { rate: 0, seed: 42 });
});

test('sampling: rate 1 compares every subject', () => {
  const report = compare([SUBJECT_A, SUBJECT_R, SUBJECT_M, SUBJECT_P, SUBJECT_Q], DEFAULT_PRIORITY_POLICY, {
    sampling: { rate: 1, seed: 7 },
  });

  assert.equal(report.comparedCount, 5);
  assert.deepEqual(report.sampling, { rate: 1, seed: 7 });
});

test('sampling: the same seed produces the same sample, so a sampled run is reproducible', () => {
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, { version: 'c', weights: { importanceHigh: 400 } });
  const subjects = [SUBJECT_A, SUBJECT_R, SUBJECT_M, SUBJECT_P, SUBJECT_Q];
  const options = { sampling: { rate: 0.5, seed: 11 } };

  assert.deepEqual(compare(subjects, candidate, options), compare(subjects, candidate, options));
});

/* ── Kendall tau ──────────────────────────────────────────────────── */

test('correlation: fewer than two compared items yields null rather than a number', () => {
  assert.equal(compare([]).rankCorrelation, null);
  assert.equal(compare([SUBJECT_A]).rankCorrelation, null);
  assert.equal(compare([SUBJECT_A]).comparedCount, 1);
});

/* ── Determinism and the clock ────────────────────────────────────── */

test('determinism: the same inputs twice produce a deeply equal report', () => {
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, {
    version: 'priority-policy-candidate-both',
    weights: { importanceHigh: 400, userPressureRecent: 500 },
  });
  const subjects = [SUBJECT_M, SUBJECT_A, SUBJECT_R];

  assert.deepEqual(compare(subjects, candidate), compare(subjects, candidate));
});

test('determinism: subject order does not change the report', () => {
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, {
    version: 'priority-policy-candidate-both',
    weights: { importanceHigh: 400, userPressureRecent: 500 },
  });

  assert.deepEqual(
    compare([SUBJECT_A, SUBJECT_R, SUBJECT_M], candidate),
    compare([SUBJECT_M, SUBJECT_A, SUBJECT_R], candidate),
  );
});

test('clock: generatedAt is taken from the caller and echoed verbatim', () => {
  const report = compare([SUBJECT_A], DEFAULT_PRIORITY_POLICY, { generatedAt: '2001-01-01T00:00:00.000Z' });
  assert.equal(report.generatedAt, '2001-01-01T00:00:00.000Z');
});

/* ── Shape and refusals ───────────────────────────────────────────── */

test('report: carries the schema version and both policy versions', () => {
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, { version: 'candidate-v9', weights: { importanceHigh: 400 } });
  const report = compare([SUBJECT_P, SUBJECT_Q], candidate);

  assert.equal(report.version, CALIBRATION_SCHEMA_VERSION);
  assert.equal(report.baselinePolicyVersion, DEFAULT_PRIORITY_POLICY.version);
  assert.equal(report.candidatePolicyVersion, 'candidate-v9');
});

test('report: two subjects sharing a commitment id are refused, not silently ranked', () => {
  // Ranks are keyed by commitment id. A duplicate would make "the rank of
  // cmt_a" ambiguous and quietly attribute one row's movement to the other.
  assert.throws(() => compare([SUBJECT_A, SUBJECT_A]), /duplicate/i);
});

test('report: an unusable now is refused rather than substituted', () => {
  assert.throws(() => compare([SUBJECT_A], DEFAULT_PRIORITY_POLICY, { now: 'sometime' }), /now/);
});

test('markdown: renders the cause split and never collapses it into one number', () => {
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, {
    version: 'priority-policy-candidate-both',
    weights: { importanceHigh: 400, userPressureRecent: 500 },
  });
  const markdown = generateShadowComparisonMarkdown(compare([SUBJECT_A, SUBJECT_R, SUBJECT_M], candidate));

  assert.match(markdown, /missing_context/);
  assert.match(markdown, /scorer_disagreement/);
  assert.match(markdown, /mixed/);
  assert.match(markdown, /cmt_r/);
  assert.match(markdown, /priority-policy-candidate-both/);
});

/* ── The policy delta the cause rule reads ────────────────────────── */

test('policy delta: names the features whose weights moved, and nothing else', () => {
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, {
    version: 'c',
    weights: { importanceHigh: 400, latenessPerSnooze: 5 },
  });
  const delta = policyDelta(DEFAULT_PRIORITY_POLICY, candidate);

  assert.deepEqual(delta.changedWeightKeys, ['importanceHigh', 'latenessPerSnooze']);
  assert.deepEqual(delta.changedFeatures, ['importance', 'lateness']);
  assert.deepEqual(delta.changedStructuralKeys, []);
  assert.equal(delta.identical, false);
});

test('policy delta: a base or cap change is structural and governs no feature', () => {
  const candidate = derivePolicy(DEFAULT_PRIORITY_POLICY, {
    version: 'c',
    bandCap: 500,
    reasonBase: { pending: 900 },
  });
  const delta = policyDelta(DEFAULT_PRIORITY_POLICY, candidate);

  assert.deepEqual(delta.changedFeatures, []);
  assert.deepEqual(delta.changedStructuralKeys, ['bandCap', 'reasonBase.pending']);
  assert.equal(delta.identical, false);
});

test('policy delta: a version bump alone is not a difference in weights', () => {
  const delta = policyDelta(DEFAULT_PRIORITY_POLICY, derivePolicy(DEFAULT_PRIORITY_POLICY, { version: 'renamed' }));

  assert.equal(delta.identical, true);
  assert.deepEqual(delta.changedWeightKeys, []);
});

test('policy delta: deriving a policy leaves the frozen one untouched', () => {
  const before = JSON.stringify(DEFAULT_PRIORITY_POLICY);
  derivePolicy(DEFAULT_PRIORITY_POLICY, { version: 'c', weights: { importanceHigh: 1 }, bandCap: 1 });

  assert.equal(JSON.stringify(DEFAULT_PRIORITY_POLICY), before);
});
