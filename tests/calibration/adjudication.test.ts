import test from 'node:test';
import assert from 'node:assert/strict';

import { validateAdjudications } from '../../lib/calibration/adjudication.ts';
import {
  ruleChangesBetween,
  validateAnnotationPolicyRegistry,
} from '../../lib/calibration/policy.ts';
import { hasIssue } from '../../lib/evaluation/registry/validationPrimitives.ts';
import { POLICIES, adjudication, clone } from './calibrationFixtures.ts';

const CONTEXT = { policies: POLICIES, disagreedSourceIds: ['src-a', 'src-b'] };

test('policy: the shipped shape validates', () => {
  const result = validateAnnotationPolicyRegistry(POLICIES);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('policy: exactly one root version is allowed', () => {
  const twoRoots = clone(POLICIES);
  twoRoots.policies[1].supersedes = null;

  const result = validateAnnotationPolicyRegistry(twoRoots);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'POL027'));
});

test('policy: a rule change must name the dimensions it can move', () => {
  const vague = clone(POLICIES);
  vague.policies[1].changedRules[0].affects = [];

  const result = validateAnnotationPolicyRegistry(vague);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'POL024'));
});

test('policy: rule changes accumulate across a supersession chain', () => {
  const oneStep = ruleChangesBetween(POLICIES, '1.0.0', '2.0.0');
  assert.equal(oneStep?.length, 1);

  const twoSteps = ruleChangesBetween(POLICIES, '1.0.0', '2.1.0');
  assert.equal(twoSteps?.length, 2);

  assert.deepEqual(ruleChangesBetween(POLICIES, '2.0.0', '2.0.0'), []);
  assert.equal(ruleChangesBetween(POLICIES, '2.1.0', '1.0.0'), null, 'walking backwards is not a chain');
});

test('adjudication: a well-formed record validates', () => {
  const result = validateAdjudications([adjudication()], CONTEXT);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('adjudication: an unexplained override is rejected', () => {
  const result = validateAdjudications([adjudication({ rationale: '  ' })], CONTEXT);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'ADJ017'));
});

test('adjudication: policy_shift requires two different policy versions', () => {
  const result = validateAdjudications(
    [adjudication({ classification: 'policy_shift', firstPassPolicy: '1.0.0', secondPassPolicy: '1.0.0' })],
    CONTEXT,
  );
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'ADJ041'));
});

test('adjudication: policy_shift requires a rule change that moves that dimension', () => {
  // 1.0.0 -> 2.1.0 changes both decision and date_time rules, so a decision
  // claim is supportable...
  const supported = validateAdjudications(
    [
      adjudication({
        classification: 'policy_shift',
        dimension: 'decision',
        firstPassPolicy: '1.0.0',
        secondPassPolicy: '2.0.0',
        canonicalPass: 'second',
      }),
    ],
    CONTEXT,
  );
  assert.equal(supported.valid, true, JSON.stringify(supported.issues, null, 2));

  // ...but 1.0.0 -> 2.0.0 changes nothing that affects date_time, so blaming a
  // date-time disagreement on that policy step is rejected.
  const unsupported = validateAdjudications(
    [
      adjudication({
        classification: 'policy_shift',
        dimension: 'date_time',
        firstPassPolicy: '1.0.0',
        secondPassPolicy: '2.0.0',
      }),
    ],
    { policies: POLICIES },
  );
  assert.equal(unsupported.valid, false);
  assert.ok(hasIssue(unsupported, 'ADJ043'));
});

test('adjudication: a tooling_defect must name the defect it blames', () => {
  const result = validateAdjudications(
    [adjudication({ classification: 'tooling_defect', dimension: 'date_time', defectId: null })],
    CONTEXT,
  );
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'ADJ031'));
});

test('adjudication: an adjudication cannot be invented for an item that agreed', () => {
  const result = validateAdjudications([adjudication({ sourceQueueId: 'src-z' })], CONTEXT);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'ADJ032'));
});

test('adjudication: one source may hold one adjudication per dimension, not two of the same', () => {
  const twoDimensions = validateAdjudications(
    [
      adjudication({ dimension: 'decision' }),
      adjudication({ dimension: 'date_time', classification: 'tooling_defect', defectId: 'CAL-002' }),
    ],
    CONTEXT,
  );
  assert.equal(twoDimensions.valid, true, JSON.stringify(twoDimensions.issues, null, 2));

  const duplicated = validateAdjudications([adjudication(), adjudication()], CONTEXT);
  assert.equal(duplicated.valid, false);
  assert.ok(hasIssue(duplicated, 'ADJ050'));
});

test('adjudication: "agreement" is not an adjudication outcome', () => {
  const result = validateAdjudications([adjudication({ classification: 'agreement' })], CONTEXT);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'ADJ030'));
});

test('adjudication: an unregistered policy version is rejected', () => {
  const result = validateAdjudications([adjudication({ adjudicatedUnderPolicy: '9.9.9' })], CONTEXT);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'ADJ040'));
});

test('adjudication: every record must cite the issue that authorized it', () => {
  const result = validateAdjudications([adjudication({ authorizingIssue: '' })], CONTEXT);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'ADJ020'));
});
