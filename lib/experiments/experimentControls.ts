import {
  isNextStepArm,
  NEXT_STEP_ARMS,
  NEXT_STEP_BASELINE_ARM,
  NEXT_STEP_EXPERIMENT_ID,
  type NextStepArm,
} from '../../src/contracts/v1/experimentContracts';
import { assignExperiment } from '../analytics/privacySafeEvents';

export const NEXT_STEP_EXPERIMENT_ENV = 'MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS';

/**
 * The arm production serves when the experiment is off (UC-2.9, #170).
 *
 * With no experiment running, everyone still has to get *some* arm, and the
 * default was `generic` — the arm that ignores the time of day and the user's
 * own history. Production wants `personalized`, and pinning it through the
 * environment rather than changing the default keeps the reviewed baseline as
 * what an unconfigured checkout serves.
 *
 * `selectNextStepForArm` already falls back to baseline ordering when
 * `profileIsUsable` is false, so a pinned `personalized` degrades to exactly
 * the generic behaviour for a user with too little history rather than
 * inventing something from nothing.
 */
export const NEXT_STEP_PINNED_ARM_ENV = 'MAYBESITTER_NEXT_STEP_ARM';

/**
 * The V03 arm experiment is off unless explicitly enabled, so an unconfigured
 * environment serves the reviewed generic baseline to everyone.
 */
export function nextStepExperimentEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[NEXT_STEP_EXPERIMENT_ENV] === 'true';
}

/**
 * The pinned arm, when the environment names a real one.
 *
 * An unrecognised value is ignored rather than thrown on. This is read on every
 * next-step request, and a typo in a deployment variable should degrade to the
 * reviewed baseline, not take the feature down for everyone.
 */
export function pinnedNextStepArm(
  env: Record<string, string | undefined> = process.env,
): NextStepArm | null {
  const value = env[NEXT_STEP_PINNED_ARM_ENV];
  return isNextStepArm(value) ? value : null;
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
    return {
      experimentId: NEXT_STEP_EXPERIMENT_ID,
      arm: pinnedNextStepArm(env) ?? NEXT_STEP_BASELINE_ARM,
      // Still `false`: a pinned arm is a deployment choice, not an experiment,
      // and reporting it as enabled would put an `experimentId` on every event
      // for a trial nobody is running.
      enabled: false,
    };
  }
  const assignment = assignExperiment(anonymousUserId, NEXT_STEP_EXPERIMENT_ID, NEXT_STEP_ARMS);
  return { experimentId: assignment.experimentId, arm: assignment.arm as NextStepArm, enabled: true };
}
