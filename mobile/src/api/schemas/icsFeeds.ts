import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * Subscribed calendar feeds (UC-3.4, #188), as `/api/mobile/calendar/ics`
 * answers them.
 *
 * ── What is not here ─────────────────────────────────────────────
 *
 * The feed URL. The server stores it encrypted and never returns it — a Moodle
 * export link carries `authtoken=` and is a password — and these schemas are
 * `.strict()` so a response that ever started carrying `url`, a host or a host
 * hash fails the fixture test in CI rather than reaching the phone's cache.
 * The phone holds the URL only in the text field, only until the subscribe
 * call returns.
 */

export const icsFeedStatusSchema = z.enum(['ok', 'error', 'paused']);

export const icsFeedSchema = z.object({
  feedId: z.string(),
  label: z.string().nullable(),
  autoAcceptDeadlines: z.boolean(),
  status: icsFeedStatusSchema,
  consecutiveFailures: z.number().int().nonnegative(),
  lastErrorCode: z.string().nullable(),
  lastFetchedAt: isoDateTime.nullable(),
  nextFetchAt: isoDateTime,
  busyBlocks: z.number().int().nonnegative(),
  pendingDeadlines: z.number().int().nonnegative(),
}).strict();

export const icsDeadlineSchema = z.object({
  itemKey: z.string(),
  feedId: z.string(),
  title: z.string(),
  dueAt: isoDateTime,
  allDay: z.boolean(),
  state: z.enum(['pending', 'accepted', 'rejected', 'withdrawn']),
  notice: z.enum(['moved', 'removed']).nullable(),
  proposedDueAt: isoDateTime.nullable(),
  commitmentId: z.string().nullable(),
  autoAccepted: z.boolean(),
}).strict();

export type IcsFeed = z.infer<typeof icsFeedSchema>;
export type IcsDeadline = z.infer<typeof icsDeadlineSchema>;

export const icsFeedListSchema = z.object({
  success: z.literal(true),
  feeds: z.array(icsFeedSchema),
  deadlines: z.array(icsDeadlineSchema),
}).strict();

export const icsFeedCreatedSchema = z.object({
  success: z.literal(true),
  feed: icsFeedSchema,
  preview: z.object({
    deadlines: z.number().int().nonnegative(),
    busyBlocks: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const icsFeedUpdatedSchema = z.object({
  success: z.literal(true),
  feed: icsFeedSchema,
}).strict();

export const icsFeedRefreshedSchema = z.object({
  success: z.boolean(),
  outcome: z.enum(['updated', 'not_modified', 'failed', 'kms_retry', 'paused']),
  feed: icsFeedSchema,
}).strict();

export const icsFeedDeletedSchema = z.object({
  success: z.literal(true),
  busyBlocks: z.number().int().nonnegative(),
  proposals: z.number().int().nonnegative(),
}).strict();

export const icsDeadlineDecidedSchema = z.object({
  success: z.literal(true),
  deadline: icsDeadlineSchema,
  replayed: z.boolean(),
}).strict();

/** Every refusal code the feed routes answer with. */
export const ICS_FEED_REASONS = [
  'feature_disabled',
  'invalid_request',
  'invalid_url',
  'too_many_feeds',
  'feed_not_found',
  'item_not_found',
  'refresh_too_soon',
  'fetch_failed',
  'not_a_calendar',
  'calendar_too_complex',
  'invalid_action',
  'past_due',
  'encryption_unavailable',
] as const;

export type IcsFeedReason = (typeof ICS_FEED_REASONS)[number];

export const icsFeedRefusalSchema = z.object({
  success: z.literal(false),
  error: z.enum(ICS_FEED_REASONS),
  reason: z.enum(ICS_FEED_REASONS),
  detail: z.string().optional(),
}).strict();

export type IcsDeadlineAction = 'accept' | 'dismiss' | 'undo' | 'apply_move' | 'acknowledge';
