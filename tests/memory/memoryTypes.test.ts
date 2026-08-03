import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidTransition,
  isTerminalStatus,
  InvalidCommitmentTransitionError,
} from '../../src/domain/memory/commitmentStateMachine.ts';

test('commitmentStateMachine: mentioned → proposed is valid', () => {
  assert.doesNotThrow(() => assertValidTransition('mentioned', 'proposed'));
});

test('commitmentStateMachine: mentioned → scheduled is valid', () => {
  assert.doesNotThrow(() => assertValidTransition('mentioned', 'scheduled'));
});

test('commitmentStateMachine: completed → mentioned is invalid', () => {
  assert.throws(
    () => assertValidTransition('completed', 'mentioned'),
    InvalidCommitmentTransitionError,
  );
});

test('commitmentStateMachine: cancelled → proposed is invalid', () => {
  assert.throws(
    () => assertValidTransition('cancelled', 'proposed'),
    InvalidCommitmentTransitionError,
  );
});

test('commitmentStateMachine: postponed → confirmed is valid', () => {
  assert.doesNotThrow(() => assertValidTransition('postponed', 'confirmed'));
});

test('commitmentStateMachine: scheduled → completed is valid', () => {
  assert.doesNotThrow(() => assertValidTransition('scheduled', 'completed'));
});

test('commitmentStateMachine: terminal statuses identified', () => {
  assert.ok(isTerminalStatus('completed'));
  assert.ok(isTerminalStatus('cancelled'));
  assert.ok(isTerminalStatus('expired'));
  assert.ok(!isTerminalStatus('mentioned'));
  assert.ok(!isTerminalStatus('proposed'));
  assert.ok(!isTerminalStatus('confirmed'));
  assert.ok(!isTerminalStatus('scheduled'));
  assert.ok(!isTerminalStatus('postponed'));
});
