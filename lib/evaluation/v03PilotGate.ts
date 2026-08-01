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
    repeatedRecommendationUsers: number;
    repeatedAcceptanceUsers: number;
    repeatedCompletionUsers: number;
    correctionUsers: number;
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
    repeatedAcceptanceRate: number | null;
    repeatedCompletionRate: number | null;
    correctionRate: number | null;
    invasiveFeedbackRate: number | null;
    trustPrivacyObjectionRate: number | null;
    existingWorkflowPreferenceRate: number | null;
  };
  blockers: string[];
  conditions: string[];
  acceptedLimitations: string[];
  changesRequiredBeforeV04: string[];
  evidenceRefs: string[];
}

const SHA = /^[0-9a-f]{40}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EVIDENCE_REF = /^(?:https:\/\/github\.com\/anasakkari3\/maybesitter\/(?:issues|pull)\/\d+|artifact:\/\/[a-z0-9/_-]+)$/;
const FORBIDDEN_EVIDENCE = /raw|transcript|message|name|email|phone|diagnosis/i;

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
  if (!ISO_TIME.test(input.reviewedAt)) errors.push('reviewedAt must be UTC ISO time');
  if (!SHA.test(input.candidateSha)) errors.push('candidateSha must be a full lowercase SHA');

  const counts = [
    input.interviews.total, input.interviews.commercial, input.interviews.fastResearch,
    input.interviews.recurringWeeklyPainWithConcreteCost, input.pilot.qualifiedUsers,
    input.pilot.activatedUsers, input.pilot.repeatedRecommendationUsers,
    input.pilot.repeatedAcceptanceUsers, input.pilot.repeatedCompletionUsers,
    input.pilot.correctionUsers, input.pilot.invasiveFeedbackUsers,
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
  for (const [name, value] of [
    ['repeatedAcceptanceUsers', input.pilot.repeatedAcceptanceUsers],
    ['repeatedCompletionUsers', input.pilot.repeatedCompletionUsers],
    ['correctionUsers', input.pilot.correctionUsers],
  ] as const) {
    if (value > input.pilot.repeatedRecommendationUsers) errors.push(`${name} exceeds repeated recommendation users`);
  }
  if (input.pilot.invasiveFeedbackUsers > input.pilot.qualifiedUsers || input.pilot.trustPrivacyObjectionUsers > input.pilot.qualifiedUsers) {
    errors.push('trust counts exceed qualified users');
  }
  if (input.competitive.existingWorkflowPreferred > input.competitive.completedComparisons) errors.push('preference count exceeds comparisons');
  if (![input.experiment.medianLatencyMs, input.experiment.p95LatencyMs, input.experiment.averageCostCents].every(finiteNonNegative)) {
    errors.push('latency and cost must be finite and non-negative');
  }
  if (input.experiment.p95LatencyMs < input.experiment.medianLatencyMs) errors.push('p95 latency cannot be below median');
  if (input.acceptedLimitations.some((item) => !item.trim() || item.length > 240)) errors.push('limitations must be concise');
  if (input.evidenceRefs.length === 0 || input.evidenceRefs.some((ref) => !EVIDENCE_REF.test(ref) || FORBIDDEN_EVIDENCE.test(ref))) {
    errors.push('evidenceRefs must contain privacy-safe GitHub or artifact references');
  }
  return errors;
}

export function buildV03GateReport(input: V03GateInput): V03GateReport {
  const validation = validateV03GateInput(input);
  if (validation.length) throw new Error(`invalid V03 gate input: ${validation.join('; ')}`);

  const metrics = {
    recurringPainRate: rate(input.interviews.recurringWeeklyPainWithConcreteCost, input.interviews.total),
    activationRate: rate(input.pilot.activatedUsers, input.pilot.qualifiedUsers),
    repeatedAcceptanceRate: rate(input.pilot.repeatedAcceptanceUsers, input.pilot.repeatedRecommendationUsers),
    repeatedCompletionRate: rate(input.pilot.repeatedCompletionUsers, input.pilot.repeatedRecommendationUsers),
    correctionRate: rate(input.pilot.correctionUsers, input.pilot.repeatedRecommendationUsers),
    invasiveFeedbackRate: rate(input.pilot.invasiveFeedbackUsers, input.pilot.qualifiedUsers),
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
  if (!input.operations.ownerRecorded || !input.operations.rollbackVerified) blockers.push('Operational ownership and rollback verification are required.');
  if (input.operations.privacyIncidents > 0 || input.operations.criticalSafetyIncidents > 0 || input.operations.unresolvedIncidents > 0) {
    blockers.push('Privacy, critical safety, or unresolved incidents require HOLD.');
  }
  if (metrics.invasiveFeedbackRate !== null && metrics.invasiveFeedbackRate >= 0.25) blockers.push('Invasive feedback reached the 25% major-failure threshold.');
  if (metrics.trustPrivacyObjectionRate !== null && metrics.trustPrivacyObjectionRate > 0.30) blockers.push('Trust/privacy objections exceeded 30%.');
  if (input.competitive.completedComparisons < 10) blockers.push('Competitive workflow evidence is too small for the pilot gate.');

  const problemFailure = metrics.recurringPainRate !== null && metrics.recurringPainRate < 0.40;
  const competitiveFailure = metrics.existingWorkflowPreferenceRate !== null && metrics.existingWorkflowPreferenceRate >= 0.70;
  let decision: V03GateDecision;
  if (problemFailure || competitiveFailure) {
    decision = 'PIVOT';
    changesRequiredBeforeV04.push(problemFailure ? 'Revisit the target problem or cohort before V04.' : 'Revisit the standalone workflow thesis before V04.');
  } else if (blockers.length) {
    decision = 'HOLD';
    changesRequiredBeforeV04.push(...blockers);
  } else {
    if (metrics.activationRate !== null && metrics.activationRate < 0.25) conditions.push('Activation is below 25%; improve first-value completion before V04.');
    if (metrics.repeatedAcceptanceRate !== null && metrics.repeatedAcceptanceRate < 0.35) conditions.push('Repeated recommendation acceptance is below 35%.');
    if (metrics.repeatedCompletionRate !== null && metrics.repeatedCompletionRate < 0.25) conditions.push('Repeated recommendation completion is below 25%.');
    if (input.operations.criticalReliabilityIncidents > 0) conditions.push('Resolve the reliability incident pattern before V04 expansion.');
    decision = conditions.length || input.acceptedLimitations.length ? 'CONDITIONAL GO' : 'GO';
    changesRequiredBeforeV04.push(...conditions);
  }

  return {
    schemaVersion: 'v1', reviewedAt: input.reviewedAt, candidateSha: input.candidateSha,
    decision, pilotExposureMayContinue: decision === 'GO' || decision === 'CONDITIONAL GO',
    metrics, blockers, conditions, acceptedLimitations: [...input.acceptedLimitations],
    changesRequiredBeforeV04, evidenceRefs: [...input.evidenceRefs],
  };
}
