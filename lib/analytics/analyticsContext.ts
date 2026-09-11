import { randomUUID } from 'node:crypto';
import { resolvePilotAnalyticsConsent } from '../pilot/pilotAccess';
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
  /**
   * Async since UC-1.0c (#142): recording an event is a storage write. It is
   * awaited rather than fired and forgotten, because an event that is only
   * probably recorded makes the activation and funnel report unfalsifiable —
   * a low number could be the product or could be dropped writes.
   *
   * `Promise<unknown>` rather than `Promise<void>` so the real implementation,
   * `appendAnalyticsEvent`, can keep returning the event it stored: a
   * `Promise<PrivacySafeAnalyticsEvent>` is not assignable to `Promise<void>`.
   */
  emit: (event: PrivacySafeAnalyticsEvent) => void | Promise<unknown>;
}

/**
 * Builds a context from caller-supplied identity, or null when the caller sent no
 * anonymous id — analytics is then simply off for that request rather than an error.
 */
export async function analyticsContextFrom(
  source: { anonymousUserId?: unknown; consent?: unknown },
  emit: (event: PrivacySafeAnalyticsEvent) => void | Promise<unknown>,
  now = new Date(),
): Promise<AnalyticsContext | null> {
  if (typeof source.anonymousUserId !== 'string' || !source.anonymousUserId) return null;
  return {
    anonymousUserId: source.anonymousUserId,
    // Async since UC-1.0b (#141): derived consent is read from durable storage.
    consent: await resolvePilotAnalyticsConsent(
      source.anonymousUserId,
      source.consent === 'granted' ? 'granted' : 'essential',
    ),
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
export async function emitAnalyticsEvent(
  context: AnalyticsContext,
  eventName: AnalyticsEventName,
  properties: PrivacySafeAnalyticsEvent['properties'],
): Promise<PrivacySafeAnalyticsEvent | null> {
  if (context.consent !== 'granted' && !ESSENTIAL_CONSENT_EVENTS.has(eventName)) return null;
  const event = buildAnalyticsEvent(context, eventName, properties);
  await context.emit(event);
  return event;
}
