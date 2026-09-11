import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';
import { analyticsContextFrom, buildAnalyticsEvent, emitAnalyticsEvent } from '../../lib/analytics/analyticsContext.ts';
import { appendAnalyticsEvent, getAnalyticsEvents, resetAnalyticsEventsForTests } from '../../lib/analytics/eventStore.ts';
import {
  CLIENT_REPORTABLE_EVENTS,
  changedFieldCount,
  isClientReportableEvent,
  recordClientEvent,
  recordCaptureAnalytics,
  recordCommitmentEdited,
  recordDataDeleted,
  recordFirstValueReached,
} from '../../lib/analytics/loopAnalytics.ts';
import { validateAnalyticsEvent } from '../../lib/analytics/privacySafeEvents.ts';
import { buildProductMetricsReport } from '../../lib/analytics/productMetrics.ts';

const NOW = new Date('2026-08-31T09:00:00.000Z');

function commitment(id: string, overrides: Partial<Commitment> = {}): Commitment {
  return {
    id, kind: 'task', title: 'Call Maya', description: null, person: null, status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: '2026-08-31T10:00:00.000Z', remindAt: null, timezone: 'UTC' },
    currentAckState: 'aware', postponedUntil: null, createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z', confirmedAt: null, completedAt: null, droppedAt: null,
    ...overrides,
  };
}

function stateWith(...items: Commitment[]): DomainState {
  return { ...createEmptyDomainState(), commitments: Object.fromEntries(items.map((item) => [item.id, item])) };
}

function context(consent: 'granted' | 'essential' = 'granted') {
  return { anonymousUserId: 'loop-user', consent, now: NOW, emit: appendAnalyticsEvent };
}

test('analytics: capture wiring derives detection and confirmation from domain state', async () => {
  await resetAnalyticsEventsForTests();
  const before = stateWith(commitment('c0', { confirmedAt: '2026-08-30T00:00:00.000Z' }));
  const after = stateWith(
    commitment('c0', { confirmedAt: '2026-08-30T00:00:00.000Z' }),
    commitment('c1', { confirmedAt: NOW.toISOString() }),
    commitment('c2'),
  );
  const events = await recordCaptureAnalytics(context(), { inputLength: 24, locale: 'en', detectionSource: 'rule-based', before, after });

  assert.deepEqual(events.map((event) => event.eventName), ['capture_submitted', 'commitment_detected', 'commitment_confirmed', 'commitment_detected']);
  assert.deepEqual(events[0].properties, { inputLength: 24, locale: 'en' });
  assert.deepEqual(events[1].properties, { commitmentId: 'c1', detectionSource: 'rule-based' });
  assert.deepEqual(events[2].properties, { commitmentId: 'c1' });
  for (const event of await getAnalyticsEvents()) assert.equal(validateAnalyticsEvent(event).valid, true);
});

test('analytics: capture events carry no raw captured text', async () => {
  await resetAnalyticsEventsForTests();
  await recordCaptureAnalytics(context(), {
    inputLength: 'Call Maya about the hospital results'.length, locale: 'en', detectionSource: 'rule-based',
    before: createEmptyDomainState(), after: stateWith(commitment('c1')),
  });
  assert.doesNotMatch(JSON.stringify(await getAnalyticsEvents()), /Maya|hospital|Call/i);
});

test('analytics: loop events require analytics consent but a deletion receipt does not', async () => {
  await resetAnalyticsEventsForTests();
  const withoutConsent = context('essential');
  await recordCaptureAnalytics(withoutConsent, { inputLength: 5, locale: 'en', detectionSource: 'rule-based', before: createEmptyDomainState(), after: stateWith(commitment('c1')) });
  assert.equal((await getAnalyticsEvents()).length, 0);

  assert.equal(await recordCommitmentEdited(withoutConsent, 'c1', 2), null);
  const deletion = await recordDataDeleted(withoutConsent, 'all_commitments');
  assert.equal(deletion?.eventName, 'data_deleted');
  assert.deepEqual((await getAnalyticsEvents()).map((event) => event.eventName), ['data_deleted']);
});

test('analytics: a deletion receipt purges that user history and leaves other users intact', async () => {
  await resetAnalyticsEventsForTests();
  await recordCaptureAnalytics(context(), { inputLength: 5, locale: 'en', detectionSource: 'rule-based', before: createEmptyDomainState(), after: stateWith(commitment('c1')) });
  await emitAnalyticsEvent({ ...context(), anonymousUserId: 'other-user' }, 'pricing_viewed', { surface: 'paywall' });
  await recordDataDeleted(context(), 'all_commitments');

  const remaining = await getAnalyticsEvents();
  assert.deepEqual(remaining.filter((event) => event.anonymousUserId === 'loop-user').map((event) => event.eventName), ['data_deleted']);
  assert.equal(remaining.filter((event) => event.anonymousUserId === 'other-user').length, 1);
});

test('analytics: experiment assignment is stable per user and split across arms', () => {
  const arms = new Set<string>();
  for (const anonymousUserId of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8']) {
    const first = buildAnalyticsEvent({ ...context(), anonymousUserId }, 'pricing_viewed', { surface: 'paywall' });
    const second = buildAnalyticsEvent({ ...context(), anonymousUserId }, 'purchase_intent', { priceCents: 900, currency: 'USD' });
    assert.deepEqual(first.experiment, second.experiment);
    assert.equal(first.cohortId, '2026-W36');
    arms.add(first.experiment!.arm);
  }
  assert.equal(arms.size, 2);
});

test('analytics: forged loop events are not client-reportable and bad payloads are rejected at build time', () => {
  for (const name of ['capture_submitted', 'commitment_confirmed', 'recommendation_accepted', 'first_value_reached']) {
    assert.equal(isClientReportableEvent(name), false);
  }
  for (const name of CLIENT_REPORTABLE_EVENTS) assert.equal(isClientReportableEvent(name), true);
  assert.throws(() => buildAnalyticsEvent(context(), 'pricing_viewed', { rawMessage: 'private' }), /not allowed|forbidden/);
  assert.throws(() => buildAnalyticsEvent({ ...context(), anonymousUserId: 'bad id!' }, 'pricing_viewed', { surface: 'paywall' }), /valid user/);
});

test('analytics: phone-presence client events are privacy-safe and reportable', async () => {
  await resetAnalyticsEventsForTests();
  const event = await recordClientEvent(context(), 'voice_capture_completed', {
    source: 'widget',
    locale: 'en-US',
    inputLength: 42,
    flagWidget: true,
    flagVoice: true,
    flagAwareness: false,
    flagWatch: false,
    flagImports: false,
  });

  assert.equal(event?.eventName, 'voice_capture_completed');
  assert.equal(validateAnalyticsEvent(event).valid, true);
  assert.throws(
    () => buildAnalyticsEvent(context(), 'voice_capture_completed', {
      rawText: 'call Maya',
      source: 'widget',
    }),
    /not allowed|forbidden/,
  );
  assert.throws(
    () => buildAnalyticsEvent(context(), 'widget_tap', {
      surface: 'homeWidget',
      targetRoute: '/capture?source=Call%20Maya%20about%20hospital&input=voice',
    }),
    /targetRoute is not canonical/,
  );
});

test('analytics: an absent anonymous id disables collection rather than failing the request', async () => {
  assert.equal(await analyticsContextFrom({}, appendAnalyticsEvent), null);
  assert.equal(await analyticsContextFrom({ anonymousUserId: '' }, appendAnalyticsEvent), null);
  assert.equal((await analyticsContextFrom({ anonymousUserId: 'u1' }, appendAnalyticsEvent))?.consent, 'essential');
});

/**
 * The last line of the test above used to assert that a caller claiming
 * `consent: 'granted'` was believed, because outside a configured pilot the
 * claim was passed straight through. UC-1.0e (#144) removed the environment
 * variable that decided "outside a configured pilot", and with it the
 * pass-through: a claim is not a consent, and consent is now read from the
 * user's own trust record or it is `essential`.
 */
test('analytics: a client-claimed consent is not believed without a trust record', async () => {
  const claimed = await analyticsContextFrom({ anonymousUserId: 'u1', consent: 'granted' }, appendAnalyticsEvent);
  assert.equal(claimed?.consent, 'essential');
});

test('analytics: changed field count reports edit shape without field values', () => {
  assert.equal(changedFieldCount({ title: 'a', person: null }, { title: 'b', person: null }), 1);
  assert.equal(changedFieldCount({ title: 'a' }, { title: 'a', priority: { level: 'high' } }), 1);
  assert.equal(changedFieldCount({ title: 'a' }, { title: 'a' }), 0);
  assert.equal(changedFieldCount(undefined, { title: 'a' }), 0);
});

test('analytics: live-wired events reconcile into the activation and funnel report', async () => {
  await resetAnalyticsEventsForTests();
  await recordCaptureAnalytics(context(), {
    inputLength: 24, locale: 'en', detectionSource: 'rule-based',
    before: createEmptyDomainState(), after: stateWith(commitment('c1', { confirmedAt: NOW.toISOString() })),
  });
  await emitAnalyticsEvent(context(), 'recommendation_shown', { proposalId: 'p1', commitmentId: 'c1', baselineVersion: 'v1' });
  await emitAnalyticsEvent(context(), 'recommendation_accepted', { proposalId: 'p1' });
  await recordFirstValueReached(context(), { surface: 'recommendation', reason: 'next_step_ready' });

  const report = buildProductMetricsReport(await getAnalyticsEvents(), new Date('2026-09-01T00:00:00.000Z'));
  assert.equal(report.totalUsers, 1);
  assert.equal(report.activatedUsers, 1);
  assert.equal(report.activationRate, 1);
  assert.deepEqual(report.activation, { denominator: 1, activated: 1, rate: 1 });
  assert.deepEqual(report.firstValue, { denominator: 1, reached: 1, rate: 1 });
  assert.deepEqual(report.funnel, {
    capture_submitted: 1, commitment_detected: 1, commitment_confirmed: 1,
    recommendation_shown: 1, recommendation_accepted: 1, recommendation_completed: 0,
  });
});
