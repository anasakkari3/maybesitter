import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * `/api/mobile/settings/reminders` (UC-3.11, #196).
 *
 * Read from the route, not from the issue's table: the stored quiet hours live
 * on the routine profile and this response is where the server publishes them,
 * so `quietHours.timezone` is the *profile's* zone and can differ from the
 * device's. The screen shows the server's answer rather than assuming the
 * phone's zone is the one the window was set in.
 */
export const quietHoursSchema = z.object({
  /** `HH:MM` on the user's clock face; never an instant. */
  start: z.string(),
  end: z.string(),
  timezone: z.string(),
});

export const escalationCeilingSchema = z.enum(['soft', 'followUp', 'hard']);

export const reminderSettingsSchema = z.object({
  softEnabled: z.boolean(),
  /** 60, 30 or 15. A number rather than an enum: see `plan.ts` on reasonCode. */
  softLeadMinutes: z.number(),
  /*
   * The Must-reminder controls (UC-3.12a, #197).
   *
   * Optional on the wire, because a server that predates #197 does not send
   * them and a schema failure there would take the whole reminders screen down
   * with it. Absent is resolved by `toEngineSettings` through the survey's
   * legacy mapping — the same one the server applies — never as "ring".
   *
   * `escalationCeiling` is an enum and not a string: a word this build does not
   * know must not be read as a ceiling at all. It fails the parse, which the
   * screen shows as a failed load; the engine then schedules from the last good
   * settings or from nothing, and neither can ring louder than asked.
   */
  hardEnabled: z.boolean().optional(),
  escalationCeiling: escalationCeilingSchema.optional(),
  mustThroughQuietHours: z.boolean().optional(),
  quietHours: quietHoursSchema.nullable(),
  timezone: z.string(),
  updatedAt: isoDateTime.nullable(),
});

export const reminderSettingsResponseSchema = z.object({
  success: z.literal(true),
  reminderSettings: reminderSettingsSchema,
});

export type QuietHours = z.infer<typeof quietHoursSchema>;
export type ReminderSettingsDto = z.infer<typeof reminderSettingsSchema>;
export type ReminderSettingsResponse = z.infer<typeof reminderSettingsResponseSchema>;
