import type { AnalyticsEventName, PrivacySafeAnalyticsEvent } from '../../src/contracts/v1/analyticsEventContracts';
import {
  EXPERIMENT_DECISION_POLICY,
  NEXT_STEP_ARMS,
  NEXT_STEP_BASELINE_ARM,
  NEXT_STEP_EXPERIMENT_ID,
  isNextStepArm,
  isRating,
  type NextStepArm,
} from '../../src/contracts/v1/experimentContracts';
import { requireValidAnalyticsEvent } from '../analytics/privacySafeEvents';

const Z_95 = 1.959964;

export interface RateMeasure {
  count: number;
  denominator: number;
  rate: number;
}

export interface RatingMeasure {
  count: number;
  mean: number;
  standardDeviation: number;
}

export interface ArmMeasures {
  arm: NextStepArm;
  users: number;
  exposures: number;
  decisions: number;
  acceptanceRate: RateMeasure;
  completionRate: RateMeasure;
  dismissalRate: RateMeasure;
  correctionRate: RateMeasure;
  deferralRate: RateMeasure;
  utilityRating: RatingMeasure;
  invasivenessRating: RatingMeasure;
  latencyMs: { count: number; mean: number; p95: number };
  costMicros: { count: number; mean: number };
}

export interface RateEffect {
  metric: string;
  baselineRate: number;
  armRate: number;
  difference: number;
  relativeLift: number;
  confidenceInterval: [number, number];
  cohensH: number;
  significant: boolean;
}

export interface RatingEffect {
  metric: string;
  baselineMean: number;
  armMean: number;
  difference: number;
  confidenceInterval: [number, number];
  cohensD: number;
  significant: boolean;
}

export interface ArmComparison {
  arm: NextStepArm;
  rateEffects: RateEffect[];
  ratingEffects: RatingEffect[];
  sampleLimitations: string[];
  /** True only when a behavioral metric clears the policy bar and nothing regressed. */
  approvedByDecisionRule: boolean;
  blockers: string[];
}

export interface AssignmentIntegrity {
  totalEvents: number;
  analyzedEvents: number;
  excludedOtherExperiment: number;
  excludedUnknownArm: number;
  usersInMultipleArms: string[];
  armShare: Record<NextStepArm, number>;
  balanced: boolean;
}

export interface ExperimentReport {
  version: string;
  experimentId: string;
  baselineArm: NextStepArm;
  generatedAt: string;
  assignmentIntegrity: AssignmentIntegrity;
  arms: ArmMeasures[];
  comparisons: ArmComparison[];
  /** Never true from ratings alone; see EXPERIMENT_DECISION_POLICY. */
  personalizationApproved: boolean;
  summary: string[];
}

function rate(count: number, denominator: number): RateMeasure {
  return { count, denominator, rate: denominator ? Number((count / denominator).toFixed(4)) : 0 };
}

function rating(values: readonly number[]): RatingMeasure {
  if (values.length === 0) return { count: 0, mean: 0, standardDeviation: 0 };
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  return { count: values.length, mean: Number(mean.toFixed(4)), standardDeviation: Number(Math.sqrt(variance).toFixed(4)) };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function mean(values: readonly number[]): number {
  return values.length ? Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(4)) : 0;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

/** Two-proportion effect with a Wald interval on the difference and Cohen's h. */
function rateEffect(metric: string, baseline: RateMeasure, arm: RateMeasure): RateEffect {
  const difference = arm.rate - baseline.rate;
  const standardError = Math.sqrt(
    (baseline.rate * (1 - baseline.rate)) / Math.max(1, baseline.denominator)
      + (arm.rate * (1 - arm.rate)) / Math.max(1, arm.denominator),
  );
  const margin = Z_95 * standardError;
  const lower = difference - margin;
  const upper = difference + margin;
  const estimable = baseline.denominator > 0 && arm.denominator > 0;
  return {
    metric,
    baselineRate: baseline.rate,
    armRate: arm.rate,
    difference: round(difference),
    relativeLift: baseline.rate ? round(difference / baseline.rate) : 0,
    confidenceInterval: [round(lower), round(upper)],
    cohensH: round(2 * Math.asin(Math.sqrt(arm.rate)) - 2 * Math.asin(Math.sqrt(baseline.rate))),
    significant: estimable && (lower > 0 || upper < 0),
  };
}

/** Mean difference with a Welch interval and Cohen's d. */
function ratingEffect(metric: string, baseline: RatingMeasure, arm: RatingMeasure): RatingEffect {
  const difference = arm.mean - baseline.mean;
  const estimable = baseline.count > 1 && arm.count > 1;
  const standardError = estimable
    ? Math.sqrt((baseline.standardDeviation ** 2) / baseline.count + (arm.standardDeviation ** 2) / arm.count)
    : 0;
  const margin = Z_95 * standardError;
  const pooledVariance = estimable
    ? ((baseline.count - 1) * baseline.standardDeviation ** 2 + (arm.count - 1) * arm.standardDeviation ** 2)
      / (baseline.count + arm.count - 2)
    : 0;
  const pooled = Math.sqrt(pooledVariance);
  return {
    metric,
    baselineMean: baseline.mean,
    armMean: arm.mean,
    difference: round(difference),
    confidenceInterval: [round(difference - margin), round(difference + margin)],
    cohensD: pooled ? round(difference / pooled) : 0,
    // With zero variance the interval collapses to the difference itself, which is a
    // real result; only an unestimable sample (n <= 1) is treated as inconclusive.
    significant: estimable && (difference - margin > 0 || difference + margin < 0),
  };
}

interface ArmEvents {
  events: PrivacySafeAnalyticsEvent[];
  users: Set<string>;
}

function proposalKey(event: PrivacySafeAnalyticsEvent): string | null {
  const proposalId = event.properties.proposalId;
  return typeof proposalId === 'string' ? `${event.anonymousUserId}:${proposalId}` : null;
}

function decisionKeys(events: readonly PrivacySafeAnalyticsEvent[], eventName: AnalyticsEventName): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.eventName !== eventName) continue;
    const key = proposalKey(event);
    if (key) keys.add(key);
  }
  return keys;
}

function shownNumbersFrom(events: readonly PrivacySafeAnalyticsEvent[], property: string): number[] {
  const firstByProposal = new Map<string, number>();
  for (const event of events) {
    if (event.eventName !== 'recommendation_shown') continue;
    const key = proposalKey(event);
    const value = event.properties[property];
    if (key && typeof value === 'number' && Number.isFinite(value) && !firstByProposal.has(key)) {
      firstByProposal.set(key, value);
    }
  }
  return Array.from(firstByProposal.values());
}

function ratingsFrom(events: readonly PrivacySafeAnalyticsEvent[], property: string, shown: ReadonlySet<string>): number[] {
  const latestByProposal = new Map<string, number>();
  for (const event of events) {
    if (event.eventName !== 'recommendation_rated') continue;
    const key = proposalKey(event);
    const value = event.properties[property];
    if (key && shown.has(key) && isRating(value)) latestByProposal.set(key, value);
  }
  return Array.from(latestByProposal.values());
}

function keepShown(keys: ReadonlySet<string>, shown: ReadonlySet<string>): Set<string> {
  const kept = new Set<string>();
  keys.forEach((key) => {
    if (shown.has(key)) kept.add(key);
  });
  return kept;
}

function measureArm(arm: NextStepArm, bucket: ArmEvents): ArmMeasures {
  const { events } = bucket;
  const shown = decisionKeys(events, 'recommendation_shown');
  const exposures = shown.size;
  const accepted = keepShown(decisionKeys(events, 'recommendation_accepted'), shown);
  const completed = keepShown(decisionKeys(events, 'recommendation_completed'), shown);
  const dismissed = keepShown(decisionKeys(events, 'recommendation_dismissed'), shown);
  const edited = keepShown(decisionKeys(events, 'recommendation_edited'), shown);
  const deferred = keepShown(decisionKeys(events, 'recommendation_deferred'), shown);
  const decided = new Set<string>();
  for (const keys of [accepted, completed, dismissed, edited, deferred]) {
    keys.forEach((key) => decided.add(key));
  }
  const latencies = shownNumbersFrom(events, 'latencyMs');
  const costs = shownNumbersFrom(events, 'costMicros');

  return {
    arm,
    users: bucket.users.size,
    exposures,
    decisions: decided.size,
    acceptanceRate: rate(accepted.size, exposures),
    completionRate: rate(completed.size, exposures),
    dismissalRate: rate(dismissed.size, exposures),
    correctionRate: rate(edited.size, exposures),
    deferralRate: rate(deferred.size, exposures),
    utilityRating: rating(ratingsFrom(events, 'utilityRating', shown)),
    invasivenessRating: rating(ratingsFrom(events, 'invasivenessRating', shown)),
    latencyMs: { count: latencies.length, mean: mean(latencies), p95: percentile(latencies, 0.95) },
    costMicros: { count: costs.length, mean: mean(costs) },
  };
}

function sampleLimitations(baseline: ArmMeasures, arm: ArmMeasures, integrity: AssignmentIntegrity): string[] {
  const limitations: string[] = [];
  const minimumExposures = EXPERIMENT_DECISION_POLICY.minimumExposuresPerArm;
  const minimumDecisions = EXPERIMENT_DECISION_POLICY.minimumDecisionsPerArm;
  if (baseline.exposures < minimumExposures || arm.exposures < minimumExposures) {
    limitations.push(`below_minimum_exposures (need ${minimumExposures} per arm, have ${baseline.exposures} baseline / ${arm.exposures} arm)`);
  }
  if (baseline.decisions < minimumDecisions || arm.decisions < minimumDecisions) {
    limitations.push(`below_minimum_decisions (need ${minimumDecisions} per arm, have ${baseline.decisions} baseline / ${arm.decisions} arm)`);
  }
  if (baseline.utilityRating.count === 0 || arm.utilityRating.count === 0) limitations.push('no_utility_ratings');
  if (baseline.invasivenessRating.count === 0 || arm.invasivenessRating.count === 0) limitations.push('no_invasiveness_ratings');
  if (integrity.usersInMultipleArms.length > 0) limitations.push(`cross_arm_contamination (${integrity.usersInMultipleArms.length} users)`);
  if (!integrity.balanced) limitations.push('unbalanced_arm_assignment');
  return limitations;
}

/**
 * Applies the #56 decision rule. Approval requires a behavioral metric to clear the
 * effect bar with a confidence interval excluding zero; a positive utility rating can
 * never substitute for that, and an invasiveness or correction regression blocks it.
 */
function decide(
  arm: ArmMeasures,
  rateEffects: readonly RateEffect[],
  ratingEffects: readonly RatingEffect[],
  limitations: readonly string[],
): { approved: boolean; blockers: string[] } {
  const blockers: string[] = [];
  const behavioral = rateEffects.filter((effect) => (EXPERIMENT_DECISION_POLICY.behavioralMetrics as readonly string[]).includes(effect.metric));
  const winning = behavioral.filter((effect) => effect.significant && effect.difference >= EXPERIMENT_DECISION_POLICY.minimumBehavioralEffect);

  if (winning.length === 0) {
    blockers.push('no_behavioral_metric_cleared_the_effect_bar');
  }
  const blocking = limitations.filter((limitation) => limitation.startsWith('below_minimum') || limitation.startsWith('cross_arm_contamination'));
  for (const limitation of blocking) blockers.push(`sample_limitation: ${limitation}`);

  const invasiveness = ratingEffects.find((effect) => effect.metric === 'invasivenessRating');
  if (invasiveness && invasiveness.difference > EXPERIMENT_DECISION_POLICY.maximumInvasivenessRegression) {
    blockers.push(`invasiveness_regression (${invasiveness.difference} > ${EXPERIMENT_DECISION_POLICY.maximumInvasivenessRegression})`);
  }
  const correction = rateEffects.find((effect) => effect.metric === 'correctionRate');
  if (correction && correction.difference > EXPERIMENT_DECISION_POLICY.maximumCorrectionRegression) {
    blockers.push(`correction_regression (${correction.difference} > ${EXPERIMENT_DECISION_POLICY.maximumCorrectionRegression})`);
  }
  if (arm.exposures === 0) blockers.push('no_exposures');

  return { approved: blockers.length === 0, blockers };
}

export function buildExperimentReport(values: readonly unknown[], generatedAt: Date): ExperimentReport {
  const all = values.map(requireValidAnalyticsEvent);
  const buckets = new Map<NextStepArm, ArmEvents>(
    NEXT_STEP_ARMS.map((arm) => [arm, { events: [], users: new Set<string>() }]),
  );
  const armsByUser = new Map<string, Set<string>>();
  let excludedOtherExperiment = 0;
  let excludedUnknownArm = 0;

  for (const event of all) {
    if (!event.experiment || event.experiment.experimentId !== NEXT_STEP_EXPERIMENT_ID) {
      excludedOtherExperiment += 1;
      continue;
    }
    if (!isNextStepArm(event.experiment.arm)) {
      excludedUnknownArm += 1;
      continue;
    }
    const bucket = buckets.get(event.experiment.arm)!;
    bucket.events.push(event);
    bucket.users.add(event.anonymousUserId);
    const seen = armsByUser.get(event.anonymousUserId) || new Set<string>();
    seen.add(event.experiment.arm);
    armsByUser.set(event.anonymousUserId, seen);
  }

  const arms = NEXT_STEP_ARMS.map((arm) => measureArm(arm, buckets.get(arm)!));
  const analyzedEvents = arms.reduce((total, measures) => total + buckets.get(measures.arm)!.events.length, 0);
  const totalUsers = armsByUser.size;
  const armShare = Object.fromEntries(
    arms.map((measures) => [measures.arm, totalUsers ? round(measures.users / totalUsers) : 0]),
  ) as Record<NextStepArm, number>;
  const shares = Object.values(armShare);
  const integrity: AssignmentIntegrity = {
    totalEvents: all.length,
    analyzedEvents,
    excludedOtherExperiment,
    excludedUnknownArm,
    usersInMultipleArms: Array.from(armsByUser.entries()).filter(([, seen]) => seen.size > 1).map(([user]) => user).sort(),
    armShare,
    // Even assignment is 1/3 per arm; flag anything drifting more than 10 points from even.
    balanced: totalUsers === 0 || shares.every((share) => Math.abs(share - 1 / NEXT_STEP_ARMS.length) <= 0.1),
  };

  const baseline = arms.find((measures) => measures.arm === NEXT_STEP_BASELINE_ARM)!;
  const comparisons = arms
    .filter((measures) => measures.arm !== NEXT_STEP_BASELINE_ARM)
    .map((measures) => {
      const rateEffects = [
        rateEffect('acceptanceRate', baseline.acceptanceRate, measures.acceptanceRate),
        rateEffect('completionRate', baseline.completionRate, measures.completionRate),
        rateEffect('dismissalRate', baseline.dismissalRate, measures.dismissalRate),
        rateEffect('correctionRate', baseline.correctionRate, measures.correctionRate),
        rateEffect('deferralRate', baseline.deferralRate, measures.deferralRate),
      ];
      const ratingEffects = [
        ratingEffect('utilityRating', baseline.utilityRating, measures.utilityRating),
        ratingEffect('invasivenessRating', baseline.invasivenessRating, measures.invasivenessRating),
      ];
      const limitations = sampleLimitations(baseline, measures, integrity);
      const decision = decide(measures, rateEffects, ratingEffects, limitations);
      return {
        arm: measures.arm,
        rateEffects,
        ratingEffects,
        sampleLimitations: limitations,
        approvedByDecisionRule: decision.approved,
        blockers: decision.blockers,
      };
    });

  const personalized = comparisons.find((comparison) => comparison.arm === 'personalized');
  const summary = comparisons.map((comparison) => {
    const acceptance = comparison.rateEffects.find((effect) => effect.metric === 'acceptanceRate')!;
    return `${comparison.arm}: acceptance ${acceptance.difference >= 0 ? '+' : ''}${acceptance.difference} vs ${NEXT_STEP_BASELINE_ARM} `
      + `(95% CI ${acceptance.confidenceInterval[0]} to ${acceptance.confidenceInterval[1]}), `
      + `${comparison.approvedByDecisionRule ? 'meets the decision rule' : `blocked by ${comparison.blockers.join(', ')}`}`;
  });

  return {
    version: 'v1',
    experimentId: NEXT_STEP_EXPERIMENT_ID,
    baselineArm: NEXT_STEP_BASELINE_ARM,
    generatedAt: generatedAt.toISOString(),
    assignmentIntegrity: integrity,
    arms,
    comparisons,
    personalizationApproved: personalized?.approvedByDecisionRule === true,
    summary,
  };
}
