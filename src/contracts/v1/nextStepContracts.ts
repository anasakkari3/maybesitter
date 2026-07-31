import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const NEXT_STEP_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export type NextStepLocale = 'en' | 'ar' | 'he';
export type NextStepState = 'ready' | 'empty' | 'insufficient_evidence';
export type NextStepDecision = 'accept' | 'edit' | 'defer' | 'dismiss' | 'done';

export interface NextStepExplanationContract {
  summary: string;
  evidenceLabels: string[];
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
