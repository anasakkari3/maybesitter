import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const ANALYTICS_EVENT_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;

export const ANALYTICS_EVENT_NAMES = [
  'capture_submitted', 'commitment_detected', 'commitment_confirmed', 'commitment_edited',
  'recommendation_shown', 'recommendation_accepted', 'recommendation_edited',
  'recommendation_deferred', 'recommendation_dismissed', 'recommendation_completed',
  'reason_opened', 'calendar_connect_started', 'calendar_connected', 'data_deleted',
  'pricing_viewed', 'purchase_intent',
  // Additive V03 extension: self-reported utility and invasiveness for a shown proposal.
  'recommendation_rated',
  // Additive C05 extension: first pilot value loop surface signals.
  'voice_capture_started', 'voice_capture_completed', 'voice_capture_abandoned',
  'widget_impression', 'widget_tap', 'deep_link_opened', 'first_value_reached',
  // Additive C05-C10 extension. widget_snapshot_published is the app writing a
  // snapshot; widget_impression stays reserved for the widget reporting that it
  // actually rendered, so a write is never counted as a sighting.
  'widget_snapshot_published',
  'source_intake_reviewed', 'source_intake_confirmed',
  'pilot_feedback_submitted', 'soft_awareness_action', 'soft_awareness_missed',
  // Additive UC-2.R1 (#171): the app reporting that somebody finished
  // onboarding. Content-free by construction — it carries no properties at
  // all — and it is only ever sent when analytics consent was granted on
  // the consent screen it is reporting the end of.
  'onboarding_completed',
  // Additive UC-2.R2 (#172): the rest of the capture funnel. `capture_submitted`
  // was already named above; these are the two steps after it.
  //
  // `capture_confirmed` is derived on the server from committed domain state —
  // the count of items that are actually confirmed in the user's own state
  // after the confirm — because a funnel step a client could report is a
  // funnel step a client could forge. `capture_undone` is the exception, and
  // only because nothing on the server can see it: the undo happens inside a
  // five-second window on the device and may delete nothing at all. Both carry
  // counts and nothing else.
  'capture_confirmed', 'capture_undone',
] as const;

export type AnalyticsEventName = typeof ANALYTICS_EVENT_NAMES[number];

export interface PrivacySafeAnalyticsEvent {
  version: typeof ANALYTICS_EVENT_CONTRACT_VERSION;
  eventId: string;
  eventName: AnalyticsEventName;
  occurredAt: string;
  anonymousUserId: string;
  cohortId: string;
  experiment: { experimentId: string; arm: string } | null;
  consent: 'granted' | 'essential';
  properties: Record<string, string | number | boolean | null>;
}

export interface AnalyticsValidationResult {
  valid: boolean;
  errors: string[];
}
