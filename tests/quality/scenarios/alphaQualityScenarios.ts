/**
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE
 *
 * Alpha quality evaluation scenarios. Every scenario is a synthetic fixture
 * for engineering QA. None represents V03 human evidence.
 */
import type { ExtractionContext } from '../../../src/extraction/extractionTypes';
import type { BaselineCandidate } from '../../../lib/services/nextStepBaseline';
import type { NextStepLocale } from '../../../src/contracts/v1/nextStepContracts';

export type FailureTaxonomy =
  | 'invented_fact'
  | 'missed_commitment'
  | 'wrong_time'
  | 'unspecific_next_step'
  | 'not_actionable'
  | 'unfaithful'
  | 'inappropriate_assumption'
  | 'over_broad'
  | 'multilingual_regression'
  | 'fallback_misuse';

export type Severity = 'P0' | 'P1' | 'P2';

export const TAXONOMY_SEVERITY: Record<FailureTaxonomy, Severity> = {
  invented_fact: 'P0',
  missed_commitment: 'P0',
  wrong_time: 'P0',
  inappropriate_assumption: 'P0',
  unfaithful: 'P0',
  unspecific_next_step: 'P1',
  not_actionable: 'P1',
  over_broad: 'P1',
  multilingual_regression: 'P0',
  fallback_misuse: 'P1',
};

export interface ScenarioConstraint {
  expectedType?: string;
  titleRegex?: RegExp;
  titleContains?: string[];
  titleMustNotContain?: string[];
  expectedDisposition?: string;
  expectedDayOffset?: number;
  expectedHourUtc?: number;
  expectedHourOffset?: { min: number; max: number };
  expectedPriorityLevel?: string;
  expectedPrioritySource?: string;
  expectedRecState?: string;
  recTitleContains?: string[];
  recEvidenceContains?: string[];
  recActionsInclude?: string[];
  failureTaxonomy: FailureTaxonomy;
}

export interface AlphaScenario {
  id: string;
  lang: 'en' | 'ar' | 'he' | 'mixed';
  input: string;
  context: ExtractionContext;
  nextStepCandidates?: BaselineCandidate[];
  locale?: NextStepLocale;
  constraints: ScenarioConstraint[];
}

const FIXED_NOW = new Date('2026-08-10T08:00:00.000Z');
const FIXED_CONTEXT: ExtractionContext = { now: FIXED_NOW, timezone: 'UTC' };
const FIXED_PROPOSAL_ID = 'alpha-eval-001';

function inNdaysAtTime(n: number, hour: number, minute = 0): string {
  const d = new Date(FIXED_NOW);
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

export const ALPHA_SCENARIOS: AlphaScenario[] = [
  // ── English core flow ──────────────────────────────────────────
  {
    id: 'en-task-tomorrow',
    lang: 'en',
    input: 'Remind me to call Maya tomorrow at 10am',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', titleRegex: /call maya/i, expectedDisposition: 'auto_confirm', expectedDayOffset: 1, expectedHourUtc: 10, failureTaxonomy: 'wrong_time' },
      { titleMustNotContain: ['reminder'], failureTaxonomy: 'invented_fact' },
      { expectedRecState: 'ready', recTitleContains: ['Call Maya'], failureTaxonomy: 'unspecific_next_step' },
    ],
    nextStepCandidates: [{ commitmentId: 'c1', title: 'Call Maya', confirmed: true, status: 'active', dueAt: inNdaysAtTime(1, 10), remindAt: inNdaysAtTime(1, 10), importance: 'high', explicitEffortMinutes: null }],
    locale: 'en',
  },
  {
    id: 'en-task-today',
    lang: 'en',
    input: 'Please remind me to email Alex at 3pm today',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', titleRegex: /email alex/i, expectedDisposition: 'auto_confirm', expectedDayOffset: 0, expectedHourUtc: 15, failureTaxonomy: 'wrong_time' },
      { titleMustNotContain: ['please', 'remind'], failureTaxonomy: 'invented_fact' },
    ],
    nextStepCandidates: [{ commitmentId: 'c2', title: 'Email Alex', confirmed: true, status: 'active', dueAt: inNdaysAtTime(0, 15), remindAt: inNdaysAtTime(0, 15), importance: null, explicitEffortMinutes: null }],
    locale: 'en',
  },
  {
    id: 'en-follow-up',
    lang: 'en',
    input: 'Follow up with Daniel about lease tomorrow',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'follow_up', titleRegex: /follow up.*daniel/i, expectedDisposition: 'pending_confirmation', failureTaxonomy: 'missed_commitment' },
      { expectedRecState: 'ready', recTitleContains: ['Daniel'], failureTaxonomy: 'unspecific_next_step' },
    ],
    locale: 'en',
  },
  {
    id: 'en-info-context',
    lang: 'en',
    input: 'Maya is waiting on the invoice',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'informational_context', expectedDisposition: 'store_note', failureTaxonomy: 'missed_commitment' },
      { expectedRecState: 'empty', failureTaxonomy: 'over_broad' },
    ],
  },
  {
    id: 'en-ambiguous',
    lang: 'en',
    input: 'Call mom',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', titleRegex: /call mom/i, expectedDisposition: 'needs_clarification', failureTaxonomy: 'wrong_time' },
      { expectedRecState: 'empty', failureTaxonomy: 'unspecific_next_step' },
    ],
  },
  {
    id: 'en-dont-remind',
    lang: 'en',
    input: "Don't remind me to call mom tomorrow",
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', expectedDisposition: 'store_note', failureTaxonomy: 'missed_commitment' },
    ],
  },
  {
    id: 'en-report-friday',
    lang: 'en',
    input: 'I need to submit report Friday',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', titleRegex: /submit report/i, expectedDisposition: 'pending_confirmation', failureTaxonomy: 'missed_commitment' },
    ],
  },
  {
    id: 'en-24h-range',
    lang: 'en',
    input: 'Remind me to go to work from 17:00 to 22:00',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', titleRegex: /go to work/i, expectedHourUtc: 17, expectedDisposition: 'auto_confirm', failureTaxonomy: 'wrong_time' },
    ],
  },

  // ── Arabic ─────────────────────────────────────────────────────
  {
    id: 'ar-task-tomorrow-high',
    lang: 'ar',
    input: 'ذكرني ادفع الفاتورة بكرا الصبح ضروري',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', titleContains: ['ادفع الفاتورة'], expectedPriorityLevel: 'high', expectedPrioritySource: 'user_explicit', expectedDisposition: 'auto_confirm', failureTaxonomy: 'missed_commitment' },
      { titleMustNotContain: ['ضروري'], failureTaxonomy: 'invented_fact' },
    ],
  },
  {
    id: 'ar-task-lower',
    lang: 'ar',
    input: 'ذكرني اقرأ فصل بعد بكرا المسا يمكن',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', titleContains: ['اقرأ فصل'], expectedPriorityLevel: 'low', expectedPrioritySource: 'inferred', expectedDisposition: 'pending_confirmation', failureTaxonomy: 'missed_commitment' },
    ],
  },
  {
    id: 'ar-clock-phrase',
    lang: 'ar',
    input: 'ذكرني اروح النادي الساعة ٥ مساء',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', titleContains: ['اروح النادي'], expectedHourUtc: 17, expectedDisposition: 'auto_confirm', failureTaxonomy: 'wrong_time' },
      { titleMustNotContain: ['٥'], failureTaxonomy: 'invented_fact' },
    ],
  },
  {
    id: 'ar-task-friday',
    lang: 'ar',
    input: 'ذكرني اتصل بالدكتور يوم الجمعة',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', titleContains: ['اتصل'], failureTaxonomy: 'missed_commitment' },
    ],
  },
  {
    id: 'ar-info-not-task',
    lang: 'ar',
    input: 'سارة سألتني عن التقرير',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'informational_context', failureTaxonomy: 'missed_commitment' },
    ],
  },
  {
    id: 'ar-low-priority',
    lang: 'ar',
    input: 'ذكرني أوصل الكتاب لمكتبة بكرا',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', titleContains: ['أوصل الكتاب'], failureTaxonomy: 'missed_commitment' },
    ],
  },

  // ── Hebrew ─────────────────────────────────────────────────────
  {
    id: 'he-task-tomorrow',
    lang: 'he',
    input: 'תזכיר לי להתקשר מחר לאימא',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', failureTaxonomy: 'multilingual_regression' },
    ],
  },
  {
    id: 'he-follow-up',
    lang: 'he',
    input: 'לשלוח מייל לדני מחר',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', failureTaxonomy: 'multilingual_regression' },
    ],
  },
  {
    id: 'he-info-context',
    lang: 'he',
    input: 'דני מחכה לחשבון',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'informational_context', failureTaxonomy: 'multilingual_regression' },
    ],
  },

  // ── Mixed language ─────────────────────────────────────────────
  {
    id: 'mixed-ar-en',
    lang: 'mixed',
    input: 'Remind me ادفع الفاتورة بكرا morning',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', failureTaxonomy: 'multilingual_regression' },
    ],
  },
  {
    id: 'mixed-he-en',
    lang: 'mixed',
    input: 'Call אמא tomorrow at 3pm',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', failureTaxonomy: 'multilingual_regression' },
    ],
  },

  // ── Inappropriate-assumption checks ────────────────────────────
  {
    id: 'en-no-medical-inference',
    lang: 'en',
    input: 'Remind me to take medication every morning',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', titleRegex: /take medication/i, failureTaxonomy: 'inappropriate_assumption' },
    ],
  },
  {
    id: 'ar-no-gender-inference',
    lang: 'ar',
    input: 'ذكرني احضر هدية لعيد ميلاد سارة بكرا',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', titleContains: ['هدية'], failureTaxonomy: 'inappropriate_assumption' },
    ],
  },

  // ── Next-step specificity ──────────────────────────────────────
  {
    id: 'en-specific-nextstep',
    lang: 'en',
    input: 'Remind me to send invoice to Alex today at 4pm',
    context: FIXED_CONTEXT,
    nextStepCandidates: [{ commitmentId: 'c3', title: 'Send invoice to Alex', confirmed: true, status: 'active', dueAt: inNdaysAtTime(0, 16), remindAt: inNdaysAtTime(0, 16), importance: null, explicitEffortMinutes: 5 }],
    locale: 'en',
    constraints: [
      { expectedRecState: 'ready', recTitleContains: ['send invoice'], recEvidenceContains: ['due within 24 hours'], recActionsInclude: ['accept', 'edit', 'defer', 'dismiss', 'done'], failureTaxonomy: 'unspecific_next_step' },
    ],
  },
  {
    id: 'en-overdue-nextstep',
    lang: 'en',
    input: 'I needed to submit the report yesterday',
    context: FIXED_CONTEXT,
    nextStepCandidates: [{ commitmentId: 'c4', title: 'Submit report', confirmed: true, status: 'active', dueAt: inNdaysAtTime(-1, 17), remindAt: inNdaysAtTime(-1, 17), importance: 'high', explicitEffortMinutes: null }],
    locale: 'en',
    constraints: [
      { expectedRecState: 'ready', recTitleContains: ['Submit report'], recEvidenceContains: ['overdue'], failureTaxonomy: 'over_broad' },
    ],
  },

  // ── Fallback / insufficient evidence ───────────────────────────
  {
    id: 'en-empty-nextstep',
    lang: 'en',
    input: 'I had a nice day',
    context: FIXED_CONTEXT,
    nextStepCandidates: [],
    locale: 'en',
    constraints: [
      { expectedType: 'informational_context', expectedRecState: 'empty', failureTaxonomy: 'fallback_misuse' },
    ],
  },

  // ── Time accuracy edge cases ───────────────────────────────────
  {
    id: 'en-tomorrow-evening',
    lang: 'en',
    input: 'Remind me to call mom tomorrow evening around 8pm',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', expectedDayOffset: 1, expectedHourUtc: 20, failureTaxonomy: 'wrong_time' },
    ],
  },

  // ── Multi-action evaluation ────────────────────────────────────
  {
    id: 'en-accept-action',
    lang: 'en',
    input: 'send the report',
    context: FIXED_CONTEXT,
    nextStepCandidates: [{ commitmentId: 'c5', title: 'Send the report', confirmed: true, status: 'active', dueAt: inNdaysAtTime(1, 12), remindAt: inNdaysAtTime(1, 12), importance: 'normal', explicitEffortMinutes: 10 }],
    locale: 'en',
    constraints: [
      { expectedRecState: 'ready', recActionsInclude: ['accept', 'edit', 'defer', 'dismiss', 'done'], failureTaxonomy: 'not_actionable' },
    ],
  },
  // ── Low-priority English ──────────────────────────────────────
  {
    id: 'en-low-effort',
    lang: 'en',
    input: 'Remind me to reply to Sam’s email',
    context: FIXED_CONTEXT,
    nextStepCandidates: [{ commitmentId: 'c6', title: 'Reply to Sam', confirmed: true, status: 'active', dueAt: inNdaysAtTime(2, 9), remindAt: inNdaysAtTime(2, 9), importance: null, explicitEffortMinutes: 3 }],
    locale: 'en',
    constraints: [
      { expectedRecState: 'ready', recTitleContains: ['Sam'], failureTaxonomy: 'unspecific_next_step' },
    ],
  },

  // ── Unfaithfulness: user asked NOT to be reminded ──────────────
  {
    id: 'en-unfaithful-dont-remind',
    lang: 'en',
    input: "Do not remind me about the dentist appointment, I have it in my calendar",
    context: FIXED_CONTEXT,
    constraints: [
      { expectedDisposition: 'store_note', failureTaxonomy: 'unfaithful' },
      { expectedRecState: 'empty', failureTaxonomy: 'unfaithful' },
    ],
    nextStepCandidates: [{ commitmentId: 'c7', title: 'Dentist appointment', confirmed: false, status: 'pending_confirmation', dueAt: inNdaysAtTime(1, 9), remindAt: inNdaysAtTime(1, 9), importance: null, explicitEffortMinutes: null }],
    locale: 'en',
  },

  // ── Arabic weekday + Hebrew tomorrow ───────────────────────────
  {
    id: 'ar-task-weekday',
    lang: 'ar',
    input: 'ذكرني ادفع الإيجار يوم الأحد',
    context: FIXED_CONTEXT,
    constraints: [
      // Arabic weekday names previously fell to needs_clarification because
      // they were not parsed. With weekday support, an explicit reminder
      // with a resolved time auto-confirms, consistent with English.
      { expectedType: 'task', titleContains: ['ادفع الإيجار'], expectedDisposition: 'auto_confirm', failureTaxonomy: 'multilingual_regression' },
    ],
  },
  {
    id: 'he-task-tomorrow-morning',
    lang: 'he',
    input: 'תזכיר לי לקנות חלב מחר בבוקר',
    context: FIXED_CONTEXT,
    constraints: [
      { expectedType: 'task', failureTaxonomy: 'multilingual_regression' },
    ],
  },
];

export { FIXED_NOW, FIXED_PROPOSAL_ID };
