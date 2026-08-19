import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_EVENT_NAMES } from '../../src/contracts/v1/analyticsEventContracts';
import { CLIENT_REPORTABLE_EVENTS, isClientReportableEvent } from '../../lib/analytics/loopAnalytics';

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

test('first value stays server-observed and is never client-reportable', () => {
  // The client rendering something is not evidence the user got value from it.
  assert.ok((ANALYTICS_EVENT_NAMES as readonly string[]).includes('first_value_reached'));
  assert.equal(
    (CLIENT_REPORTABLE_EVENTS as readonly string[]).includes('first_value_reached'),
    false,
  );
});
