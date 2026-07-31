import type { AdjudicationRecord, ConsistencyDimension, DimensionAgreement } from './contracts';
import { adjudicationFor } from './adjudication';
import { wilsonInterval } from './wilson';

/** One reviewer decision, in the shape the Gemma review tooling writes. */
export interface ReviewDecision {
  sourceQueueId: string;
  decision: string;
  completion: Readonly<Record<string, unknown>> | null;
}

/** One per-item Gold annotation of a multi-commitment source. */
export interface PerItemAnnotation {
  sourceQueueId: string;
  reviewerId: string;
  itemCount: number;
  items: readonly PerItemEntry[];
}

export interface PerItemEntry {
  order: number;
  sourceSegment: string;
  startCodePoint: number;
  endCodePoint: number;
  target: Readonly<Record<string, unknown>>;
}

export interface DecisionPair {
  sourceQueueId: string;
  first: ReviewDecision;
  second: ReviewDecision;
  agrees: boolean;
}

/** Target fields that carry a temporal value; scored as their own dimension. */
export const DATE_TIME_TARGET_FIELDS: readonly string[] = ['dueAt', 'remindAt', 'localTimeSpec'];

export function buildDecisionPairs(
  first: readonly ReviewDecision[],
  second: readonly ReviewDecision[],
  blindSourceIds: readonly string[],
): readonly DecisionPair[] {
  const firstById = lastWins(first);
  const secondById = lastWins(second);

  const pairs: DecisionPair[] = [];
  for (const sourceQueueId of blindSourceIds) {
    const a = firstById.get(sourceQueueId);
    const b = secondById.get(sourceQueueId);
    if (a === undefined || b === undefined) continue;
    pairs.push({ sourceQueueId, first: a, second: b, agrees: a.decision === b.decision });
  }
  return pairs;
}

function lastWins(decisions: readonly ReviewDecision[]): Map<string, ReviewDecision> {
  const byId = new Map<string, ReviewDecision>();
  for (const decision of decisions) byId.set(decision.sourceQueueId, decision);
  return byId;
}

export function makeAgreement(
  dimension: ConsistencyDimension,
  matches: number,
  compared: number,
  underpoweredBelowComparisons: number,
): DimensionAgreement {
  const measurable = compared > 0;
  return {
    dimension,
    matches,
    compared,
    rate: measurable ? matches / compared : null,
    measurable,
    confidenceInterval: wilsonInterval(matches, compared),
    underpowered: !measurable || compared < underpoweredBelowComparisons,
  };
}

export function rawDecisionAgreement(
  pairs: readonly DecisionPair[],
  underpoweredBelowComparisons: number,
): DimensionAgreement {
  const matches = pairs.filter((pair) => pair.agrees).length;
  return makeAgreement('decision', matches, pairs.length, underpoweredBelowComparisons);
}

/**
 * Agreement over the items that actually measure reviewer reliability.
 *
 * Disagreements a human adjudicated as `policy_shift` or `tooling_defect` are
 * excluded, not counted as agreement: the two passes were made under different
 * rules or against broken tooling, so they are evidence of neither reliability
 * nor unreliability. Counting them as agreement would inflate the rate; leaving
 * them in would blame the reviewer for a guideline change.
 */
export function policyNormalizedDecisionAgreement(
  pairs: readonly DecisionPair[],
  adjudications: readonly AdjudicationRecord[],
  underpoweredBelowComparisons: number,
): DimensionAgreement {
  let matches = 0;
  let compared = 0;

  for (const pair of pairs) {
    if (pair.agrees) {
      matches += 1;
      compared += 1;
      continue;
    }

    const adjudication = adjudicationFor(adjudications, pair.sourceQueueId);
    if (adjudication === null) {
      compared += 1;
      continue;
    }
    if (adjudication.classification === 'policy_shift' || adjudication.classification === 'tooling_defect') {
      continue;
    }
    compared += 1;
  }

  return makeAgreement('decision', matches, compared, underpoweredBelowComparisons);
}

export function classificationCounts(
  pairs: readonly DecisionPair[],
  adjudications: readonly AdjudicationRecord[],
): Record<'agreement' | 'policy_shift' | 'tooling_defect' | 'reviewer_noise', number> {
  const counts = { agreement: 0, policy_shift: 0, tooling_defect: 0, reviewer_noise: 0 };

  for (const pair of pairs) {
    if (pair.agrees) {
      counts.agreement += 1;
      continue;
    }
    const adjudication = adjudicationFor(adjudications, pair.sourceQueueId);
    if (adjudication === null || adjudication.classification === 'agreement') continue;
    counts[adjudication.classification] += 1;
  }

  return counts;
}

export function unadjudicatedDisagreements(
  pairs: readonly DecisionPair[],
  adjudications: readonly AdjudicationRecord[],
): readonly string[] {
  return pairs
    .filter((pair) => !pair.agrees && adjudicationFor(adjudications, pair.sourceQueueId) === null)
    .map((pair) => pair.sourceQueueId)
    .sort();
}
