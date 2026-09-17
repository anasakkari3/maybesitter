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
  // UC-2.R1 (#171) and UC-2.R2 (#172): the two the React Native app sends.
  // `capture_undone` is the only capture-funnel event a client may report —
  // the other two are derived from committed domain state on the server.
  'onboarding_completed', 'capture_undone',
  // UC-3.10b (#195). What somebody did with the plan they were shown. Only the
  // device knows: the server stores a status, but "opened it" and "moved
  // something and was refused" leave no trace in domain state.
  'plan_opened', 'plan_accepted', 'plan_edited', 'plan_regenerated', 'plan_dismissed',
  // UC-3.17 (#469). How many of the five setup questions were answered — a
  // count, never the answers.
  'onboarding_setup_answered',
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

/**
 * Every name a client may report can be validated, not just the ones somebody
 * listed above.
 *
 * `MOBILE_EMITTED_EVENTS` is written by hand, and a hand-written list is one
 * somebody has to remember to add to. `EVENT_PROPERTIES` is looked up by event
 * name and then `.includes()`d, so a reportable name with no entry resolves to
 * `undefined` and the route 500s instead of answering — a failure the app sees
 * as "the analytics endpoint is broken", not as "that event is not allowed".
 *
 * (That the app's copy of this list and this one are the same list is asserted
 * in `tests/analytics/captureFunnelAnalytics.test.ts`.)
 */
test('every client-reportable event has a privacy allowlist, listed or not', () => {
  assert.ok(CLIENT_REPORTABLE_EVENTS.length >= MOBILE_EMITTED_EVENTS.length);
  for (const name of CLIENT_REPORTABLE_EVENTS) {
    assert.ok(
      (ANALYTICS_EVENT_NAMES as readonly string[]).includes(name),
      `${name} is client-reportable but unknown to the server contract`,
    );
    assert.doesNotThrow(
      () => validateAnalyticsEvent(analyticsEnvelope(name, {})),
      `validating ${name} threw instead of returning a verdict`,
    );
  }
});

function analyticsEnvelope(eventName: string, properties: Record<string, unknown>) {
  return {
    version: ANALYTICS_EVENT_CONTRACT_VERSION,
    eventId: '11111111-1111-4111-8111-111111111111',
    eventName,
    occurredAt: '2026-08-22T06:00:00.000Z',
    anonymousUserId: 'anon-1',
    cohortId: '2026-W34',
    experiment: null,
    consent: 'granted',
    properties,
  };
}

/**
 * The plan events (UC-3.10b, #195), validated with the properties the screen
 * actually sends.
 *
 * Declared here rather than read out of `EVENT_PROPERTIES`, which would be the
 * allowlist checking itself. The app's half of the same pair is asserted in
 * `mobile/src/features/plan/__tests__/planAnalytics.test.ts`, which reads this
 * repository's allowlist out of its source and holds the reporters against it
 * — so the two hand-written halves cannot drift from the one thing they
 * describe, in either direction.
 */
const PLAN_EVENT_PAYLOADS: Record<string, Record<string, string | number>> = {
  plan_opened: {
    generation: 1, scheduledCount: 3, unscheduledCount: 0,
    explanationSource: 'template', status: 'proposed',
  },
  plan_accepted: { generation: 1, scheduledCount: 3, unscheduledCount: 0 },
  plan_edited: { movedCount: 1, removedCount: 0, outcome: 'refused', reason: 'overlaps_fixed_event' },
  plan_regenerated: { generation: 2 },
  plan_dismissed: { generation: 1 },
};

test('the route accepts each plan event with the properties the screen sends', () => {
  for (const [eventName, properties] of Object.entries(PLAN_EVENT_PAYLOADS)) {
    const verdict = validateAnalyticsEvent(analyticsEnvelope(eventName, properties));
    assert.deepEqual(verdict, { valid: true, errors: [] }, `${eventName}: ${verdict.errors.join('; ')}`);
  }
});

test('the route refuses a plan event that tried to carry somebody\u2019s morning', () => {
  // The allowlist is what keeps a title or a commitment id out of analytics
  // even if a future screen passed one. A plan's `itemId` *is* a commitment
  // id, so a list of them is a list of what somebody committed to this
  // morning; `title` is refused twice over, once as un-allowlisted and once by
  // the private-key rule.
  for (const eventName of Object.keys(PLAN_EVENT_PAYLOADS)) {
    for (const smuggled of [
      { title: 'Call the bank' },
      { itemId: 'plan_fixture_0' },
      { explanationText: 'I placed 3 things between 09:00 and 10:30.' },
      { date: '2026-08-09' },
    ]) {
      const verdict = validateAnalyticsEvent(analyticsEnvelope(eventName, {
        ...PLAN_EVENT_PAYLOADS[eventName], ...smuggled,
      }));
      assert.equal(verdict.valid, false, `${eventName} accepted ${Object.keys(smuggled)[0]}`);
    }
  }
});

/**
 * The guided setup chat (UC-3.17, #469) reports one thing: how many of its
 * five questions got an answer. The answers themselves are profile text and
 * go through `POST /api/mobile/profile/describe`, never through analytics.
 */
test('the route accepts onboarding_setup_answered with a count and nothing else', () => {
  for (const answeredCount of [0, 3, 5]) {
    const verdict = validateAnalyticsEvent(analyticsEnvelope('onboarding_setup_answered', { answeredCount }));
    assert.deepEqual(verdict, { valid: true, errors: [] }, `answeredCount=${answeredCount}: ${verdict.errors.join('; ')}`);
  }
});

test('the route refuses onboarding_setup_answered that is not a count of 0-5', () => {
  for (const properties of [
    { answeredCount: 'three' },
    { answeredCount: 6 },
    { answeredCount: -1 },
    { answeredCount: 2.5 },
    { answeredCount: 3, work: 'nurse at the city hospital' },
    { answeredCount: 3, answers: 'x' },
  ]) {
    const verdict = validateAnalyticsEvent(analyticsEnvelope('onboarding_setup_answered', properties));
    assert.equal(verdict.valid, false, `accepted ${JSON.stringify(properties)}`);
  }
});
