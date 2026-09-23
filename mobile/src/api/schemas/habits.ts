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
  source: z.enum(['user_created', 'goal_confirmed', 'onboarding_confirmed']),
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

export const habitListSchema = z.object({ success: z.literal(true), items: z.array(habitSchema) });
export const habitChangedSchema = z.object({ success: z.literal(true), habit: habitSchema, occurrences: z.array(habitOccurrenceSchema) });
export const habitDeletedSchema = z.object({ success: z.literal(true), habitId: z.string(), deleted: z.literal(true) });

export type Habit = z.infer<typeof habitSchema>;
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
