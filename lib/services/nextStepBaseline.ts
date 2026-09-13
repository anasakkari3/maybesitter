import type { Commitment, DomainState } from '../../src/domain/stateMachine';
import type {
  NextStepEvidenceContract,
  NextStepLocale,
  NextStepRecommendationContract,
} from '../../src/contracts/v1/nextStepContracts';
import { evidenceLabels as labelsFor } from './nextStepEvidence';
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
  /**
   * The user said this, rather than the extractor reading it off their words.
   *
   * An inferred importance used to be discarded outright — `importance` was set
   * to `null` unless the source was `user_explicit` — so a commitment the
   * extractor was confident was urgent scored exactly the same as one with no
   * importance at all. It now counts, at half the weight, which is the only
   * arrangement where a guess can help order two items and can never outrank
   * something the person actually said (UC-2.9, #170).
   */
  importanceIsStated: boolean;
  explicitEffortMinutes: number | null;
}

export interface BaselineScore {
  commitmentId: string;
  eligible: boolean;
  evidenceSufficient: boolean;
  latenessBand: 0 | 1;
  urgencyBand: 0 | 1 | 2;
  importanceBand: number;
  effortTieBreak: number;
  /** Derived from `evidenceCodes`; never assembled separately. See nextStepEvidence.ts. */
  evidenceLabels: string[];
  evidenceCodes: NextStepEvidenceContract[];
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

/**
 * The importance band, on a doubled scale.
 *
 * Doubled so half weight is exact rather than a rounding: stated high/normal/low
 * are 6/4/2 and the same levels guessed are 3/2/1. Every guessed band therefore
 * sits strictly below its stated counterpart, and a guessed `high` (3) also
 * sits below a stated `normal` (4) — which is the point. What the person said
 * outranks what was read off their words, always.
 */
function importanceBand(
  value: BaselineCandidate['importance'],
  stated: boolean,
): number {
  const full = value === 'high' ? 6 : value === 'normal' ? 4 : value === 'low' ? 2 : 0;
  return stated ? full : full / 2;
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
  const importance = importanceBand(candidate.importance, candidate.importanceIsStated);
  const effort = candidate.explicitEffortMinutes;
  const effortValid = effort !== null && Number.isFinite(effort) && effort > 0;
  const evidenceCodes: NextStepEvidenceContract[] = [];
  if (latenessBand) evidenceCodes.push({ code: 'overdue' });
  else if (urgencyBand === 2) evidenceCodes.push({ code: 'due_within_24h' });
  else if (urgencyBand === 1) evidenceCodes.push({ code: 'due_within_7d' });
  if (importance > 0 && candidate.importance) {
    // Two codes, because "you marked it Must" and "this looks like a Must" are
    // different claims and only one of them is true here. Saying the first
    // about a guess is the product taking credit for a decision the user did
    // not make.
    evidenceCodes.push({
      code: candidate.importanceIsStated ? 'importance' : 'importance_estimated',
      params: { level: candidate.importance },
    });
  }
  if (effortValid) evidenceCodes.push({ code: 'effort', params: { minutes: Math.round(effort) } });
  const evidenceLabels = labelsFor(evidenceCodes);

  return {
    commitmentId: candidate.commitmentId,
    eligible,
    evidenceSufficient: eligible && evidenceCodes.length > 0,
    latenessBand,
    urgencyBand,
    importanceBand: importance,
    effortTieBreak: effortValid ? -Math.round(effort) : Number.MIN_SAFE_INTEGER,
    evidenceLabels,
    evidenceCodes,
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
      evidenceCodes: selectedScore.evidenceCodes,
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
    // Three sources, and only two of them are an opinion about this
    // commitment. `default` is the fallback `normal` that every commitment
    // starts with — nobody said anything, and counting it would hand a band to
    // every item alike and put "it looks like a Should" on most cards.
    importance: commitment.priority.source === 'default' ? null : commitment.priority.level,
    importanceIsStated: commitment.priority.source === 'user_explicit',
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
