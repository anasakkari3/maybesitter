import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const NEXT_STEP_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export type NextStepLocale = 'en' | 'ar' | 'he';
export type NextStepState = 'ready' | 'empty' | 'insufficient_evidence';
export type NextStepDecision = 'accept' | 'edit' | 'defer' | 'dismiss' | 'done';

/**
 * Why this step, as a code the client renders (UC-2.R3 #173, UC-2.9 #170).
 *
 * ── Codes, never sentences ───────────────────────────────────────
 *
 * `evidenceLabels` are English prose — "overdue", "due within 24 hours",
 * "you often set these aside". The endpoint takes a `locale` and always
 * ignored it for these, so an Arabic-first app showed its one explanatory line
 * in English. A reason the user cannot read is worse than no reason, because
 * the product's whole claim for the next step is that it can say why.
 *
 * This is the same rule `CaptureProposalContract` already applies to
 * clarification questions: the server sends a key and parameters, the phone
 * renders the sentence from its own locale files. The copy then lives where a
 * person can read all three languages at once and review them together.
 *
 * `evidenceLabels` stays, unchanged, for the alpha quality harness and the
 * trace recorder, which match on the English text and are not user-facing.
 */
export type NextStepEvidenceCode =
  | 'overdue'
  | 'due_within_24h'
  | 'due_within_7d'
  | 'importance'
  | 'importance_estimated'
  | 'effort'
  | 'fits_focus_time'
  | 'outside_usual_hours'
  | 'short_for_end_of_day'
  | 'fits_before_due'
  | 'usually_finishes'
  | 'often_set_aside'
  | 'usual_productive_time'
  /** A timed event inside its last hour: "coming up", the one time it is a step (audit 2026-10-03 #2). */
  | 'starts_soon'
  /** The step prepares for an important event at `params.at` (audit 2026-10-03 #2). */
  | 'prepares_for_event'
  /** A fixed evening plan, `params.title` at `params.at`, sits before that event: asked about, never judged. */
  | 'evening_plan_before_event';

export interface NextStepEvidenceContract {
  code: NextStepEvidenceCode;
  /**
   * Values the phrase interpolates: `importance` carries `level`, `effort`
   * carries `minutes`; `prepares_for_event` carries the event's `at` (and
   * `allDay` when it names a day), `evening_plan_before_event` the plan's own
   * `title` and `at` — the person's words and times, sent back to them.
   * Everything else carries nothing, and a client that does not know a code
   * renders no line rather than the code itself.
   */
  params?: { level?: 'low' | 'normal' | 'high'; minutes?: number; at?: string; allDay?: boolean; title?: string };
}

export interface NextStepExplanationContract {
  /**
   * English, and not shown to the user. Kept because the quality harness and
   * the trace recorder match on it; the phone reads `evidenceCodes`.
   */
  summary: string;
  evidenceLabels: string[];
  /** The same evidence, in a form the phone can say in the user's language. */
  evidenceCodes: NextStepEvidenceContract[];
  sensitiveInferenceUsed: false;
}

export interface NextStepRecommendationContract {
  version: typeof NEXT_STEP_CONTRACT_VERSION;
  proposalId: string;
  state: NextStepState;
  locale: NextStepLocale;
  primaryStep: {
    commitmentId: string;
    title: string;
    /**
     * Absent for the ordinary case: the step *is* the commitment. `prepare`
     * when it is preparation for the event `commitmentId` names (audit
     * 2026-10-03 #2): the title is the preparation, and `done` / `edit` are not
     * offered, because they would complete or rename the event itself.
     */
    purpose?: 'prepare';
  } | null;
  explanation: NextStepExplanationContract | null;
  availableActions: NextStepDecision[];
  persistence: {
    occurred: false;
    confirmationRequired: true;
  };
}

export interface NextStepDecisionContract {
  version: typeof NEXT_STEP_CONTRACT_VERSION;
  proposalId: string;
  decision: NextStepDecision;
  editedTitle?: string;
  decidedAt: string;
}

export const NEXT_STEP_PRODUCT_POLICY = Object.freeze({
  maximumPrimarySteps: 1,
  onboardingRequired: false,
  rejectionHasPenalty: false,
  modelMayPersist: false,
  confirmationRequiredBeforePersistence: true,
  sensitiveInferenceAllowed: false,
  commandLanguageAllowed: false,
  guiltLanguageAllowed: false,
});
