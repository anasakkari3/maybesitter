import { randomUUID } from 'node:crypto';
import {
  ANALYTICS_EVENT_CONTRACT_VERSION,
  type AnalyticsEventName,
  type PrivacySafeAnalyticsEvent,
} from '../../src/contracts/v1/analyticsEventContracts';
import { assignExperiment, cohortFor, requireValidAnalyticsEvent } from './privacySafeEvents';

export const V02_EXPERIMENT_ID = 'v02-next-step';
export const V02_EXPERIMENT_ARMS = ['baseline', 'variant'] as const;

/** Events that may be recorded on essential consent alone, because suppressing them would hide a privacy action. */
const ESSENTIAL_CONSENT_EVENTS = new Set<AnalyticsEventName>(['data_deleted']);

export interface AnalyticsContext {
  anonymousUserId: string;
  consent: 'granted' | 'essential';
  now: Date;
  experimentId?: string;
  arms?: readonly string[];
  emit: (event: PrivacySafeAnalyticsEvent) => void;
}

/**
 * Builds a context from caller-supplied identity, or null when the caller sent no
 * anonymous id — analytics is then simply off for that request rather than an error.
 */
export function analyticsContextFrom(
  source: { anonymousUserId?: unknown; consent?: unknown },
  emit: (event: PrivacySafeAnalyticsEvent) => void,
  now = new Date(),
): AnalyticsContext | null {
  if (typeof source.anonymousUserId !== 'string' || !source.anonymousUserId) return null;
  return {
    anonymousUserId: source.anonymousUserId,
    consent: source.consent === 'granted' ? 'granted' : 'essential',
    now,
    emit,
  };
}

export function buildAnalyticsEvent(
  context: AnalyticsContext,
  eventName: AnalyticsEventName,
  properties: PrivacySafeAnalyticsEvent['properties'],
): PrivacySafeAnalyticsEvent {
  return requireValidAnalyticsEvent({
    version: ANALYTICS_EVENT_CONTRACT_VERSION,
    eventId: randomUUID(),
    eventName,
    occurredAt: context.now.toISOString(),
    anonymousUserId: context.anonymousUserId,
    cohortId: cohortFor(context.now),
    experiment: assignExperiment(context.anonymousUserId, context.experimentId || V02_EXPERIMENT_ID, context.arms || V02_EXPERIMENT_ARMS),
    consent: context.consent,
    properties,
  });
}

/** Builds, validates, and emits an event, or returns null when consent does not cover it. */
export function emitAnalyticsEvent(
  context: AnalyticsContext,
  eventName: AnalyticsEventName,
  properties: PrivacySafeAnalyticsEvent['properties'],
): PrivacySafeAnalyticsEvent | null {
  if (context.consent !== 'granted' && !ESSENTIAL_CONSENT_EVENTS.has(eventName)) return null;
  const event = buildAnalyticsEvent(context, eventName, properties);
  context.emit(event);
  return event;
}
