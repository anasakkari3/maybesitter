export type V03GateDecision = 'GO' | 'CONDITIONAL GO' | 'PIVOT' | 'HOLD';

export interface V03GateInput {
  schemaVersion: 'v1';
  reviewedAt: string;
  candidateSha: string;
  dependencies: {
    issue54Complete: boolean;
    issue55Complete: boolean;
    issue56Complete: boolean;
  };
  interviews: {
    total: number;
    commercial: number;
    fastResearch: number;
    recurringWeeklyPainWithConcreteCost: number;
  };
  pilot: {
    qualifiedUsers: number;
    activatedUsers: number;
    recommendationShownUsers: number;
    acceptedRecommendationUsers: number;
    completedRecommendationUsers: number;
    repeatedRecommendationUsers: number;
    repeatedAcceptanceUsers: number;
    repeatedCompletionUsers: number;
    correctionUsers: number;
    invasivenessResponseUsers: number;
    invasiveFeedbackUsers: number;
    trustPrivacyObjectionUsers: number;
  };
  experiment: {
    assignmentIntegrityPassed: boolean;
    baselineUsers: number;
    contextualUsers: number;
    personalizedUsers: number;
    medianLatencyMs: number;
    p95LatencyMs: number;
    averageCostCents: number;
  };
  operations: {
    criticalReliabilityIncidents: number;
    criticalSafetyIncidents: number;
    privacyIncidents: number;
    unresolvedIncidents: number;
    rollbackVerified: boolean;
    ownerRecorded: boolean;
  };
  competitive: {
    completedComparisons: number;
    existingWorkflowPreferred: number;
  };
  acceptedLimitations: string[];
  evidenceRefs: string[];
  evidenceChecksums: {
    researchSha256: string;
    pilotSha256: string;
    experimentSha256: string;
    operationsSha256: string;
    competitiveSha256: string;
  };
}

export interface V03GateReport {
  schemaVersion: 'v1';
  reviewedAt: string;
  candidateSha: string;
  decision: V03GateDecision;
  pilotExposureMayContinue: boolean;
  metrics: {
    recurringPainRate: number | null;
    activationRate: number | null;
    earlyAcceptanceRate: number | null;
    earlyCompletionRate: number | null;
    repeatedAcceptanceRate: number | null;
    repeatedCompletionRate: number | null;
    correctionRate: number | null;
    invasiveFeedbackRate: number | null;
    invasivenessResponseRate: number | null;
    trustPrivacyObjectionRate: number | null;
    existingWorkflowPreferenceRate: number | null;
  };
  blockers: string[];
  conditions: string[];
  acceptedLimitations: string[];
  changesRequiredBeforeV04: string[];
  evidenceRefs: string[];
  evidenceChecksums: V03GateInput['evidenceChecksums'];
}

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EVIDENCE_REF = /^(?:https:\/\/github\.com\/anasakkari3\/maybesitter\/(?:issues|pull)\/\d+|artifact:\/\/[a-z0-9/_-]+)$/;
const FORBIDDEN_EVIDENCE = /raw|transcript|message|name|email|phone|diagnosis/i;
const LIMITATION_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const EVIDENCE_CHECKSUM_KEYS = [
  'researchSha256', 'pilotSha256', 'experimentSha256', 'operationsSha256', 'competitiveSha256',
] as const;

export const V03_OPERATIONAL_THRESHOLDS = Object.freeze({
  conditionalP95LatencyMs: 2_000,
  holdP95LatencyMs: 5_000,
  conditionalAverageCostCents: 1,
  holdAverageCostCents: 5,
  conditionalCorrectionRate: 0.25,
  minimumInvasivenessResponseRate: 0.5,
});

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function integer(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function validateV03GateInput(input: V03GateInput): string[] {
  const errors: string[] = [];
  if (input.schemaVersion !== 'v1') errors.push('schemaVersion must be v1');
  const normalizedReviewTime = typeof input.reviewedAt === 'string' && !input.reviewedAt.includes('.')
    ? input.reviewedAt.replace(/Z$/, '.000Z') : input.reviewedAt;
  if (!ISO_TIME.test(input.reviewedAt) || Number.isNaN(Date.parse(input.reviewedAt)) || new Date(input.reviewedAt).toISOString() !== normalizedReviewTime) errors.push('reviewedAt must be UTC ISO time');
  if (!SHA.test(input.candidateSha)) errors.push('candidateSha must be a full lowercase SHA');

  const counts = [
    input.interviews.total, input.interviews.commercial, input.interviews.fastResearch,
    input.interviews.recurringWeeklyPainWithConcreteCost, input.pilot.qualifiedUsers,
    input.pilot.activatedUsers, input.pilot.recommendationShownUsers,
    input.pilot.acceptedRecommendationUsers, input.pilot.completedRecommendationUsers,
    input.pilot.repeatedRecommendationUsers,
    input.pilot.repeatedAcceptanceUsers, input.pilot.repeatedCompletionUsers,
    input.pilot.correctionUsers, input.pilot.invasivenessResponseUsers, input.pilot.invasiveFeedbackUsers,
    input.pilot.trustPrivacyObjectionUsers, input.experiment.baselineUsers,
    input.experiment.contextualUsers, input.experiment.personalizedUsers,
    input.operations.criticalReliabilityIncidents, input.operations.criticalSafetyIncidents,
    input.operations.privacyIncidents, input.operations.unresolvedIncidents,
    input.competitive.completedComparisons, input.competitive.existingWorkflowPreferred,
  ];
  if (counts.some((value) => !integer(value))) errors.push('all evidence counts must be non-negative integers');
  if (input.interviews.commercial + input.interviews.fastResearch !== input.interviews.total) errors.push('interview cohort counts must reconcile');
  if (input.interviews.recurringWeeklyPainWithConcreteCost > input.interviews.total) errors.push('pain count exceeds interviews');
  if (input.pilot.activatedUsers > input.pilot.qualifiedUsers) errors.push('activated users exceed qualified users');
  if (input.pilot.recommendationShownUsers > input.pilot.activatedUsers) errors.push('recommendation shown users exceed activated users');
  for (const [name, value] of [
    ['acceptedRecommendationUsers', input.pilot.acceptedRecommendationUsers],
    ['completedRecommendationUsers', input.pilot.completedRecommendationUsers],
    ['correctionUsers', input.pilot.correctionUsers],
    ['invasivenessResponseUsers', input.pilot.invasivenessResponseUsers],
  ] as const) {
    if (value > input.pilot.recommendationShownUsers) errors.push(`${name} exceeds recommendation shown users`);
  }
  if (input.pilot.repeatedRecommendationUsers > input.pilot.recommendationShownUsers) errors.push('repeated recommendation users exceed recommendation shown users');
  for (const [name, value] of [
    ['repeatedAcceptanceUsers', input.pilot.repeatedAcceptanceUsers],
    ['repeatedCompletionUsers', input.pilot.repeatedCompletionUsers],
  ] as const) {
    if (value > input.pilot.repeatedRecommendationUsers) errors.push(`${name} exceeds repeated recommendation users`);
  }
  if (input.pilot.invasiveFeedbackUsers > input.pilot.invasivenessResponseUsers || input.pilot.trustPrivacyObjectionUsers > input.pilot.qualifiedUsers) {
    errors.push('trust counts exceed qualified users');
  }
  const assignedUsers = input.experiment.baselineUsers + input.experiment.contextualUsers + input.experiment.personalizedUsers;
  if (assignedUsers !== input.pilot.recommendationShownUsers) errors.push('experiment arm users must reconcile to recommendation shown users');
  if (input.competitive.existingWorkflowPreferred > input.competitive.completedComparisons) errors.push('preference count exceeds comparisons');
  if (input.competitive.completedComparisons > input.interviews.total) errors.push('competitive comparisons exceed interviews');
  if (![input.experiment.medianLatencyMs, input.experiment.p95LatencyMs, input.experiment.averageCostCents].every(finiteNonNegative)) {
    errors.push('latency and cost must be finite and non-negative');
  }
  if (input.experiment.p95LatencyMs < input.experiment.medianLatencyMs) errors.push('p95 latency cannot be below median');
  if (input.acceptedLimitations.some((item) => !LIMITATION_CODE.test(item))) errors.push('limitations must use privacy-safe codes');
  if (input.evidenceRefs.length === 0 || input.evidenceRefs.some((ref) => !EVIDENCE_REF.test(ref) || FORBIDDEN_EVIDENCE.test(ref))) {
    errors.push('evidenceRefs must contain privacy-safe GitHub or artifact references');
  }
  if (new Set(input.evidenceRefs).size !== input.evidenceRefs.length) errors.push('evidenceRefs must not contain duplicates');
  if (!input.evidenceChecksums
    || Object.keys(input.evidenceChecksums).sort().join(',') !== [...EVIDENCE_CHECKSUM_KEYS].sort().join(',')
    || Object.values(input.evidenceChecksums).some((checksum) => !SHA256.test(checksum))) {
    errors.push('all five evidence checksums must be lowercase SHA-256');
  }
  return errors;
}

export function buildV03GateReport(input: V03GateInput): V03GateReport {
  const validation = validateV03GateInput(input);
  if (validation.length) throw new Error(`invalid V03 gate input: ${validation.join('; ')}`);

  const metrics = {
    recurringPainRate: rate(input.interviews.recurringWeeklyPainWithConcreteCost, input.interviews.total),
    activationRate: rate(input.pilot.activatedUsers, input.pilot.qualifiedUsers),
    earlyAcceptanceRate: rate(input.pilot.acceptedRecommendationUsers, input.pilot.recommendationShownUsers),
    earlyCompletionRate: rate(input.pilot.completedRecommendationUsers, input.pilot.recommendationShownUsers),
    repeatedAcceptanceRate: rate(input.pilot.repeatedAcceptanceUsers, input.pilot.repeatedRecommendationUsers),
    repeatedCompletionRate: rate(input.pilot.repeatedCompletionUsers, input.pilot.repeatedRecommendationUsers),
    correctionRate: rate(input.pilot.correctionUsers, input.pilot.recommendationShownUsers),
    invasiveFeedbackRate: rate(input.pilot.invasiveFeedbackUsers, input.pilot.invasivenessResponseUsers),
    invasivenessResponseRate: rate(input.pilot.invasivenessResponseUsers, input.pilot.recommendationShownUsers),
    trustPrivacyObjectionRate: rate(input.pilot.trustPrivacyObjectionUsers, input.pilot.qualifiedUsers),
    existingWorkflowPreferenceRate: rate(input.competitive.existingWorkflowPreferred, input.competitive.completedComparisons),
  };
  const blockers: string[] = [];
  const conditions: string[] = [];
  const changesRequiredBeforeV04: string[] = [];

  if (!input.dependencies.issue54Complete) blockers.push('Issue #54 evidence is incomplete.');
  if (!input.dependencies.issue55Complete) blockers.push('Issue #55 pilot is incomplete.');
  if (!input.dependencies.issue56Complete) blockers.push('Issue #56 comparison experiment is incomplete.');
  if (input.interviews.total < 30 || input.interviews.total > 40) blockers.push('Interview sample must contain 30–40 participants.');
  if (input.pilot.qualifiedUsers < 25 || input.pilot.qualifiedUsers > 40) blockers.push('Closed pilot must contain 25–40 qualified users.');
  if (!input.experiment.assignmentIntegrityPassed) blockers.push('Experiment assignment integrity failed.');
  if ([input.experiment.baselineUsers, input.experiment.contextualUsers, input.experiment.personalizedUsers].some((users) => users === 0)) {
    blockers.push('Every experiment arm must contain exposed users.');
  }
  if (input.pilot.repeatedRecommendationUsers === 0) blockers.push('Repeated recommendation evidence is absent.');
  if (!input.operations.ownerRecorded || !input.operations.rollbackVerified) blockers.push('Operational ownership and rollback verification are required.');
  if (input.operations.privacyIncidents > 0 || input.operations.criticalSafetyIncidents > 0 || input.operations.criticalReliabilityIncidents > 0 || input.operations.unresolvedIncidents > 0) {
    blockers.push('Privacy, critical safety/reliability, or unresolved incidents require HOLD.');
  }
  if (metrics.invasiveFeedbackRate !== null && metrics.invasiveFeedbackRate >= 0.25) blockers.push('Invasive feedback reached the 25% major-failure threshold.');
  if (metrics.trustPrivacyObjectionRate !== null && metrics.trustPrivacyObjectionRate > 0.30) blockers.push('Trust/privacy objections exceeded 30%.');
  if (input.competitive.completedComparisons < 10) blockers.push('Competitive workflow evidence is too small for the pilot gate.');
  if (input.experiment.p95LatencyMs > V03_OPERATIONAL_THRESHOLDS.holdP95LatencyMs) blockers.push('P95 latency exceeded the operational HOLD threshold.');
  if (input.experiment.averageCostCents > V03_OPERATIONAL_THRESHOLDS.holdAverageCostCents) blockers.push('Average cost exceeded the operational HOLD threshold.');

  const problemFailure = metrics.recurringPainRate !== null && metrics.recurringPainRate < 0.40;
  const competitiveFailure = metrics.existingWorkflowPreferenceRate !== null && metrics.existingWorkflowPreferenceRate >= 0.70;
  let decision: V03GateDecision;
  if (blockers.length) {
    decision = 'HOLD';
    changesRequiredBeforeV04.push(...blockers);
  } else if (problemFailure || competitiveFailure) {
    decision = 'PIVOT';
    changesRequiredBeforeV04.push(problemFailure ? 'Revisit the target problem or cohort before V04.' : 'Revisit the standalone workflow thesis before V04.');
  } else {
    if (metrics.recurringPainRate !== null && metrics.recurringPainRate < 0.70) conditions.push('Recurring weekly pain with concrete cost is below the 70% success threshold.');
    if (metrics.activationRate !== null && metrics.activationRate < 0.25) conditions.push('Activation is below 25%; improve first-value completion before V04.');
    if (metrics.earlyAcceptanceRate !== null && metrics.earlyAcceptanceRate < 0.35) conditions.push('Early recommendation acceptance is below 35%.');
    if (metrics.earlyCompletionRate !== null && metrics.earlyCompletionRate < 0.25) conditions.push('Early recommendation completion is below 25%.');
    if (metrics.repeatedAcceptanceRate !== null && metrics.repeatedAcceptanceRate < 0.35) conditions.push('Repeated recommendation acceptance is below 35%.');
    if (metrics.repeatedCompletionRate !== null && metrics.repeatedCompletionRate < 0.25) conditions.push('Repeated recommendation completion is below 25%.');
    if (input.pilot.repeatedRecommendationUsers < 10) conditions.push('Repeated recommendation evidence covers fewer than 10 users.');
    if (metrics.correctionRate !== null && metrics.correctionRate > V03_OPERATIONAL_THRESHOLDS.conditionalCorrectionRate) conditions.push('Recommendation correction exceeds 25%.');
    if (metrics.invasivenessResponseRate !== null && metrics.invasivenessResponseRate < V03_OPERATIONAL_THRESHOLDS.minimumInvasivenessResponseRate) conditions.push('Invasiveness response coverage is below 50%.');
    if (input.experiment.p95LatencyMs > V03_OPERATIONAL_THRESHOLDS.conditionalP95LatencyMs) conditions.push('P95 latency exceeds 2 seconds.');
    if (input.experiment.averageCostCents > V03_OPERATIONAL_THRESHOLDS.conditionalAverageCostCents) conditions.push('Average recommendation cost exceeds 1 cent.');
    decision = conditions.length || input.acceptedLimitations.length ? 'CONDITIONAL GO' : 'GO';
    changesRequiredBeforeV04.push(...conditions);
  }

  return {
    schemaVersion: 'v1', reviewedAt: input.reviewedAt, candidateSha: input.candidateSha,
    decision, pilotExposureMayContinue: decision === 'GO' || decision === 'CONDITIONAL GO',
    metrics, blockers, conditions, acceptedLimitations: [...input.acceptedLimitations],
    changesRequiredBeforeV04, evidenceRefs: [...input.evidenceRefs], evidenceChecksums: { ...input.evidenceChecksums },
  };
}
