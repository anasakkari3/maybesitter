/**
 * What the model may propose about somebody, and what survives validation
 * (UC-2.7b, #168).
 *
 * ── A suggestion is not a fact ───────────────────────────────────
 *
 * Nothing here is stored. These are proposals held for thirty minutes while
 * the user looks at them, and only the ones they tick become memory records.
 * The type is separate from `CreateMemoryInput` for exactly that reason: a
 * shared type would make "write it" a one-line mistake.
 */

export const PROFILE_PROMPT_VERSION = 'profile-v1';

/** Same thirty minutes as a capture proposal, and for the same reason. */
export const PROFILE_PROPOSAL_TTL_MS = 30 * 60 * 1_000;

/** The most a single description may produce. */
export const MAX_PROFILE_SUGGESTIONS = 8;

/** A suggestion is a phrase, not a paragraph. */
export const MAX_SUGGESTION_LENGTH = 80;

/** Below this the model is guessing, and a guess about a person is not kept. */
export const MIN_SUGGESTION_CONFIDENCE = 0.6;

/** The most text the endpoint will read. Never stored. */
export const MAX_DESCRIPTION_LENGTH = 1_000;

export type SuggestionKind = 'fact' | 'preference' | 'goal';

export const SUGGESTION_KINDS: readonly SuggestionKind[] = ['fact', 'preference', 'goal'];

/**
 * Deliberately coarse, and deliberately missing the categories that matter
 * most to get wrong. There is no `health`, no `religion`, no `finance` — not
 * because the model will never see them, but because there is nowhere for one
 * to be filed even if it does.
 */
export type SuggestionCategory =
  | 'work_study'
  | 'schedule'
  | 'household'
  | 'social'
  | 'fitness_habit'
  | 'learning'
  | 'personal_project'
  | 'other';

export const SUGGESTION_CATEGORIES: readonly SuggestionCategory[] = [
  'work_study', 'schedule', 'household', 'social',
  'fitness_habit', 'learning', 'personal_project', 'other',
];

export interface ProfileSuggestion {
  readonly kind: SuggestionKind;
  readonly category: SuggestionCategory;
  /** In the user's own language, third person, neutral. */
  readonly content: string;
  /** `YYYY-MM-DD`, and only when the user stated one. */
  readonly targetDate: string | null;
  readonly confidence: number;
}

/** What the describe endpoint answers with. The raw text is not in it. */
export interface ProfileProposal {
  readonly proposalId: string;
  readonly suggestions: readonly ProfileSuggestion[];
  readonly createdAt: string;
  readonly promptVersion: string;
  readonly model: string | null;
}

/** Why a suggestion was dropped. Counted, never attached to content. */
export type DropReason =
  | 'unknown_kind'
  | 'unknown_category'
  | 'empty_content'
  | 'too_long'
  | 'low_confidence'
  | 'bad_confidence'
  | 'past_target_date'
  | 'bad_target_date'
  | 'sensitive'
  | 'over_limit';

export interface ValidationOutcome {
  readonly suggestions: readonly ProfileSuggestion[];
  /** How many fell to each reason. The content of a dropped item is not kept. */
  readonly dropped: Readonly<Partial<Record<DropReason, number>>>;
}
