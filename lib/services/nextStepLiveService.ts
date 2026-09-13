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
  /**
   * Commitments the next step must not offer right now (UC-2.9, #170).
   *
   * Deferred or recently dismissed. They are removed from the candidate set
   * and nothing else: their status, time and priority are untouched, and every
   * other screen still shows them.
   */
  excludeCommitmentIds?: ReadonlySet<string>;
  /** The user's own hours (UC-2.7a #167), so the arm's evidence is about them. */
  routine?: {
    quietHours?: { start: string; end: string } | null;
    focusWindows?: readonly { start: string; end: string }[];
  };
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

function visibleState(state: DomainState, exclude?: ReadonlySet<string>): DomainState {
  if (!exclude || exclude.size === 0) return state;
  const commitments = Object.fromEntries(
    Object.entries(state.commitments).filter(([id]) => !exclude.has(id)),
  );
  return { ...state, commitments };
}

function proposalId(state: DomainState): string {
  const fingerprint = JSON.stringify(Object.values(state.commitments).map((item) => [item.id, item.updatedAt]).sort());
  return `next-step-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`;
}

// Async since UC-1.0c (#142): the `recommendation_shown` event it emits is a
// storage write. The proposal itself is still computed synchronously — only
// the recording is awaited.
export async function getLiveNextStep(state: DomainState, context: LiveContext): Promise<NextStepRecommendationContract> {
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
  // Filtered here rather than inside the selector: the selector's job is to
  // rank what it is given, and "the user said not this one" is not a ranking
  // signal. Removing them also changes `proposalId`, which is correct — the
  // proposal really is a different one now, and any card still holding the old
  // id is genuinely stale.
  const candidates = visibleState(state, context.excludeCommitmentIds);
  const selection = selectNextStepForArmFromState(arm, candidates, {
    now: context.now,
    locale: context.locale,
    proposalId: proposalId(candidates),
    timezone: context.timezone || 'UTC',
    ...(context.routine ? { routine: context.routine } : {}),
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  const proposal = selection.recommendation;

  if (proposal.state === 'ready' && context.emitShown !== false && proposal.primaryStep) {
    await emitAnalyticsEvent(assigned, 'recommendation_shown', {
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

/**
 * The decision, and the event it would emit, kept apart (UC-1.0b, #141).
 *
 * A caller recording the decision inside a storage transaction cannot emit
 * from in there: a transaction retries, and an analytics event emitted per
 * attempt is an event the user did not generate. This returns the outcome
 * (pure) plus an `emit` the caller runs once, after the transaction committed.
 */
export function prepareLiveNextStepDecision(
  proposal: NextStepRecommendationContract,
  decision: NextStepDecision,
  context: LiveContext,
  editedTitle?: string,
): { outcome: NextStepInteractionOutcome; emit: () => Promise<void> } {
  const runtime = resolveModuleRuntime('recommendation', context.controls || readRuntimeControls());
  if (runtime.mode !== 'enabled') throw new Error(`recommendation unavailable: ${runtime.reason}`);
  const outcome = decideNextStep(proposal, decision, context.now.toISOString(), editedTitle);
  const properties: Record<string, string | number> = { proposalId: proposal.proposalId };
  if (decision === 'edit') properties.changedFieldCount = 1;
  if (decision === 'defer') properties.deferMinutes = 1440;
  if (decision === 'done' && proposal.primaryStep) properties.commitmentId = proposal.primaryStep.commitmentId;
  return {
    outcome,
    emit: async () => {
      await emitAnalyticsEvent(withArmAssignment(context), DECISION_EVENTS[decision], properties);
    },
  };
}

export async function recordLiveNextStepDecision(
  proposal: NextStepRecommendationContract,
  decision: NextStepDecision,
  context: LiveContext,
  editedTitle?: string,
): Promise<NextStepInteractionOutcome> {
  const prepared = prepareLiveNextStepDecision(proposal, decision, context, editedTitle);
  await prepared.emit();
  return prepared.outcome;
}
