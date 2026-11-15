import { z } from 'zod';
import { isoDateTime } from './common';

const cadenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('weekly_count'), count: z.number().int().min(1).max(7) }),
  z.object({ kind: z.literal('weekdays'), weekdays: z.array(z.number().int().min(0).max(6)) }),
]);

const windowSchema = z.object({ start: z.string(), end: z.string(), label: z.string().optional() });
const confirmationSchema = z.object({
  confirmedByUserAt: isoDateTime,
  sourceRef: z.string().nullable(),
  acceptedSuggestedValues: z.boolean(),
});

export const habitSchema = z.object({
  habitId: z.string(),
  title: z.string(),
  cadence: cadenceSchema,
  durationMinutes: z.number().int().positive(),
  preferredWindows: z.array(windowSchema),
  minimumOccurrences: z.number().int().nonnegative(),
  maximumOccurrences: z.number().int().positive(),
  flexibility: z.enum(['flexible', 'protected_flexible']),
  recoveryPolicy: z.enum(['skip', 'retry_same_day', 'recover_within_period']),
  status: z.enum(['active', 'paused', 'archived']),
  source: z.enum(['user_created', 'goal_confirmed', 'onboarding_confirmed', 'capture_chat']),
  confirmation: confirmationSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const habitOccurrenceSchema = z.object({
  occurrenceId: z.string(),
  habitId: z.string(),
  localDate: z.string(),
  ordinal: z.number().int(),
  state: z.enum(['pending', 'scheduled', 'completed', 'skipped', 'recovered']),
  durationMinutes: z.number().int().positive(),
  recoveredFromOccurrenceId: z.string().nullable(),
});

// `today` (CA5.4): the occurrences due on the caller's local date — what the
// habit card marks done or not today. Optional: a server from before it
// answers without one, which reads as nothing due.
// `weeks` and `anyDay` (owner decision 2026-11-15): a weekly-count habit's
// count this week, and which of today's rows are off days («تمّت» only).
// Optional: a server from before them sends neither.
export const habitWeekSchema = z.object({ habitId: z.string(), completed: z.number().int().nonnegative(), target: z.number().int().nonnegative() });
export const habitTodaySchema = z.object({
  localDate: z.string(),
  occurrences: z.array(habitOccurrenceSchema),
  weeks: z.array(habitWeekSchema).optional(),
  anyDay: z.array(z.string()).optional(),
});
export const habitListSchema = z.object({ success: z.literal(true), items: z.array(habitSchema), today: habitTodaySchema.optional() });
export const habitOutcomeSchema = z.object({
  success: z.literal(true),
  occurrence: habitOccurrenceSchema,
  changed: z.boolean(),
  recovery: z.union([
    z.object({ recovered: z.literal(true), replacement: habitOccurrenceSchema }),
    z.object({ recovered: z.literal(false), reason: z.string() }),
  ]).optional(),
});
export const habitChangedSchema = z.object({ success: z.literal(true), habit: habitSchema, occurrences: z.array(habitOccurrenceSchema) });
export const habitDeletedSchema = z.object({ success: z.literal(true), habitId: z.string(), deleted: z.literal(true) });

export type Habit = z.infer<typeof habitSchema>;
export type HabitOccurrence = z.infer<typeof habitOccurrenceSchema>;
export type HabitToday = z.infer<typeof habitTodaySchema>;
export type HabitWeek = z.infer<typeof habitWeekSchema>;
export type HabitOutcome = z.infer<typeof habitOutcomeSchema>;
export type HabitOccurrenceDecision = { habitId: string; occurrenceId: string; outcome: 'completed' | 'skipped' };
export type NewHabitInput = {
  title: string;
  cadence: { kind: 'weekly_count'; count: number } | { kind: 'weekdays'; weekdays: readonly number[] };
  durationMinutes: number;
  preferredWindows: readonly { start: string; end: string; label?: string }[];
  minimumOccurrences: number;
  maximumOccurrences: number;
  flexibility: 'flexible' | 'protected_flexible';
  recoveryPolicy: 'skip' | 'retry_same_day' | 'recover_within_period';
  source: 'user_created';
  confirmation: { confirmedByUserAt: string; sourceRef: null; acceptedSuggestedValues: boolean };
};
