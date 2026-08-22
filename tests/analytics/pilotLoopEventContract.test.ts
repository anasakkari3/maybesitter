import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYTICS_EVENT_CONTRACT_VERSION,
  ANALYTICS_EVENT_NAMES,
} from '../../src/contracts/v1/analyticsEventContracts';
import { CLIENT_REPORTABLE_EVENTS, isClientReportableEvent } from '../../lib/analytics/loopAnalytics';
import { validateAnalyticsEvent } from '../../lib/analytics/privacySafeEvents';

// Every event the mobile app can emit must be nameable by the server, or the
// analytics endpoint rejects it and the pilot measures nothing.
const MOBILE_EMITTED_EVENTS = [
  'voice_capture_started', 'voice_capture_completed', 'voice_capture_abandoned',
  'widget_snapshot_published', 'widget_impression', 'widget_tap',
  'deep_link_opened', 'calendar_connect_started', 'calendar_connected',
  'source_intake_reviewed', 'source_intake_confirmed',
  'pilot_feedback_submitted', 'soft_awareness_action', 'soft_awareness_missed',
] as const;

test('every event the mobile app emits is a known analytics event', () => {
  for (const name of MOBILE_EMITTED_EVENTS) {
    assert.ok(
      (ANALYTICS_EVENT_NAMES as readonly string[]).includes(name),
      `${name} is emitted by the app but unknown to the server contract`,
    );
  }
});

test('every event the mobile app emits is accepted from a client', () => {
  for (const name of MOBILE_EMITTED_EVENTS) {
    assert.ok(
      isClientReportableEvent(name),
      `${name} is emitted by the app but would be rejected as non-client-reportable`,
    );
  }
});

test('a published snapshot is a distinct event from a widget impression', () => {
  assert.ok((ANALYTICS_EVENT_NAMES as readonly string[]).includes('widget_snapshot_published'));
  assert.ok((ANALYTICS_EVENT_NAMES as readonly string[]).includes('widget_impression'));
});

test('every event the mobile app emits has a privacy allowlist', () => {
  // validateAnalyticsEvent looks the event name up in its allowlist and calls
  // .includes() on the result. An event the app emits but the allowlist has
  // never heard of resolves to undefined, so the lookup throws rather than
  // rejecting — the endpoint 500s instead of answering.
  for (const name of MOBILE_EMITTED_EVENTS) {
    const event = {
      version: ANALYTICS_EVENT_CONTRACT_VERSION,
      eventId: '11111111-1111-4111-8111-111111111111',
      eventName: name,
      occurredAt: '2026-08-22T06:00:00.000Z',
      anonymousUserId: 'anon-1',
      cohortId: '2026-W34',
      experiment: null,
      consent: 'granted',
      properties: {},
    };
    assert.doesNotThrow(
      () => validateAnalyticsEvent(event),
      `validating ${name} threw instead of returning a verdict`,
    );
  }
});

test('the properties the app actually sends survive privacy validation', () => {
  // Property names taken from the factory constructors in
  // mobile/lib/models/pilot_loop_analytics.dart.
  const samples: Record<string, Record<string, string | number | boolean>> = {
    source_intake_reviewed: { importSource: 'clipboard', characterCount: 42 },
    source_intake_confirmed: { importSource: 'clipboard', characterCount: 42 },
    pilot_feedback_submitted: {
      feedbackSurface: 'settings', usefulness: 3, annoyance: 2, timing: 4,
    },
    soft_awareness_action: { action: 'acknowledged' },
    soft_awareness_missed: { outcome: 'expired' },
  };

  for (const [name, properties] of Object.entries(samples)) {
    const result = validateAnalyticsEvent({
      version: ANALYTICS_EVENT_CONTRACT_VERSION,
      eventId: '11111111-1111-4111-8111-111111111111',
      eventName: name,
      occurredAt: '2026-08-22T06:00:00.000Z',
      anonymousUserId: 'anon-1',
      cohortId: '2026-W34',
      experiment: null,
      consent: 'granted',
      properties: { ...properties, flagWidget: true, flagVoice: false, flagAwareness: true, flagWatch: false, flagImports: true },
    });
    assert.deepEqual(result.errors, [], `${name} was rejected: ${result.errors.join('; ')}`);
    assert.equal(result.valid, true);
  }
});

test('first value stays server-observed and is never client-reportable', () => {
  // The client rendering something is not evidence the user got value from it.
  assert.ok((ANALYTICS_EVENT_NAMES as readonly string[]).includes('first_value_reached'));
  assert.equal(
    (CLIENT_REPORTABLE_EVENTS as readonly string[]).includes('first_value_reached'),
    false,
  );
});
