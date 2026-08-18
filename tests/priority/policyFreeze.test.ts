/**
 * The shipped priority policy is frozen for Sprint 05.
 *
 * Sprint 05 builds calibration machinery but has no judgments to calibrate
 * against: Sprint 04 shipped the corpus empty precisely so the product's
 * ranking could not be fitted to preferences nobody expressed. The machinery
 * therefore runs only on judgments marked `synthetic_pipeline_proof`, and its
 * output is a report rather than a config.
 *
 * That separation cannot rest on the discipline of whoever runs the pipeline,
 * because weights fitted to invented judgments look exactly like weights fitted
 * to real ones — there is nothing in a tuned number that says where it came
 * from. So the boundary is a test.
 *
 * This file is owned centrally rather than by the calibration track, for the
 * same reason an auditor does not report to the department being audited.
 *
 * **If this test fails, do not update it to match.** A change here means the
 * shipped weights moved. Either that was unintended — in which case the change
 * is the defect — or it was deliberate, in which case editing this file is the
 * point: it forces the new numbers, and the evidence for them, through review
 * rather than letting them arrive as an unremarkable diff in a data file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PRIORITY_POLICY, PRIORITY_POLICY_VERSION } from '../../lib/priority/priorityPolicy.ts';

/**
 * Sprint 04's shipped values, transcribed independently of the module under
 * test. Written out literally rather than imported or derived: a pin that
 * computes its expectation from the thing it is pinning would follow it
 * anywhere.
 */
const FROZEN = {
  version: 'priority-policy-v1',
  reasonBase: { overdue: 7_000, due_soon: 5_000, active: 3_000, pending: 1_000 },
  bandCap: 999,
  totalCap: 9_999,
  weights: {
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
  },
} as const;

test('the shipped policy version has not moved', () => {
  assert.equal(PRIORITY_POLICY_VERSION, FROZEN.version);
  assert.equal(DEFAULT_PRIORITY_POLICY.version, FROZEN.version);
});

test('the shipped reason bands have not moved', () => {
  assert.deepEqual({ ...DEFAULT_PRIORITY_POLICY.reasonBase }, { ...FROZEN.reasonBase });
});

test('the shipped caps have not moved', () => {
  assert.equal(DEFAULT_PRIORITY_POLICY.bandCap, FROZEN.bandCap);
  assert.equal(DEFAULT_PRIORITY_POLICY.totalCap, FROZEN.totalCap);
});

test('every shipped weight has not moved, checked value by value', () => {
  // Compared per key rather than as one deepEqual so a failure names the weight
  // that moved. A calibration run that shifted one term should not have to be
  // diffed by hand to find out which.
  const actual = DEFAULT_PRIORITY_POLICY.weights as Readonly<Record<string, number>>;
  const expected = FROZEN.weights as Readonly<Record<string, number>>;

  for (const [name, value] of Object.entries(expected)) {
    assert.equal(actual[name], value, `weight '${name}' moved: ${actual[name]} !== ${value}`);
  }
});

test('no weight was added or removed', () => {
  // A pin over known keys alone would miss a new term silently changing scores.
  assert.deepEqual(
    Object.keys(DEFAULT_PRIORITY_POLICY.weights).sort(),
    Object.keys(FROZEN.weights).sort(),
  );
});

test('the shipped policy is frozen at runtime, not only by type', () => {
  // `readonly` is erased at runtime, so a calibration run holding a reference
  // could mutate the shared policy in place and every later score would use the
  // tuned weights without any file changing.
  assert.equal(Object.isFrozen(DEFAULT_PRIORITY_POLICY), true);
  assert.equal(Object.isFrozen(DEFAULT_PRIORITY_POLICY.weights), true);
  assert.equal(Object.isFrozen(DEFAULT_PRIORITY_POLICY.reasonBase), true);

  assert.throws(
    () => {
      (DEFAULT_PRIORITY_POLICY.weights as unknown as Record<string, number>).importanceHigh = 999;
    },
    TypeError,
    'a frozen policy must reject mutation loudly rather than ignoring it',
  );
  assert.equal(DEFAULT_PRIORITY_POLICY.weights.importanceHigh, FROZEN.weights.importanceHigh);
});
