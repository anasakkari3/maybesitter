import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyUserDeletion, assignExperiment, cohortFor, validateAnalyticsEvent } from '../../lib/analytics/privacySafeEvents.ts';
import { buildProductMetricsReport } from '../../lib/analytics/productMetrics.ts';

const events = readFileSync('evaluation-data/v02-analytics-events.jsonl', 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('analytics: fixture events validate and contain no raw private content fields', () => {
  for (const event of events) assert.equal(validateAnalyticsEvent(event).valid, true);
  assert.doesNotMatch(JSON.stringify(events), /rawMessage|messageText|description|person|email/i);
});

test('analytics: unknown and private payload fields are rejected', () => {
  const base = events[0];
  assert.equal(validateAnalyticsEvent({ ...base, surprise: true }).valid, false);
  assert.equal(validateAnalyticsEvent({ ...base, properties: { ...base.properties, rawMessage: 'private' } }).valid, false);
  assert.equal(validateAnalyticsEvent({ ...base, consent: 'essential' }).valid, false);
});

test('analytics: cohort and experiment assignment are reproducible', () => {
  assert.deepEqual(assignExperiment('user-1', 'exp-1', ['baseline', 'variant']), assignExperiment('user-1', 'exp-1', ['baseline', 'variant']));
  assert.equal(cohortFor(new Date('2026-06-01T12:00:00Z')), '2026-W23');
});

test('analytics: deletion removes user history while retaining the deletion receipt', () => {
  const after = applyUserDeletion(events, 'u2');
  assert.equal(after.filter((event) => event.anonymousUserId === 'u2').length, 1);
  assert.equal(after.find((event) => event.anonymousUserId === 'u2')?.eventName, 'data_deleted');
});

test('analytics: activation, funnel, retention, and consent metrics reconcile', () => {
  const report = buildProductMetricsReport(events, new Date('2026-08-15T00:00:00Z'));
  assert.equal(report.totalUsers, 2);
  assert.equal(report.activatedUsers, 1);
  assert.equal(report.activationRate, 0.5);
  assert.deepEqual(report.funnel, { capture_submitted: 2, commitment_detected: 1, commitment_confirmed: 1, recommendation_shown: 1, recommendation_accepted: 1, recommendation_completed: 1 });
  assert.deepEqual(report.retention, { week4Eligible: 2, week4Retained: 1, week4Rate: 0.5, week8Eligible: 2, week8Retained: 0, week8Rate: 0 });
  assert.equal(report.consent.deletions, 1);
});
