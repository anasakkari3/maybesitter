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
  /**
   * The most pressure this classification permits — a cap the pressure path
   * takes a minimum against, never a level it reaches for. See `behaviorFor`
   * for why the asymmetry is in the name (#107, UC-3.13 (#199)).
   */
  maxPressureLevel: AdaptivePressureLevel;
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

/**
 * What the classification is allowed to do to pressure (#107, decided in
 * UC-3.13 (#199)).
 *
 * It used to do the opposite of this: `avoidant` meant `pressureLevel: 'high'`
 * worded `direct`, so three ignored commitments moved a person to the strongest
 * setting the product had. The cohort this product is for identifies with
 * avoidance and task-initiation difficulty — the rule read "when someone shows
 * the difficulty this product exists for, push harder", on thresholds that rest
 * on no evidence, inside a loop whose only observed outcome is compliance.
 *
 * The field is `maxPressureLevel` rather than `pressureLevel` because the
 * decision is asymmetric and the old name hid that. It is **a cap, never a
 * level to reach**: the pressure path takes the lowest of the commitment's own
 * base, this cap and the user's ceiling, so a classification can only ever
 * subtract. `disciplined` is `'high'` because it subtracts nothing, not because
 * being disciplined earns a louder reminder — no branch here can produce more
 * pressure than the commitment and the ceiling already allowed.
 *
 * Written this way the classification stays a live, meaningful input (the same
 * rule `src/contracts/v1/personalizationContracts.ts` already states: "Many
 * ignores may make the product quieter; they can never make it louder") instead
 * of a constant folded flat, which is a guarantee nothing can be tested
 * against.
 *
 * `suggestionStyle` is the other half: how small and how concrete the suggested
 * step is. `avoidant` and `inconsistent` both get `supportive` because the
 * answer to avoidance is a smaller step, not a louder one.
 */
function behaviorFor(userType: AdaptiveUserType): AdaptiveBehavior {
  if (userType === 'avoidant') {
    return {
      userType,
      maxPressureLevel: 'low',
      suggestionStyle: 'supportive',
    };
  }

  if (userType === 'inconsistent') {
    return {
      userType,
      maxPressureLevel: 'medium',
      suggestionStyle: 'supportive',
    };
  }

  return {
    userType,
    maxPressureLevel: 'high',
    suggestionStyle: 'minimal',
  };
}

export function getAdaptiveBehavior(signals: AdaptiveSignals = {}): AdaptiveBehavior {
  return behaviorFor(classifyUserType(normalizeAdaptiveSignals(signals)));
}

// Async since UC-1.0c (#142): the behavioural signals it merges in are a
// storage read. `getAdaptiveBehavior(signals)` above stays synchronous — it is
// a pure classifier over signals the caller already has, which is why
// lib/personalizationControls/inventory.ts is untouched by this change.
export async function deriveAdaptiveSignals(
  state: DomainState = getCommandServiceState(),
  sessionSignals: AdaptiveFeedbackOptions = {}
): Promise<NormalizedAdaptiveSignals> {
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
    ? await getBehaviorFeedbackSignals({
      feedbackStore: sessionSignals.feedbackStore,
      feedbackScopeId: sessionSignals.feedbackScopeId,
      conversationId: sessionSignals.conversationId,
      sessionId: sessionSignals.sessionId,
      userId: sessionSignals.userId,
    })
    : {};

  return normalizeAdaptiveSignals(mergeAdaptiveSignals(stateSignals, feedbackSignals));
}

export async function getAdaptiveBehaviorFromState(
  state: DomainState = getCommandServiceState(),
  sessionSignals: AdaptiveFeedbackOptions = {}
): Promise<AdaptiveBehavior> {
  return getAdaptiveBehavior(await deriveAdaptiveSignals(state, sessionSignals));
}
