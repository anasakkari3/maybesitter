import { apiRequest } from '../client';
import { reminderSettingsResponseSchema, type ReminderSettingsResponse } from '../schemas/reminders';

/** What this account has chosen about gentle reminders (UC-3.11, #196). */
export function getReminderSettings(): Promise<ReminderSettingsResponse> {
  return apiRequest('GET', '/api/mobile/settings/reminders', {
    schema: reminderSettingsResponseSchema,
  });
}

export interface ReminderSettingsPatch {
  softEnabled?: boolean;
  softLeadMinutes?: number;
  /** `null` clears the window. Omit the key entirely to leave it alone. */
  quietHours?: { start: string; end: string; timezone: string } | null;
}

/**
 * Mirrors the screen's three controls to the account.
 *
 * A whole-resource `PUT` that is safe to send twice, like the routine profile's
 * — which is what lets the screen re-send after a failed save without a replay
 * queue (UC-1.R4 #157's no-offline-queue rule).
 *
 * Quiet hours sent here are stored on the routine profile, because that is
 * where they already live and where the next-step gate reads them. The wire
 * shape is #196's; the storage decision is
 * `lib/services/mobile/reminderSettingsService`'s.
 */
export function putReminderSettings(patch: ReminderSettingsPatch): Promise<ReminderSettingsResponse> {
  return apiRequest('PUT', '/api/mobile/settings/reminders', {
    body: patch,
    schema: reminderSettingsResponseSchema,
  });
}
