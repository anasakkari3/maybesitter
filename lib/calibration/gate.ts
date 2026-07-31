import { CONSISTENCY_GATE_CONTRACT_VERSION } from './contracts';
import type {
  AdjudicationRecord,
  ConsistencyGateReport,
  ConsistencyGateThresholds,
  DimensionAgreement,
  GateInput,
  GateStatus,
} from './contracts';
import {
  classificationCounts,
  policyNormalizedDecisionAgreement,
  rawDecisionAgreement,
  unadjudicatedDisagreements,
} from './consistency';
import type { DecisionPair, PerItemAnnotation } from './consistency';
import { computePerItemAgreement } from './perItemAgreement';

/**
 * The agreed thresholds.
 *
 * `minPolicyNormalizedDecisionAgreement` is 0.85, the conventional
 * substantial-agreement bar, applied to a deliberately hard stratified sample.
 * `underpoweredBelowComparisons` is 30: below that a single item moves the rate
 * by more than three points, so any pass is reported as provisional rather than
 * final. That distinction is the point — the first round's gate reported a bare
 * rate over 10 items with no power statement at all.
 */
export const DEFAULT_GATE_THRESHOLDS: ConsistencyGateThresholds = {
  minPolicyNormalizedDecisionAgreement: 0.85,
  minPerItemAgreement: 0.85,
  underpoweredBelowComparisons: 30,
  requireEveryDisagreementAdjudicated: true,
};

export interface EvaluateGateInput {
  reportId: string;
  createdAt: string;
  inputs: readonly GateInput[];
  pairs: readonly DecisionPair[];
  adjudications: readonly AdjudicationRecord[];
  perItemAnnotations: readonly PerItemAnnotation[];
  thresholds?: ConsistencyGateThresholds;
}

export function evaluateConsistencyGate(input: EvaluateGateInput): ConsistencyGateReport {
  const thresholds = input.thresholds ?? DEFAULT_GATE_THRESHOLDS;
  const { underpoweredBelowComparisons } = thresholds;

  const raw = rawDecisionAgreement(input.pairs, underpoweredBelowComparisons);
  const normalized = policyNormalizedDecisionAgreement(
    input.pairs,
    input.adjudications,
    underpoweredBelowComparisons,
  );

  const dateTimeDefectSourceIds = input.adjudications
    .filter((record) => record.dimension === 'date_time' && record.classification === 'tooling_defect')
    .map((record) => record.sourceQueueId);

  const perItem = computePerItemAgreement(input.perItemAnnotations, {
    underpoweredBelowComparisons,
    dateTimeDefectSourceIds,
  });

  const unadjudicated = unadjudicatedDisagreements(input.pairs, input.adjudications);

  const failures: string[] = [];
  const provisos: string[] = [];

  if (thresholds.requireEveryDisagreementAdjudicated && unadjudicated.length > 0) {
    failures.push(
      `${unadjudicated.length} disagreement(s) have no adjudication: ${unadjudicated.join(', ')}`,
    );
  }

  // An unmeasurable dimension is a gate failure, never a silent null. This is
  // the defect that let the first round's multi-commitment gate fail open.
  const allDimensions: readonly DimensionAgreement[] = [normalized, ...perItem.dimensions];
  for (const dimension of allDimensions) {
    if (!dimension.measurable) {
      failures.push(
        `${dimension.dimension} agreement is unmeasurable (0 comparisons); the gate cannot be closed on a dimension it does not measure`,
      );
    }
  }

  if (normalized.measurable && (normalized.rate ?? 0) < thresholds.minPolicyNormalizedDecisionAgreement) {
    failures.push(
      `policy-normalized decision agreement ${formatRate(normalized.rate)} is below the ${thresholds.minPolicyNormalizedDecisionAgreement} threshold`,
    );
  }

  for (const dimension of perItem.dimensions) {
    if (dimension.measurable && (dimension.rate ?? 0) < thresholds.minPerItemAgreement) {
      failures.push(
        `${dimension.dimension} agreement ${formatRate(dimension.rate)} is below the ${thresholds.minPerItemAgreement} threshold`,
      );
    }
  }

  for (const dimension of allDimensions) {
    if (dimension.measurable && dimension.underpowered) {
      provisos.push(
        `${dimension.dimension} is measured over ${dimension.compared} comparison(s), below the ${underpoweredBelowComparisons} needed for a final result`,
      );
    }
  }

  if (perItem.excludedByDefect > 0) {
    provisos.push(
      `${perItem.excludedByDefect} date-time comparison(s) excluded as an adjudicated tooling defect`,
    );
  }

  const reannotation = input.adjudications.filter((record) => record.requiresReannotation);
  if (reannotation.length > 0) {
    provisos.push(
      `${reannotation.length} source(s) need re-annotation before their Gold is usable: ${reannotation
        .map((record) => record.sourceQueueId)
        .join(', ')}`,
    );
  }

  const status: GateStatus =
    failures.length > 0 ? 'fail' : provisos.length > 0 ? 'pass_provisional' : 'pass';

  return {
    contractVersion: CONSISTENCY_GATE_CONTRACT_VERSION,
    reportId: input.reportId,
    createdAt: input.createdAt,
    inputs: input.inputs,
    thresholds,
    comparedItems: input.pairs.length,
    classification: classificationCounts(input.pairs, input.adjudications),
    rawDecisionAgreement: raw,
    policyNormalizedDecisionAgreement: normalized,
    perItemAgreement: perItem.dimensions,
    unadjudicatedDisagreements: unadjudicated,
    status,
    failures,
    provisos,
  };
}

function formatRate(rate: number | null): string {
  return rate === null ? 'null' : rate.toFixed(4);
}

/** A provisional pass is enough to freeze Gold. It is never enough to train. */
export function gateAuthorizesFreeze(report: ConsistencyGateReport): boolean {
  return report.status === 'pass' || report.status === 'pass_provisional';
}

export function gateAuthorizesTraining(report: ConsistencyGateReport): boolean {
  return report.status === 'pass';
}
