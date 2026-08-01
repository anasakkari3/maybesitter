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
