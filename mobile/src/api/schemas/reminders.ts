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

export const reminderSettingsSchema = z.object({
  softEnabled: z.boolean(),
  /** 60, 30 or 15. A number rather than an enum: see `plan.ts` on reasonCode. */
  softLeadMinutes: z.number(),
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
