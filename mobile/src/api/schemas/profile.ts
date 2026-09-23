import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * The routine profile and the memory it becomes (UC-2.7a, #167).
 *
 * Windows are wall-clock `HH:MM` in the profile's own zone, never instants —
 * "I sleep at 22:30" stays true after a flight. The client maps them back to
 * the survey chips in `features/routine/routineProfile.ts`.
 */
export const routineTimeWindowSchema = z.object({
  start: z.string(),
  end: z.string(),
  label: z.string().optional(),
});

export const reminderIntensitySchema = z.enum(['none', 'softAwareness', 'followUp', 'strongReminder']);

export const routineProfileSchema = z.object({
  schemaVersion: z.number(),
  updatedAt: isoDateTime,
  timezone: z.string(),
  sleepWindow: routineTimeWindowSchema.nullable(),
  focusWindows: z.array(routineTimeWindowSchema),
  fixedCommitmentWindows: z.array(routineTimeWindowSchema),
  preferredReminderIntensity: reminderIntensitySchema,
  quietHours: routineTimeWindowSchema.nullable(),
  surveySkipped: z.boolean(),
});

/** `routine: null` is an account that has never answered — not an error. */
export const profileResponseSchema = z.object({
  routine: routineProfileSchema.nullable(),
  updatedAt: isoDateTime.nullable(),
});

export const routineSavedSchema = z.object({
  success: z.literal(true),
  routine: routineProfileSchema,
  /** What reconciliation did, which the client logs but does not render. */
  facts: z.object({
    created: z.number(),
    superseded: z.number(),
    revoked: z.number(),
    unchanged: z.number(),
  }),
});

/**
 * Which path a fact arrived by. `behaviour_rule` is a suggestion the user kept
 * (UC-3.16, #202).
 */
export const memoryOriginSchema = z.enum([
  'routine_survey', 'self_description', 'manual', 'capture', 'behaviour_rule',
  /** A profile another AI assistant wrote, which the user brought over. */
  'ai_context_import',
]);

/**
 * Where a fact came from, which is what the provenance chip renders.
 * `null` on records written before #167 — the chip is then omitted rather
 * than guessed at.
 */
export const memoryProvenanceSchema = z.object({
  origin: memoryOriginSchema,
  originRef: z.string().optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  confirmedByUserAt: z.string().optional(),
  /**
   * Which assistant an imported claim came from. Only ever present alongside
   * `origin: 'ai_context_import'`, and a name rather than a model id because it
   * is rendered as words: "brought from ChatGPT".
   */
  assistant: z.enum(['chatgpt', 'gemini', 'claude', 'other']).optional(),
});

/**
 * The label the screen puts under a fact, decided by the server (UC-3.16 #202).
 *
 * A token, not a sentence: the words are this app's, in three languages, and a
 * server that shipped English prose here would be deciding what an Arabic
 * screen says. What the server owns is the *classification* — which needs
 * `source` and `provenance` together — and that is what arrives.
 */
export const memorySourceLabelSchema = z.enum([
  'you_told_us',
  'you_answered_onboarding',
  'noticed_from_confirmed',
  'model_suggested_you_confirmed',
  'model_suggested',
  /**
   * Brought from another AI assistant and kept. Both the edited and unedited
   * versions of an imported line read this way: every one of them was confirmed
   * by the act of keeping it, so the confirmed/unconfirmed split the
   * `model_suggested*` pair needs has nothing to carry here.
   */
  'you_brought_from_ai',
]);

/**
 * What backs a fact, as the "Why?" line can answer it (UC-3.16, #202).
 *
 * No evidence ids: they name rows in stores this app cannot read, and an id a
 * user cannot resolve is not evidence. `observationCount` is the honest part —
 * and it is 0 for everything written today, which the screen says plainly
 * rather than implying data that does not exist.
 */
/**
 * What one growth rule read off the user's behaviour (UC-3.16, #202; R2 in
 * #532). A token and the claim's own shape, never a sentence: R1 carries a
 * local window, R2 the length of a "Later" in minutes, and the words are this
 * app's in three languages.
 *
 * Discriminated on `ruleId`, so a rule this version does not know fails the
 * parse for that field alone rather than being read as R1's shape.
 */
export const memoryPatternSchema = z.discriminatedUnion('ruleId', [
  z.object({
    ruleId: z.literal('R1_focus_window'),
    window: z.object({ start: z.string(), end: z.string() }),
  }),
  z.object({
    ruleId: z.literal('R2_defer_default'),
    deferMinutes: z.number(),
  }),
]);

export const memoryEvidenceSchema = z.object({
  origin: memoryOriginSchema.nullable(),
  observedAt: isoDateTime,
  recordedAt: isoDateTime,
  confirmedAt: isoDateTime.nullable(),
  edited: z.boolean(),
  observationCount: z.number(),
  /**
   * The pattern a rule read off the user's behaviour, on a suggestion they
   * kept unedited. Null for everything else. Defaulted for a server older than
   * #202's growth half, which does not send it.
   */
  pattern: memoryPatternSchema.nullable().default(null),
});

export const memoryItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['fact', 'preference', 'hypothesis', 'goal']),
  content: z.string(),
  language: z.enum(['ar', 'he', 'en', 'mixed']),
  source: z.enum(['user_stated', 'deterministic_rule', 'model_inferred']),
  sourceLabel: memorySourceLabelSchema,
  confidence: z.number(),
  createdAt: isoDateTime,
  observedAt: isoDateTime,
  /** When this stops being believed. A ten-year date means "until you change it". */
  staleAfter: isoDateTime,
  provenance: memoryProvenanceSchema.nullable(),
  evidence: memoryEvidenceSchema,
});

const suggestionEvidenceSchema = z.object({
  matchingCount: z.number(),
  totalCount: z.number(),
  lookbackDays: z.number(),
});

/**
 * Something MaybeSitter could say it noticed, computed on the read and stored
 * nowhere until the user keeps it (UC-3.16, #202; R2 in #532). A token and the
 * claim's own shape, not a sentence: the words are this app's, in three
 * languages.
 */
export const memorySuggestionSchema = z.discriminatedUnion('ruleId', [
  z.object({
    ruleId: z.literal('R1_focus_window'),
    fingerprint: z.string(),
    window: z.object({ start: z.string(), end: z.string() }),
    confidence: z.number(),
    evidence: suggestionEvidenceSchema,
  }),
  z.object({
    ruleId: z.literal('R2_defer_default'),
    fingerprint: z.string(),
    deferMinutes: z.number(),
    confidence: z.number(),
    evidence: suggestionEvidenceSchema,
  }),
]);

/**
 * How reminders adapt to this account (UC-3.16, #202 step 1's `adaptive`).
 *
 * A token and the effect's two halves, never a sentence — the same split
 * `sourceLabel` makes: the server owns the classification (it takes the
 * behaviour counters to compute), the words are this app's in three languages.
 * `effect.maxPressureLevel` is the post-UC-3.13 (#199) cap: a group can lower
 * how hard the product pushes, never raise it.
 *
 * `classification: null` is the neutral unset state: an account with no
 * recorded behaviour has no group, and the screen says so rather than showing
 * a label derived from defaults.
 */
export const memoryAdaptiveSchema = z.object({
  classification: z.enum(['avoidant', 'inconsistent', 'disciplined']).nullable(),
  effect: z.object({
    maxPressureLevel: z.enum(['low', 'medium', 'high']),
    suggestionStyle: z.enum(['direct', 'supportive', 'minimal']),
  }).nullable(),
});

export const memoryListSchema = z.object({
  items: z.array(memoryItemSchema),
  /** Defaulted, so a server without the growth half still parses. */
  suggestions: z.array(memorySuggestionSchema).default([]),
  /** Defaulted, so a server without the adaptive field still parses. */
  adaptive: memoryAdaptiveSchema.nullable().default(null),
});

export const memorySuggestionKeptSchema = z.object({
  success: z.literal(true),
  decision: z.literal('keep'),
  memory: memoryItemSchema,
});

export const memorySuggestionDismissedSchema = z.object({
  success: z.literal(true),
  decision: z.literal('dismiss'),
});

/** Either answer, told apart by `decision`. Both calls parse with this. */
export const memorySuggestionDecisionSchema = z.discriminatedUnion('decision', [
  memorySuggestionKeptSchema,
  memorySuggestionDismissedSchema,
]);

export const memoryCreatedSchema = z.object({ success: z.literal(true), memory: memoryItemSchema });

export const memoryDeletedSchema = z.object({ success: z.literal(true), deleted: z.number() });

export type RoutineProfile = z.infer<typeof routineProfileSchema>;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export type MemoryItem = z.infer<typeof memoryItemSchema>;
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;
export type MemorySourceLabel = z.infer<typeof memorySourceLabelSchema>;
export type MemoryEvidence = z.infer<typeof memoryEvidenceSchema>;
export type MemorySuggestion = z.infer<typeof memorySuggestionSchema>;
export type MemoryPattern = z.infer<typeof memoryPatternSchema>;
export type MemoryAdaptive = z.infer<typeof memoryAdaptiveSchema>;

/**
 * A suggestion drawn from a self-description (UC-2.7b, #168).
 *
 * Held for thirty minutes and shown as a checklist; nothing here is stored
 * until the user ticks it. The raw description is deliberately **not** in the
 * response — it is not stored anywhere, so there is nothing to echo.
 */
export const profileSuggestionSchema = z.object({
  kind: z.enum(['fact', 'preference', 'goal']),
  category: z.enum([
    'work_study', 'schedule', 'household', 'social',
    'fitness_habit', 'learning', 'personal_project', 'other',
  ]),
  content: z.string(),
  targetDate: z.string().nullable(),
  confidence: z.number(),
});

export const profileProposalSchema = z.object({
  success: z.literal(true),
  proposalId: z.string(),
  suggestions: z.array(profileSuggestionSchema),
  createdAt: isoDateTime,
  promptVersion: z.string(),
  model: z.string().nullable(),
});

export const profileConfirmedSchema = z.object({
  success: z.literal(true),
  saved: z.number(),
  kinds: z.record(z.string(), z.number()),
});

export type ProfileSuggestion = z.infer<typeof profileSuggestionSchema>;
export type ProfileProposal = z.infer<typeof profileProposalSchema>;
