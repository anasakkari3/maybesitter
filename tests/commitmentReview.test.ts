import test from 'node:test';
import assert from 'node:assert/strict';
import { getCommitmentReviewSnapshot } from '../lib/services/commitmentReviewService.ts';
import { applyCommand, createEmptyDomainState } from '../src/domain/stateMachine.ts';
import type { DomainState } from '../src/domain/stateMachine.ts';

const now = new Date('2026-04-08T08:00:00.000Z');

function addDraft(
  state: DomainState,
  id: string,
  title: string,
  dueAt: string,
  draftStatus: 'pending_confirmation' | 'draft' = 'pending_confirmation'
): DomainState {
  return applyCommand(state, {
    type: 'CreateDraft',
    now: '2026-04-08T07:00:00.000Z',
    commitment: {
      id,
      kind: 'task',
      title,
      timeSpec: {
        kind: 'due_by',
        dueAt,
        remindAt: dueAt,
        timezone: 'UTC',
      },
    },
    draftStatus,
  }).newState;
}

test('commitmentReviewService: groups commitment state read-only', () => {
  let state = createEmptyDomainState();
  state = addDraft(state, 'past', 'Send invoice', '2026-04-08T07:30:00.000Z');
  state = applyCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'past',
    now: '2026-04-08T07:01:00.000Z',
    reminders: [{ id: 'rem_past', scheduledFor: '2026-04-08T07:30:00.000Z' }],
  }).newState;
  state = addDraft(state, 'future', 'Call Maya', '2026-04-08T10:00:00.000Z');

  const snapshot = getCommitmentReviewSnapshot(now, state);

  assert.deepEqual(snapshot.sections.active.map((item) => item.id), ['past']);
  assert.deepEqual(snapshot.sections.pendingConfirmations.map((item) => item.id), ['future']);
  assert.deepEqual(snapshot.sections.overdue.map((item) => item.id), ['past']);
  assert.deepEqual(snapshot.sections.upcoming.map((item) => item.id), ['future']);
});
