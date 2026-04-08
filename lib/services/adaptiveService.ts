import { getCommandServiceState } from './commandService';
import {
  getBehaviorFeedbackSignals,
  type BehaviorFeedbackScopeOptions,
  type BehaviorFeedbackStore,
} from './behaviorFeedbackService';
import type { DomainState } from '../../src/domain/stateMachine';

export type AdaptiveUserType = 'disciplined' | 'inconsistent' | 'avoidant';
export type AdaptivePressureLevel = 'low' | 'medium' | 'high';
export type AdaptiveSuggestionStyle = 'direct' | 'supportive' | 'minimal';

export interface AdaptiveSignals {
  ignoredCommitmentsCount?: number | null;
  completionRate?: number | null;
  delayFrequency?: number | null;
  clarificationFrequency?: number | null;
}

export type NormalizedAdaptiveSignals = {
  [Key in keyof AdaptiveSignals]-?: number;
};

export interface AdaptiveBehavior {
  userType: AdaptiveUserType;
  pressureLevel: AdaptivePressureLevel;
  suggestionStyle: AdaptiveSuggestionStyle;
}

export interface AdaptiveFeedbackOptions extends BehaviorFeedbackScopeOptions {
  feedbackStore?: BehaviorFeedbackStore;
  clarificationFrequency?: number | null;
}

const DEFAULT_SIGNALS: NormalizedAdaptiveSignals = {
  ignoredCommitmentsCount: 0,
  completionRate: 1,
  delayFrequency: 0,
  clarificationFrequency: 0,
};

function nonNegativeInteger(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function rate(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function normalizeAdaptiveSignals(signals: AdaptiveSignals = {}): NormalizedAdaptiveSignals {
  return {
    ignoredCommitmentsCount: nonNegativeInteger(
      signals.ignoredCommitmentsCount,
      DEFAULT_SIGNALS.ignoredCommitmentsCount
    ),
    completionRate: rate(signals.completionRate, DEFAULT_SIGNALS.completionRate),
    delayFrequency: rate(signals.delayFrequency, DEFAULT_SIGNALS.delayFrequency),
    clarificationFrequency: rate(signals.clarificationFrequency, DEFAULT_SIGNALS.clarificationFrequency),
  };
}

function hasSignal(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalRateMax(a: number | null | undefined, b: number | null | undefined): number | undefined {
  const values = [a, b].filter(hasSignal).map((value) => rate(value, 0));
  return values.length > 0 ? Math.max(...values) : undefined;
}

function optionalRateMin(a: number | null | undefined, b: number | null | undefined): number | undefined {
  const values = [a, b].filter(hasSignal).map((value) => rate(value, 1));
  return values.length > 0 ? Math.min(...values) : undefined;
}

function hasFeedbackContext(options: AdaptiveFeedbackOptions): boolean {
  return Boolean(
    options.feedbackStore ||
    options.feedbackScopeId ||
    options.conversationId ||
    options.sessionId ||
    options.userId
  );
}

export function mergeAdaptiveSignals(primary: AdaptiveSignals = {}, feedback: AdaptiveSignals = {}): AdaptiveSignals {
  return {
    ignoredCommitmentsCount:
      nonNegativeInteger(primary.ignoredCommitmentsCount, 0) + nonNegativeInteger(feedback.ignoredCommitmentsCount, 0),
    completionRate: optionalRateMin(primary.completionRate, feedback.completionRate),
    delayFrequency: optionalRateMax(primary.delayFrequency, feedback.delayFrequency),
    clarificationFrequency: optionalRateMax(primary.clarificationFrequency, feedback.clarificationFrequency),
  };
}

function classifyUserType(signals: NormalizedAdaptiveSignals): AdaptiveUserType {
  if (
    signals.ignoredCommitmentsCount >= 3 ||
    signals.completionRate < 0.35 ||
    signals.delayFrequency >= 0.6
  ) {
    return 'avoidant';
  }

  if (
    signals.ignoredCommitmentsCount >= 1 ||
    signals.completionRate < 0.75 ||
    signals.delayFrequency >= 0.25 ||
    signals.clarificationFrequency >= 0.35
  ) {
    return 'inconsistent';
  }

  return 'disciplined';
}

function behaviorFor(userType: AdaptiveUserType): AdaptiveBehavior {
  if (userType === 'avoidant') {
    return {
      userType,
      pressureLevel: 'high',
      suggestionStyle: 'direct',
    };
  }

  if (userType === 'inconsistent') {
    return {
      userType,
      pressureLevel: 'medium',
      suggestionStyle: 'supportive',
    };
  }

  return {
    userType,
    pressureLevel: 'low',
    suggestionStyle: 'minimal',
  };
}

export function getAdaptiveBehavior(signals: AdaptiveSignals = {}): AdaptiveBehavior {
  return behaviorFor(classifyUserType(normalizeAdaptiveSignals(signals)));
}

export function deriveAdaptiveSignals(
  state: DomainState = getCommandServiceState(),
  sessionSignals: AdaptiveFeedbackOptions = {}
): NormalizedAdaptiveSignals {
  const commitments = Object.values(state.commitments);
  const trackableCommitments = commitments.filter((commitment) => (
    commitment.status !== 'draft' &&
    commitment.status !== 'needs_clarification' &&
    commitment.status !== 'pending_confirmation'
  ));
  const denominator = trackableCommitments.length;
  const completed = trackableCommitments.filter((commitment) => commitment.status === 'completed').length;
  const ignoredCommitmentIds = new Set<string>();

  for (const commitment of commitments) {
    if (commitment.currentAckState === 'ignored') ignoredCommitmentIds.add(commitment.id);
  }
  for (const reminder of Object.values(state.reminders)) {
    if (reminder.status === 'ignored') ignoredCommitmentIds.add(reminder.commitmentId);
  }

  const delayedCommitmentIds = new Set<string>();
  for (const commitment of commitments) {
    if (commitment.currentAckState === 'postponed' || commitment.postponedUntil) {
      delayedCommitmentIds.add(commitment.id);
    }
  }
  for (const reminder of Object.values(state.reminders)) {
    if (reminder.status === 'snoozed' || reminder.snoozedUntil) delayedCommitmentIds.add(reminder.commitmentId);
  }

  const stateSignals: AdaptiveSignals = {
    ignoredCommitmentsCount: ignoredCommitmentIds.size,
    completionRate: denominator === 0 ? undefined : completed / denominator,
    delayFrequency: denominator === 0 ? undefined : delayedCommitmentIds.size / denominator,
    clarificationFrequency: sessionSignals.clarificationFrequency,
  };

  const feedbackSignals = hasFeedbackContext(sessionSignals)
    ? getBehaviorFeedbackSignals({
      feedbackStore: sessionSignals.feedbackStore,
      feedbackScopeId: sessionSignals.feedbackScopeId,
      conversationId: sessionSignals.conversationId,
      sessionId: sessionSignals.sessionId,
      userId: sessionSignals.userId,
    })
    : {};

  return normalizeAdaptiveSignals(mergeAdaptiveSignals(stateSignals, feedbackSignals));
}

export function getAdaptiveBehaviorFromState(
  state: DomainState = getCommandServiceState(),
  sessionSignals: AdaptiveFeedbackOptions = {}
): AdaptiveBehavior {
  return getAdaptiveBehavior(deriveAdaptiveSignals(state, sessionSignals));
}
