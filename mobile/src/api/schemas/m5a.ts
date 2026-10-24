import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * M5a's shapes (PLAN-M5a Wire + addendum G-1): calendars chosen, not assumed;
 * one email scan that says what happened; what the person agreed to in their
 * own reply, added and removable; monitoring that says what it reads.
 *
 * Every new object is strict: a field this app was not built against is a
 * contract change, not something to ignore. Fields added to an existing
 * response are optional so an older server still parses.
 */

/** `GET /api/mobile/capabilities/m5a`: env flag AND durable control, false when either is off. */
export const m5aCapabilitiesSchema = z.object({
  success: z.literal(true),
  calendarChoice: z.boolean(),
  emailSources: z.boolean(),
}).strict();
export type M5aCapabilities = z.infer<typeof m5aCapabilitiesSchema>;

/* ── calendar choice ─────────────────────────────────────────────────── */

export const calendarChoiceStateSchema = z.enum(['purging', 'active']);

/** `POST /api/mobile/calendar/choice`. Only `active` is done (M5A-R9-001). */
export const calendarChoiceEnrolSchema = z.object({
  success: z.literal(true),
  state: calendarChoiceStateSchema,
  enrolledAt: isoDateTime,
}).strict();

/** `GET /api/mobile/calendar/choice?sourceId=…`, always available. */
export const calendarChoiceProbeSchema = z.object({
  success: z.literal(true),
  enrolled: z.boolean(),
  state: calendarChoiceStateSchema.nullable(),
  sourceStatus: z.enum(['active', 'revoked']).nullable(),
  sourceEpoch: z.number().int().nullable(),
}).strict();
export type CalendarChoiceProbe = z.infer<typeof calendarChoiceProbeSchema>;

/** `POST /api/mobile/calendar/busy/register`. */
export const sourceRegisteredSchema = z.object({
  success: z.literal(true),
  sourceId: z.string().min(1),
}).strict();

/** `POST /api/mobile/calendar/busy/intent`: the server mints the epoch. */
export const busyIntentSchema = z.object({
  success: z.literal(true),
  opId: z.string().min(1),
  epoch: z.number().int(),
  intentId: z.string().min(1),
}).strict();
export type BusyIntent = z.infer<typeof busyIntentSchema>;

export const phoneSourceSchema = z.object({
  sourceId: z.string().min(1),
  status: z.enum(['registered', 'uploading', 'active', 'clearing', 'retiring']),
  platform: z.enum(['ios', 'android']).nullable(),
  lastUploadAt: isoDateTime.nullable(),
  blockCount: z.number().int().nonnegative(),
}).strict();
export type PhoneSource = z.infer<typeof phoneSourceSchema>;

/** `GET /api/mobile/calendar/busy/sources` (enrolled accounts). */
export const phoneSourcesSchema = z.object({
  success: z.literal(true),
  sources: z.array(phoneSourceSchema),
}).strict();

/** The refusals an enrolled account's busy routes answer with. */
export const busyRefusalSchema = z.object({
  success: z.literal(false),
  error: z.enum(['calendar_choice_required', 'calendar_choice_purging', 'source_revoked', 'selection_stale', 'too_many_phones']),
  currentEpoch: z.number().int().optional(),
}).passthrough();

/* ── the email scan ──────────────────────────────────────────────────── */

const counts = {
  messagesRead: z.number().int().nonnegative(),
  messagesUnavailable: z.number().int().nonnegative(),
  messagesTrimmed: z.number().int().nonnegative(),
  observationsFound: z.number().int().nonnegative(),
  addedFromEmail: z.number().int().nonnegative(),
};

export const scanWaitSchema = z.object({
  reason: z.enum(['daily_ai_limit', 'rate_limit']),
  resumesAt: isoDateTime,
}).strict();
export type ScanWait = z.infer<typeof scanWaitSchema>;

export const scanFailureSchema = z.enum(['reconnect_needed', 'source_unavailable', 'analysis_unavailable', 'monitoring_off', 'daily_limit']);
export type ScanFailure = z.infer<typeof scanFailureSchema>;

const window = {
  scanId: z.string().min(1),
  from: isoDateTime,
  until: isoDateTime,
  startedAt: isoDateTime,
  ...counts,
};

const origin = z.enum(['manual', 'backfill']);

export const scanStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running'), origin, ...window, waiting: scanWaitSchema.nullable().optional() }).strict(),
  z.object({ status: z.literal('complete'), origin, ...window, finishedAt: isoDateTime }).strict(),
  z.object({ status: z.literal('failed'), origin, ...window, failedAt: isoDateTime, failure: scanFailureSchema }).strict(),
]);
export type ScanStatus = z.infer<typeof scanStatusSchema>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const dailyStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running'), ...window, day, waiting: scanWaitSchema.nullable().optional() }).strict(),
  z.object({ status: z.literal('complete'), ...window, day, finishedAt: isoDateTime }).strict(),
  z.object({ status: z.literal('failed'), ...window, day, failedAt: isoDateTime, failure: scanFailureSchema }).strict(),
  z.object({ status: z.literal('held'), reason: z.literal('no_timezone'), heldAt: isoDateTime }).strict(),
]);
export type DailyStatus = z.infer<typeof dailyStatusSchema>;

export const queuedScanSchema = z.object({
  scanId: z.string().min(1).optional(),
  origin,
  from: isoDateTime,
  until: isoDateTime,
  acceptedAt: isoDateTime,
}).strict();
export type QueuedScan = z.infer<typeof queuedScanSchema>;

/** `GET /api/mobile/intelligence/sources/gmail/scan` (email sources on). */
export const emailScanOverviewSchema = z.object({
  success: z.literal(true),
  manual: scanStatusSchema.nullable(),
  queuedManual: queuedScanSchema.nullable().optional(),
  daily: dailyStatusSchema.nullable(),
}).strict();
export type EmailScanOverview = z.infer<typeof emailScanOverviewSchema>;

/** `POST …/gmail/scan` with `m5: true`. Extra base fields are tolerated (the base answer's `messagesRead`, `observations`). */
export const emailScanPostSchema = z.object({
  success: z.literal(true),
  scan: scanStatusSchema,
  queuedManual: queuedScanSchema.nullable().optional(),
}).passthrough();

/* ── added from email ────────────────────────────────────────────────── */

export const addedItemSchema = z.object({
  autoAddId: z.string().min(1),
  commitmentId: z.string().min(1),
  title: z.string(),
  startsAt: isoDateTime.nullable(),
  evidence: z.string(),
  at: isoDateTime,
  status: z.enum(['open', 'done', 'dropped', 'archived']),
  removable: z.boolean(),
}).strict();
export type AddedItem = z.infer<typeof addedItemSchema>;

export const addedPageSchema = z.object({
  success: z.literal(true),
  items: z.array(addedItemSchema),
  nextCursor: z.string().nullable(),
}).strict();
export type AddedPage = z.infer<typeof addedPageSchema>;

export const addedRemovedSchema = z.object({ success: z.literal(true) }).strict();
