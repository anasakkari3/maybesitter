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
  // Additive UC-3.10b (#195): what somebody did with the plan they were shown.
  //
  // Every one of these is content-free by construction — counts, a generation
  // number, and two small enumerations. No title, no item id, no explanation
  // text. The plan's item ids *are* commitment ids, so they are left out
  // altogether rather than allowlisted: "which commitments are in your morning"
  // is the shape of the thing this product does not collect.
  'plan_opened', 'plan_accepted', 'plan_edited', 'plan_regenerated', 'plan_dismissed',
  // Additive UC-3.17 (#469). How many of the five setup questions were
  // answered — a count, never the answers. What somebody typed about their
  // work, their day or their habits is profile text and travels through the
  // describe/review flow, which needs confirmation; analytics gets a number.
  'onboarding_setup_answered',
  // Additive #519: the Seed lifecycle. Content-free by construction — a kind
  // from a closed set of four, a boolean, and which of two things a promotion
  // produced. The `summary` is the user's own sentence about something they
  // have not decided to do, which is the last thing that belongs in telemetry,
  // and `seedId`/`promotedTo` are left out altogether rather than allowlisted
  // for the reason the plan events leave item ids out: "which maybes does this
  // person have" is the shape of the thing this product does not collect.
  //
  // `seed_proposed` is counted on the server when a capture offers one, which
  // is why it carries a count rather than a kind: a proposal is not yet
  // anybody's seed.
  'seed_proposed', 'seed_confirmed', 'seed_snoozed', 'seed_promoted', 'seed_dismissed',
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
