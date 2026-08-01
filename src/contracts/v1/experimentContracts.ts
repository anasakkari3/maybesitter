import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const EXPERIMENT_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;

/** V03 proposal experiment. Arm order is fixed; assignment hashes against these names. */
export const NEXT_STEP_EXPERIMENT_ID = 'v03-next-step-proposal';
export const NEXT_STEP_ARMS = ['generic', 'contextual', 'personalized'] as const;
export type NextStepArm = typeof NEXT_STEP_ARMS[number];
export const NEXT_STEP_BASELINE_ARM: NextStepArm = 'generic';

export function isNextStepArm(value: unknown): value is NextStepArm {
  return NEXT_STEP_ARMS.includes(value as NextStepArm);
}

/** Self-reported scales. Both are 1-5; invasiveness is worse when higher. */
export const RATING_SCALE = Object.freeze({ minimum: 1, maximum: 5 });

export function isRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= RATING_SCALE.minimum && value <= RATING_SCALE.maximum;
}

/**
 * Encodes the #56 decision rule. Personalization is never approved from ratings alone:
 * a behavioral metric must clear its own bar, and invasiveness must not regress.
 */
export const EXPERIMENT_DECISION_POLICY = Object.freeze({
  /** Per-arm exposures required before any arm comparison is reported as conclusive. */
  minimumExposuresPerArm: 100,
  /** Per-arm decisions required before a behavioral rate is treated as estimable. */
  minimumDecisionsPerArm: 50,
  /** Behavioral metrics that alone can justify approval. Ratings are explicitly excluded. */
  behavioralMetrics: ['acceptanceRate', 'completionRate'] as const,
  /** Self-reported metrics that may support but never establish a decision. */
  selfReportedMetrics: ['utilityRating', 'invasivenessRating'] as const,
  /** A positive behavioral effect must exceed this absolute rate difference. */
  minimumBehavioralEffect: 0.05,
  /** Any invasiveness increase beyond this many scale points blocks approval. */
  maximumInvasivenessRegression: 0.25,
  /** A correction (edit) rate increase beyond this blocks approval. */
  maximumCorrectionRegression: 0.1,
});

export type BehavioralMetric = typeof EXPERIMENT_DECISION_POLICY.behavioralMetrics[number];
