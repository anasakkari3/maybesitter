import { createHash, randomUUID } from 'node:crypto';
import type { DomainState } from '../../src/domain/stateMachine';
import type { RuntimeControlSnapshot } from '../../src/contracts/v1/runtimeControls';
import { readRuntimeControls, resolveModuleRuntime } from '../../src/contracts/v1/runtimeControls';
import type { NextStepDecision, NextStepLocale, NextStepRecommendationContract } from '../../src/contracts/v1/nextStepContracts';
import type { PrivacySafeAnalyticsEvent } from '../../src/contracts/v1/analyticsEventContracts';
import { cohortFor } from '../analytics/privacySafeEvents';
import { candidatesFromDomainState, selectBaselineNextStep } from './nextStepBaseline';
import { decideNextStep, type NextStepInteractionOutcome } from './nextStepReviewService';

export interface LiveContext {
  anonymousUserId: string;
  consent: 'granted' | 'essential';
  locale: NextStepLocale;
  now: Date;
  controls?: RuntimeControlSnapshot;
  emit: (event: PrivacySafeAnalyticsEvent) => void;
  emitShown?: boolean;
}

function proposalId(state: DomainState): string {
  const fingerprint = JSON.stringify(Object.values(state.commitments).map((item) => [item.id, item.updatedAt]).sort());
  return `next-step-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`;
}

function event(context: LiveContext, name: PrivacySafeAnalyticsEvent['eventName'], properties: PrivacySafeAnalyticsEvent['properties']): PrivacySafeAnalyticsEvent {
  return {
    version: 'v1',
    eventId: randomUUID(),
    eventName: name,
    occurredAt: context.now.toISOString(),
    anonymousUserId: context.anonymousUserId,
    cohortId: cohortFor(context.now),
    experiment: { experimentId: 'v02-next-step', arm: 'baseline' },
    consent: context.consent,
    properties,
  };
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
  const proposal = selectBaselineNextStep(candidatesFromDomainState(state), context.now, context.locale, proposalId(state)).recommendation;
  if (proposal.state === 'ready' && context.consent === 'granted' && context.emitShown !== false && proposal.primaryStep) {
    context.emit(event(context, 'recommendation_shown', { proposalId: proposal.proposalId, commitmentId: proposal.primaryStep.commitmentId, baselineVersion: 'v1' }));
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
  if (context.consent === 'granted') context.emit(event(context, DECISION_EVENTS[decision], properties));
  return outcome;
}
