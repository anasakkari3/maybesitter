import type { Commitment, DomainState } from '../../src/domain/stateMachine';
import type { NextStepLocale, NextStepRecommendationContract } from '../../src/contracts/v1/nextStepContracts';
import { proposeNextStep } from './nextStepReviewService';
import { compareByCodePoint } from '../planning/shared/compare';

export interface BaselineCandidate {
  commitmentId: string;
  title: string;
  confirmed: boolean;
  status: Commitment['status'];
  dueAt: string | null;
  remindAt: string | null;
  importance: 'low' | 'normal' | 'high' | null;
  explicitEffortMinutes: number | null;
}

export interface BaselineScore {
  commitmentId: string;
  eligible: boolean;
  evidenceSufficient: boolean;
  latenessBand: 0 | 1;
  urgencyBand: 0 | 1 | 2;
  importanceBand: 0 | 1 | 2 | 3;
  effortTieBreak: number;
  evidenceLabels: string[];
  exclusionReason: 'not_confirmed' | 'closed' | 'invalid_time' | null;
}

export interface BaselineSelection {
  recommendation: NextStepRecommendationContract;
  scores: BaselineScore[];
  selectedCommitmentId: string | null;
}

const CLOSED = new Set<Commitment['status']>(['completed', 'dropped', 'archived']);
const DAY_MS = 24 * 60 * 60 * 1_000;

function parseExplicitTime(candidate: BaselineCandidate): number | null | 'invalid' {
  const raw = candidate.dueAt || candidate.remindAt;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 'invalid' : parsed;
}

function importanceBand(value: BaselineCandidate['importance']): 0 | 1 | 2 | 3 {
  if (value === 'high') return 3;
  if (value === 'normal') return 2;
  if (value === 'low') return 1;
  return 0;
}

export function scoreBaselineCandidate(candidate: BaselineCandidate, now: Date): BaselineScore {
  const time = parseExplicitTime(candidate);
  const closed = CLOSED.has(candidate.status);
  const eligible = candidate.confirmed && !closed && time !== 'invalid';
  const nowMs = now.getTime();
  const latenessBand = typeof time === 'number' && time < nowMs ? 1 : 0;
  const urgencyBand = typeof time !== 'number' || time < nowMs
    ? 0
    : time - nowMs <= DAY_MS ? 2 : time - nowMs <= 7 * DAY_MS ? 1 : 0;
  const importance = importanceBand(candidate.importance);
  const effort = candidate.explicitEffortMinutes;
  const effortValid = effort !== null && Number.isFinite(effort) && effort > 0;
  const evidenceLabels: string[] = [];
  if (latenessBand) evidenceLabels.push('overdue');
  else if (urgencyBand === 2) evidenceLabels.push('due within 24 hours');
  else if (urgencyBand === 1) evidenceLabels.push('due within 7 days');
  if (importance > 0) evidenceLabels.push(`importance: ${candidate.importance}`);
  if (effortValid) evidenceLabels.push(`effort: ${Math.round(effort)} minutes`);

  return {
    commitmentId: candidate.commitmentId,
    eligible,
    evidenceSufficient: eligible && evidenceLabels.length > 0,
    latenessBand,
    urgencyBand,
    importanceBand: importance,
    effortTieBreak: effortValid ? -Math.round(effort) : Number.MIN_SAFE_INTEGER,
    evidenceLabels,
    exclusionReason: !candidate.confirmed ? 'not_confirmed' : closed ? 'closed' : time === 'invalid' ? 'invalid_time' : null,
  };
}

function compareScores(left: BaselineScore, right: BaselineScore): number {
  return right.latenessBand - left.latenessBand
    || right.urgencyBand - left.urgencyBand
    || right.importanceBand - left.importanceBand
    || right.effortTieBreak - left.effortTieBreak
    // Code-unit ordering, never `localeCompare`. This is the final key of the
    // baseline order, so on a fully-tied score it alone decides which
    // commitment the user is shown — and `localeCompare` with no argument
    // resolves against the host's default locale. Measured: 'i-ITEM' and
    // 'I-item' swap between en-US and tr-TR.
    || compareByCodePoint(left.commitmentId, right.commitmentId);
}

function explanation(labels: readonly string[]): string {
  return labels.length === 1 ? `Based on ${labels[0]}.` : `Based on ${labels.slice(0, 2).join(' and ')}.`;
}

export function selectBaselineNextStep(
  candidates: readonly BaselineCandidate[],
  now: Date,
  locale: NextStepLocale,
  proposalId: string,
): BaselineSelection {
  const scores = candidates
    .map((candidate) => scoreBaselineCandidate(candidate, now))
    .sort((left, right) => compareByCodePoint(left.commitmentId, right.commitmentId));
  const byId = new Map(candidates.map((candidate) => [candidate.commitmentId, candidate]));
  const selectedScore = scores.filter((score) => score.evidenceSufficient).sort(compareScores)[0];
  const selected = selectedScore ? byId.get(selectedScore.commitmentId) : null;
  let recommendation = proposeNextStep(
    selected && selectedScore ? [{
      commitmentId: selected.commitmentId,
      title: selected.title,
      reason: explanation(selectedScore.evidenceLabels),
      evidenceLabels: selectedScore.evidenceLabels,
      rank: 0,
    }] : [],
    locale,
    proposalId,
  );
  if (!selected && scores.some((score) => score.eligible)) {
    recommendation = { ...recommendation, state: 'insufficient_evidence' };
  }
  return { recommendation, scores, selectedCommitmentId: selected?.commitmentId || null };
}

export function candidatesFromDomainState(state: DomainState): BaselineCandidate[] {
  return Object.values(state.commitments).map((commitment) => ({
    commitmentId: commitment.id,
    title: commitment.title,
    confirmed: commitment.confirmedAt !== null,
    status: commitment.status,
    dueAt: commitment.timeSpec.dueAt,
    remindAt: commitment.timeSpec.remindAt,
    importance: commitment.priority.source === 'user_explicit' ? commitment.priority.level : null,
    explicitEffortMinutes: null,
  }));
}

export interface VariantComparison {
  baselineCommitmentId: string | null;
  variantCommitmentId: string | null;
  sameSelection: boolean;
  baselineEvidenceLabels: string[];
}

export function compareVariantSelection(
  baseline: BaselineSelection,
  variantCommitmentId: string | null,
): VariantComparison {
  const selectedScore = baseline.scores.find((score) => score.commitmentId === baseline.selectedCommitmentId);
  return {
    baselineCommitmentId: baseline.selectedCommitmentId,
    variantCommitmentId,
    sameSelection: baseline.selectedCommitmentId === variantCommitmentId,
    baselineEvidenceLabels: selectedScore?.evidenceLabels || [],
  };
}
