import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * Weekly fixed blocks — «ثابت أسبوعي» (server: `src/contracts/v1/
 * weeklyBlockContracts.ts`, routes under `/api/mobile/weekly-blocks`).
 *
 * `weekdays` are 0 = Sunday … 6 = Saturday; `start`/`end` are `HH:MM` on the
 * block's own `timezone`, end after start on the same day (the server refuses
 * overnight with `code: 'overnight_not_supported'`).
 */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const weekdays = z.array(z.number().int().min(0).max(6)).min(1).max(7);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * What the phone writes as ONE recurring device-calendar event: weekly on
 * `weekdays` (RRULE `FREQ=WEEKLY;BYDAY=…`), first on `startsOn` at `start`,
 * ending `end`, in `timezone`. Null while the block is paused — remove the
 * device event.
 */
export const weeklyBlockDeviceEventSchema = z.object({
  title: z.string(),
  weekdays,
  start: clock,
  end: clock,
  timezone: z.string(),
  startsOn: localDate,
});

export const weeklyBlockSchema = z.object({
  id: z.string(),
  title: z.string(),
  weekdays,
  start: clock,
  end: clock,
  timezone: z.string(),
  status: z.enum(['active', 'paused']),
  source: z.enum(['manual', 'capture']),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  confirmedAt: isoDateTime,
  startsOn: localDate,
  deviceEvent: weeklyBlockDeviceEventSchema.nullable(),
});

/** A capture item's offer, rendered «كل سبت · 10:00–16:00» on the Review card. */
export const weeklyBlockOfferSchema = z.object({
  title: z.string(),
  weekdays,
  start: clock,
  end: clock,
  timezone: z.string(),
});

export const weeklyBlockListSchema = z.object({ success: z.literal(true), items: z.array(weeklyBlockSchema) });
export const weeklyBlockChangedSchema = z.object({ success: z.literal(true), block: weeklyBlockSchema });
export const weeklyBlockDeletedSchema = z.object({ success: z.literal(true), deleted: z.literal(true) });

/** One materialized occurrence — exactly the busy time the planner keeps free. */
export const weeklyBlockOccurrenceSchema = z.object({
  occurrenceId: z.string(),
  weeklyBlockId: z.string(),
  title: z.string(),
  startAt: isoDateTime,
  endAt: isoDateTime,
});

export const weeklyBlockOccurrencesSchema = z.object({
  success: z.literal(true),
  from: isoDateTime,
  to: isoDateTime,
  items: z.array(weeklyBlockOccurrenceSchema),
});

export type WeeklyBlock = z.infer<typeof weeklyBlockSchema>;
export type WeeklyBlockOffer = z.infer<typeof weeklyBlockOfferSchema>;
export type WeeklyBlockOccurrence = z.infer<typeof weeklyBlockOccurrenceSchema>;
export type WeeklyBlockDeviceEvent = z.infer<typeof weeklyBlockDeviceEventSchema>;
