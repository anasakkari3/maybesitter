import { createHash } from 'node:crypto';

export type ResearchCohort = 'commercial' | 'fast_research';
export type CurrentWorkflow = 'paper' | 'calendar' | 'todo_app' | 'chat_ai' | 'notes' | 'memory' | 'other';
export type SwitchingPain = 'none' | 'low' | 'medium' | 'high';
export type CompetitiveBaseline = 'current_workflow' | 'chatgpt_calendar' | 'chatgpt_todoist';

export interface BehavioralInterviewRecord {
  schemaVersion: 'v1';
  interviewId: string;
  cohort: ResearchCohort;
  cohortEligibilityConfirmed: true;
  occurredAt: string;
  consentRecorded: true;
  adultConfirmed: true;
  pastBehaviorExampleObserved: boolean;
  recurringWeeklyPain: boolean;
  concreteCostObserved: boolean;
  currentWorkflows: CurrentWorkflow[];
  abandonedToolObserved: boolean;
  paidForRelatedTool: boolean;
  privacyBoundaryObserved: boolean;
  switchingPain: SwitchingPain;
  preferredBaseline: CompetitiveBaseline;
  evidenceRef: string;
}

export interface PilotRecruitmentRecord {
  schemaVersion: 'v1';
  candidateId: string;
  cohort: ResearchCohort;
  screenedAt: string;
  adultConfirmed: true;
  qualified: boolean;
  behavioralPainQualified: boolean;
  cohortEligibilityConfirmed: true;
  researchConsentRecorded: true;
  pilotContactConsentRecorded: boolean;
  pilotStatus: 'not_invited' | 'invited' | 'accepted' | 'declined' | 'withdrawn';
}

export interface V03ResearchReport {
  schemaVersion: 'v1';
  interviewSample: {
    total: number;
    targetMinimum: 30;
    targetMaximum: 40;
    complete: boolean;
  };
  problemEvidence: {
    qualifiedPainCount: number;
    rate: number | null;
    decision: 'success' | 'failure' | 'inconclusive' | 'insufficient_sample';
  };
  recruitment: {
    qualifiedAndContactConsented: number;
    accepted: number;
    targetMinimum: 25;
    targetMaximum: 40;
    complete: boolean;
  };
  cohorts: Record<ResearchCohort, {
    interviews: number;
    qualifiedPainCount: number;
    qualifiedPainRate: number | null;
    paidForRelatedToolCount: number;
    highOrMediumSwitchingPainCount: number;
  }>;
  competitiveBaselines: Record<CompetitiveBaseline, number>;
  cohortDifferences: {
    qualifiedPainRateCommercialMinusFastResearch: number | null;
    paidToolRateCommercialMinusFastResearch: number | null;
    switchingPainRateCommercialMinusFastResearch: number | null;
  };
  evidenceIntegrity: {
    algorithm: 'sha256';
    interviewsSemanticSha256: string;
    recruitmentSemanticSha256: string;
  };
  limitations: string[];
}

const INTERVIEW_KEYS = new Set([
  'schemaVersion', 'interviewId', 'cohort', 'cohortEligibilityConfirmed', 'occurredAt', 'consentRecorded', 'adultConfirmed',
  'pastBehaviorExampleObserved', 'recurringWeeklyPain', 'concreteCostObserved', 'currentWorkflows',
  'abandonedToolObserved', 'paidForRelatedTool', 'privacyBoundaryObserved', 'switchingPain',
  'preferredBaseline', 'evidenceRef',
]);
const RECRUITMENT_KEYS = new Set([
  'schemaVersion', 'candidateId', 'cohort', 'screenedAt', 'adultConfirmed', 'qualified', 'behavioralPainQualified', 'cohortEligibilityConfirmed',
  'researchConsentRecorded', 'pilotContactConsentRecorded', 'pilotStatus',
]);
const FORBIDDEN_KEYS = /name|email|phone|address|transcript|raw(message|text)|diagnosis/i;
const ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const COHORTS = new Set<ResearchCohort>(['commercial', 'fast_research']);
const WORKFLOWS = new Set<CurrentWorkflow>(['paper', 'calendar', 'todo_app', 'chat_ai', 'notes', 'memory', 'other']);
const SWITCHING = new Set<SwitchingPain>(['none', 'low', 'medium', 'high']);
const BASELINES = new Set<CompetitiveBaseline>(['current_workflow', 'chatgpt_calendar', 'chatgpt_todoist']);
const PILOT_STATUSES = new Set<PilotRecruitmentRecord['pilotStatus']>(['not_invited', 'invited', 'accepted', 'declined', 'withdrawn']);

function exactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key) && !FORBIDDEN_KEYS.test(key))
    && allowed.size === Object.keys(value).length;
}

function validIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(value);
  const normalized = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === normalized;
}

export function validateInterviewRecord(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['record must be an object'];
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  if (!exactKeys(record, INTERVIEW_KEYS)) errors.push('record fields must exactly match the privacy-safe v1 schema');
  if (record.schemaVersion !== 'v1') errors.push('schemaVersion must be v1');
  if (typeof record.interviewId !== 'string' || !ID.test(record.interviewId)) errors.push('interviewId must be pseudonymous');
  if (!COHORTS.has(record.cohort as ResearchCohort)) errors.push('cohort is invalid');
  if (record.cohortEligibilityConfirmed !== true) errors.push('cohort eligibility must be confirmed');
  if (!validIsoTime(record.occurredAt)) errors.push('occurredAt must be UTC ISO time');
  if (record.consentRecorded !== true || record.adultConfirmed !== true) errors.push('consent and adult confirmation are required');
  for (const key of ['pastBehaviorExampleObserved', 'recurringWeeklyPain', 'concreteCostObserved', 'abandonedToolObserved', 'paidForRelatedTool', 'privacyBoundaryObserved']) {
    if (typeof record[key] !== 'boolean') errors.push(`${key} must be boolean`);
  }
  if (!Array.isArray(record.currentWorkflows) || record.currentWorkflows.length === 0
    || record.currentWorkflows.some((item) => !WORKFLOWS.has(item as CurrentWorkflow))) errors.push('currentWorkflows must use allowed codes');
  if (!SWITCHING.has(record.switchingPain as SwitchingPain)) errors.push('switchingPain is invalid');
  if (!BASELINES.has(record.preferredBaseline as CompetitiveBaseline)) errors.push('preferredBaseline is invalid');
  if (typeof record.evidenceRef !== 'string' || !/^research:\/\/[a-z0-9/_-]+$/.test(record.evidenceRef)) errors.push('evidenceRef must be an external pseudonymous research URI');
  if (record.cohort === 'commercial' && record.paidForRelatedTool !== true) {
    errors.push('commercial cohort requires observed paid-tool behavior');
  }
  return errors;
}

export function validateRecruitmentRecord(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['record must be an object'];
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  if (!exactKeys(record, RECRUITMENT_KEYS)) errors.push('record fields must exactly match the privacy-safe v1 schema');
  if (record.schemaVersion !== 'v1') errors.push('schemaVersion must be v1');
  if (typeof record.candidateId !== 'string' || !ID.test(record.candidateId)) errors.push('candidateId must be pseudonymous');
  if (!COHORTS.has(record.cohort as ResearchCohort)) errors.push('cohort is invalid');
  if (record.cohortEligibilityConfirmed !== true) errors.push('cohort eligibility must be confirmed');
  if (!validIsoTime(record.screenedAt)) errors.push('screenedAt must be UTC ISO time');
  if (record.adultConfirmed !== true || record.researchConsentRecorded !== true) errors.push('adult confirmation and research consent are required');
  if (typeof record.qualified !== 'boolean' || typeof record.behavioralPainQualified !== 'boolean' || typeof record.pilotContactConsentRecorded !== 'boolean') errors.push('qualification, behavioral pain, and contact consent must be boolean');
  if (!PILOT_STATUSES.has(record.pilotStatus as PilotRecruitmentRecord['pilotStatus'])) errors.push('pilotStatus is invalid');
  if (record.pilotStatus === 'accepted' && (record.qualified !== true || record.behavioralPainQualified !== true || record.cohortEligibilityConfirmed !== true || record.pilotContactConsentRecorded !== true)) {
    errors.push('accepted candidates must be behaviorally qualified, cohort-eligible, and contact-consented');
  }
  return errors;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function semanticChecksum<T>(records: readonly T[], id: (record: T) => string): string {
  const canonical = [...records].sort((left, right) => id(left).localeCompare(id(right))).map(canonicalJson).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export function buildV03ResearchReport(
  interviews: readonly BehavioralInterviewRecord[],
  recruitment: readonly PilotRecruitmentRecord[],
): V03ResearchReport {
  for (const record of interviews) {
    const errors = validateInterviewRecord(record);
    if (errors.length) throw new Error(`invalid interview ${record.interviewId}: ${errors.join('; ')}`);
  }
  for (const record of recruitment) {
    const errors = validateRecruitmentRecord(record);
    if (errors.length) throw new Error(`invalid recruitment ${record.candidateId}: ${errors.join('; ')}`);
  }
  if (new Set(interviews.map((record) => record.interviewId)).size !== interviews.length) throw new Error('duplicate interviewId');
  if (new Set(interviews.map((record) => record.evidenceRef)).size !== interviews.length) throw new Error('duplicate evidenceRef');
  if (new Set(recruitment.map((record) => record.candidateId)).size !== recruitment.length) throw new Error('duplicate candidateId');

  const qualifiedPainCount = interviews.filter((record) => record.pastBehaviorExampleObserved && record.recurringWeeklyPain && record.concreteCostObserved).length;
  const problemRate = rate(qualifiedPainCount, interviews.length);
  const complete = interviews.length >= 30 && interviews.length <= 40;
  const decision = !complete ? 'insufficient_sample'
    : problemRate !== null && problemRate >= 0.7 ? 'success'
      : problemRate !== null && problemRate < 0.4 ? 'failure' : 'inconclusive';
  const qualifiedAndContactConsented = recruitment.filter((record) => record.qualified && record.behavioralPainQualified && record.cohortEligibilityConfirmed && record.pilotContactConsentRecorded).length;
  const accepted = recruitment.filter((record) => record.pilotStatus === 'accepted').length;

  const cohortReport = (cohort: ResearchCohort) => {
    const rows = interviews.filter((record) => record.cohort === cohort);
    const pain = rows.filter((record) => record.pastBehaviorExampleObserved && record.recurringWeeklyPain && record.concreteCostObserved).length;
    return {
      interviews: rows.length,
      qualifiedPainCount: pain,
      qualifiedPainRate: rate(pain, rows.length),
      paidForRelatedToolCount: rows.filter((record) => record.paidForRelatedTool).length,
      highOrMediumSwitchingPainCount: rows.filter((record) => record.switchingPain === 'high' || record.switchingPain === 'medium').length,
    };
  };

  const cohorts = { commercial: cohortReport('commercial'), fast_research: cohortReport('fast_research') };
  const cohortRateDifference = (field: 'qualifiedPainCount' | 'paidForRelatedToolCount' | 'highOrMediumSwitchingPainCount'): number | null => {
    if (cohorts.commercial.interviews === 0 || cohorts.fast_research.interviews === 0) return null;
    return cohorts.commercial[field] / cohorts.commercial.interviews - cohorts.fast_research[field] / cohorts.fast_research.interviews;
  };

  return {
    schemaVersion: 'v1',
    interviewSample: { total: interviews.length, targetMinimum: 30, targetMaximum: 40, complete },
    problemEvidence: { qualifiedPainCount, rate: problemRate, decision },
    recruitment: { qualifiedAndContactConsented, accepted, targetMinimum: 25, targetMaximum: 40, complete: accepted >= 25 && accepted <= 40 },
    cohorts,
    competitiveBaselines: {
      current_workflow: interviews.filter((record) => record.preferredBaseline === 'current_workflow').length,
      chatgpt_calendar: interviews.filter((record) => record.preferredBaseline === 'chatgpt_calendar').length,
      chatgpt_todoist: interviews.filter((record) => record.preferredBaseline === 'chatgpt_todoist').length,
    },
    cohortDifferences: {
      qualifiedPainRateCommercialMinusFastResearch: cohortRateDifference('qualifiedPainCount'),
      paidToolRateCommercialMinusFastResearch: cohortRateDifference('paidForRelatedToolCount'),
      switchingPainRateCommercialMinusFastResearch: cohortRateDifference('highOrMediumSwitchingPainCount'),
    },
    evidenceIntegrity: {
      algorithm: 'sha256',
      interviewsSemanticSha256: semanticChecksum(interviews, (record) => record.interviewId),
      recruitmentSemanticSha256: semanticChecksum(recruitment, (record) => record.candidateId),
    },
    limitations: [
      'Fast-research cohort results are segmented and are not global market evidence.',
      'Coded interview evidence does not establish retention or willingness to pay.',
      'No success decision is available outside the 30–40 interview window.',
    ],
  };
}
