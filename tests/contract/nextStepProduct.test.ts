import test from 'node:test';
import assert from 'node:assert/strict';
import { NEXT_STEP_PRODUCT_POLICY } from '../../src/contracts/v1/nextStepContracts.ts';
import { decideNextStep, proposeNextStep } from '../../lib/services/nextStepReviewService.ts';

const candidates = [
  { commitmentId: 'b', title: 'Send the report', reason: 'It is due today.', evidenceLabels: ['due today'], rank: 2 },
  { commitmentId: 'a', title: 'Call Maya', reason: 'You set this for this morning.', evidenceLabels: ['scheduled time'], rank: 1 },
];

test('one-next-step: projection is deterministic and presents exactly one primary step', () => {
  const first = proposeNextStep(candidates, 'en', 'proposal-1');
  const replay = proposeNextStep([...candidates].reverse(), 'en', 'proposal-1');
  assert.deepEqual(first, replay);
  assert.equal(first.primaryStep?.commitmentId, 'a');
  assert.equal(first.explanation?.sensitiveInferenceUsed, false);
  assert.equal(first.persistence.occurred, false);
});

test('one-next-step: empty and insufficient evidence are distinct', () => {
  assert.equal(proposeNextStep([], 'ar', 'empty').state, 'empty');
  assert.equal(proposeNextStep([{ ...candidates[0], reason: null }], 'he', 'unknown').state, 'insufficient_evidence');
});

test('one-next-step: command-like or guilt-based language fails closed', () => {
  const unsafe = proposeNextStep([{ ...candidates[0], reason: 'You must do this or you are lazy.' }], 'en', 'unsafe');
  assert.equal(unsafe.state, 'insufficient_evidence');
});

test('one-next-step: accept, edit, and done require confirmation and never persist', () => {
  const proposal = proposeNextStep(candidates, 'en', 'proposal-1');
  for (const action of ['accept', 'done'] as const) {
    assert.deepEqual(decideNextStep(proposal, action, '2026-08-31T00:00:00.000Z').status, 'confirmation_required');
    assert.equal(decideNextStep(proposal, action, '2026-08-31T00:00:00.000Z').persisted, false);
  }
  assert.equal(decideNextStep(proposal, 'edit', '2026-08-31T00:00:00.000Z', 'Call Maya tomorrow').persisted, false);
});

test('one-next-step: defer and dismiss carry no penalty', () => {
  const proposal = proposeNextStep(candidates, 'en', 'proposal-1');
  assert.equal(decideNextStep(proposal, 'defer', '2026-08-31T00:00:00.000Z').status, 'recorded_without_penalty');
  assert.equal(decideNextStep(proposal, 'dismiss', '2026-08-31T00:00:00.000Z').status, 'recorded_without_penalty');
  assert.equal(NEXT_STEP_PRODUCT_POLICY.rejectionHasPenalty, false);
  assert.equal(NEXT_STEP_PRODUCT_POLICY.maximumPrimarySteps, 1);
});
