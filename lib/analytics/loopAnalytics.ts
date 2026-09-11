import type { DomainState } from '../../src/domain/stateMachine';
import type { AnalyticsEventName, PrivacySafeAnalyticsEvent } from '../../src/contracts/v1/analyticsEventContracts';
import { NEXT_STEP_ARMS } from '../../src/contracts/v1/experimentContracts';
import { resolveNextStepArm } from '../experiments/experimentControls';
import { emitAnalyticsEvent, type AnalyticsContext } from './analyticsContext';

/**
 * Every recorder here is async since UC-1.0c (#142): an event is a storage
 * write under `users/{uid}/analyticsEvents`, and it is awaited rather than
 * fired and forgotten so the funnel report cannot be quietly short.
 */

/**
 * Event names a client surface may report directly. Loop-state events are derived from
 * domain state on the server so a caller cannot forge activation or funnel progress.
 */
export const CLIENT_REPORTABLE_EVENTS = [
  'reason_opened', 'calendar_connect_started', 'calendar_connected',
  'pricing_viewed', 'purchase_intent', 'data_deleted',
  // Self-reported utility and invasiveness for the V03 arm experiment.
  'recommendation_rated',
  // Phone-presence loop events are observed by the client but carry only scalar,
  // content-free context. Server-side validation rejects raw content keys.
  'voice_capture_started', 'voice_capture_completed', 'voice_capture_abandoned',
  'widget_impression', 'widget_tap', 'deep_link_opened',
  // Presence, intake, and awareness signals the device observes and the server
  // cannot. All content-free; server-side validation still rejects raw content
  // keys. None of them feed activation or retention -- those stay derived from
  // domain state so a client cannot forge funnel progress.
  'widget_snapshot_published',
  'source_intake_reviewed', 'source_intake_confirmed',
  'pilot_feedback_submitted', 'soft_awareness_action', 'soft_awareness_missed',
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
 *
 * The awaits are sequential on purpose: these events are a funnel, and writing
 * them in order is what lets a plain listing read back as one.
 */
export async function recordCaptureAnalytics(
  context: AnalyticsContext,
  input: CaptureAnalyticsInput,
): Promise<PrivacySafeAnalyticsEvent[]> {
  const events: (PrivacySafeAnalyticsEvent | null)[] = [
    await emitAnalyticsEvent(context, 'capture_submitted', { inputLength: input.inputLength, locale: input.locale }),
  ];
  for (const [commitmentId, commitment] of Object.entries(input.after.commitments)) {
    const previous = input.before.commitments[commitmentId];
    if (!previous) {
      events.push(await emitAnalyticsEvent(context, 'commitment_detected', { commitmentId, detectionSource: input.detectionSource }));
    }
    if (commitment.confirmedAt && previous?.confirmedAt !== commitment.confirmedAt) {
      events.push(await emitAnalyticsEvent(context, 'commitment_confirmed', { commitmentId }));
    }
  }
  return emitted(events);
}

/** Counts the fields an edit actually changed, so the event carries a shape rather than content. */
export function changedFieldCount(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): number {
  if (!before || !after) return 0;
  return Object.keys({ ...before, ...after }).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).length;
}

export async function recordCommitmentEdited(
  context: AnalyticsContext,
  commitmentId: string,
  fields: number,
): Promise<PrivacySafeAnalyticsEvent | null> {
  return emitAnalyticsEvent(context, 'commitment_edited', { commitmentId, changedFieldCount: fields });
}

export async function recordDataDeleted(
  context: AnalyticsContext,
  deletionScope: string,
): Promise<PrivacySafeAnalyticsEvent | null> {
  return emitAnalyticsEvent(context, 'data_deleted', { deletionScope });
}

export async function recordFirstValueReached(
  context: AnalyticsContext,
  properties: { surface: string; reason: string },
): Promise<PrivacySafeAnalyticsEvent | null> {
  return emitAnalyticsEvent(context, 'first_value_reached', properties);
}

export async function recordClientEvent(
  context: AnalyticsContext,
  eventName: ClientReportableEvent,
  properties: PrivacySafeAnalyticsEvent['properties'],
): Promise<PrivacySafeAnalyticsEvent | null> {
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
