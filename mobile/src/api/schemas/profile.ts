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
 * Where a fact came from, which is what the provenance chip renders.
 * `null` on records written before #167 — the chip is then omitted rather
 * than guessed at.
 */
export const memoryProvenanceSchema = z.object({
  origin: z.enum(['routine_survey', 'self_description', 'manual', 'capture']),
  originRef: z.string().optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  confirmedByUserAt: z.string().optional(),
});

export const memoryItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['fact', 'preference', 'hypothesis', 'goal']),
  content: z.string(),
  language: z.enum(['ar', 'he', 'en', 'mixed']),
  source: z.enum(['user_stated', 'deterministic_rule', 'model_inferred']),
  confidence: z.number(),
  createdAt: isoDateTime,
  observedAt: isoDateTime,
  provenance: memoryProvenanceSchema.nullable(),
});

export const memoryListSchema = z.object({ items: z.array(memoryItemSchema) });

export const memoryCreatedSchema = z.object({ success: z.literal(true), memory: memoryItemSchema });

export const memoryDeletedSchema = z.object({ success: z.literal(true), deleted: z.number() });

export type RoutineProfile = z.infer<typeof routineProfileSchema>;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export type MemoryItem = z.infer<typeof memoryItemSchema>;
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;

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
