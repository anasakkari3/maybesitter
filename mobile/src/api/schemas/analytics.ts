import { z } from 'zod';

/**
 * Mirrors `analytics.ack.json`.
 *
 * The request is `{ eventName, properties }` — not the Flutter
 * `PilotLoopAnalyticsEvent` #157's table names. Each event name has its own
 * allowed property list on the server (`EVENT_PROPERTIES` in
 * `lib/analytics/privacySafeEvents.ts`) and anything else is a 400, which is
 * how raw content is kept out of analytics entirely.
 *
 * `recorded: false` is a success: it means the user has not granted analytics
 * consent, so nothing was written. The client must not treat that as an error.
 */
export const analyticsAckSchema = z.object({
  success: z.boolean(),
  participantId: z.string(),
  recorded: z.boolean(),
  eventId: z.string().nullable(),
});

/** The events the server accepts from a client. Anything else is refused. */
export const CLIENT_REPORTABLE_EVENTS = [
  'reason_opened',
  'calendar_connect_started',
  'calendar_connected',
  'pricing_viewed',
  'purchase_intent',
  'data_deleted',
  'recommendation_rated',
  'voice_capture_started',
  'voice_capture_completed',
  'voice_capture_abandoned',
  'widget_impression',
  'widget_tap',
  'deep_link_opened',
  'widget_snapshot_published',
  'source_intake_reviewed',
  'source_intake_confirmed',
  'pilot_feedback_submitted',
  'soft_awareness_action',
  'soft_awareness_missed',
  'onboarding_completed',
  // UC-2.R2 (#172). The only capture-funnel event a client may report:
  // `capture_submitted` and `capture_confirmed` are derived on the server from
  // committed domain state, so nothing here can claim activation progress.
  'capture_undone',
] as const;

export type ClientReportableEvent = (typeof CLIENT_REPORTABLE_EVENTS)[number];

/** Scalars only: an object or array here would be a way to smuggle content. */
export type AnalyticsProperties = Record<string, string | number | boolean | null>;
