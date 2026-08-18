/**
 * SYNTHETIC — ENG/QA INFRA ONLY
 *
 * Alpha feedback flag contracts. These allow internal dogfooders to flag
 * recommendations during the pre-pilot phase. Flags are reviewable through
 * the `scripts/alpha-review.ts` CLI.
 */

export const ALPHA_FEEDBACK_FLAG_VERSION = 'alpha-v1';

export type AlphaFeedbackFlagCategory =
  | 'recommendation_wrong'
  | 'misunderstood_me'
  | 'not_useful'
  | 'invasive'
  | 'technical_problem';

export interface AlphaFeedbackFlag {
  readonly version: typeof ALPHA_FEEDBACK_FLAG_VERSION;
  readonly flagId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly proposalId: string;
  readonly commitmentId: string | null;
  readonly category: AlphaFeedbackFlagCategory;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface AlphaFeedbackFlagInput {
  readonly participantId: string;
  readonly sessionId?: string | null;
  readonly proposalId: string;
  readonly commitmentId?: string | null;
  readonly category: AlphaFeedbackFlagCategory;
  readonly note?: string | null;
}

export const VALID_FLAG_CATEGORIES: readonly AlphaFeedbackFlagCategory[] = [
  'recommendation_wrong',
  'misunderstood_me',
  'not_useful',
  'invasive',
  'technical_problem',
] as const;

/** Maximum length for the optional free-text note. */
export const FLAG_NOTE_MAX_LENGTH = 500;

export function isValidFlagCategory(value: string): value is AlphaFeedbackFlagCategory {
  return (VALID_FLAG_CATEGORIES as readonly string[]).includes(value);
}

export function validateFlagInput(input: unknown): asserts input is AlphaFeedbackFlagInput {
  if (!input || typeof input !== 'object') throw new Error('flag input must be an object');
  const i = input as Record<string, unknown>;
  if (typeof i.participantId !== 'string' || !i.participantId) throw new Error('participantId is required');
  if (i.sessionId !== undefined && i.sessionId !== null && typeof i.sessionId !== 'string') {
    throw new Error('sessionId must be a string or omitted');
  }
  if (typeof i.proposalId !== 'string' || !i.proposalId) throw new Error('proposalId is required');
  if (typeof i.category !== 'string' || !isValidFlagCategory(i.category)) {
    throw new Error(`category must be one of: ${VALID_FLAG_CATEGORIES.join(', ')}`);
  }
  if (i.note !== undefined && i.note !== null && typeof i.note !== 'string') {
    throw new Error('note must be a string or null');
  }
}
