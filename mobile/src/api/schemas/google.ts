import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * The Google connection (CL6a): one grant, three features — Calendar busy
 * time, a bounded Gmail read, one picked Drive file.
 *
 * Every schema here is checked against `google.*.json`, which
 * `tests/mobile/exportMobileApiFixtures.test.ts` records from the real
 * handlers against a fake Google. Read the route or the fixture, not this
 * comment, when they disagree.
 *
 * The Gmail scan and the Drive import answer with the share proposal
 * (`shareProposalSchema`), so the review screen reads them unchanged.
 */
export const GOOGLE_FEATURES = ['calendar', 'gmail', 'drive'] as const;
export type GoogleFeature = (typeof GOOGLE_FEATURES)[number];

/**
 * `not_configured` until the owner has put the OAuth client in Secret Manager.
 * The four states are the whole vocabulary: a new one is a contract change,
 * and a `ContractError` is the right answer to it.
 */
export const googleStatusSchema = z.object({
  status: z.enum(['not_configured', 'not_connected', 'connected', 'needs_reauth']),
  /** The address the person connected. Shown on the row; never a token. */
  accountEmail: z.string().nullable(),
  features: z.object({ calendar: z.boolean(), gmail: z.boolean(), drive: z.boolean() }).strict(),
  /** Drive also needs the owner's Picker key. */
  pickerAvailable: z.boolean(),
  connectedAt: isoDateTime.nullable(),
}).strict();

export type GoogleStatus = z.infer<typeof googleStatusSchema>;

export const googleStatusResponseSchema = z.object({
  success: z.literal(true),
  google: googleStatusSchema,
});

export const googleConnectStartedSchema = z.object({
  success: z.literal(true),
  /** Opened in an auth session. Holds the state; never a secret. */
  authorizationUrl: z.string().url(),
  expiresAt: isoDateTime,
  /** What the auth session waits for. */
  returnUrl: z.string(),
});

export type GoogleConnectStarted = z.infer<typeof googleConnectStartedSchema>;

export const googleDisconnectedSchema = z.object({
  success: z.literal(true),
  disconnected: z.boolean(),
  google: googleStatusSchema,
});

export const googleCalendarSyncedSchema = z.object({
  success: z.literal(true),
  blocks: z.number().int().nonnegative(),
  source: z.object({
    sourceId: z.string(),
    lastSyncedAt: isoDateTime,
    windowStart: isoDateTime,
    windowEnd: isoDateTime,
  }),
});

/**
 * Six fields per block and nothing else — no title, no attendee — the same
 * guarantee the phone's own busy blocks carry. `.strict()` so a response that
 * ever carried more fails here instead of reaching a screen.
 */
export const googleBusyBlockSchema = z.object({
  blockId: z.string(),
  sourceId: z.string(),
  sourceKind: z.literal('google'),
  startAt: isoDateTime,
  endAt: isoDateTime,
  allDay: z.boolean(),
}).strict();

export type GoogleBusyBlock = z.infer<typeof googleBusyBlockSchema>;

export const googleCalendarBlocksSchema = z.object({
  success: z.literal(true),
  blocks: z.array(googleBusyBlockSchema),
  /**
   * The last sync's honest window (M4a, WIRE "Google busy window"): null when
   * nothing was ever synced. Optional so an older server still parses; the app
   * then treats Google as covering nothing.
   */
  windowStart: isoDateTime.nullable().optional(),
  windowEnd: isoDateTime.nullable().optional(),
});

export const googlePickerTicketSchema = z.object({
  success: z.literal(true),
  /** A one-time, two-minute page link. Holds a ticket, never a token. */
  pickerUrl: z.string().url(),
  expiresAt: isoDateTime,
  returnUrl: z.string(),
});

export type GooglePickerTicket = z.infer<typeof googlePickerTicketSchema>;

/**
 * Every refusal the Google routes give, by `reason` (`GOOGLE_REFUSAL_STATUS`
 * in `lib/integrations/google/googleConnectService.ts`, plus the calendar
 * consent refusal). All of them are prefixed or specific enough that no other
 * route's body can match this schema by accident.
 */
export const GOOGLE_REFUSAL_REASONS = [
  'provider_not_configured',
  'google_not_connected',
  'google_reauth_required',
  'google_feature_not_granted',
  'google_account_mismatch',
  'google_permission_not_granted',
  'google_access_denied',
  'google_state_invalid',
  'google_unavailable',
  'google_picker_unavailable',
  'google_file_unsupported',
  'google_file_too_large',
  'ai_consent_required',
  'calendar_consent_required',
] as const;

export type GoogleRefusalReason = (typeof GOOGLE_REFUSAL_REASONS)[number];

export const googleRefusalSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  reason: z.enum(GOOGLE_REFUSAL_REASONS),
}).strict();
