import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import type { DomainState } from '../../src/domain/stateMachine.ts';

const now = '2026-04-08T09:00:00.000Z';

function createDraft(state: DomainState, highPressure = false): DomainState {
  return applyCommand(state, {
    type: 'CreateDraft',
    now,
    commitment: {
      id: 'cmt_1',
      kind: 'task',
      title: 'Send invoice',
      priority: {
        level: highPressure ? 'high' : 'normal',
        source: highPressure ? 'user_explicit' : 'default',
        pressureAllowed: highPressure,
        pressureLevel: highPressure ? 'firm' : 'none',
      },
      timeSpec: {
        kind: 'due_by',
        dueAt: '2026-04-08T18:00:00.000Z',
        remindAt: '2026-04-08T10:00:00.000Z',
        timezone: 'UTC',
      },
    },
    draftStatus: 'pending_confirmation',
  }).newState;
}

test('stateMachine: create -> confirm -> complete', () => {
  let state = createEmptyDomainState();
  state = createDraft(state);
  state = applyCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'cmt_1',
    now,
    reminders: [{ id: 'rem_1', scheduledFor: '2026-04-08T10:00:00.000Z' }],
  }).newState;
  state = applyCommand(state, {
    type: 'Complete',
    commitmentId: 'cmt_1',
    now: '2026-04-08T09:30:00.000Z',
  }).newState;

  assert.equal(state.commitments.cmt_1.status, 'completed');
  assert.equal(state.commitments.cmt_1.currentAckState, 'completed');
  assert.equal(state.reminders.rem_1.status, 'cancelled');
});

test('stateMachine: create -> confirm -> postpone', () => {
  let state = createEmptyDomainState();
  state = createDraft(state);
  state = applyCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'cmt_1',
    now,
    reminders: [{ id: 'rem_1', scheduledFor: '2026-04-08T10:00:00.000Z' }],
  }).newState;
  state = applyCommand(state, {
    type: 'Postpone',
    commitmentId: 'cmt_1',
    now: '2026-04-08T09:30:00.000Z',
    postponedUntil: '2026-04-08T12:00:00.000Z',
    reminderId: 'rem_postponed',
  }).newState;

  assert.equal(state.commitments.cmt_1.status, 'active');
  assert.equal(state.commitments.cmt_1.currentAckState, 'postponed');
  assert.equal(state.reminders.rem_1.status, 'cancelled');
  assert.equal(state.reminders.rem_postponed.status, 'scheduled');
  assert.equal(state.reminders.rem_postponed.scheduledFor, '2026-04-08T12:00:00.000Z');
});

test('stateMachine: reminder -> ignored -> escalation', () => {
  let state = createEmptyDomainState();
  state = createDraft(state, true);
  state = applyCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'cmt_1',
    now,
    reminders: [{ id: 'rem_1', scheduledFor: '2026-04-08T10:00:00.000Z' }],
  }).newState;
  state = applyCommand(state, {
    type: 'ReminderTriggered',
    reminderId: 'rem_1',
    now: '2026-04-08T10:00:00.000Z',
  }).newState;
  state = applyCommand(state, {
    type: 'ReminderIgnored',
    reminderId: 'rem_1',
    now: '2026-04-08T10:10:00.000Z',
  }).newState;
  const transition = applyCommand(state, {
    type: 'EscalationTriggered',
    commitmentId: 'cmt_1',
    now: '2026-04-08T10:10:01.000Z',
  });

  assert.equal(transition.newState.reminders.rem_1.status, 'ignored');
  assert.equal(transition.newState.commitments.cmt_1.currentAckState, 'ignored');
  assert.equal(transition.newState.escalationStates.cmt_1.status, 'active');
  assert.equal(transition.newState.escalationStates.cmt_1.perCycleCount, 1);
  assert.deepEqual(transition.sideEffects, [{ type: 'send_escalation', commitmentId: 'cmt_1', level: 1 }]);
});

test('stateMachine: duplicate reminder trigger is a no-op', () => {
  let state = createEmptyDomainState();
  state = createDraft(state);
  state = applyCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'cmt_1',
    now,
    reminders: [{ id: 'rem_1', scheduledFor: '2026-04-08T10:00:00.000Z' }],
  }).newState;
  state = applyCommand(state, {
    type: 'ReminderTriggered',
    reminderId: 'rem_1',
    now: '2026-04-08T10:00:00.000Z',
  }).newState;
  const transition = applyCommand(state, {
    type: 'ReminderTriggered',
    reminderId: 'rem_1',
    now: '2026-04-08T10:00:01.000Z',
  });

  assert.equal(transition.newState.reminders.rem_1.status, 'delivered');
  assert.deepEqual(transition.sideEffects, []);
});

test('stateMachine: escalation cannot repeat immediately', () => {
  let state = createEmptyDomainState();
  state = createDraft(state, true);
  state = applyCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'cmt_1',
    now,
    reminders: [{ id: 'rem_1', scheduledFor: '2026-04-08T10:00:00.000Z' }],
  }).newState;
  state = applyCommand(state, {
    type: 'ReminderTriggered',
    reminderId: 'rem_1',
    now: '2026-04-08T10:00:00.000Z',
  }).newState;
  state = applyCommand(state, {
    type: 'ReminderIgnored',
    reminderId: 'rem_1',
    now: '2026-04-08T10:10:00.000Z',
  }).newState;
  state = applyCommand(state, {
    type: 'EscalationTriggered',
    commitmentId: 'cmt_1',
    now: '2026-04-08T10:10:01.000Z',
  }).newState;

  const transition = applyCommand(state, {
    type: 'EscalationTriggered',
    commitmentId: 'cmt_1',
    now: '2026-04-08T10:11:01.000Z',
  });

  assert.equal(transition.newState.escalationStates.cmt_1.perCycleCount, 1);
  assert.deepEqual(transition.sideEffects, []);
});

test('stateMachine: duplicate postpone is a no-op', () => {
  let state = createEmptyDomainState();
  state = createDraft(state);
  state = applyCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'cmt_1',
    now,
    reminders: [{ id: 'rem_1', scheduledFor: '2026-04-08T10:00:00.000Z' }],
  }).newState;
  state = applyCommand(state, {
    type: 'Postpone',
    commitmentId: 'cmt_1',
    now: '2026-04-08T09:30:00.000Z',
    postponedUntil: '2026-04-08T12:00:00.000Z',
    reminderId: 'rem_postponed',
  }).newState;

  const transition = applyCommand(state, {
    type: 'Postpone',
    commitmentId: 'cmt_1',
    now: '2026-04-08T09:31:00.000Z',
    postponedUntil: '2026-04-08T12:00:00.000Z',
    reminderId: 'rem_postponed',
  });

  assert.equal(transition.didChange, false);
  assert.equal(transition.newState.reminders.rem_postponed.status, 'scheduled');
  assert.deepEqual(transition.sideEffects, []);
});
