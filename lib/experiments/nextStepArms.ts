import type { Commitment, DomainState } from '../../src/domain/stateMachine';
import type { NextStepLocale, NextStepRecommendationContract } from '../../src/contracts/v1/nextStepContracts';
import { NEXT_STEP_ARMS, NEXT_STEP_BASELINE_ARM, type NextStepArm } from '../../src/contracts/v1/experimentContracts';
import type { PreferenceMemory, FactMemory } from '../../src/domain/memory/memoryTypes.ts';
import {
  candidatesFromDomainState,
  scoreBaselineCandidate,
  selectBaselineNextStep,
  type BaselineCandidate,
  type BaselineScore,
  type BaselineSelection,
} from '../services/nextStepBaseline';
import { isSafeText, proposeNextStep } from '../services/nextStepReviewService';
import {
  buildBehaviorProfile,
  kindAffinity,
  localHour,
  preferredHours,
  profileIsUsable,
  type BehaviorProfile,
} from './behaviorProfile';

export interface ArmCandidate extends BaselineCandidate {
  kind: Commitment['kind'];
}

export interface ArmAdjustment {
  commitmentId: string;
  bonus: number;
  labels: string[];
}

export interface ArmSelection {
  arm: NextStepArm | 'stated-preference';
  recommendation: NextStepRecommendationContract;
  scores: BaselineScore[];
  selectedCommitmentId: string | null;
  adjustments: ArmAdjustment[];
  /** Set when an arm could not run its own logic and deliberately fell back. */
  fallbackReason: string | null;
  preferenceTrace?: PreferenceTraceEntry[];
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
    || left.commitmentId.localeCompare(right.commitmentId);
}

function explanation(labels: readonly string[]): string {
  return labels.length === 1 ? `Based on ${labels[0]}.` : `Based on ${labels.slice(0, 2).join(' and ')}.`;
}

export interface PreferenceTraceEntry {
  kind: 'fact' | 'preference';
  id: string;
  statement: string;
  confidence: number;
  effect: 'bonus' | 'penalty' | 'veto';
  magnitude: number;
}

export interface StatedPreferenceInputs {
  preferences: readonly PreferenceMemory[];
  facts: readonly FactMemory[];
}

const PREFERENCE_CONFIDENCE_FLOOR = 0.5;
const SOFT_PREFER_BONUS = 2;
const HARD_PREFER_BONUS = 4;
const SOFT_AVOID_PENALTY = -2;
const FACT_BONUS = 1;

function scopeMatchesCandidate(scope: string, candidateTitle: string): boolean {
  return candidateTitle.toLowerCase().includes(scope.toLowerCase());
}

/**
 * ADR §5: "magnitude scales with confidence". The 0.5 floor stays an on/off gate — below
 * it a statement contributes nothing at all — but above it the effect is proportional, so
 * the feedback loop's ±0.03/-0.05 confidence nudges actually move ranking instead of doing
 * nothing until a nudge happens to cross the gate.
 */
function scaledMagnitude(base: number, confidence: number): number {
  return base * confidence;
}

interface StatedAdjustment {
  /** Soft signals (soft prefer/avoid, facts). Only ever break ties inside an urgency tier. */
  softBonus: number;
  /** Hard prefer signals. An explicit user override, allowed to compete across tiers. */
  hardBonus: number;
  veto: boolean;
  trace: PreferenceTraceEntry[];
}

function statedPreferenceAdjustment(
  candidate: ArmCandidate,
  inputs: StatedPreferenceInputs,
): StatedAdjustment {
  const trace: PreferenceTraceEntry[] = [];
  let softBonus = 0;
  let hardBonus = 0;
  let veto = false;

  for (const preference of inputs.preferences) {
    if (preference.status !== 'active') continue;
    // A confirm-band (0.60–0.84) statement is recorded but unconfirmed: it must not move
    // ranking until a human confirms it, otherwise two similar-but-different statements
    // on one scope would both score, which is exactly what the confirm band exists to stop.
    if (preference.requiresConfirmation) continue;
    if (preference.confidence < PREFERENCE_CONFIDENCE_FLOOR) continue;
    if (!scopeMatchesCandidate(preference.scope, candidate.title)) continue;

    if (preference.polarity === 'avoid' && preference.strength === 'hard') {
      veto = true;
      trace.push({ kind: 'preference', id: preference.id, statement: preference.statement, confidence: preference.confidence, effect: 'veto', magnitude: 0 });
      continue;
    }
    if (preference.polarity === 'avoid') {
      const magnitude = scaledMagnitude(SOFT_AVOID_PENALTY, preference.confidence);
      softBonus += magnitude;
      trace.push({ kind: 'preference', id: preference.id, statement: preference.statement, confidence: preference.confidence, effect: 'penalty', magnitude });
      continue;
    }
    const hard = preference.strength === 'hard';
    const magnitude = scaledMagnitude(hard ? HARD_PREFER_BONUS : SOFT_PREFER_BONUS, preference.confidence);
    if (hard) hardBonus += magnitude;
    else softBonus += magnitude;
    trace.push({ kind: 'preference', id: preference.id, statement: preference.statement, confidence: preference.confidence, effect: 'bonus', magnitude });
  }

  for (const fact of inputs.facts) {
    if (fact.status !== 'active') continue;
    if (fact.requiresConfirmation) continue;
    if (fact.confidence < PREFERENCE_CONFIDENCE_FLOOR) continue;
    if (!scopeMatchesCandidate(fact.scope, candidate.title)) continue;
    // Facts state what is true, not a ranked preference, so they are always a soft signal.
    const magnitude = scaledMagnitude(FACT_BONUS, fact.confidence);
    softBonus += magnitude;
    trace.push({ kind: 'fact', id: fact.id, statement: fact.statement, confidence: fact.confidence, effect: 'bonus', magnitude });
  }

  return { softBonus, hardBonus, veto, trace };
}

/** The three urgency dimensions the deterministic baseline ranks on, most significant first. */
function urgencyTierOrder(left: BaselineScore, right: BaselineScore): number {
  return right.latenessBand - left.latenessBand
    || right.urgencyBand - left.urgencyBand
    || right.importanceBand - left.importanceBand;
}

function selectStatedPreferenceArm(
  candidates: readonly ArmCandidate[],
  baseline: BaselineSelection,
  inputs: StatedPreferenceInputs,
  locale: NextStepLocale,
  proposalId: string,
): ArmSelection {
  const byId = new Map(candidates.map((candidate) => [candidate.commitmentId, candidate]));
  const eligible = baseline.scores.filter((score) => score.evidenceSufficient);

  const adjustmentById = new Map<string, StatedAdjustment>();
  for (const score of eligible) {
    const candidate = byId.get(score.commitmentId);
    if (!candidate) continue;
    adjustmentById.set(score.commitmentId, statedPreferenceAdjustment(candidate, inputs));
  }

  const hardBonusOf = (score: BaselineScore): number => adjustmentById.get(score.commitmentId)?.hardBonus || 0;
  const softBonusOf = (score: BaselineScore): number => adjustmentById.get(score.commitmentId)?.softBonus || 0;

  const notVetoed = eligible.filter((score) => !adjustmentById.get(score.commitmentId)?.veto);
  // Ranking order, most significant first:
  //   1. HARD prefer signals — an explicit user override, deliberately allowed to beat the
  //      baseline's urgency tiers (the same latitude the hard-avoid veto already has).
  //   2. The baseline's own urgency tiers (lateness → urgency → importance).
  //   3. SOFT signals (soft prefer/avoid, facts) — a nudge *within* one urgency tier only.
  //   4. The baseline's remaining tiebreaks (effort, then id).
  // Step 2 sitting above step 3 is what makes "a soft preference is outweighed by overdue
  // urgency" true: a mild +2*confidence can no longer pull a candidate past a genuinely
  // more urgent one, only past an equally urgent one.
  const selectedScore = [...notVetoed].sort((left, right) => (
    hardBonusOf(right) - hardBonusOf(left)
      || urgencyTierOrder(left, right)
      || softBonusOf(right) - softBonusOf(left)
      || baselineOrder(left, right)
  ))[0];
  const selected = selectedScore ? byId.get(selectedScore.commitmentId) : null;
  const fallbackReason = inputs.preferences.length === 0 && inputs.facts.length === 0 ? 'no_stated_state' : null;

  // Every otherwise-eligible candidate was hard-avoid vetoed. Falling back to the
  // pre-veto baseline here would silently recommend the very candidate the veto was
  // meant to exclude, so this case is handled separately from "nothing eligible at all".
  if (eligible.length > 0 && notVetoed.length === 0) {
    const vetoedScores = eligible.filter((score) => adjustmentById.get(score.commitmentId)?.veto);
    const vetoTrace = vetoedScores.flatMap((score) => adjustmentById.get(score.commitmentId)?.trace || []);
    const recommendation = { ...proposeNextStep([], locale, proposalId), state: 'insufficient_evidence' as const };
    return {
      arm: 'stated-preference',
      recommendation,
      scores: baseline.scores,
      selectedCommitmentId: null,
      adjustments: [],
      fallbackReason: 'all_vetoed',
      preferenceTrace: vetoTrace,
    };
  }

  if (!selected || !selectedScore) {
    return { arm: 'stated-preference', ...baseline, adjustments: [], fallbackReason };
  }

  const trace = adjustmentById.get(selectedScore.commitmentId)?.trace || [];
  // This is the first arm to put arbitrary user-authored free text into evidenceLabels —
  // every earlier arm only used fixed system-generated strings. Screen it with the same
  // tone guard proposeNextStep applies to `reason`, so a statement like "I must go to the
  // gym" is dropped from the surfaced evidence rather than collapsing the whole proposal.
  const statementLabels = trace.map((entry) => entry.statement).filter(isSafeText);
  const evidenceLabels = [...selectedScore.evidenceLabels, ...statementLabels];
  const recommendation = proposeNextStep(
    [{
      commitmentId: selected.commitmentId,
      title: selected.title,
      reason: explanation(evidenceLabels),
      evidenceLabels,
      rank: 0,
    }],
    locale,
    proposalId,
  );
  return {
    arm: 'stated-preference',
    recommendation,
    scores: baseline.scores,
    // If the proposal did not survive review (e.g. the commitment's own title trips the
    // tone guard), nothing was actually surfaced. Reporting a pick anyway would let a
    // benchmark credit the arm with a recommendation the user never saw.
    selectedCommitmentId: recommendation.state === 'ready' ? selected.commitmentId : null,
    adjustments: [],
    fallbackReason,
    preferenceTrace: trace,
  };
}

export function selectNextStepForArm(
  arm: NextStepArm | 'stated-preference',
  candidates: readonly ArmCandidate[],
  context: ArmContext,
  profile?: BehaviorProfile,
  statedInputs?: StatedPreferenceInputs,
): ArmSelection {
  const baseline = selectBaselineNextStep(candidates, context.now, context.locale, context.proposalId);
  if (arm === NEXT_STEP_BASELINE_ARM) {
    return { arm, ...baseline, adjustments: [], fallbackReason: null };
  }

  if (arm === 'stated-preference') {
    return selectStatedPreferenceArm(candidates, baseline, statedInputs || { preferences: [], facts: [] }, context.locale, context.proposalId);
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
