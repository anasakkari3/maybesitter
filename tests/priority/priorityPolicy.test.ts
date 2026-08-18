/**
 * Default scoring policy specs (Sprint 04, #18).
 *
 * The default policy is not free configuration: it is the transcription of the
 * live `agendaScoring` weights. `agendaScoring` delegates to this scorer at
 * merge time, so a changed weight here silently reorders what users already
 * see. The literal table below is therefore asserted value by value — an edit
 * to a weight must turn this test red and be a deliberate decision.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRIORITY_POLICY, PRIORITY_POLICY_VERSION } from '../../lib/priority/priorityPolicy.ts';
import { scorePriority } from '../../lib/priority/priorityScorer.ts';
import { makeFeatures } from './priorityScorerFixtures.ts';

test('priorityPolicy: reason bands reproduce the live base scores', () => {
  assert.deepEqual(DEFAULT_PRIORITY_POLICY.reasonBase, {
    overdue: 7_000,
    due_soon: 5_000,
    active: 3_000,
    pending: 1_000,
  });
});

test('priorityPolicy: caps reproduce the live band and total caps', () => {
  assert.equal(DEFAULT_PRIORITY_POLICY.bandCap, 999);
  assert.equal(DEFAULT_PRIORITY_POLICY.totalCap, 9_999);
});

test('priorityPolicy: weights reproduce the live band components', () => {
  assert.deepEqual(DEFAULT_PRIORITY_POLICY.weights, {
    urgencyOverduePerHour: 6,
    urgencyOverdueMax: 420,
    urgencyDueSoonMax: 420,
    importanceHigh: 180,
    importanceNormal: 80,
    latenessPerSnooze: 90,
    latenessSnoozeMax: 270,
    latenessPostponed: 160,
    latenessDeferred: 80,
    userPressureRecent: 240,
    userPressureStale: 120,
  });
});

test('priorityPolicy: the band components can outrun the band cap, which is why the clamp is explicit', () => {
  const { weights, bandCap } = DEFAULT_PRIORITY_POLICY;
  const maximumBand =
    weights.urgencyOverdueMax +
    weights.importanceHigh +
    weights.latenessSnoozeMax +
    weights.latenessPostponed +
    weights.latenessDeferred +
    weights.userPressureRecent;

  assert.equal(maximumBand, 1_350);
  assert.ok(maximumBand > bandCap);
});

test('priorityPolicy: the policy is frozen, so a caller cannot mutate the defaults in place', () => {
  assert.ok(Object.isFrozen(DEFAULT_PRIORITY_POLICY));
  assert.ok(Object.isFrozen(DEFAULT_PRIORITY_POLICY.reasonBase));
  assert.ok(Object.isFrozen(DEFAULT_PRIORITY_POLICY.weights));
});

test('priorityPolicy: the version travels onto every score it produces', () => {
  const scored = scorePriority({
    features: makeFeatures(),
    reason: 'pending',
    policy: DEFAULT_PRIORITY_POLICY,
  });

  assert.equal(DEFAULT_PRIORITY_POLICY.version, PRIORITY_POLICY_VERSION);
  assert.equal(scored.policyVersion, PRIORITY_POLICY_VERSION);
});
