export type ResearchCohort = 'commercial' | 'fast_research';
export type CurrentWorkflow = 'paper' | 'calendar' | 'todo_app' | 'chat_ai' | 'notes' | 'memory' | 'other';
export type SwitchingPain = 'none' | 'low' | 'medium' | 'high';
export type CompetitiveBaseline = 'current_workflow' | 'chatgpt_calendar' | 'chatgpt_todoist';

export interface BehavioralInterviewRecord {
  schemaVersion: 'v1';
  interviewId: string;
  cohort: ResearchCohort;
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
  limitations: string[];
}

const INTERVIEW_KEYS = new Set([
  'schemaVersion', 'interviewId', 'cohort', 'occurredAt', 'consentRecorded', 'adultConfirmed',
  'pastBehaviorExampleObserved', 'recurringWeeklyPain', 'concreteCostObserved', 'currentWorkflows',
  'abandonedToolObserved', 'paidForRelatedTool', 'privacyBoundaryObserved', 'switchingPain',
  'preferredBaseline', 'evidenceRef',
]);
const RECRUITMENT_KEYS = new Set([
  'schemaVersion', 'candidateId', 'cohort', 'screenedAt', 'adultConfirmed', 'qualified',
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

export function validateInterviewRecord(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['record must be an object'];
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  if (!exactKeys(record, INTERVIEW_KEYS)) errors.push('record fields must exactly match the privacy-safe v1 schema');
  if (record.schemaVersion !== 'v1') errors.push('schemaVersion must be v1');
  if (typeof record.interviewId !== 'string' || !ID.test(record.interviewId)) errors.push('interviewId must be pseudonymous');
  if (!COHORTS.has(record.cohort as ResearchCohort)) errors.push('cohort is invalid');
  if (typeof record.occurredAt !== 'string' || !ISO_DATE.test(record.occurredAt)) errors.push('occurredAt must be UTC ISO time');
  if (record.consentRecorded !== true || record.adultConfirmed !== true) errors.push('consent and adult confirmation are required');
  for (const key of ['pastBehaviorExampleObserved', 'recurringWeeklyPain', 'concreteCostObserved', 'abandonedToolObserved', 'paidForRelatedTool', 'privacyBoundaryObserved']) {
    if (typeof record[key] !== 'boolean') errors.push(`${key} must be boolean`);
  }
  if (!Array.isArray(record.currentWorkflows) || record.currentWorkflows.length === 0
    || record.currentWorkflows.some((item) => !WORKFLOWS.has(item as CurrentWorkflow))) errors.push('currentWorkflows must use allowed codes');
  if (!SWITCHING.has(record.switchingPain as SwitchingPain)) errors.push('switchingPain is invalid');
  if (!BASELINES.has(record.preferredBaseline as CompetitiveBaseline)) errors.push('preferredBaseline is invalid');
  if (typeof record.evidenceRef !== 'string' || !/^research:\/\/[a-z0-9/_-]+$/.test(record.evidenceRef)) errors.push('evidenceRef must be an external pseudonymous research URI');
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
  if (typeof record.screenedAt !== 'string' || !ISO_DATE.test(record.screenedAt)) errors.push('screenedAt must be UTC ISO time');
  if (record.adultConfirmed !== true || record.researchConsentRecorded !== true) errors.push('adult confirmation and research consent are required');
  if (typeof record.qualified !== 'boolean' || typeof record.pilotContactConsentRecorded !== 'boolean') errors.push('qualification and contact consent must be boolean');
  if (!PILOT_STATUSES.has(record.pilotStatus as PilotRecruitmentRecord['pilotStatus'])) errors.push('pilotStatus is invalid');
  if (record.pilotStatus === 'accepted' && (record.qualified !== true || record.pilotContactConsentRecorded !== true)) {
    errors.push('accepted candidates must be qualified and contact-consented');
  }
  return errors;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
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
  if (new Set(recruitment.map((record) => record.candidateId)).size !== recruitment.length) throw new Error('duplicate candidateId');

  const qualifiedPainCount = interviews.filter((record) => record.pastBehaviorExampleObserved && record.recurringWeeklyPain && record.concreteCostObserved).length;
  const problemRate = rate(qualifiedPainCount, interviews.length);
  const complete = interviews.length >= 30 && interviews.length <= 40;
  const decision = !complete ? 'insufficient_sample'
    : problemRate !== null && problemRate >= 0.7 ? 'success'
      : problemRate !== null && problemRate < 0.4 ? 'failure' : 'inconclusive';
  const qualifiedAndContactConsented = recruitment.filter((record) => record.qualified && record.pilotContactConsentRecorded).length;
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

  return {
    schemaVersion: 'v1',
    interviewSample: { total: interviews.length, targetMinimum: 30, targetMaximum: 40, complete },
    problemEvidence: { qualifiedPainCount, rate: problemRate, decision },
    recruitment: { qualifiedAndContactConsented, accepted, targetMinimum: 25, targetMaximum: 40, complete: accepted >= 25 && accepted <= 40 },
    cohorts: { commercial: cohortReport('commercial'), fast_research: cohortReport('fast_research') },
    competitiveBaselines: {
      current_workflow: interviews.filter((record) => record.preferredBaseline === 'current_workflow').length,
      chatgpt_calendar: interviews.filter((record) => record.preferredBaseline === 'chatgpt_calendar').length,
      chatgpt_todoist: interviews.filter((record) => record.preferredBaseline === 'chatgpt_todoist').length,
    },
    limitations: [
      'Fast-research cohort results are segmented and are not global market evidence.',
      'Coded interview evidence does not establish retention or willingness to pay.',
      'No success decision is available outside the 30–40 interview window.',
    ],
  };
}
