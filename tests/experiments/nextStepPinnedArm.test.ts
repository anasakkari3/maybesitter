import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEXT_STEP_EXPERIMENT_ENV,
  NEXT_STEP_PINNED_ARM_ENV,
  pinnedNextStepArm,
  resolveNextStepArm,
} from '../../lib/experiments/experimentControls.ts';

/**
 * The arm production serves when no experiment is running (UC-2.9, #170).
 *
 * The default was `generic` — the arm that ignores the time of day and the
 * user's own history. Production wants `personalized`, and pinning it through
 * the environment keeps the reviewed baseline as what an unconfigured checkout
 * serves.
 */

const UID = 'ArmUser';

test('an unconfigured environment still serves the reviewed baseline', () => {
  assert.equal(resolveNextStepArm(UID, {}).arm, 'generic');
});

test('the pinned arm is what production gets', () => {
  const assignment = resolveNextStepArm(UID, { [NEXT_STEP_PINNED_ARM_ENV]: 'personalized' });
  assert.equal(assignment.arm, 'personalized');
});

test('a pinned arm is not reported as an experiment', () => {
  // `enabled` drives whether events carry an `experimentId`. A deployment
  // choice is not a trial, and labelling it as one would put an experiment id
  // on every event for a study nobody is running.
  assert.equal(resolveNextStepArm(UID, { [NEXT_STEP_PINNED_ARM_ENV]: 'personalized' }).enabled, false);
});

test('a typo degrades to the baseline rather than taking the feature down', () => {
  // Read on every next-step request. A bad deployment variable must not be an
  // exception on a user's request path.
  for (const bad of ['personalised', 'PERSONALIZED', '', 'true', 'undefined']) {
    assert.equal(resolveNextStepArm(UID, { [NEXT_STEP_PINNED_ARM_ENV]: bad }).arm, 'generic');
    assert.equal(pinnedNextStepArm({ [NEXT_STEP_PINNED_ARM_ENV]: bad }), null);
  }
});

test('a running experiment wins over the pin', () => {
  // The pin is the answer to "what when no experiment is running". With one
  // running, honouring the pin would silently exclude everyone from the trial.
  const assignment = resolveNextStepArm(UID, {
    [NEXT_STEP_EXPERIMENT_ENV]: 'true',
    [NEXT_STEP_PINNED_ARM_ENV]: 'personalized',
  });
  assert.equal(assignment.enabled, true);
  assert.ok(['generic', 'contextual', 'personalized'].includes(assignment.arm));
});

test('the pin is stable for a user across calls', () => {
  const env = { [NEXT_STEP_PINNED_ARM_ENV]: 'contextual' };
  assert.equal(resolveNextStepArm(UID, env).arm, resolveNextStepArm(UID, env).arm);
  assert.equal(resolveNextStepArm('SomebodyElse', env).arm, 'contextual');
});
