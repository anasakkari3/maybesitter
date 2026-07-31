import type { PrivacySafeAnalyticsEvent } from '../../src/contracts/v1/analyticsEventContracts';
import { applyUserDeletion, requireValidAnalyticsEvent } from './privacySafeEvents';

let events: PrivacySafeAnalyticsEvent[] = [];

export function appendAnalyticsEvent(value: unknown): PrivacySafeAnalyticsEvent {
  const event = requireValidAnalyticsEvent(value);
  events = [...events, event];
  if (event.eventName === 'data_deleted') events = applyUserDeletion(events, event.anonymousUserId);
  return event;
}

export function getAnalyticsEvents(): PrivacySafeAnalyticsEvent[] {
  return events.map((event) => ({ ...event, properties: { ...event.properties } }));
}

export function resetAnalyticsEventsForTests(): void {
  events = [];
}
