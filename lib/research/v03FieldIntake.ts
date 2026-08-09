/**
 * V03 (#54) field intake.
 *
 * The frozen privacy-safe evidence schema lives in `v03BehavioralResearch.ts` and must not
 * change: the #57 gate pins its SHA-256 fingerprints. This module sits one layer above it and
 * covers what a human researcher actually maintains in the field — two trackers:
 *
 *   1. recruitment tracker   — one row per screened candidate (the funnel)
 *   2. interview evidence tracker — one row per completed interview (the coded evidence)
 *
 * Operational columns (source channel, coder codes, rehearsal flag, language) stay in the
 * tracker layer and are never exported into the coded evidence artifact.
 *
 * Qualification and pilot handoff are *derived*, never hand-typed: a candidate cannot reach
 * `accepted` without a linked, coded, pain-qualified interview and separate contact consent.
 */

import {
  buildV03ResearchReport,
  validateInterviewRecord,
  validateRecruitmentRecord,
  type BehavioralInterviewRecord,
  type CompetitiveBaseline,
  type CurrentWorkflow,
  type PilotRecruitmentRecord,
  type ResearchCohort,
  type SwitchingPain,
  type V03ResearchReport,
} from './v03BehavioralResearch';

export const INTERVIEW_TRACKER_COLUMNS = [
  'interview_id',
  'sample_inclusion',
  'cohort',
  'interview_language',
  'cohort_eligibility_confirmed',
  'occurred_at',
  'research_consent_recorded',
  'adult_confirmed',
  'past_behavior_example',
  'recurring_weekly_pain',
  'concrete_cost',
  'current_workflows',
  'abandoned_tool',
  'paid_for_related_tool',
  'privacy_boundary',
  'switching_pain',
  'preferred_baseline',
  'competitive_comparison_completed',
  'evidence_ref',
  'primary_coder',
  'second_coder',
  'second_coder_pain_qualified',
  'adjudicated',
] as const;

export const RECRUITMENT_TRACKER_COLUMNS = [
  'candidate_id',
  'cohort',
  'source_channel',
  'screened_at',
  'screener_outcome',
  'adult_confirmed',
  'cohort_eligibility_confirmed',
  'research_consent_recorded',
  'screener_pain_signal',
  'linked_interview_id',
  'pilot_contact_consent_recorded',
  'pilot_status',
  'withdrawn_at',
  'deletion_completed',
] as const;

export type SampleInclusion = 'sample' | 'rehearsal';
export type InterviewLanguage = 'en' | 'ar' | 'he' | 'mixed';
export type ScreenerOutcome = 'qualified' | 'not_qualified' | 'declined' | 'no_response';
export type PilotStatus = PilotRecruitmentRecord['pilotStatus'];
export type SourceChannel =
  | 'adhd_community'
  | 'productivity_community'
  | 'coaching_network'
  | 'university_board'
  | 'student_group'
  | 'referral'
  | 'personal_network'
  | 'other';

export interface InterviewTrackerRow {
  interviewId: string;
  sampleInclusion: SampleInclusion;
  cohort: ResearchCohort;
  interviewLanguage: InterviewLanguage;
  cohortEligibilityConfirmed: boolean;
  occurredAt: string;
  researchConsentRecorded: boolean;
  adultConfirmed: boolean;
  pastBehaviorExampleObserved: boolean;
  recurringWeeklyPain: boolean;
  concreteCostObserved: boolean;
  currentWorkflows: CurrentWorkflow[];
  abandonedToolObserved: boolean;
  paidForRelatedTool: boolean;
  privacyBoundaryObserved: boolean;
  switchingPain: SwitchingPain;
  preferredBaseline: CompetitiveBaseline;
  /**
   * Whether the competitive block ran to its final question. The frozen schema always carries a
   * `preferredBaseline`, so without this flag a time-pressured forced default is indistinguishable
   * from a real comparison — and #57 blocks on the comparison denominator.
   */
  competitiveComparisonCompleted: boolean;
  evidenceRef: string;
  primaryCoder: string;
  secondCoder: string | null;
  secondCoderPainQualified: boolean | null;
  adjudicated: boolean;
}

export interface RecruitmentTrackerRow {
  candidateId: string;
  cohort: ResearchCohort;
  sourceChannel: SourceChannel;
  screenedAt: string;
  screenerOutcome: ScreenerOutcome;
  adultConfirmed: boolean;
  cohortEligibilityConfirmed: boolean;
  researchConsentRecorded: boolean;
  screenerPainSignal: boolean;
  linkedInterviewId: string | null;
  pilotContactConsentRecorded: boolean;
  pilotStatus: PilotStatus;
  withdrawnAt: string | null;
  deletionCompleted: boolean | null;
}

export interface TrackerIssue {
  /** 1-based line number in the source CSV, counting the header as line 1. */
  line: number;
  column: string;
  message: string;
}

/**
 * Approved sampling defaults for #54 (research owner sign-off, 2026-08-09). These are project
 * decisions, not thresholds stated in the issue.
 *
 * Every value here affects **decision readiness only**. None of them enters a measured rate: the
 * recurring-pain, concrete-cost, qualified-pain, cohort-difference and competitive numbers are
 * computed from the coded rows alone and are identical whether or not these defaults are met.
 *
 * `minimumCommercialInterviews` operationalises the #54 non-goal ("do not infer global market
 * viability from the bilingual student cohort alone"). The double-coding floor makes the coding
 * rubric auditable. `maximumPersonalNetworkShare` bounds the largest recruiting bias available to a
 * solo researcher. Changing any of them is a recorded decision, never a mid-collection adjustment.
 */
export const V03_FIELDWORK_DEFAULTS = {
  /** Recruitment targets. Planning figures, surfaced as next actions rather than requirements. */
  commercialCohortTarget: { minimum: 20, maximum: 25 },
  fastResearchCohortTarget: { minimum: 10, maximum: 15 },
  /** Hard decision-readiness floor for the commercial cohort. */
  minimumCommercialInterviews: 15,
  /** At least 20% of analysed interviews double-coded, and never fewer than 6. */
  minimumDoubleCodedShare: 0.2,
  minimumDoubleCodedInterviews: 6,
  approachingMaximumInterviews: 38,
  maximumPersonalNetworkShare: 0.2,
} as const;

/** Required double-coded count: 20% of the analysed sample, with an absolute floor of 6. */
export function requiredDoubleCodedInterviews(sampleSize: number): number {
  return Math.max(
    V03_FIELDWORK_DEFAULTS.minimumDoubleCodedInterviews,
    Math.ceil(V03_FIELDWORK_DEFAULTS.minimumDoubleCodedShare * sampleSize),
  );
}

/** Marginal and conjunctive coded rates over one set of interviews. Denominators are never dropped. */
export interface CodedRates {
  denominator: number;
  pastBehaviorExample: number;
  recurringWeeklyPain: number;
  concreteCost: number;
  qualifiedPain: number;
  pastBehaviorExampleRate: number | null;
  recurringWeeklyPainRate: number | null;
  concreteCostRate: number | null;
  qualifiedPainRate: number | null;
}

export interface V03FieldworkStatus {
  schemaVersion: 'v1';
  intake: {
    interviewRowsRead: number;
    rehearsalRowsExcluded: number;
    sampleInterviews: number;
    recruitmentRowsRead: number;
  };
  funnel: {
    screened: number;
    screenerQualified: number;
    interviewed: number;
    painQualified: number;
    contactConsented: number;
    invited: number;
    /** Rows at `accepted` that satisfy every handoff rule. Only these count toward 25–40. */
    accepted: number;
    /** Rows typed as `accepted` that fail a handoff rule; excluded from the coded evidence. */
    acceptedWithUnmetHandoff: number;
    declined: number;
    withdrawn: number;
  };
  progress: {
    interviews: {
      sample: number;
      minimum: 30;
      maximum: 40;
      remainingToMinimum: number;
      schedulingHeadroom: number;
      approachingMaximum: boolean;
      stopScheduling: boolean;
    };
    /** Per-cohort recruitment targets. Planning only — never a gate on the measured rates. */
    cohortTargets: {
      commercial: { interviews: number; minimum: number; maximum: number; remainingToMinimum: number };
      fastResearch: { interviews: number; minimum: number; maximum: number; remainingToMinimum: number };
    };
    recruitment: {
      accepted: number;
      minimum: 25;
      maximum: 40;
      remainingToMinimum: number;
      stopInviting: boolean;
    };
  };
  /**
   * The #54 threshold applies to `qualifiedPain`. The two marginal rates are reported alongside it
   * because they diagnose *which* half of the conjunction is failing.
   */
  rates: {
    overall: CodedRates;
    commercial: CodedRates;
    fastResearch: CodedRates;
    /** Commercial minus fast-research, in rate points. Null when either cohort is empty. */
    cohortDifferences: {
      recurringWeeklyPain: number | null;
      concreteCost: number | null;
      qualifiedPain: number | null;
      paidForRelatedTool: number | null;
      mediumOrHighSwitchingPain: number | null;
    };
  };
  /** Feeds `competitive` in the #57 gate input. The denominator is smaller than the sample. */
  competitive: {
    completedComparisons: number;
    existingWorkflowPreferred: number;
    existingWorkflowPreferenceRate: number | null;
    baselineCounts: Record<CompetitiveBaseline, number>;
    minimumComparisonsForGate: 10;
    belowGateMinimum: boolean;
  };
  cohortIntegrity: {
    commercialInterviews: number;
    fastResearchInterviews: number;
    commercialShare: number | null;
    minimumCommercialInterviews: number;
    commercialCohortUnderpowered: boolean;
    commercialQualifiedPainRate: number | null;
    fastResearchQualifiedPainRate: number | null;
    personalNetworkInterviews: number;
    personalNetworkShare: number | null;
    maximumPersonalNetworkShare: number;
    personalNetworkOverRepresented: boolean;
  };
  coding: {
    doubleCoded: number;
    doubleCodedShare: number | null;
    required: number;
    agreements: number;
    disagreements: number;
    agreementRate: number | null;
    unadjudicatedDisagreements: number;
    minimumDoubleCodedShare: number;
    minimumDoubleCodedInterviews: number;
    doubleCodingBelowMinimum: boolean;
  };
  handoff: {
    readyToInvite: string[];
    invitedAwaitingResponse: string[];
    blockedFromAccept: { candidateId: string; reasons: string[] }[];
  };
  /** Integrity violations. Fieldwork must stop and fix these; the CLI exits non-zero. */
  blockers: string[];
  /** What still stands between the current trackers and a reportable #54 result. */
  decisionReadiness: {
    ready: boolean;
    unmetRequirements: string[];
  };
  nextActions: string[];
  report: V03ResearchReport;
}

const SAMPLE_INCLUSIONS: readonly string[] = ['sample', 'rehearsal'];
const LANGUAGES: readonly string[] = ['en', 'ar', 'he', 'mixed'];
const COHORTS: readonly string[] = ['commercial', 'fast_research'];
const WORKFLOWS: readonly string[] = ['paper', 'calendar', 'todo_app', 'chat_ai', 'notes', 'memory', 'other'];
const SWITCHING: readonly string[] = ['none', 'low', 'medium', 'high'];
const BASELINES: readonly string[] = ['current_workflow', 'chatgpt_calendar', 'chatgpt_todoist'];
const SCREENER_OUTCOMES: readonly string[] = ['qualified', 'not_qualified', 'declined', 'no_response'];
const PILOT_STATUSES: readonly string[] = ['not_invited', 'invited', 'accepted', 'declined', 'withdrawn'];
const SOURCE_CHANNELS: readonly string[] = [
  'adhd_community', 'productivity_community', 'coaching_network', 'university_board',
  'student_group', 'referral', 'personal_network', 'other',
];

const ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const CODER_ID = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EVIDENCE_REF = /^research:\/\/[a-z0-9/_-]+$/;
/** Anything that looks like a direct identifier must never reach a tracker cell. */
const FORBIDDEN_VALUE = /@|\+\d{6,}|\bhttps?:\/\//i;

/** RFC 4180 subset: quoted fields, doubled quotes inside them, CRLF or LF line endings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; } else { quoted = false; }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field === '') { quoted = true; started = true; continue; }
    if (character === ',') { row.push(field); field = ''; started = true; continue; }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index++;
      if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
      row = []; field = ''; started = false;
      continue;
    }
    field += character;
    started = true;
  }
  if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function headerIssues(actual: string[], expected: readonly string[]): string[] {
  const trimmed = actual.map((cell) => cell.trim());
  if (trimmed.length !== expected.length || trimmed.some((cell, index) => cell !== expected[index])) {
    return [`header must be exactly: ${expected.join(',')}`];
  }
  return [];
}

class RowReader {
  readonly issues: TrackerIssue[] = [];
  private readonly cells: Record<string, string> = {};

  constructor(private readonly line: number, header: readonly string[], values: string[]) {
    for (let index = 0; index < header.length; index++) {
      this.cells[header[index]] = (values[index] ?? '').trim();
    }
    if (values.length !== header.length) {
      this.fail(header[0], `row has ${values.length} cells but the header declares ${header.length}`);
    }
  }

  fail(column: string, message: string): void {
    this.issues.push({ line: this.line, column, message });
  }

  raw(column: string): string {
    const value = this.cells[column] ?? '';
    if (FORBIDDEN_VALUE.test(value)) {
      this.fail(column, 'cell looks like a direct identifier (email, phone, or URL); trackers hold pseudonymous codes only');
      return '';
    }
    return value;
  }

  enum<T extends string>(column: string, allowed: readonly string[], fallback: T): T {
    const value = this.raw(column);
    if (!allowed.includes(value)) {
      this.fail(column, `must be one of: ${allowed.join(' | ')}`);
      return fallback;
    }
    return value as T;
  }

  yesNo(column: string): boolean {
    const value = this.raw(column).toLowerCase();
    if (value === 'yes') return true;
    if (value === 'no') return false;
    this.fail(column, 'must be yes or no');
    return false;
  }

  optionalYesNo(column: string): boolean | null {
    const value = this.raw(column).toLowerCase();
    if (value === '') return null;
    if (value === 'yes') return true;
    if (value === 'no') return false;
    this.fail(column, 'must be yes, no, or empty');
    return null;
  }

  requiredTrue(column: string, message: string): boolean {
    const value = this.yesNo(column);
    if (!value) this.fail(column, message);
    return value;
  }

  pattern(column: string, expression: RegExp, message: string): string {
    const value = this.raw(column);
    if (!expression.test(value)) { this.fail(column, message); return ''; }
    return value;
  }

  optionalPattern(column: string, expression: RegExp, message: string): string | null {
    const value = this.raw(column);
    if (value === '') return null;
    if (!expression.test(value)) { this.fail(column, message); return null; }
    return value;
  }

  isoTime(column: string): string {
    const value = this.raw(column);
    if (!ISO_DATE.test(value)) { this.fail(column, 'must be a UTC ISO timestamp, e.g. 2026-09-14T09:00:00Z'); return ''; }
    const parsed = new Date(value);
    const normalized = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
      this.fail(column, 'is not a real UTC timestamp');
      return '';
    }
    return value;
  }

  optionalIsoTime(column: string): string | null {
    return this.raw(column) === '' ? null : this.isoTime(column);
  }

  workflows(column: string): CurrentWorkflow[] {
    const value = this.raw(column);
    const parts = value.split('|').map((part) => part.trim()).filter((part) => part !== '');
    if (parts.length === 0) { this.fail(column, 'at least one workflow code is required'); return ['other']; }
    const invalid = parts.filter((part) => !WORKFLOWS.includes(part));
    if (invalid.length) { this.fail(column, `unknown workflow codes: ${invalid.join(', ')}`); return ['other']; }
    return parts as CurrentWorkflow[];
  }
}

export interface TrackerParseResult<T> {
  rows: T[];
  issues: TrackerIssue[];
}

export function parseInterviewTracker(text: string): TrackerParseResult<InterviewTrackerRow> {
  const table = parseCsv(text);
  const issues: TrackerIssue[] = [];
  if (table.length === 0) return { rows: [], issues: [{ line: 1, column: 'header', message: 'file is empty' }] };
  for (const message of headerIssues(table[0], INTERVIEW_TRACKER_COLUMNS)) {
    issues.push({ line: 1, column: 'header', message });
  }
  if (issues.length) return { rows: [], issues };

  const rows: InterviewTrackerRow[] = [];
  const seenIds: string[] = [];
  const seenRefs: string[] = [];
  for (let index = 1; index < table.length; index++) {
    const reader = new RowReader(index + 1, INTERVIEW_TRACKER_COLUMNS, table[index]);
    const row: InterviewTrackerRow = {
      interviewId: reader.pattern('interview_id', ID, 'must be a pseudonymous code, e.g. int-014'),
      sampleInclusion: reader.enum<SampleInclusion>('sample_inclusion', SAMPLE_INCLUSIONS, 'sample'),
      cohort: reader.enum<ResearchCohort>('cohort', COHORTS, 'commercial'),
      interviewLanguage: reader.enum<InterviewLanguage>('interview_language', LANGUAGES, 'en'),
      cohortEligibilityConfirmed: reader.requiredTrue('cohort_eligibility_confirmed', 'cohort eligibility must be confirmed before the interview is coded'),
      occurredAt: reader.isoTime('occurred_at'),
      researchConsentRecorded: reader.requiredTrue('research_consent_recorded', 'research consent must be recorded before an interview can be coded'),
      adultConfirmed: reader.requiredTrue('adult_confirmed', 'adult confirmation is required'),
      pastBehaviorExampleObserved: reader.yesNo('past_behavior_example'),
      recurringWeeklyPain: reader.yesNo('recurring_weekly_pain'),
      concreteCostObserved: reader.yesNo('concrete_cost'),
      currentWorkflows: reader.workflows('current_workflows'),
      abandonedToolObserved: reader.yesNo('abandoned_tool'),
      paidForRelatedTool: reader.yesNo('paid_for_related_tool'),
      privacyBoundaryObserved: reader.yesNo('privacy_boundary'),
      switchingPain: reader.enum<SwitchingPain>('switching_pain', SWITCHING, 'none'),
      preferredBaseline: reader.enum<CompetitiveBaseline>('preferred_baseline', BASELINES, 'current_workflow'),
      competitiveComparisonCompleted: reader.yesNo('competitive_comparison_completed'),
      evidenceRef: reader.pattern('evidence_ref', EVIDENCE_REF, 'must be an external pseudonymous URI, e.g. research://v03/int-014'),
      primaryCoder: reader.pattern('primary_coder', CODER_ID, 'must be a coder code, e.g. coder-a'),
      secondCoder: reader.optionalPattern('second_coder', CODER_ID, 'must be a coder code or empty'),
      secondCoderPainQualified: reader.optionalYesNo('second_coder_pain_qualified'),
      adjudicated: reader.yesNo('adjudicated'),
    };
    if (row.cohort === 'commercial' && !row.paidForRelatedTool) {
      reader.fail('paid_for_related_tool', 'commercial-cohort rows require observed paid-tool behavior; recode the cohort or the answer');
    }
    if (row.secondCoder !== null && row.secondCoderPainQualified === null) {
      reader.fail('second_coder_pain_qualified', 'a second coder must record an independent pain judgement');
    }
    if (row.secondCoder === null && row.secondCoderPainQualified !== null) {
      reader.fail('second_coder', 'a second-coder judgement requires the second coder code');
    }
    if (row.secondCoder !== null && row.secondCoder === row.primaryCoder) {
      reader.fail('second_coder', 'the second coder must differ from the primary coder');
    }
    if (seenIds.includes(row.interviewId)) reader.fail('interview_id', 'duplicate interview_id');
    if (row.evidenceRef !== '' && seenRefs.includes(row.evidenceRef)) reader.fail('evidence_ref', 'duplicate evidence_ref');
    seenIds.push(row.interviewId);
    seenRefs.push(row.evidenceRef);
    issues.push(...reader.issues);
    if (reader.issues.length === 0) rows.push(row);
  }
  return { rows, issues };
}

export function parseRecruitmentTracker(text: string): TrackerParseResult<RecruitmentTrackerRow> {
  const table = parseCsv(text);
  const issues: TrackerIssue[] = [];
  if (table.length === 0) return { rows: [], issues: [{ line: 1, column: 'header', message: 'file is empty' }] };
  for (const message of headerIssues(table[0], RECRUITMENT_TRACKER_COLUMNS)) {
    issues.push({ line: 1, column: 'header', message });
  }
  if (issues.length) return { rows: [], issues };

  const rows: RecruitmentTrackerRow[] = [];
  const seenIds: string[] = [];
  for (let index = 1; index < table.length; index++) {
    const reader = new RowReader(index + 1, RECRUITMENT_TRACKER_COLUMNS, table[index]);
    const row: RecruitmentTrackerRow = {
      candidateId: reader.pattern('candidate_id', ID, 'must be a pseudonymous code, e.g. cand-014'),
      cohort: reader.enum<ResearchCohort>('cohort', COHORTS, 'commercial'),
      sourceChannel: reader.enum<SourceChannel>('source_channel', SOURCE_CHANNELS, 'other'),
      screenedAt: reader.isoTime('screened_at'),
      screenerOutcome: reader.enum<ScreenerOutcome>('screener_outcome', SCREENER_OUTCOMES, 'not_qualified'),
      adultConfirmed: reader.yesNo('adult_confirmed'),
      cohortEligibilityConfirmed: reader.yesNo('cohort_eligibility_confirmed'),
      researchConsentRecorded: reader.yesNo('research_consent_recorded'),
      screenerPainSignal: reader.yesNo('screener_pain_signal'),
      linkedInterviewId: reader.optionalPattern('linked_interview_id', ID, 'must be a pseudonymous interview code or empty'),
      pilotContactConsentRecorded: reader.yesNo('pilot_contact_consent_recorded'),
      pilotStatus: reader.enum<PilotStatus>('pilot_status', PILOT_STATUSES, 'not_invited'),
      withdrawnAt: reader.optionalIsoTime('withdrawn_at'),
      deletionCompleted: reader.optionalYesNo('deletion_completed'),
    };
    if (row.screenerOutcome === 'qualified' && !row.adultConfirmed) {
      reader.fail('adult_confirmed', 'a candidate cannot be screener-qualified without adult confirmation');
    }
    if (row.pilotStatus === 'withdrawn' && row.withdrawnAt === null) {
      reader.fail('withdrawn_at', 'withdrawal must record the time the participant withdrew');
    }
    if (row.pilotStatus !== 'withdrawn' && row.withdrawnAt !== null) {
      reader.fail('pilot_status', 'a withdrawal time requires pilot_status=withdrawn');
    }
    if (seenIds.includes(row.candidateId)) reader.fail('candidate_id', 'duplicate candidate_id');
    seenIds.push(row.candidateId);
    issues.push(...reader.issues);
    if (reader.issues.length === 0) rows.push(row);
  }
  return { rows, issues };
}

function painQualified(row: InterviewTrackerRow): boolean {
  return row.pastBehaviorExampleObserved && row.recurringWeeklyPain && row.concreteCostObserved;
}

/** Rows flagged `rehearsal` never enter the coded artifact or any denominator. */
export function sampleRows(rows: readonly InterviewTrackerRow[]): InterviewTrackerRow[] {
  return rows.filter((row) => row.sampleInclusion === 'sample');
}

export function toInterviewRecord(row: InterviewTrackerRow): BehavioralInterviewRecord {
  const record: BehavioralInterviewRecord = {
    schemaVersion: 'v1',
    interviewId: row.interviewId,
    cohort: row.cohort,
    cohortEligibilityConfirmed: true,
    occurredAt: row.occurredAt,
    consentRecorded: true,
    adultConfirmed: true,
    pastBehaviorExampleObserved: row.pastBehaviorExampleObserved,
    recurringWeeklyPain: row.recurringWeeklyPain,
    concreteCostObserved: row.concreteCostObserved,
    currentWorkflows: row.currentWorkflows,
    abandonedToolObserved: row.abandonedToolObserved,
    paidForRelatedTool: row.paidForRelatedTool,
    privacyBoundaryObserved: row.privacyBoundaryObserved,
    switchingPain: row.switchingPain,
    preferredBaseline: row.preferredBaseline,
    evidenceRef: row.evidenceRef,
  };
  const errors = validateInterviewRecord(record);
  if (errors.length) throw new Error(`interview ${row.interviewId} cannot be exported: ${errors.join('; ')}`);
  return record;
}

/**
 * The pilot handoff rules, as code. Every reason returned here is a hard stop between
 * "interviewed participant" and "qualified pilot candidate".
 */
export function handoffBlockers(
  row: RecruitmentTrackerRow,
  interviews: readonly InterviewTrackerRow[],
): string[] {
  const reasons: string[] = [];
  if (!row.adultConfirmed) reasons.push('adult confirmation missing');
  if (!row.cohortEligibilityConfirmed) reasons.push('cohort eligibility not confirmed');
  if (!row.researchConsentRecorded) reasons.push('research consent not recorded');
  if (row.screenerOutcome !== 'qualified') reasons.push(`screener outcome is ${row.screenerOutcome}`);
  const interview = interviews.filter((candidate) => candidate.interviewId === row.linkedInterviewId)[0];
  if (row.linkedInterviewId === null) reasons.push('no linked interview');
  else if (!interview) reasons.push(`linked interview ${row.linkedInterviewId} is missing or failed validation`);
  else if (interview.sampleInclusion !== 'sample') reasons.push('linked interview is a rehearsal and carries no evidence');
  else if (interview.cohort !== row.cohort) reasons.push('linked interview cohort does not match the candidate cohort');
  else if (!painQualified(interview)) reasons.push('linked interview is not behaviorally pain-qualified');
  if (!row.pilotContactConsentRecorded) reasons.push('separate pilot-contact consent not recorded');
  if (row.pilotStatus === 'withdrawn') reasons.push('participant withdrew');
  return reasons;
}

export function toRecruitmentRecord(
  row: RecruitmentTrackerRow,
  interviews: readonly InterviewTrackerRow[],
): PilotRecruitmentRecord {
  const interview = interviews.filter((candidate) => candidate.interviewId === row.linkedInterviewId)[0];
  const behavioralPainQualified = Boolean(interview && interview.sampleInclusion === 'sample' && painQualified(interview));
  const record: PilotRecruitmentRecord = {
    schemaVersion: 'v1',
    candidateId: row.candidateId,
    cohort: row.cohort,
    screenedAt: row.screenedAt,
    adultConfirmed: true,
    qualified: handoffBlockers(row, interviews).length === 0,
    behavioralPainQualified,
    cohortEligibilityConfirmed: true,
    researchConsentRecorded: true,
    pilotContactConsentRecorded: row.pilotContactConsentRecorded,
    pilotStatus: row.pilotStatus,
  };
  const errors = validateRecruitmentRecord(record);
  if (errors.length) throw new Error(`candidate ${row.candidateId} cannot be exported: ${errors.join('; ')}`);
  return record;
}

/**
 * Only candidates whose research consent and adult confirmation are on record may appear in the
 * coded recruitment artifact at all; the rest stay in the operational tracker.
 *
 * A row typed as `accepted` that fails a handoff rule is also withheld. It is a data-entry error,
 * not evidence: letting it through would put an unqualified participant into the #57 cohort count.
 * `buildFieldworkStatus` reports every withheld row as a blocker.
 */
export function exportableRecruitmentRows(
  rows: readonly RecruitmentTrackerRow[],
  interviews: readonly InterviewTrackerRow[],
): RecruitmentTrackerRow[] {
  return rows.filter((row) => row.adultConfirmed && row.researchConsentRecorded && row.cohortEligibilityConfirmed
    && (row.pilotStatus !== 'accepted' || handoffBlockers(row, interviews).length === 0));
}

function share(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function codedRates(rows: readonly InterviewTrackerRow[]): CodedRates {
  const total = rows.length;
  const pastBehaviorExample = rows.filter((row) => row.pastBehaviorExampleObserved).length;
  const recurringWeeklyPain = rows.filter((row) => row.recurringWeeklyPain).length;
  const concreteCost = rows.filter((row) => row.concreteCostObserved).length;
  const qualifiedPain = rows.filter(painQualified).length;
  return {
    denominator: total,
    pastBehaviorExample,
    recurringWeeklyPain,
    concreteCost,
    qualifiedPain,
    pastBehaviorExampleRate: share(pastBehaviorExample, total),
    recurringWeeklyPainRate: share(recurringWeeklyPain, total),
    concreteCostRate: share(concreteCost, total),
    qualifiedPainRate: share(qualifiedPain, total),
  };
}

function difference(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right;
}

export function buildFieldworkStatus(
  interviewRows: readonly InterviewTrackerRow[],
  recruitmentRows: readonly RecruitmentTrackerRow[],
): V03FieldworkStatus {
  const sample = sampleRows(interviewRows);
  const interviews = sample.map(toInterviewRecord);
  const exportable = exportableRecruitmentRows(recruitmentRows, interviewRows);
  const recruitment = exportable.map((row) => toRecruitmentRecord(row, interviewRows));
  const report = buildV03ResearchReport(interviews, recruitment);

  const commercial = sample.filter((row) => row.cohort === 'commercial');
  const fastResearch = sample.filter((row) => row.cohort === 'fast_research');
  const doubleCodedRows = sample.filter((row) => row.secondCoder !== null);
  const agreements = doubleCodedRows.filter((row) => row.secondCoderPainQualified === painQualified(row)).length;
  const disagreements = doubleCodedRows.length - agreements;
  const unadjudicatedDisagreements = doubleCodedRows
    .filter((row) => row.secondCoderPainQualified !== painQualified(row) && !row.adjudicated).length;

  const blockedFromAccept: { candidateId: string; reasons: string[] }[] = [];
  const readyToInvite: string[] = [];
  const invitedAwaitingResponse: string[] = [];
  let acceptedWithUnmetHandoff = 0;
  for (const row of recruitmentRows) {
    const reasons = handoffBlockers(row, interviewRows);
    if (reasons.length && row.pilotStatus !== 'declined' && row.pilotStatus !== 'not_invited') {
      blockedFromAccept.push({ candidateId: row.candidateId, reasons });
      if (row.pilotStatus === 'accepted') acceptedWithUnmetHandoff++;
    }
    if (reasons.length === 0 && row.pilotStatus === 'not_invited') readyToInvite.push(row.candidateId);
    if (row.pilotStatus === 'invited') invitedAwaitingResponse.push(row.candidateId);
  }
  const accepted = report.recruitment.accepted;

  const overallRates = codedRates(sample);
  const commercialRates = codedRates(commercial);
  const fastResearchRates = codedRates(fastResearch);
  const commercialShare = share(commercial.length, sample.length);
  const doubleCodedShare = share(doubleCodedRows.length, sample.length);
  const requiredDoubleCoded = requiredDoubleCodedInterviews(sample.length);

  const comparisons = sample.filter((row) => row.competitiveComparisonCompleted);
  const existingWorkflowPreferred = comparisons.filter((row) => row.preferredBaseline === 'current_workflow').length;

  const personalNetworkInterviewIds = recruitmentRows
    .filter((row) => row.sourceChannel === 'personal_network' && row.linkedInterviewId !== null)
    .map((row) => row.linkedInterviewId);
  const personalNetworkInterviews = sample
    .filter((row) => personalNetworkInterviewIds.includes(row.interviewId)).length;
  const personalNetworkShare = share(personalNetworkInterviews, sample.length);
  const personalNetworkOverRepresented = personalNetworkShare !== null
    && personalNetworkShare > V03_FIELDWORK_DEFAULTS.maximumPersonalNetworkShare;
  const blockers: string[] = [];
  const unmetRequirements: string[] = [];
  const nextActions: string[] = [];

  if (sample.length > 40) blockers.push('Interview sample exceeds 40; the #54 decision window is invalid and the extra interviews must be reported as a protocol deviation.');
  if (unadjudicatedDisagreements > 0) blockers.push(`${unadjudicatedDisagreements} double-coded interviews disagree and are not adjudicated.`);
  for (const blocked of blockedFromAccept) {
    blockers.push(`Candidate ${blocked.candidateId} sits at a pilot status its handoff rules do not support and is withheld from the coded evidence: ${blocked.reasons.join('; ')}.`);
  }

  if (sample.length < 30) unmetRequirements.push(`Interview sample is ${sample.length} of the required 30.`);
  if (commercial.length < V03_FIELDWORK_DEFAULTS.minimumCommercialInterviews) {
    unmetRequirements.push(`Commercial cohort holds ${commercial.length} of the required ${V03_FIELDWORK_DEFAULTS.minimumCommercialInterviews} interviews; an overall pass cannot be read as market evidence while the bilingual student cohort dominates the sample.`);
  }
  if (doubleCodedRows.length < requiredDoubleCoded) {
    unmetRequirements.push(`Double-coding covers ${doubleCodedRows.length} interviews; ${requiredDoubleCoded} are required (20% of the analysed sample, minimum 6).`);
  }
  if (personalNetworkOverRepresented && personalNetworkShare !== null) {
    unmetRequirements.push(`${(personalNetworkShare * 100).toFixed(0)}% of interviews come from the founder's personal network, above the ${(V03_FIELDWORK_DEFAULTS.maximumPersonalNetworkShare * 100).toFixed(0)}% cap; recruit through independent channels before reading the result.`);
  }
  if (comparisons.length < 10) {
    unmetRequirements.push(`Competitive comparison is complete for ${comparisons.length} interviews; the #57 gate blocks below 10.`);
  }
  if (accepted < 25) unmetRequirements.push(`Closed-pilot cohort holds ${accepted} of the required 25 accepted participants.`);

  if (sample.length < 30) nextActions.push(`Run ${30 - sample.length} more interviews to reach the minimum sample of 30.`);
  else if (sample.length < 40) nextActions.push(`Sample is decision-valid at ${sample.length}; at most ${40 - sample.length} further interviews may be added.`);
  const commercialTarget = V03_FIELDWORK_DEFAULTS.commercialCohortTarget;
  const fastResearchTarget = V03_FIELDWORK_DEFAULTS.fastResearchCohortTarget;
  if (commercial.length < commercialTarget.minimum) {
    nextActions.push(`Recruit ${commercialTarget.minimum - commercial.length} more commercial-cohort participants to reach the ${commercialTarget.minimum}–${commercialTarget.maximum} target.`);
  } else if (commercial.length > commercialTarget.maximum) {
    nextActions.push(`Commercial cohort is at ${commercial.length}, above the ${commercialTarget.minimum}–${commercialTarget.maximum} target; stop recruiting it and note the deviation.`);
  }
  if (fastResearch.length < fastResearchTarget.minimum) {
    nextActions.push(`Recruit ${fastResearchTarget.minimum - fastResearch.length} more bilingual-student participants to reach the ${fastResearchTarget.minimum}–${fastResearchTarget.maximum} target.`);
  } else if (fastResearch.length > fastResearchTarget.maximum) {
    nextActions.push(`Bilingual-student cohort is at ${fastResearch.length}, above the ${fastResearchTarget.minimum}–${fastResearchTarget.maximum} target; stop recruiting it and note the deviation.`);
  }
  if (doubleCodedRows.length < requiredDoubleCoded) {
    nextActions.push(`Double-code ${requiredDoubleCoded - doubleCodedRows.length} more interviews with the assigned second coder.`);
  }
  if (accepted < 25) nextActions.push(`Convert ${25 - accepted} more qualified candidates into accepted pilot participants.`);
  if (readyToInvite.length) nextActions.push(`${readyToInvite.length} qualified candidates are ready for a pilot invitation.`);
  if (report.problemEvidence.decision === 'failure') {
    nextActions.push('Recurring weekly pain is below 40%. Report the failure signal honestly and prepare a PIVOT recommendation for #57 rather than continuing recruitment.');
  }

  return {
    schemaVersion: 'v1',
    intake: {
      interviewRowsRead: interviewRows.length,
      rehearsalRowsExcluded: interviewRows.length - sample.length,
      sampleInterviews: sample.length,
      recruitmentRowsRead: recruitmentRows.length,
    },
    funnel: {
      screened: recruitmentRows.length,
      screenerQualified: recruitmentRows.filter((row) => row.screenerOutcome === 'qualified').length,
      interviewed: recruitmentRows.filter((row) => row.linkedInterviewId !== null).length,
      painQualified: recruitment.filter((row) => row.behavioralPainQualified).length,
      contactConsented: recruitmentRows.filter((row) => row.pilotContactConsentRecorded).length,
      invited: recruitmentRows.filter((row) => row.pilotStatus === 'invited').length,
      accepted,
      acceptedWithUnmetHandoff,
      declined: recruitmentRows.filter((row) => row.pilotStatus === 'declined').length,
      withdrawn: recruitmentRows.filter((row) => row.pilotStatus === 'withdrawn').length,
    },
    progress: {
      interviews: {
        sample: sample.length,
        minimum: 30,
        maximum: 40,
        remainingToMinimum: Math.max(0, 30 - sample.length),
        schedulingHeadroom: Math.max(0, 40 - sample.length),
        approachingMaximum: sample.length >= V03_FIELDWORK_DEFAULTS.approachingMaximumInterviews,
        stopScheduling: sample.length >= 40,
      },
      cohortTargets: {
        commercial: {
          interviews: commercial.length,
          minimum: V03_FIELDWORK_DEFAULTS.commercialCohortTarget.minimum,
          maximum: V03_FIELDWORK_DEFAULTS.commercialCohortTarget.maximum,
          remainingToMinimum: Math.max(0, V03_FIELDWORK_DEFAULTS.commercialCohortTarget.minimum - commercial.length),
        },
        fastResearch: {
          interviews: fastResearch.length,
          minimum: V03_FIELDWORK_DEFAULTS.fastResearchCohortTarget.minimum,
          maximum: V03_FIELDWORK_DEFAULTS.fastResearchCohortTarget.maximum,
          remainingToMinimum: Math.max(0, V03_FIELDWORK_DEFAULTS.fastResearchCohortTarget.minimum - fastResearch.length),
        },
      },
      recruitment: {
        accepted,
        minimum: 25,
        maximum: 40,
        remainingToMinimum: Math.max(0, 25 - accepted),
        stopInviting: accepted >= 40,
      },
    },
    rates: {
      overall: overallRates,
      commercial: commercialRates,
      fastResearch: fastResearchRates,
      cohortDifferences: {
        recurringWeeklyPain: difference(commercialRates.recurringWeeklyPainRate, fastResearchRates.recurringWeeklyPainRate),
        concreteCost: difference(commercialRates.concreteCostRate, fastResearchRates.concreteCostRate),
        qualifiedPain: difference(commercialRates.qualifiedPainRate, fastResearchRates.qualifiedPainRate),
        paidForRelatedTool: difference(
          share(commercial.filter((row) => row.paidForRelatedTool).length, commercial.length),
          share(fastResearch.filter((row) => row.paidForRelatedTool).length, fastResearch.length),
        ),
        mediumOrHighSwitchingPain: difference(
          share(commercial.filter((row) => row.switchingPain === 'medium' || row.switchingPain === 'high').length, commercial.length),
          share(fastResearch.filter((row) => row.switchingPain === 'medium' || row.switchingPain === 'high').length, fastResearch.length),
        ),
      },
    },
    competitive: {
      completedComparisons: comparisons.length,
      existingWorkflowPreferred,
      existingWorkflowPreferenceRate: share(existingWorkflowPreferred, comparisons.length),
      baselineCounts: {
        current_workflow: comparisons.filter((row) => row.preferredBaseline === 'current_workflow').length,
        chatgpt_calendar: comparisons.filter((row) => row.preferredBaseline === 'chatgpt_calendar').length,
        chatgpt_todoist: comparisons.filter((row) => row.preferredBaseline === 'chatgpt_todoist').length,
      },
      minimumComparisonsForGate: 10,
      belowGateMinimum: comparisons.length < 10,
    },
    cohortIntegrity: {
      commercialInterviews: commercial.length,
      fastResearchInterviews: fastResearch.length,
      commercialShare,
      minimumCommercialInterviews: V03_FIELDWORK_DEFAULTS.minimumCommercialInterviews,
      commercialCohortUnderpowered: commercial.length < V03_FIELDWORK_DEFAULTS.minimumCommercialInterviews,
      commercialQualifiedPainRate: report.cohorts.commercial.qualifiedPainRate,
      fastResearchQualifiedPainRate: report.cohorts.fast_research.qualifiedPainRate,
      personalNetworkInterviews,
      personalNetworkShare,
      maximumPersonalNetworkShare: V03_FIELDWORK_DEFAULTS.maximumPersonalNetworkShare,
      personalNetworkOverRepresented,
    },
    coding: {
      doubleCoded: doubleCodedRows.length,
      doubleCodedShare,
      required: requiredDoubleCoded,
      agreements,
      disagreements,
      agreementRate: share(agreements, doubleCodedRows.length),
      unadjudicatedDisagreements,
      minimumDoubleCodedShare: V03_FIELDWORK_DEFAULTS.minimumDoubleCodedShare,
      minimumDoubleCodedInterviews: V03_FIELDWORK_DEFAULTS.minimumDoubleCodedInterviews,
      doubleCodingBelowMinimum: doubleCodedRows.length < requiredDoubleCoded,
    },
    handoff: { readyToInvite, invitedAwaitingResponse, blockedFromAccept },
    blockers,
    decisionReadiness: {
      ready: blockers.length === 0 && unmetRequirements.length === 0,
      unmetRequirements,
    },
    nextActions,
    report,
  };
}

/** Header-only CSV templates, generated from the column definitions so they cannot drift. */
export function trackerTemplate(kind: 'interview' | 'recruitment'): string {
  const columns = kind === 'interview' ? INTERVIEW_TRACKER_COLUMNS : RECRUITMENT_TRACKER_COLUMNS;
  return `${columns.join(',')}\n`;
}
