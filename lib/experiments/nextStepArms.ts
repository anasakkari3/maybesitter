import type { Commitment, DomainState } from '../../src/domain/stateMachine';
import type { NextStepLocale, NextStepRecommendationContract } from '../../src/contracts/v1/nextStepContracts';
import { NEXT_STEP_ARMS, NEXT_STEP_BASELINE_ARM, type NextStepArm } from '../../src/contracts/v1/experimentContracts';
import {
  candidatesFromDomainState,
  scoreBaselineCandidate,
  selectBaselineNextStep,
  type BaselineCandidate,
  type BaselineScore,
} from '../services/nextStepBaseline';
import { proposeNextStep } from '../services/nextStepReviewService';
import {
  buildBehaviorProfile,
  kindAffinity,
  localHour,
  preferredHours,
  profileIsUsable,
  type BehaviorProfile,
} from './behaviorProfile';
import { compareByCodePoint } from '../planning/shared/compare';

export interface ArmCandidate extends BaselineCandidate {
  kind: Commitment['kind'];
}

export interface ArmAdjustment {
  commitmentId: string;
  bonus: number;
  labels: string[];
}

export interface ArmSelection {
  arm: NextStepArm;
  recommendation: NextStepRecommendationContract;
  scores: BaselineScore[];
  selectedCommitmentId: string | null;
  adjustments: ArmAdjustment[];
  /** Set when an arm could not run its own logic and deliberately fell back. */
  fallbackReason: string | null;
}

export interface ArmContext {
  now: Date;
  locale: NextStepLocale;
  proposalId: string;
  timezone: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const LATE_DAY_HOUR = 17;
const QUIET_HOURS_START = 22;
const QUIET_HOURS_END = 7;

function isQuietHour(hour: number): boolean {
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

function dueWithin(candidate: BaselineCandidate, now: Date, windowMs: number): boolean {
  const raw = candidate.dueAt || candidate.remindAt;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(parsed)) return false;
  const delta = parsed - now.getTime();
  return delta >= 0 && delta <= windowMs;
}

function isOverdue(candidate: BaselineCandidate, now: Date): boolean {
  const raw = candidate.dueAt || candidate.remindAt;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return !Number.isNaN(parsed) && parsed < now.getTime();
}

function shortEffort(candidate: BaselineCandidate): boolean {
  const effort = candidate.explicitEffortMinutes;
  return effort !== null && Number.isFinite(effort) && effort > 0 && effort <= 15;
}

/**
 * Context-aware deterministic rules. Same evidence and eligibility as the generic arm;
 * only the ordering among already-eligible candidates changes.
 */
function contextualAdjustment(candidate: ArmCandidate, context: ArmContext, hour: number | null): ArmAdjustment {
  const labels: string[] = [];
  let bonus = 0;

  if (hour !== null && isQuietHour(hour) && !isOverdue(candidate, context.now)) {
    bonus -= 2;
    labels.push('outside your usual hours');
  }
  if (hour !== null && hour >= LATE_DAY_HOUR && shortEffort(candidate)) {
    bonus += 2;
    labels.push('short enough for the end of the day');
  }
  if (dueWithin(candidate, context.now, DAY_MS)) {
    bonus += 1;
    labels.push('fits before it is due');
  }
  return { commitmentId: candidate.commitmentId, bonus, labels };
}

/**
 * Lightweight personalization from the user's own closed-commitment counts. It layers on
 * top of the contextual rules and never uses cross-user data or a trained model.
 */
function personalizedAdjustment(
  candidate: ArmCandidate,
  context: ArmContext,
  hour: number | null,
  profile: BehaviorProfile,
): ArmAdjustment {
  const base = contextualAdjustment(candidate, context, hour);
  const labels = [...base.labels];
  let bonus = base.bonus;

  const affinity = kindAffinity(profile, candidate.kind);
  if (affinity >= 0.2) {
    bonus += 2;
    labels.push('you usually finish these');
  } else if (affinity <= -0.2) {
    bonus -= 1;
    labels.push('you often set these aside');
  }
  if (hour !== null && preferredHours(profile).includes(hour)) {
    bonus += 1;
    labels.push('a time you usually get things done');
  }
  return { commitmentId: candidate.commitmentId, bonus, labels };
}

function baselineOrder(left: BaselineScore, right: BaselineScore): number {
  return right.latenessBand - left.latenessBand
    || right.urgencyBand - left.urgencyBand
    || right.importanceBand - left.importanceBand
    || right.effortTieBreak - left.effortTieBreak
    // Code-unit ordering, never `localeCompare` — see the note on the same fix
    // in lib/services/nextStepReviewService.ts. This is the final key of the
    // baseline order, so on a fully-tied score it alone decides the selection.
    || compareByCodePoint(left.commitmentId, right.commitmentId);
}

function explanation(labels: readonly string[]): string {
  return labels.length === 1 ? `Based on ${labels[0]}.` : `Based on ${labels.slice(0, 2).join(' and ')}.`;
}

export function selectNextStepForArm(
  arm: NextStepArm,
  candidates: readonly ArmCandidate[],
  context: ArmContext,
  profile?: BehaviorProfile,
): ArmSelection {
  const baseline = selectBaselineNextStep(candidates, context.now, context.locale, context.proposalId);
  if (arm === NEXT_STEP_BASELINE_ARM) {
    return { arm, ...baseline, adjustments: [], fallbackReason: null };
  }

  const usable = arm === 'personalized' && profile !== undefined && profileIsUsable(profile);
  const fallbackReason = arm === 'personalized' && !usable
    ? (profile === undefined ? 'no_profile' : 'insufficient_history')
    : null;

  const hour = localHour(context.now, context.timezone);
  const adjustments = candidates.map((candidate) => (
    usable && profile
      ? personalizedAdjustment(candidate, context, hour, profile)
      : contextualAdjustment(candidate, context, hour)
  ));
  const bonusById = new Map(adjustments.map((adjustment) => [adjustment.commitmentId, adjustment]));
  const byId = new Map(candidates.map((candidate) => [candidate.commitmentId, candidate]));

  // Arms may only reorder candidates the generic arm already found eligible and evidenced.
  const eligible = baseline.scores.filter((score) => score.evidenceSufficient);
  const selectedScore = [...eligible].sort((left, right) => (
    (bonusById.get(right.commitmentId)?.bonus || 0) - (bonusById.get(left.commitmentId)?.bonus || 0)
      || baselineOrder(left, right)
  ))[0];
  const selected = selectedScore ? byId.get(selectedScore.commitmentId) : null;

  if (!selected || !selectedScore) {
    return { arm, ...baseline, adjustments, fallbackReason };
  }

  const armLabels = bonusById.get(selectedScore.commitmentId)?.labels || [];
  const evidenceLabels = [...selectedScore.evidenceLabels, ...armLabels];
  const recommendation = proposeNextStep(
    [{
      commitmentId: selected.commitmentId,
      title: selected.title,
      reason: explanation(evidenceLabels),
      evidenceLabels,
      rank: 0,
    }],
    context.locale,
    context.proposalId,
  );
  return { arm, recommendation, scores: baseline.scores, selectedCommitmentId: selected.commitmentId, adjustments, fallbackReason };
}

export function armCandidatesFromDomainState(state: DomainState): ArmCandidate[] {
  return candidatesFromDomainState(state).map((candidate) => ({
    ...candidate,
    kind: state.commitments[candidate.commitmentId].kind,
  }));
}

export function selectNextStepForArmFromState(
  arm: NextStepArm,
  state: DomainState,
  context: ArmContext,
): ArmSelection {
  return selectNextStepForArm(
    arm,
    armCandidatesFromDomainState(state),
    context,
    arm === 'personalized' ? buildBehaviorProfile(state, context.timezone) : undefined,
  );
}

export { NEXT_STEP_ARMS, scoreBaselineCandidate };
