import type { Checksum } from '../evaluation/registry/contracts';

export const ANNOTATION_POLICY_CONTRACT_VERSION = '1.0.0';
export const ADJUDICATION_CONTRACT_VERSION = '1.0.0';
export const CONSISTENCY_GATE_CONTRACT_VERSION = '1.0.0';
export const GOLD_FREEZE_CONTRACT_VERSION = '1.0.0';

/**
 * A named, versioned annotation rule set. The first calibration round changed
 * how multi-commitment messages should be labelled *between* the first pass and
 * the blind second pass, and nothing recorded that. The instrument then read the
 * change as reviewer inconsistency. Policies are versioned so a guideline change
 * is a fact about the corpus, not an invisible confound.
 */
export interface AnnotationPolicy {
  id: string;
  version: string;
  title: string;
  effectiveFrom: string;
  supersedes: string | null;
  summary: string;
  /** Rule ids this version introduced, changed, or removed against `supersedes`. */
  changedRules: readonly PolicyRuleChange[];
}

export type PolicyRuleChangeKind = 'introduced' | 'changed' | 'removed';

export interface PolicyRuleChange {
  ruleId: string;
  kind: PolicyRuleChangeKind;
  statement: string;
  /** Which review dimensions a decision under this rule can move. */
  affects: readonly ConsistencyDimension[];
}

export interface AnnotationPolicyRegistry {
  contractVersion: string;
  policies: readonly AnnotationPolicy[];
}

export type ConsistencyDimension =
  | 'decision'
  | 'commitment_count'
  | 'boundary'
  | 'slots'
  | 'date_time';

export const CONSISTENCY_DIMENSIONS: readonly ConsistencyDimension[] = [
  'decision',
  'commitment_count',
  'boundary',
  'slots',
  'date_time',
];

/**
 * Why a blind second pass differs from the canonical first pass.
 *
 * Only `reviewer_noise` measures reviewer reliability. Separating the other
 * classes is the whole point: a guideline change and a tooling defect are real
 * findings that a single "agreement rate" hides.
 */
export type DisagreementClass =
  | 'agreement'
  | 'policy_shift'
  | 'tooling_defect'
  | 'reviewer_noise';

export const DISAGREEMENT_CLASSES: readonly DisagreementClass[] = [
  'agreement',
  'policy_shift',
  'tooling_defect',
  'reviewer_noise',
];

/** Which pass a human adjudicator declared canonical. */
export type CanonicalPass = 'first' | 'second' | 'neither';

/**
 * An adjudication is strictly additive. It never edits `gold-decisions.jsonl`;
 * it records which pass is canonical and why, leaving both original human
 * decisions intact and traceable.
 */
export interface AdjudicationRecord {
  contractVersion: string;
  sourceQueueId: string;
  /**
   * One source can disagree for different reasons at different levels — the
   * decision can flip because a guideline changed while the per-item date-time
   * differs because of a tooling defect. Adjudications are therefore scoped to
   * a dimension, not to a source.
   */
  dimension: ConsistencyDimension;
  classification: DisagreementClass;
  canonicalPass: CanonicalPass;
  /** Policy version each pass was made under. */
  firstPassPolicy: string;
  secondPassPolicy: string;
  /** Policy version the adjudication itself applies. */
  adjudicatedUnderPolicy: string;
  rationale: string;
  adjudicatedBy: string;
  adjudicatedAt: string;
  authorizingIssue: string;
  /** Set when the adjudication records a defect rather than a judgement call. */
  defectId: string | null;
  /** True when the canonical Gold still needs work that this record does not supply. */
  requiresReannotation: boolean;
}

export interface DimensionAgreement {
  dimension: ConsistencyDimension;
  matches: number;
  compared: number;
  /** Null only when `compared` is 0, which is itself a gate failure. */
  rate: number | null;
  measurable: boolean;
  /** Wilson score interval at 95%, so a small sample cannot be over-read. */
  confidenceInterval: readonly [number, number] | null;
  underpowered: boolean;
}

export type GateStatus = 'pass' | 'pass_provisional' | 'fail';

export interface ConsistencyGateThresholds {
  /** Minimum agreement after policy-shift and tooling-defect items are adjudicated. */
  minPolicyNormalizedDecisionAgreement: number;
  /** Minimum agreement on each per-item dimension that has comparisons. */
  minPerItemAgreement: number;
  /** Below this many comparisons a dimension is reported as underpowered. */
  underpoweredBelowComparisons: number;
  /** Every disagreement must carry an adjudication record. */
  requireEveryDisagreementAdjudicated: boolean;
}

export interface ConsistencyGateReport {
  contractVersion: string;
  reportId: string;
  createdAt: string;
  /** Checksums of every input, so the report is reproducible and bindable. */
  inputs: readonly GateInput[];
  thresholds: ConsistencyGateThresholds;
  comparedItems: number;
  classification: Readonly<Record<DisagreementClass, number>>;
  rawDecisionAgreement: DimensionAgreement;
  policyNormalizedDecisionAgreement: DimensionAgreement;
  perItemAgreement: readonly DimensionAgreement[];
  unadjudicatedDisagreements: readonly string[];
  status: GateStatus;
  failures: readonly string[];
  provisos: readonly string[];
}

export interface GateInput {
  name: string;
  path: string;
  checksum: Checksum;
  recordCount: number | null;
}

export type GoldFreezeState = 'frozen' | 'superseded';

export interface FrozenGoldRecord {
  sourceQueueId: string;
  /** Checksum of the canonical decision line, so a rewrite is detectable. */
  decisionChecksum: Checksum;
  decision: string;
  policyVersion: string;
  canonicalPass: CanonicalPass;
  adjudicated: boolean;
  /** Checksum of the canonical per-item Gold record, when the source has one. */
  perItemChecksum: Checksum | null;
  perItemAnnotationIndex: number | null;
  excluded: boolean;
  exclusionReason: string | null;
}

/**
 * The versioned freeze. It pins exactly which human decisions are canonical at
 * a point in time, without copying or rewriting them.
 */
export interface GoldFreezeManifest {
  contractVersion: string;
  freezeId: string;
  version: string;
  state: GoldFreezeState;
  frozenAt: string;
  frozenBy: string;
  authorizingIssue: string;
  policyVersion: string;
  gateReportId: string;
  supersededBy: string | null;
  inputs: readonly GateInput[];
  records: readonly FrozenGoldRecord[];
  /** Checksum over the canonical JSON of `records`, in declared order. */
  recordsChecksum: Checksum;
  includedCount: number;
  excludedCount: number;
  /** Freezing never starts training. This must always be false here. */
  trainingStarted: false;
}
