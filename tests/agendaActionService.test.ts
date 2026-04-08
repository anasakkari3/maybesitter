import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyAgendaAction } from '../lib/services/agendaActionService.ts';
import { MemoryBehaviorFeedbackStore } from '../lib/services/behaviorFeedbackService.ts';
import {
  configureCommandService,
  getCommandServiceState,
} from '../lib/services/commandService.ts';
import { applyCommand, createEmptyDomainState } from '../src/domain/stateMachine.ts';

const now = new Date('2026-04-08T08:00:00.000Z');

function withState() {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-agenda-action-'));
  let state = createEmptyDomainState();
  state = applyCommand(state, {
    type: 'CreateDraft',
    now: '2026-04-08T07:00:00.000Z',
    commitment: {
      id: 'pending',
      kind: 'task',
      title: 'Call Maya',
      timeSpec: {
        kind: 'due_by',
        dueAt: '2026-04-08T10:00:00.000Z',
        remindAt: '2026-04-08T10:00:00.000Z',
        timezone: 'UTC',
      },
    },
    draftStatus: 'pending_confirmation',
  }).newState;
  state = applyCommand(state, {
    type: 'CreateDraft',
    now: '2026-04-08T07:00:00.000Z',
    commitment: {
      id: 'active',
      kind: 'task',
      title: 'Send invoice',
    },
    draftStatus: 'pending_confirmation',
  }).newState;
  state = applyCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'active',
    now: '2026-04-08T07:01:00.000Z',
    reminders: [],
  }).newState;

  configureCommandService({
    initialState: state,
    stateFile: join(dir, 'domain-state.json'),
    schedulerStore: null,
  });

  return () => rmSync(dir, { recursive: true, force: true });
}

test('agendaActionService: acknowledge confirms pending commitment', () => {
  const cleanup = withState();
  try {
    const result = applyAgendaAction('pending', 'aware', now);

    assert.equal(result.success, true);
    assert.equal(result.message, 'Reminder saved.');
    assert.equal(getCommandServiceState().commitments.pending.status, 'active');
  } finally {
    cleanup();
  }
});

test('agendaActionService: done completes active commitment', () => {
  const cleanup = withState();
  try {
    const result = applyAgendaAction('active', 'done', now);

    assert.equal(result.success, true);
    assert.equal(result.message, 'Marked complete.');
    assert.equal(getCommandServiceState().commitments.active.status, 'completed');
    assert.equal(getCommandServiceState().commitments.active.currentAckState, 'completed');
  } finally {
    cleanup();
  }
});

test('agendaActionService: done on pending commitment says it was saved and completed', () => {
  const cleanup = withState();
  try {
    const result = applyAgendaAction('pending', 'done', now);

    assert.equal(result.success, true);
    assert.equal(result.message, 'Saved and marked complete.');
    assert.equal(getCommandServiceState().commitments.pending.status, 'completed');
  } finally {
    cleanup();
  }
});

test('agendaActionService: records lightweight behavior feedback for user reactions', () => {
  const feedbackStore = new MemoryBehaviorFeedbackStore();
  let cleanup = withState();
  try {
    applyAgendaAction('active', 'done', now, { sessionId: 'session-a', feedbackStore });
  } finally {
    cleanup();
  }

  cleanup = withState();
  try {
    applyAgendaAction('active', 'postpone', now, { sessionId: 'session-a', feedbackStore });
  } finally {
    cleanup();
  }

  cleanup = withState();
  try {
    applyAgendaAction('active', 'skip', now, { sessionId: 'session-a', feedbackStore });
  } finally {
    cleanup();
  }

  const feedback = feedbackStore.get('session-a');
  assert.equal(feedback.completedActions, 1);
  assert.equal(feedback.delayedActions, 1);
  assert.equal(feedback.ignoredSuggestions, 1);
});

test('agendaActionService: postpone shifts active commitment attention', () => {
  const cleanup = withState();
  try {
    const result = applyAgendaAction('active', 'postpone', now);

    assert.equal(result.success, true);
    assert.equal(result.message, 'Moved to tomorrow.');
    assert.equal(getCommandServiceState().commitments.active.currentAckState, 'postponed');
    assert.equal(getCommandServiceState().commitments.active.postponedUntil, '2026-04-09T08:00:00.000Z');
  } finally {
    cleanup();
  }
});

test('agendaActionService: postpone on pending commitment says it was saved and moved', () => {
  const cleanup = withState();
  try {
    const result = applyAgendaAction('pending', 'postpone', now);

    assert.equal(result.success, true);
    assert.equal(result.message, 'Saved and moved to tomorrow.');
    assert.equal(getCommandServiceState().commitments.pending.status, 'active');
    assert.equal(getCommandServiceState().commitments.pending.currentAckState, 'postponed');
  } finally {
    cleanup();
  }
});

test('agendaActionService: skip deprioritizes active commitment without dropping it', () => {
  const cleanup = withState();
  try {
    const result = applyAgendaAction('active', 'skip', now);

    assert.equal(result.success, true);
    assert.equal(result.message, 'Moved lower for now.');
    assert.equal(getCommandServiceState().commitments.active.status, 'active');
    assert.equal(getCommandServiceState().commitments.active.priority.level, 'low');
    assert.equal(getCommandServiceState().commitments.active.priority.source, 'user_explicit');
  } finally {
    cleanup();
  }
});

test('agendaActionService: safely rejects missing commitment', () => {
  const cleanup = withState();
  try {
    const result = applyAgendaAction('missing', 'done', now);

    assert.equal(result.success, false);
    assert.equal(result.message, 'Commitment not found.');
  } finally {
    cleanup();
  }
});

test('agendaActionService: safely rejects unsupported action', () => {
  const cleanup = withState();
  try {
    const result = applyAgendaAction('active', 'destroy', now);

    assert.equal(result.success, false);
    assert.equal(result.message, 'Unsupported agenda action.');
  } finally {
    cleanup();
  }
});
