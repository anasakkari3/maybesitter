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
import { decideNextStep, proposeNextStep, type NextStepInteractionOutcome } from './nextStepReviewService';
import { evidenceLabels } from './nextStepEvidence';
import { latenessDeadline } from './mobile/time';
import { notStartableYet, preparationStep, startsSoon, type PreparationStep } from './nextStepPreparation';

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

function proposalId(state: DomainState, salt = ''): string {
  const fingerprint = JSON.stringify(Object.values(state.commitments).map((item) => [item.id, item.updatedAt]).sort()) + salt;
  return `next-step-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`;
}

/**
 * Timed events that are not yet close enough to be a step (audit 2026-10-03
 * #2, `nextStepPreparation.ts` rule 1). Removed like a deferred item: from
 * the candidates only, nowhere else.
 */
function startableNow(state: DomainState, now: Date): DomainState {
  const commitments = Object.fromEntries(
    Object.entries(state.commitments).filter(([, commitment]) => !notStartableYet(commitment, now)),
  );
  return { ...state, commitments };
}

/**
 * Whether the ordinary pick should stay ahead of a preparation step: a task
 * (not an event) with a deadline still to come, before the event and within a
 * day. Doing that first is the order the person's own deadlines imply. A
 * deadline already gone does not count — a stale item must not hold the
 * preparation back for ever.
 */
function keepsPrecedence(state: DomainState, commitmentId: string | null, prep: PreparationStep, now: Date): boolean {
  const commitment = commitmentId ? state.commitments[commitmentId] : undefined;
  if (!commitment || commitment.timeSpec.kind === 'scheduled_event') return false;
  const deadline = Date.parse(latenessDeadline(commitment.timeSpec) ?? '');
  const eventStart = Date.parse(prep.event.timeSpec.dueAt as string);
  return Number.isFinite(deadline) && deadline > now.getTime() && deadline < eventStart
    && deadline - now.getTime() <= 24 * 60 * 60 * 1_000;
}

function explanationText(labels: readonly string[]): string {
  return labels.length === 1 ? `Based on ${labels[0]}.` : `Based on ${labels.slice(0, 2).join(' and ')}.`;
}

/** The preparation step as a proposal: the event's id, the preparation's words, no `done`/`edit`. */
function preparationProposal(prep: PreparationStep, locale: NextStepLocale, id: string): NextStepRecommendationContract {
  const proposal = proposeNextStep([{
    commitmentId: prep.event.id,
    title: prep.title,
    reason: explanationText(evidenceLabels(prep.evidenceCodes)),
    evidenceCodes: prep.evidenceCodes,
    rank: 0,
  }], locale, id);
  if (proposal.state !== 'ready' || !proposal.primaryStep) return proposal;
  return {
    ...proposal,
    primaryStep: { ...proposal.primaryStep, purpose: 'prepare' },
    // `done` would complete the exam and `edit` would rename it: the step is
    // the preparation, the commitment it points at is the event.
    availableActions: proposal.availableActions.filter((action) => action === 'accept' || action === 'defer' || action === 'dismiss'),
  };
}

/** A timed event inside its last hour says so first: it is "coming up", not "start it". */
function withStartsSoon(proposal: NextStepRecommendationContract, state: DomainState, now: Date): NextStepRecommendationContract {
  const id = proposal.primaryStep?.commitmentId;
  if (proposal.state !== 'ready' || !id || !proposal.explanation || !startsSoon(id, state, now)) return proposal;
  const evidenceCodes = [{ code: 'starts_soon' as const }, ...proposal.explanation.evidenceCodes.filter((entry) => entry.code !== 'starts_soon')].slice(0, 3);
  return {
    ...proposal,
    explanation: {
      ...proposal.explanation,
      evidenceCodes,
      evidenceLabels: evidenceLabels(evidenceCodes),
      summary: explanationText(evidenceLabels(evidenceCodes)),
    },
  };
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
  const visible = visibleState(state, context.excludeCommitmentIds);
  const candidates = startableNow(visible, context.now);
  const selection = selectNextStepForArmFromState(arm, candidates, {
    now: context.now,
    locale: context.locale,
    proposalId: proposalId(candidates),
    timezone: context.timezone || 'UTC',
    ...(context.routine ? { routine: context.routine } : {}),
  });
  // Preparation for an important event comes before the ordinary pick, unless
  // that pick is a task due first (`keepsPrecedence`). Its id is its own: a
  // card holding the ordinary proposal is stale once this replaces it.
  const prep = preparationStep(visible, context.now, context.timezone || 'UTC', context.locale);
  const proposal = prep && !keepsPrecedence(candidates, selection.selectedCommitmentId, prep, context.now)
    ? preparationProposal(prep, context.locale, proposalId(candidates, `|prepare:${prep.event.id}`))
    : withStartsSoon(selection.recommendation, candidates, context.now);
  const latencyMs = Math.round(performance.now() - startedAt);

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
