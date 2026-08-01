import { createHash } from 'node:crypto';
import type { DomainState } from '../../src/domain/stateMachine';
import type { RuntimeControlSnapshot } from '../../src/contracts/v1/runtimeControls';
import { readRuntimeControls, resolveModuleRuntime } from '../../src/contracts/v1/runtimeControls';
import type { NextStepDecision, NextStepLocale, NextStepRecommendationContract } from '../../src/contracts/v1/nextStepContracts';
import type { PrivacySafeAnalyticsEvent } from '../../src/contracts/v1/analyticsEventContracts';
import { NEXT_STEP_ARMS } from '../../src/contracts/v1/experimentContracts';
import { emitAnalyticsEvent, type AnalyticsContext } from '../analytics/analyticsContext';
import { resolveNextStepArm } from '../experiments/experimentControls';
import { selectNextStepForArmFromState } from '../experiments/nextStepArms';
import { decideNextStep, type NextStepInteractionOutcome } from './nextStepReviewService';

export interface LiveContext extends AnalyticsContext {
  locale: NextStepLocale;
  controls?: RuntimeControlSnapshot;
  emitShown?: boolean;
  /** Timezone used by the context-aware and personalized arms. */
  timezone?: string;
  /** Overrides the environment when resolving the arm, for tests and pilot tooling. */
  env?: Record<string, string | undefined>;
}

/**
 * Points every event from this request at the V03 arm experiment, so the arm recorded on
 * an event is the same assignment that produced the proposal.
 */
function withArmAssignment(context: LiveContext): LiveContext {
  const assignment = resolveNextStepArm(context.anonymousUserId, context.env);
  return assignment.enabled
    ? { ...context, experimentId: assignment.experimentId, arms: NEXT_STEP_ARMS }
    : context;
}

function proposalId(state: DomainState): string {
  const fingerprint = JSON.stringify(Object.values(state.commitments).map((item) => [item.id, item.updatedAt]).sort());
  return `next-step-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`;
}

export function getLiveNextStep(state: DomainState, context: LiveContext): NextStepRecommendationContract {
  const runtime = resolveModuleRuntime('recommendation', context.controls || readRuntimeControls());
  if (runtime.mode !== 'enabled') {
    return {
      version: 'v1', proposalId: 'next-step-disabled', state: 'insufficient_evidence', locale: context.locale,
      primaryStep: null, explanation: null, availableActions: [],
      persistence: { occurred: false, confirmationRequired: true },
    };
  }
  const assigned = withArmAssignment(context);
  const arm = resolveNextStepArm(context.anonymousUserId, context.env).arm;
  const startedAt = performance.now();
  const selection = selectNextStepForArmFromState(arm, state, {
    now: context.now,
    locale: context.locale,
    proposalId: proposalId(state),
    timezone: context.timezone || 'UTC',
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  const proposal = selection.recommendation;

  if (proposal.state === 'ready' && context.emitShown !== false && proposal.primaryStep) {
    emitAnalyticsEvent(assigned, 'recommendation_shown', {
      proposalId: proposal.proposalId,
      commitmentId: proposal.primaryStep.commitmentId,
      baselineVersion: 'v1',
      latencyMs,
      // Every arm is deterministic and local, so no arm incurs model cost.
      costMicros: 0,
    });
  }
  return proposal;
}

const DECISION_EVENTS: Record<NextStepDecision, PrivacySafeAnalyticsEvent['eventName']> = {
  accept: 'recommendation_accepted', edit: 'recommendation_edited', defer: 'recommendation_deferred',
  dismiss: 'recommendation_dismissed', done: 'recommendation_completed',
};

export function recordLiveNextStepDecision(
  proposal: NextStepRecommendationContract,
  decision: NextStepDecision,
  context: LiveContext,
  editedTitle?: string,
): NextStepInteractionOutcome {
  const runtime = resolveModuleRuntime('recommendation', context.controls || readRuntimeControls());
  if (runtime.mode !== 'enabled') throw new Error(`recommendation unavailable: ${runtime.reason}`);
  const outcome = decideNextStep(proposal, decision, context.now.toISOString(), editedTitle);
  const properties: Record<string, string | number> = { proposalId: proposal.proposalId };
  if (decision === 'edit') properties.changedFieldCount = 1;
  if (decision === 'defer') properties.deferMinutes = 1440;
  if (decision === 'done' && proposal.primaryStep) properties.commitmentId = proposal.primaryStep.commitmentId;
  emitAnalyticsEvent(withArmAssignment(context), DECISION_EVENTS[decision], properties);
  return outcome;
}
