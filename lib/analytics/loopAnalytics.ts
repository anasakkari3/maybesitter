import type { DomainState } from '../../src/domain/stateMachine';
import type { AnalyticsEventName, PrivacySafeAnalyticsEvent } from '../../src/contracts/v1/analyticsEventContracts';
import { NEXT_STEP_ARMS } from '../../src/contracts/v1/experimentContracts';
import { resolveNextStepArm } from '../experiments/experimentControls';
import { emitAnalyticsEvent, type AnalyticsContext } from './analyticsContext';

/**
 * Event names a client surface may report directly. Loop-state events are derived from
 * domain state on the server so a caller cannot forge activation or funnel progress.
 */
export const CLIENT_REPORTABLE_EVENTS = [
  'reason_opened', 'calendar_connect_started', 'calendar_connected',
  'pricing_viewed', 'purchase_intent', 'data_deleted',
  // Self-reported utility and invasiveness for the V03 arm experiment.
  'recommendation_rated',
] as const;

export type ClientReportableEvent = typeof CLIENT_REPORTABLE_EVENTS[number];

export function isClientReportableEvent(value: unknown): value is ClientReportableEvent {
  return CLIENT_REPORTABLE_EVENTS.includes(value as ClientReportableEvent);
}

export interface CaptureAnalyticsInput {
  /** Character count only — the captured text itself never reaches analytics. */
  inputLength: number;
  locale: string;
  detectionSource: string;
  before: DomainState;
  after: DomainState;
}

function emitted(events: readonly (PrivacySafeAnalyticsEvent | null)[]): PrivacySafeAnalyticsEvent[] {
  return events.filter((event): event is PrivacySafeAnalyticsEvent => event !== null);
}

/**
 * Derives the capture-side funnel events from the domain state a capture produced.
 * Detection and confirmation are read from committed state rather than from the caller.
 */
export function recordCaptureAnalytics(context: AnalyticsContext, input: CaptureAnalyticsInput): PrivacySafeAnalyticsEvent[] {
  const events: (PrivacySafeAnalyticsEvent | null)[] = [
    emitAnalyticsEvent(context, 'capture_submitted', { inputLength: input.inputLength, locale: input.locale }),
  ];
  for (const [commitmentId, commitment] of Object.entries(input.after.commitments)) {
    const previous = input.before.commitments[commitmentId];
    if (!previous) {
      events.push(emitAnalyticsEvent(context, 'commitment_detected', { commitmentId, detectionSource: input.detectionSource }));
    }
    if (commitment.confirmedAt && previous?.confirmedAt !== commitment.confirmedAt) {
      events.push(emitAnalyticsEvent(context, 'commitment_confirmed', { commitmentId }));
    }
  }
  return emitted(events);
}

/** Counts the fields an edit actually changed, so the event carries a shape rather than content. */
export function changedFieldCount(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): number {
  if (!before || !after) return 0;
  return Object.keys({ ...before, ...after }).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).length;
}

export function recordCommitmentEdited(context: AnalyticsContext, commitmentId: string, fields: number): PrivacySafeAnalyticsEvent | null {
  return emitAnalyticsEvent(context, 'commitment_edited', { commitmentId, changedFieldCount: fields });
}

export function recordDataDeleted(context: AnalyticsContext, deletionScope: string): PrivacySafeAnalyticsEvent | null {
  return emitAnalyticsEvent(context, 'data_deleted', { deletionScope });
}

export function recordClientEvent(
  context: AnalyticsContext,
  eventName: ClientReportableEvent,
  properties: PrivacySafeAnalyticsEvent['properties'],
): PrivacySafeAnalyticsEvent | null {
  if (eventName === 'recommendation_rated') {
    const assignment = resolveNextStepArm(context.anonymousUserId);
    if (!assignment.enabled) return null;
    return emitAnalyticsEvent(
      { ...context, experimentId: assignment.experimentId, arms: NEXT_STEP_ARMS },
      eventName,
      properties,
    );
  }
  return emitAnalyticsEvent(context, eventName as AnalyticsEventName, properties);
}
