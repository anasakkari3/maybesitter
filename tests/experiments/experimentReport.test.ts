import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXPERIMENT_DECISION_POLICY, NEXT_STEP_EXPERIMENT_ID } from '../../src/contracts/v1/experimentContracts.ts';
import { validateAnalyticsEvent } from '../../lib/analytics/privacySafeEvents.ts';
import { buildExperimentReport } from '../../lib/experiments/experimentReport.ts';
import { recordClientEvent } from '../../lib/analytics/loopAnalytics.ts';
import { resolveNextStepArm } from '../../lib/experiments/experimentControls.ts';

const events = readFileSync('evaluation-data/v03-experiment-events.jsonl', 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const GENERATED_AT = new Date('2026-10-01T00:00:00.000Z');
const report = buildExperimentReport(events, GENERATED_AT);

function arm(name: string) {
  return report.arms.find((measures) => measures.arm === name)!;
}
function comparison(name: string) {
  return report.comparisons.find((item) => item.arm === name)!;
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    version: 'v1', eventId: 'x1', eventName: 'recommendation_shown', occurredAt: '2026-09-07T09:00:00.000Z',
    anonymousUserId: 'u1', cohortId: '2026-W37', experiment: { experimentId: NEXT_STEP_EXPERIMENT_ID, arm: 'generic' },
    consent: 'granted', properties: { proposalId: 'p1', commitmentId: 'c1', baselineVersion: 'v1', latencyMs: 3, costMicros: 0 },
    ...overrides,
  };
}

test('experiment: every fixture event validates and carries no raw content', () => {
  for (const value of events) assert.equal(validateAnalyticsEvent(value).valid, true);
  // Checked per property rather than over the serialized blob: the arm name
  // "personalized" contains "person" and would false-positive a substring scan.
  for (const { properties } of events) {
    for (const [key, property] of Object.entries(properties as Record<string, unknown>)) {
      assert.doesNotMatch(key, /raw|message|text|title|description|person|email|phone|prompt|content/i);
      assert.ok(['string', 'number', 'boolean'].includes(typeof property) || property === null);
      if (typeof property === 'string') assert.ok(!/\s/.test(property), `property ${key} looks like prose`);
    }
  }
});

test('experiment: ratings outside the 1-5 integer scale are rejected', () => {
  const rated = { eventName: 'recommendation_rated', properties: { proposalId: 'p1', utilityRating: 4, invasivenessRating: 2 } };
  assert.equal(validateAnalyticsEvent(event(rated)).valid, true);
  for (const bad of [0, 6, 3.5, '4', null]) {
    const invalid = event({ eventName: 'recommendation_rated', properties: { proposalId: 'p1', utilityRating: bad, invasivenessRating: 2 } });
    assert.equal(validateAnalyticsEvent(invalid).valid, false, `rating ${String(bad)} should be rejected`);
  }
});

test('experiment: live client ratings use the same enabled arm assignment as proposals', () => {
  const previous = process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS;
  process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS = 'true';
  try {
    const emitted: unknown[] = [];
    const rated = recordClientEvent({
      anonymousUserId: 'pilot-rating-user', consent: 'granted', now: GENERATED_AT,
      emit: (value) => emitted.push(value),
    }, 'recommendation_rated', { proposalId: 'p1', utilityRating: 4, invasivenessRating: 2 });
    assert.ok(rated);
    assert.deepEqual(rated.experiment, {
      experimentId: NEXT_STEP_EXPERIMENT_ID,
      arm: resolveNextStepArm('pilot-rating-user').arm,
    });
    assert.equal(emitted.length, 1);
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS;
    else process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS = previous;
  }
});

test('experiment: ratings are one-per-shown-proposal and latest response wins', () => {
  const values = [
    event(),
    event({ eventId: 'r1', eventName: 'recommendation_rated', properties: { proposalId: 'p1', utilityRating: 2, invasivenessRating: 2 } }),
    event({ eventId: 'r2', eventName: 'recommendation_rated', properties: { proposalId: 'p1', utilityRating: 5, invasivenessRating: 3 } }),
    event({ eventId: 'r3', eventName: 'recommendation_rated', properties: { proposalId: 'never-shown', utilityRating: 1, invasivenessRating: 5 } }),
  ];
  const measured = buildExperimentReport(values, GENERATED_AT).arms.find((item) => item.arm === 'generic')!;
  assert.deepEqual(measured.utilityRating, { count: 1, mean: 5, standardDeviation: 0 });
  assert.deepEqual(measured.invasivenessRating, { count: 1, mean: 3, standardDeviation: 0 });
});

test('experiment: behavioral decisions are counted only for shown proposals', () => {
  const values = [
    event(),
    event({ eventId: 'a1', eventName: 'recommendation_accepted', properties: { proposalId: 'p1' } }),
    event({ eventId: 'a2', eventName: 'recommendation_accepted', properties: { proposalId: 'never-shown' } }),
    event({ eventId: 'e1', eventName: 'recommendation_edited', properties: { proposalId: 'never-shown', changedFieldCount: 1 } }),
    event({ eventId: 'd1', eventName: 'recommendation_dismissed', properties: { proposalId: 'never-shown' } }),
  ];
  const measured = buildExperimentReport(values, GENERATED_AT).arms.find((item) => item.arm === 'generic')!;
  assert.equal(measured.exposures, 1);
  assert.equal(measured.decisions, 1);
  assert.deepEqual(measured.acceptanceRate, { count: 1, denominator: 1, rate: 1 });
  assert.deepEqual(measured.correctionRate, { count: 0, denominator: 1, rate: 0 });
  assert.deepEqual(measured.dismissalRate, { count: 0, denominator: 1, rate: 0 });
});

test('experiment: all three arms are measured against the generic baseline', () => {
  assert.equal(report.experimentId, NEXT_STEP_EXPERIMENT_ID);
  assert.equal(report.baselineArm, 'generic');
  assert.deepEqual(report.arms.map((measures) => measures.arm), ['generic', 'contextual', 'personalized']);
  assert.deepEqual(report.comparisons.map((item) => item.arm), ['contextual', 'personalized']);
});

test('experiment: assignment integrity is checked and no user appears in two arms', () => {
  const { assignmentIntegrity } = report;
  assert.equal(assignmentIntegrity.totalEvents, events.length);
  assert.equal(assignmentIntegrity.analyzedEvents, events.length);
  assert.deepEqual(assignmentIntegrity.usersInMultipleArms, []);
  assert.equal(assignmentIntegrity.excludedOtherExperiment, 0);
  assert.equal(assignmentIntegrity.excludedUnknownArm, 0);
  assert.equal(assignmentIntegrity.balanced, true);
});

test('experiment: events from another experiment or an unknown arm are excluded, not counted', () => {
  const mixed = [
    event(),
    event({ eventId: 'x2', experiment: { experimentId: 'v02-next-step', arm: 'baseline' } }),
    event({ eventId: 'x3', experiment: { experimentId: NEXT_STEP_EXPERIMENT_ID, arm: 'mystery' } }),
  ];
  const mixedReport = buildExperimentReport(mixed, GENERATED_AT);
  assert.equal(mixedReport.assignmentIntegrity.excludedOtherExperiment, 1);
  assert.equal(mixedReport.assignmentIntegrity.excludedUnknownArm, 1);
  assert.equal(mixedReport.assignmentIntegrity.analyzedEvents, 1);
});

test('experiment: a user split across arms is reported as contamination', () => {
  const contaminated = [
    event(),
    event({ eventId: 'x2', experiment: { experimentId: NEXT_STEP_EXPERIMENT_ID, arm: 'contextual' } }),
  ];
  const contaminatedReport = buildExperimentReport(contaminated, GENERATED_AT);
  assert.deepEqual(contaminatedReport.assignmentIntegrity.usersInMultipleArms, ['u1']);
  assert.ok(comparisonBlockers(contaminatedReport, 'contextual').some((blocker) => blocker.includes('cross_arm_contamination')));
});

function comparisonBlockers(value: ReturnType<typeof buildExperimentReport>, name: string): string[] {
  return value.comparisons.find((item) => item.arm === name)!.blockers;
}

test('experiment: behavioral, self-reported, latency, and cost measures are all populated', () => {
  for (const name of ['generic', 'contextual', 'personalized']) {
    const measures = arm(name);
    assert.ok(measures.exposures > 0, `${name} exposures`);
    assert.ok(measures.decisions > 0, `${name} decisions`);
    assert.ok(measures.acceptanceRate.rate > 0 && measures.acceptanceRate.rate < 1);
    assert.ok(measures.completionRate.rate > 0);
    assert.ok(measures.dismissalRate.rate > 0);
    assert.ok(measures.correctionRate.rate > 0);
    assert.ok(measures.utilityRating.count > 0 && measures.utilityRating.mean >= 1);
    assert.ok(measures.invasivenessRating.count > 0 && measures.invasivenessRating.mean >= 1);
    assert.ok(measures.latencyMs.mean > 0 && measures.latencyMs.p95 >= measures.latencyMs.mean);
    assert.equal(measures.costMicros.mean, 0);
  }
});

test('experiment: rates reconcile with the counts they were derived from', () => {
  for (const measures of report.arms) {
    for (const rate of [measures.acceptanceRate, measures.completionRate, measures.dismissalRate, measures.correctionRate, measures.deferralRate]) {
      assert.equal(rate.denominator, measures.exposures);
      assert.equal(rate.rate, Number((rate.count / rate.denominator).toFixed(4)));
      assert.ok(rate.count <= measures.exposures);
    }
    assert.ok(measures.decisions <= measures.exposures);
  }
});

test('experiment: effect sizes are reported against baseline with confidence intervals', () => {
  const contextual = comparison('contextual');
  const acceptance = contextual.rateEffects.find((effect) => effect.metric === 'acceptanceRate')!;

  assert.equal(acceptance.baselineRate, arm('generic').acceptanceRate.rate);
  assert.equal(acceptance.armRate, arm('contextual').acceptanceRate.rate);
  assert.equal(acceptance.difference, Number((acceptance.armRate - acceptance.baselineRate).toFixed(4)));
  assert.ok(acceptance.confidenceInterval[0] < acceptance.difference && acceptance.difference < acceptance.confidenceInterval[1]);
  assert.ok(acceptance.cohensH > 0);
  assert.equal(acceptance.significant, true);
  assert.deepEqual(
    contextual.rateEffects.map((effect) => effect.metric),
    ['acceptanceRate', 'completionRate', 'dismissalRate', 'correctionRate', 'deferralRate'],
  );
  assert.deepEqual(contextual.ratingEffects.map((effect) => effect.metric), ['utilityRating', 'invasivenessRating']);
});

test('experiment: a contextual arm with a real behavioral effect clears the decision rule', () => {
  const contextual = comparison('contextual');
  assert.deepEqual(contextual.blockers, []);
  assert.equal(contextual.approvedByDecisionRule, true);
  assert.deepEqual(contextual.sampleLimitations, []);
});

test('experiment: the best-rated arm is still rejected when no behavioral metric moves', () => {
  const personalized = comparison('personalized');
  const utility = personalized.ratingEffects.find((effect) => effect.metric === 'utilityRating')!;

  // The personalized arm is rated more useful than baseline...
  assert.ok(utility.difference > 0, 'fixture should rate personalization above baseline');
  // ...and is rejected anyway, which is the whole point of the decision rule.
  assert.equal(personalized.approvedByDecisionRule, false);
  assert.equal(report.personalizationApproved, false);
  assert.ok(personalized.blockers.includes('no_behavioral_metric_cleared_the_effect_bar'));
  assert.ok(personalized.blockers.some((blocker) => blocker.startsWith('invasiveness_regression')));
});

test('experiment: a positive rating alone can never approve an arm', () => {
  // Same acceptance as baseline, perfect ratings.
  const rated = [] as unknown[];
  for (let index = 0; index < 120; index += 1) {
    for (const armName of ['generic', 'personalized']) {
      const user = `${armName}-${index}`;
      const experiment = { experimentId: NEXT_STEP_EXPERIMENT_ID, arm: armName };
      rated.push(event({ eventId: `s-${armName}-${index}`, anonymousUserId: user, experiment, properties: { proposalId: `p${index}`, commitmentId: 'c1', baselineVersion: 'v1', latencyMs: 3, costMicros: 0 } }));
      if (index % 2 === 0) {
        rated.push(event({ eventId: `a-${armName}-${index}`, eventName: 'recommendation_accepted', anonymousUserId: user, experiment, properties: { proposalId: `p${index}` } }));
      }
      rated.push(event({
        eventId: `r-${armName}-${index}`, eventName: 'recommendation_rated', anonymousUserId: user, experiment,
        properties: { proposalId: `p${index}`, utilityRating: armName === 'personalized' ? 5 : 2, invasivenessRating: 1 },
      }));
    }
  }
  const ratedReport = buildExperimentReport(rated, GENERATED_AT);
  const personalized = ratedReport.comparisons.find((item) => item.arm === 'personalized')!;
  const utility = personalized.ratingEffects.find((effect) => effect.metric === 'utilityRating')!;

  assert.equal(utility.difference, 3);
  assert.equal(utility.significant, true);
  assert.equal(personalized.approvedByDecisionRule, false);
  assert.equal(ratedReport.personalizationApproved, false);
  assert.deepEqual(personalized.blockers, ['no_behavioral_metric_cleared_the_effect_bar']);
});

test('experiment: an underpowered sample is reported as a limitation and blocks approval', () => {
  const thin = [
    event({ eventId: 'g1', anonymousUserId: 'g1' }),
    event({ eventId: 'g1a', eventName: 'recommendation_accepted', anonymousUserId: 'g1', properties: { proposalId: 'p1' } }),
    event({ eventId: 'c1', anonymousUserId: 'c1', experiment: { experimentId: NEXT_STEP_EXPERIMENT_ID, arm: 'contextual' } }),
    event({ eventId: 'c1a', eventName: 'recommendation_accepted', anonymousUserId: 'c1', experiment: { experimentId: NEXT_STEP_EXPERIMENT_ID, arm: 'contextual' }, properties: { proposalId: 'p1' } }),
  ];
  const thinReport = buildExperimentReport(thin, GENERATED_AT);
  const contextual = thinReport.comparisons.find((item) => item.arm === 'contextual')!;

  assert.ok(contextual.sampleLimitations.some((limitation) => limitation.startsWith('below_minimum_exposures')));
  assert.ok(contextual.sampleLimitations.some((limitation) => limitation.startsWith('below_minimum_decisions')));
  assert.ok(contextual.sampleLimitations.includes('no_utility_ratings'));
  assert.equal(contextual.approvedByDecisionRule, false);
  // A 100% acceptance rate in both arms must not read as a win.
  assert.ok(contextual.blockers.some((blocker) => blocker.startsWith('sample_limitation')));
});

test('experiment: the decision policy names behavioral metrics only', () => {
  assert.deepEqual([...EXPERIMENT_DECISION_POLICY.behavioralMetrics], ['acceptanceRate', 'completionRate']);
  for (const metric of EXPERIMENT_DECISION_POLICY.selfReportedMetrics) {
    assert.ok(!(EXPERIMENT_DECISION_POLICY.behavioralMetrics as readonly string[]).includes(metric));
  }
});

test('experiment: the summary states each arm effect and whether it met the rule', () => {
  assert.equal(report.summary.length, 2);
  assert.match(report.summary[0], /^contextual: acceptance \+/);
  assert.match(report.summary[0], /meets the decision rule/);
  assert.match(report.summary[1], /^personalized: /);
  assert.match(report.summary[1], /blocked by/);
});
