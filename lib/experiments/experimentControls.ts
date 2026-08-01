import { NEXT_STEP_ARMS, NEXT_STEP_BASELINE_ARM, NEXT_STEP_EXPERIMENT_ID, type NextStepArm } from '../../src/contracts/v1/experimentContracts';
import { assignExperiment } from '../analytics/privacySafeEvents';

export const NEXT_STEP_EXPERIMENT_ENV = 'MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS';

/**
 * The V03 arm experiment is off unless explicitly enabled, so an unconfigured
 * environment serves the reviewed generic baseline to everyone.
 */
export function nextStepExperimentEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[NEXT_STEP_EXPERIMENT_ENV] === 'true';
}

export interface ArmAssignment {
  experimentId: string;
  arm: NextStepArm;
  enabled: boolean;
}

/**
 * Resolves a user's arm. Assignment is the same deterministic hash the analytics
 * envelope uses, so the arm that produced a proposal always matches the arm recorded
 * on its events — there is no second source of truth to drift.
 */
export function resolveNextStepArm(
  anonymousUserId: string,
  env: Record<string, string | undefined> = process.env,
): ArmAssignment {
  if (!nextStepExperimentEnabled(env)) {
    return { experimentId: NEXT_STEP_EXPERIMENT_ID, arm: NEXT_STEP_BASELINE_ARM, enabled: false };
  }
  const assignment = assignExperiment(anonymousUserId, NEXT_STEP_EXPERIMENT_ID, NEXT_STEP_ARMS);
  return { experimentId: assignment.experimentId, arm: assignment.arm as NextStepArm, enabled: true };
}
