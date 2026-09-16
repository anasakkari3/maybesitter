import { z } from 'zod';
import { deviceCalendarLinkSchema } from './common';

/**
 * The two calendar endpoints (UC-3.1, #185).
 *
 * `writeTarget` is the account's answer to "put my commitments in my calendar",
 * and `google` is UC-3.3 (#187)'s target on the same field — one value, so one
 * target at a time is a property of the type rather than of two switches that
 * have to be kept disagreeing.
 *
 * Which calendar on the phone was picked is deliberately not here. A calendar
 * id means nothing on another device, so it lives on the device that picked it.
 */
export const calendarWriteTargetSchema = z.enum(['off', 'device', 'google']);

export type CalendarWriteTarget = z.infer<typeof calendarWriteTargetSchema>;

export const calendarSettingsResponseSchema = z.object({
  success: z.literal(true),
  calendarSettings: z.object({
    writeTarget: calendarWriteTargetSchema,
    updatedAt: z.string().nullable(),
  }),
});

export const deviceCalendarLinkResponseSchema = z.object({
  success: z.literal(true),
  id: z.string(),
  deviceCalendarLink: deviceCalendarLinkSchema,
});

export const deviceCalendarLinkRemovedSchema = z.object({
  success: z.literal(true),
  id: z.string(),
  deleted: z.boolean(),
});

/**
 * 409 from the link route.
 *
 * `calendar_link_owned_elsewhere` — another installation writes this
 * commitment's event, so this one must not.
 * `calendar_link_detached` — the user deleted the event in their Calendar app,
 * and it is never written again.
 *
 * Both are refusals the sync service acts on rather than reports: there is
 * nothing for the user to do about either, and the correct response to both is
 * to leave the calendar alone.
 */
export const deviceCalendarLinkConflictSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  reason: z.enum(['calendar_link_owned_elsewhere', 'calendar_link_detached']),
});

/**
 * What the server answers a busy-time sync with (UC-3.2, #186).
 *
 * A count and a window, and deliberately nothing that names a single block. The
 * app already knows what it sent; an echo of the blocks would be the one place
 * in this feature where busy intervals travelled *back* over the network, for
 * no purpose beyond confirming a number.
 */
export const calendarBusyStoredSchema = z.object({
  success: z.literal(true),
  blocks: z.number().int().nonnegative(),
  source: z.object({
    sourceId: z.string(),
    lastSyncedAt: z.string(),
    windowStart: z.string(),
    windowEnd: z.string(),
  }),
});

export const calendarBusyDeletedSchema = z.object({
  success: z.literal(true),
  deleted: z.number().int().nonnegative(),
});
