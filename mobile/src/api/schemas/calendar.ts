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

/**
 * What the server answers a manual busy time store with (UC-3.7, #191 Step 7).
 */
export const manualCalendarStoredSchema = z.object({
  success: z.literal(true),
  sourceId: z.string(),
  blocks: z.number().int().nonnegative(),
  windowStart: z.string(),
  windowEnd: z.string(),
});

export const manualCalendarDeletedSchema = z.object({
  success: z.literal(true),
  sourceId: z.string(),
  deleted: z.number().int().nonnegative(),
});


/**
 * The account's server-side busy time (M4a, WIRE-M4a "Server busy read"):
 * ICS and manual blocks in the six-field shape, nothing that names them.
 *
 * It is also the probe for the free-time surfaces: a 404 means the capability
 * is off, and the Plan tab stays exactly as it was. `.strict()` on a block for
 * the same reason the Google rows are strict.
 */
export const serverBusyBlockSchema = z.object({
  blockId: z.string(),
  sourceId: z.string(),
  sourceKind: z.enum(['ics', 'manual']),
  startAt: z.string(),
  endAt: z.string(),
  allDay: z.boolean(),
}).strict();

export const serverBusySourceSchema = z.object({
  sourceId: z.string(),
  kind: z.literal('ics'),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  lastRefreshedAt: z.string().nullable(),
  status: z.enum(['ok', 'paused', 'error', 'stale', 'uninitialized']),
});

export const serverBusyResponseSchema = z.object({
  success: z.literal(true),
  blocks: z.array(serverBusyBlockSchema),
  complete: z.boolean(),
  cutoff: z.string().nullable(),
  unknownRanges: z.array(z.object({ from: z.string(), to: z.string() })),
  sources: z.array(serverBusySourceSchema),
});

export type ServerBusy = z.infer<typeof serverBusyResponseSchema>;
